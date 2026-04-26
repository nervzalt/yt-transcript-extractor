/**
 * /api/transcript?v=VIDEO_ID
 *
 * Uses YouTube's internal InnerTube API (POST) instead of scraping
 * the watch page. POST requests to internal APIs are much harder for
 * YouTube to bot-detect than GET requests to watch pages from cloud IPs.
 *
 * Returns: { title, text, lang, kind } or { error }
 */

// Try multiple InnerTube clients in order — if one gets bot-challenged,
// the next might not.
const CLIENTS = [
  {
    clientName: 'TVHTML5',
    clientVersion: '7.20220325',
    headerClientName: '7',
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
  },
  {
    clientName: 'WEB_EMBEDDED_PLAYER',
    clientVersion: '1.20220731.00.00',
    headerClientName: '56',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
  {
    clientName: 'WEB',
    clientVersion: '2.20220801.00.00',
    headerClientName: '1',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

async function getPlayerResponse(videoId, client) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.userAgent,
      'X-YouTube-Client-Name': client.headerClientName,
      'X-YouTube-Client-Version': client.clientVersion,
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: 'en',
          gl: 'US',
          utcOffsetMinutes: 0,
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
  return res.json();
}

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => (t.languageCode || '').startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => (t.languageCode || '').startsWith('en')) ||
    tracks.find(t => t.kind !== 'asr') ||
    tracks[0]
  );
}

function parseVtt(vtt) {
  const lines = [];
  let prev = '';
  for (const line of vtt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('WEBVTT') || t.startsWith('NOTE') ||
        t.startsWith('Kind:') || t.startsWith('Language:') ||
        /^\d+$/.test(t) || t.includes('-->')) continue;
    const clean = t.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").trim();
    if (clean && clean !== prev) { lines.push(clean); prev = clean; }
  }
  return lines.join(' ');
}

function parseXml(xml) {
  const lines = [];
  let prev = '';
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const clean = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (clean && clean !== prev) { lines.push(clean); prev = clean; }
  }
  return lines.join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' }); return;
  }

  let lastError = 'All clients failed';

  // Try each InnerTube client in sequence
  for (const client of CLIENTS) {
    try {
      const data = await getPlayerResponse(videoId, client);

      // Check playability
      const status = data?.playabilityStatus?.status;
      if (status === 'LOGIN_REQUIRED') {
        res.status(403).json({ error: 'Video is private or age-restricted' }); return;
      }
      if (status === 'ERROR') {
        res.status(404).json({ error: data?.playabilityStatus?.reason || 'Video not found' }); return;
      }

      const title = data?.videoDetails?.title || videoId;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (!tracks || tracks.length === 0) {
        res.status(404).json({ error: 'No captions on this video (owner disabled them)', title }); return;
      }

      const track = pickBestTrack(tracks);
      if (!track?.baseUrl) {
        res.status(404).json({ error: 'Caption track has no URL', title }); return;
      }

      // Fetch the actual caption content
      const captionRes = await fetch(track.baseUrl + '&fmt=vtt');
      if (!captionRes.ok) throw new Error(`Caption fetch HTTP ${captionRes.status}`);
      const captionText = await captionRes.text();

      const text = captionText.includes('WEBVTT')
        ? parseVtt(captionText)
        : parseXml(captionText);

      if (!text || text.length < 10) {
        res.status(404).json({ error: 'Caption track returned empty content', title }); return;
      }

      res.status(200).json({
        title,
        text,
        lang: track.languageCode,
        kind: track.kind || 'manual',
      });
      return;

    } catch (err) {
      lastError = err.message;
      // Try next client
    }
  }

  res.status(502).json({ error: lastError });
}
