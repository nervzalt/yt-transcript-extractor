/**
 * /api/channel?url=CHANNEL_URL&type=long|short
 * type=long  → videos >= 60s  (default)
 * type=short → videos < 60s   (Shorts)
 *
 * Uses TranscriptAPI.com — paginates through videos.
 * Safety: max 30 pages (3000 videos), duplicate-token guard.
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

    // Step 2: Paginate — max 30 pages (3 000 videos), duplicate-token guard
    let allRaw = [];
    let channelName = url;
    let token = null;
    let seenTokens = new Set();
    const MAX_PAGES = 30;
    let page = 0;

    do {
      const endpoint = token
        ? `${base}/youtube/channel/videos?channel=${channelId}&limit=100&continuation_token=${encodeURIComponent(token)}`
        : `${base}/youtube/channel/videos?channel=${channelId}&limit=100`;

      const pageRes = await fetch(endpoint, { headers });
      const pageData = await pageRes.json();
      if (!pageRes.ok) {
        if (allRaw.length === 0) {
          res.status(pageRes.status).json({ error: pageData?.message || 'Could not load videos' }); return;
        }
        break;
      }

      if (!channelName || channelName === url) {
        channelName = pageData.playlist_info?.ownerName || pageData.channel_name || pageData.channel || url;
      }

      const batch = pageData.results || pageData.videos || pageData.items || pageData.data || [];
      allRaw = allRaw.concat(batch);
      page++;

      const nextToken = pageData.has_more ? (pageData.continuation_token || null) : null;
      if (!nextToken || seenTokens.has(nextToken) || page >= MAX_PAGES) break;
      seenTokens.add(nextToken);
      token = nextToken;
    } while (true);

    // Filter by type: short (<60s, must have known duration) or long (>=60s or unknown duration)
    const videos = allRaw
      .map(v => ({
        id: v.videoId || v.video_id || v.id,
        title: v.title || v.videoId || v.video_id || v.id,
        duration: parseDurationSecs(v),
      }))
      .filter(v => v.id)
      .filter(v => {
        if (wantShort) {
          // Shorts: must have a known duration < 60s
          return v.duration !== null && v.duration < 60;
        } else {
          // Long-form: unknown duration (assume long) OR >= 60s
          return v.duration === null || v.duration >= 60;
        }
      });

    if (!videos.length) {
      res.status(404).json({ error: `No ${wantShort ? 'short-form' : 'long-form'} videos found for this channel`, debug: { total: allRaw.length, pages: page } }); return;
    }

    res.status(200).json({ channelName, channelId, videos, pages: page, total: allRaw.length });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
