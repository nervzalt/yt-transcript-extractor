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
  if (url.startsWith('@')) url = 'https://www.youtube.com/' + url;
  else if (!url.startsWith('http')) url = 'https://www.youtube.com/' + url;

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

    // Step 2: Paginate up to 5 pages (500 videos max), stop when no continuation token or has_more=false
    const MAX_PAGES = 5;
    let allRaw = [];
    let channelName = url;
    let continuation = null;
    let page = 0;
    const seenPages = new Set();

    while (page < MAX_PAGES) {
      const pageUrl = continuation
        ? `${base}/youtube/channel/videos?continuation=${continuation}`
        : `${base}/youtube/channel/videos?channel=${channelId}&limit=100`;
      const videosRes = await fetch(pageUrl, { headers });
      const videosData = await videosRes.json();
      if (!videosRes.ok) {
        if (page === 0) { res.status(videosRes.status).json({ error: videosData?.message || 'Could not load videos' }); return; }
        break; // subsequent page failed — use what we have
      }
      if (page === 0) {
        channelName = videosData.playlist_info?.ownerName || videosData.channel_name || videosData.channel || url;
      }
      const batch = videosData.results || videosData.videos || videosData.items || videosData.data || [];
      allRaw = allRaw.concat(batch);
      page++;

      // Debug: on first page, expose the raw top-level keys + pagination fields
      if (page === 1) {
        const debugKeys = Object.keys(videosData);
        const debugPagination = {
          keys: debugKeys,
          has_more: videosData.has_more,
          continuation_token: videosData.continuation_token,
          continuation: videosData.continuation,
          next_page_token: videosData.next_page_token,
          total: videosData.total,
          count: videosData.count,
          batch_size: batch.length,
          pages_fetched: null, // filled after loop
        };
        // Attach debug info to response (remove once pagination confirmed working)
        res._debugPagination = debugPagination;
      }

      const nextToken = videosData.continuation_token || videosData.continuation || videosData.next_page_token || null;
      if (!nextToken || nextToken === continuation || seenPages.has(nextToken)) break;
      if (videosData.has_more === false) break;
      seenPages.add(nextToken);
      continuation = nextToken;
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
      res.status(404).json({ error: `No ${wantShort ? 'short-form' : 'long-form'} videos found for this channel` }); return;
    }

    if (res._debugPagination) res._debugPagination.pages_fetched = page;
    res.status(200).json({ channelName, channelId, videos, _debug: res._debugPagination });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
