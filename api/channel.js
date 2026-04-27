/**
 * /api/channel?url=CHANNEL_URL
 *
 * Uses Supadata to get up to 100 longform videos from a channel.
 * Shorts (under 60s) are filtered out.
 * Cost: 1 credit regardless of video count.
 */

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
  if (!apiKey) {
    res.status(500).json({ error: 'SUPADATA_API_KEY not set' }); return;
  }

  try {
    const supaRes = await fetch(
      `https://api.supadata.ai/v1/youtube/channel/videos?id=${encodeURIComponent(url)}&limit=100`,
      { headers: { 'x-api-key': apiKey } }
    );

    const data = await supaRes.json();

    if (!supaRes.ok) {
      res.status(supaRes.status).json({
        error: data?.message || data?.error || `Supadata error ${supaRes.status}`
      }); return;
    }

    const rawVideos = data.videos || data.items || [];

    // Filter out Shorts — anything under 60 seconds
    // Supadata returns duration in seconds on video objects
    const videos = rawVideos
      .filter(v => {
        const dur = v.duration ?? v.durationSeconds ?? null;
        if (dur === null) return true; // keep if unknown
        return dur >= 60;
      })
      .slice(0, 100)
      .map(v => ({
        id: v.id || v.videoId,
        title: v.title || v.id,
        published: v.publishedAt || v.published || null,
        duration: v.duration || v.durationSeconds || null,
      }))
      .filter(v => v.id);

    if (!videos.length) {
      res.status(404).json({ error: 'No longform videos found for this channel' }); return;
    }

    res.status(200).json({
      channelName: data.channelName || data.channel || data.name || url,
      channelId: data.channelId || data.id || '',
      videos,
    });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
