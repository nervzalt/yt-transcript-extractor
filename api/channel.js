/**
 * /api/channel?url=CHANNEL_URL&type=long|short
 * type=long  → regular videos (not Shorts)
 * type=short → YouTube Shorts only
 *
 * Shorts detection: HEAD https://www.youtube.com/shorts/{id}
 *   200  → is a Short
 *   3xx  → redirects to /watch, not a Short
 * Only checked for videos ≤ 180s to keep it fast.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let url = req.query.url;
  if (!url) { res.status(400).json({ error: 'Missing ?url= param' }); return; }
  url = url.trim();

  // Normalize to a full youtube.com URL — the resolve endpoint works most
  // reliably with full URLs. Key rule: never double-prefix the domain.
  if (url.startsWith('http')) {
    // already a full URL — pass verbatim
  } else if (url.startsWith('@')) {
    url = 'https://www.youtube.com/' + url;
  } else if (/youtube\.com|youtu\.be/i.test(url)) {
    // pasted a domain without scheme, e.g. youtube.com/@Foo or www.youtube.com/channel/UC..
    url = 'https://' + url.replace(/^\/+/, '');
  } else {
    // bare token — treat as a handle
    url = 'https://www.youtube.com/@' + url.replace(/^\/+|^@/g, '');
  }

  // type=short → Shorts only; anything else → long-form only
  const wantShort = req.query.type === 'short';

  const apiKey = process.env.TRANSCRIPTAPI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'TRANSCRIPTAPI_API_KEY not set' }); return; }

  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const base = 'https://transcriptapi.com/api/v2';

  function parseDurationSecs(v) {
    const t = v.lengthText || v.duration || v.duration_seconds || null;
    if (!t) return null;
    if (typeof t === 'number') return t;
    const parts = String(t).split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  try {
    // Step 1: Resolve channel handle/URL to canonical ID — free
    const resolveRes = await fetch(
      `${base}/youtube/channel/resolve?input=${encodeURIComponent(url)}`,
      { headers }
    );
    const resolveData = await resolveRes.json();
    if (!resolveRes.ok) {
      res.status(resolveRes.status).json({ error: resolveData?.message || 'Could not resolve channel' }); return;
    }
    const channelId = resolveData.channel_id;
    // Prefer the @handle for the videos endpoint (the API's own docs use channel=@handle).
    const handleInUrl = url.match(/@([a-zA-Z0-9_.-]+)/);
    const channelParam = handleInUrl ? '@' + handleInUrl[1] : channelId;

    const MAX_PAGES = 5;
    let channelName = url;
    let channelClaimsVideos = false;
    let lastPagesFetched = 0;
    const pageTrace = [];

    // Paginate a given endpoint up to MAX_PAGES. firstUrl seeds page 0;
    // subsequent pages use ?continuation=TOKEN. Returns the collected raw rows.
    async function fetchPages(firstUrl) {
      const rows = [];
      let continuation = null, page = 0;
      const seenPages = new Set();
      while (page < MAX_PAGES) {
        // The token is base64 and may contain +, /, = (often pre-encoded as %3D).
        // A raw + in a query string decodes to a space server-side and corrupts
        // the token → empty results. Fully decode, then properly re-encode.
        let contEnc = continuation;
        if (continuation) {
          let raw = continuation;
          try { raw = decodeURIComponent(continuation); } catch { raw = continuation; }
          contEnc = encodeURIComponent(raw);
        }
        const pageUrl = continuation
          ? `${base}/youtube/${firstUrl.endpoint}?continuation=${contEnc}`
          : `${base}/youtube/${firstUrl.endpoint}?${firstUrl.param}`;
        const r = await fetch(pageUrl, { headers });
        const data = await r.json();
        if (!r.ok) { if (page === 0) throw new Error(data?.message || 'Could not load videos'); break; }
        if (page === 0) {
          channelName = data.playlist_info?.ownerName || data.channel_name || data.channel || channelName;
          if (/[1-9]/.test(data.playlist_info?.numVideos || '')) channelClaimsVideos = true;
        }
        const batch = data.results || data.videos || data.items || data.data || [];
        rows.push(...batch);
        const nextToken = data.continuation_token || data.continuation || data.next_page_token || null;
        pageTrace.push({ p: page, status: r.status, used_cont: !!continuation, got: batch.length, has_more: data.has_more, tok: nextToken ? String(nextToken).slice(0,18) : null });
        page++;
        if (!nextToken || nextToken === continuation || seenPages.has(nextToken)) break;
        if (data.has_more === false) break;
        seenPages.add(nextToken);
        continuation = nextToken;
      }
      lastPagesFetched = page;
      return rows;
    }

    // Primary: channel/videos. If it returns nothing (their channel scraper has
    // been observed returning empty), fall back to the uploads playlist (UC→UU).
    let allRaw, source = 'channel/videos';
    try {
      allRaw = await fetchPages({ endpoint: 'channel/videos', param: `channel=${encodeURIComponent(channelParam)}` });
    } catch (e) {
      res.status(502).json({ error: e.message }); return;
    }
    let channelPages = lastPagesFetched, channelRaw = allRaw.length;
    if (allRaw.length === 0 && /^UC/.test(channelId)) {
      const uploadsPlaylist = 'UU' + channelId.slice(2);
      try {
        allRaw = await fetchPages({ endpoint: 'playlist/videos', param: `playlist=${encodeURIComponent(uploadsPlaylist)}` });
        source = 'playlist/videos';
      } catch { /* keep allRaw empty, handled below */ }
    }

    // Deduplicate by video ID
    const seen = new Set();
    const mapped = allRaw
      .map(v => ({
        id: v.videoId || v.video_id || v.id,
        title: v.title || v.videoId || v.video_id || v.id,
        duration: parseDurationSecs(v),
        views: v.viewCountText || v.view_count_text || null,
      }))
      .filter(v => v.id && !seen.has(v.id) && seen.add(v.id));

    // Detect Shorts: check youtube.com/shorts/{id} — 200 = Short, redirect = regular video.
    // Only bother checking videos ≤ 180s (or unknown duration); long videos are never Shorts.
    async function checkIsShort(id) {
      try {
        const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
          method: 'HEAD', redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return r.status === 200;
      } catch { return false; }
    }

    const candidates = mapped.filter(v => v.duration === null || v.duration <= 180);
    const shortChecks = await Promise.all(candidates.map(v => checkIsShort(v.id)));
    const shortIds = new Set(candidates.filter((_, i) => shortChecks[i]).map(v => v.id));

    const videos = mapped.filter(v => wantShort ? shortIds.has(v.id) : !shortIds.has(v.id));

    if (!videos.length) {
      // The channel page reported videos exist, but the API handed back an empty
      // list — that's a TranscriptAPI-side outage, not a real "empty channel".
      if (channelClaimsVideos && allRaw.length === 0) {
        res.status(503).json({ error: 'TranscriptAPI returned no videos for this channel right now (their service looks down). Try again in a few minutes.' });
        return;
      }
      res.status(404).json({ error: `No ${wantShort ? 'short-form' : 'long-form'} videos found for this channel` });
      return;
    }

    res.status(200).json({ channelName, channelId, videos,
      _meta: { source, channelPages, channelRaw, finalPages: lastPagesFetched, rawTotal: allRaw.length, mapped: mapped.length, longform: videos.length, shorts: shortIds.size, trace: pageTrace } });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
