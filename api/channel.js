/**
 * /api/channel?url=CHANNEL_URL
 * Uses TranscriptAPI.com
 * - GET /youtube/channel/resolve — free, no credits
 * - GET /youtube/channel/videos — 1 credit, returns titles + video IDs
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let url = req.query.url;
  if (!url) { res.status(400).json({ error: 'Missing ?url= param' }); return; }
  url = url.trim();
  // Normalize: @handle → full YouTube URL
  if (url.startsWith('@')) url = 'https://www.youtube.com/' + url;
  else if (!url.startsWith('http')) url = 'https://www.youtube.com/' + url;

  const apiKey = process.env.TRANSCRIPTAPI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'TRANSCRIPTAPI_API_KEY not set' }); return; }

  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const base = 'https://transcriptapi.com/api/v2';

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

    // Step 2: Get videos — 1 credit, returns ~100 with titles
    const videosRes = await fetch(
      `${base}/youtube/channel/videos?channel=${channelId}&limit=100`,
      { headers }
    );
    const videosData = await videosRes.json();
    if (!videosRes.ok) {
      res.status(videosRes.status).json({ error: videosData?.message || 'Could not load videos' }); return;
    }

    // Response shape: { videos: [{ video_id, title, ... }], channel_name, ... }
    const rawVideos = videosData.videos || videosData.items || [];
    const channelName = videosData.channel_name || videosData.channel || url;

    // Filter out Shorts (duration < 60s if available) and keep up to 100
    const videos = rawVideos
      .filter(v => {
        const dur = v.duration ?? v.duration_seconds ?? null;
        if (dur === null) return true;
        return dur >= 60;
      })
      .slice(0, 100)
      .map(v => ({
        id: v.video_id || v.id,
        title: v.title || v.video_id || v.id,
      }))
      .filter(v => v.id);

    if (!videos.length) {
      res.status(404).json({ error: 'No videos found for this channel' }); return;
    }

    res.status(200).json({ channelName, channelId, videos });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
