/**
 * /api/channel?url=CHANNEL_URL
 * 
 * 1. Fetch channel metadata (name + ID) via Supadata — 1 credit
 * 2. Fetch up to 100 longform video IDs via Supadata — 1 credit  
 * 3. Fetch titles for all videos via YouTube oEmbed — FREE, no credits
 *
 * Total cost: 2 credits per channel load regardless of video count.
 */

async function getTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'Accept': 'application/json' } }
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
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    res.status(400).json({ error: 'Must be a YouTube channel URL' }); return;
  }

  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'SUPADATA_API_KEY not set' }); return; }

  try {
    // Step 1: Channel metadata — 1 credit
    const [channelRes, videosRes] = await Promise.all([
      fetch(`https://api.supadata.ai/v1/youtube/channel?id=${encodeURIComponent(url)}`,
        { headers: { 'x-api-key': apiKey } }),
      // Step 2: Video IDs, type=video excludes Shorts — 1 credit
      fetch(`https://api.supadata.ai/v1/youtube/channel/videos?id=${encodeURIComponent(url)}&type=video&limit=100`,
        { headers: { 'x-api-key': apiKey } }),
    ]);

    const [channelData, videosData] = await Promise.all([
      channelRes.json(),
      videosRes.json(),
    ]);

    if (!channelRes.ok) {
      res.status(channelRes.status).json({ error: channelData?.message || 'Could not load channel' }); return;
    }
    if (!videosRes.ok) {
      res.status(videosRes.status).json({ error: videosData?.message || 'Could not load videos' }); return;
    }

    const channelName = channelData.name || url;
    const channelId = channelData.id || '';
    const videoIds = videosData.videoIds || [];

    if (!videoIds.length) {
      res.status(404).json({ error: 'No videos found for this channel' }); return;
    }

    // Step 3: Fetch all titles via oEmbed in parallel — completely free
    // oEmbed is a public standard YouTube endpoint, no auth, no credits
    const CONCURRENCY = 10;
    const titles = new Array(videoIds.length).fill(null);

    for (let i = 0; i < videoIds.length; i += CONCURRENCY) {
      const chunk = videoIds.slice(i, i + CONCURRENCY);
      const chunkTitles = await Promise.all(chunk.map(getTitle));
      chunkTitles.forEach((t, j) => { titles[i + j] = t; });
    }

    const videos = videoIds.map((id, i) => ({
      id,
      title: titles[i] || id,
      published: null,
    }));

    res.status(200).json({ channelName, channelId, videos });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
