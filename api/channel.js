/**
 * /api/channel?url=CHANNEL_URL
 *
 * Takes any YouTube channel URL and returns a list of video IDs
 * using YouTube's public RSS feed — no scraping, no bot detection.
 *
 * Supports:
 *   https://youtube.com/@handle
 *   https://youtube.com/channel/UCxxxxxx
 *   https://youtube.com/c/name
 *   https://youtube.com/user/name
 *
 * Returns: { channelName, channelId, videos: [{ id, title, published }] }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Extract channel ID from a channel page (needed for @handle and /c/ URLs)
async function resolveChannelId(channelUrl) {
  // If it's already a /channel/UC... URL, extract directly
  const directMatch = channelUrl.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (directMatch) return directMatch[1];

  // For @handle, /c/, /user/ — fetch the channel page and extract from HTML
  const res = await fetch(channelUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Could not fetch channel page (HTTP ${res.status})`);
  const html = await res.text();

  // YouTube embeds the channel ID in multiple places
  const patterns = [
    /"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
    /"externalId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
    /channel\/(UC[a-zA-Z0-9_-]+)/,
    /"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }

  throw new Error('Could not resolve channel ID from URL. Try using the /channel/UC... URL directly.');
}

// Fetch and parse the RSS feed
async function fetchRssFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(feedUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`RSS feed returned HTTP ${res.status}`);
  const xml = await res.text();

  // Parse channel name
  const channelNameMatch = xml.match(/<title>([^<]+)<\/title>/);
  const channelName = channelNameMatch ? channelNameMatch[1].trim() : channelId;

  // Parse video entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  const videos = [];
  let m;

  while ((m = entryRegex.exec(xml)) !== null) {
    const entry = m[1];

    const idMatch = entry.match(/yt:videoId>([^<]+)</);
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);

    if (idMatch) {
      videos.push({
        id: idMatch[1].trim(),
        title: titleMatch ? titleMatch[1].trim() : idMatch[1],
        published: publishedMatch ? publishedMatch[1].trim() : null,
      });
    }
  }

  if (videos.length === 0) throw new Error('RSS feed returned no videos');

  return { channelName, channelId, videos };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let url = req.query.url;
  if (!url) { res.status(400).json({ error: 'Missing ?url= param' }); return; }

  // Normalize URL
  if (!url.startsWith('http')) url = 'https://' + url;
  if (!url.includes('youtube.com')) {
    res.status(400).json({ error: 'Must be a YouTube channel URL' }); return;
  }

  try {
    const channelId = await resolveChannelId(url);
    const data = await fetchRssFeed(channelId);
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
