/**
 * /api/channel?url=CHANNEL_URL
 * Uses TranscriptAPI.com — paginates through ALL videos on the channel.
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

    // Step 2: Paginate through ALL videos
    let allRaw = [];
    let channelName = url;
    let token = null;

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
        break; // partial results — stop paginating
      }

      if (!channelName || channelName === url) {
        channelName = pageData.playlist_info?.ownerName || pageData.channel_name || pageData.channel || url;
      }

      const page = pageData.results || pageData.videos || pageData.items || pageData.data || [];
      allRaw = allRaw.concat(page);

      token = pageData.has_more ? (pageData.continuation_token || null) : null;
    } while (token);

    // Filter out Shorts, map to clean shape
    const videos = allRaw
      .filter(v => {
        const secs = parseDurationSecs(v);
        return secs === null || secs >= 60;
      })
      .map(v => ({
        id: v.videoId || v.video_id || v.id,
        title: v.title || v.videoId || v.video_id || v.id,
        duration: parseDurationSecs(v),
      }))
      .filter(v => v.id);

    if (!videos.length) {
      res.status(404).json({ error: 'No videos found for this channel', debug: { total: allRaw.length } }); return;
    }

    res.status(200).json({ channelName, channelId, videos });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
