/**
 * /api/channel?url=CHANNEL_URL
 *
 * 1. Channel metadata (name + ID) — Supadata, 1 credit
 * 2. Video IDs (longform only) — Supadata, 1 credit
 * 3. Titles — YouTube oEmbed, completely free
 */

async function getTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let url = req.query.url;
  if (!url) { res.status(400).json({ error: 'Missing ?url= param' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;

  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'SUPADATA_API_KEY not set' }); return; }

  try {
    // Fetch channel metadata + video IDs in parallel
    const [channelRes, videosRes] = await Promise.all([
      fetch(`https://api.supadata.ai/v1/youtube/channel?id=${encodeURIComponent(url)}`,
        { headers: { 'x-api-key': apiKey } }),
      fetch(`https://api.supadata.ai/v1/youtube/channel/videos?id=${encodeURIComponent(url)}&type=video&limit=100`,
        { headers: { 'x-api-key': apiKey } }),
    ]);

    const [channelData, videosData] = await Promise.all([
      channelRes.json(),
      videosRes.json(),
    ]);

    // Handle paid-only endpoint error clearly
    if (videosRes.status === 426 || videosData?.error === 'upgrade-required') {
      res.status(402).json({
        error: 'The channel videos endpoint requires a Supadata paid plan ($10/mo). You can still paste individual video URLs using the "Paste URLs" tab.'
      }); return;
    }

    if (!channelRes.ok) {
      res.status(channelRes.status).json({ error: channelData?.message || 'Could not load channel' }); return;
    }
    if (!videosRes.ok) {
      res.status(videosRes.status).json({ error: videosData?.message || videosData?.error || 'Could not load videos' }); return;
    }

    const channelName = channelData.name || url;
    const videoIds = videosData.videoIds || [];

    if (!videoIds.length) {
      res.status(404).json({ error: 'No videos found for this channel' }); return;
    }

    // Fetch all titles via oEmbed in parallel batches — free, no credits
    const BATCH = 10;
    const titles = new Array(videoIds.length).fill(null);
    for (let i = 0; i < videoIds.length; i += BATCH) {
      const chunk = videoIds.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(getTitle));
      results.forEach((t, j) => { titles[i + j] = t; });
    }

    const videos = videoIds.map((id, i) => ({
      id,
      title: titles[i] || id,
    }));

    res.status(200).json({ channelName, channelId: channelData.id || '', videos });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
