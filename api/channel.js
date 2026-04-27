/**
 * /api/channel?url=CHANNEL_URL
 *
 * 1. Fetch channel metadata (name) — 1 credit
 * 2. Fetch up to 100 longform video IDs (type=video excludes Shorts) — 1 credit
 * 3. Fetch title for each video via metadata — 1 credit each (batched)
 *
 * Actually to save credits: Supadata channel/videos only returns IDs,
 * so we fetch titles via /youtube/video for each ID.
 * To avoid per-video credit cost for titles, we use the RSS feed as title source
 * (free, no credits) and fall back to video ID as title if not in RSS.
 */

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function getRssTitles(channelId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      { headers: BROWSER_HEADERS }
    );
    if (!res.ok) return {};
    const xml = await res.text();
    const map = {};
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) !== null) {
      const idM = m[1].match(/yt:videoId>([^<]+)</);
      const titleM = m[1].match(/<title>([^<]+)<\/title>/);
      if (idM && titleM) map[idM[1].trim()] = titleM[1].trim();
    }
    return map;
  } catch { return {}; }
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
    // Step 1: Get channel metadata (name + ID) — 1 credit
    const channelRes = await fetch(
      `https://api.supadata.ai/v1/youtube/channel?id=${encodeURIComponent(url)}`,
      { headers: { 'x-api-key': apiKey } }
    );
    const channelData = await channelRes.json();
    if (!channelRes.ok) {
      res.status(channelRes.status).json({ error: channelData?.message || 'Could not load channel' }); return;
    }
    const channelName = channelData.name || url;
    const channelId = channelData.id || '';

    // Step 2: Get video IDs (type=video = longform only, excludes Shorts) — 1 credit
    const videosRes = await fetch(
      `https://api.supadata.ai/v1/youtube/channel/videos?id=${encodeURIComponent(url)}&type=video&limit=100`,
      { headers: { 'x-api-key': apiKey } }
    );
    const videosData = await videosRes.json();
    if (!videosRes.ok) {
      res.status(videosRes.status).json({ error: videosData?.message || 'Could not load videos' }); return;
    }

    const videoIds = videosData.videoIds || [];
    if (!videoIds.length) {
      res.status(404).json({ error: 'No videos found for this channel' }); return;
    }

    // Step 3: Get titles from RSS (free, no credits) for the latest 15
    // For the rest, fall back to video ID as placeholder title
    const rssTitles = channelId ? await getRssTitles(channelId) : {};

    const videos = videoIds.map(id => ({
      id,
      title: rssTitles[id] || id, // RSS title if available, else ID
      published: null,
    }));

    res.status(200).json({ channelName, channelId, videos });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
