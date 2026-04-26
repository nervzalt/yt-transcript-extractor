/**
 * /api/transcript?v=VIDEO_ID
 * 
 * Strategy (in order):
 * 1. Try YouTube's timedtext API directly — lightweight, sometimes works from cloud IPs
 * 2. Try InnerTube POST with multiple clients as fallback
 * 
 * Returns: { title, text, lang, kind } or { error }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+294; PREF=f4=4000000&hl=en&gl=US',
};

const INNERTUBE_CLIENTS = [
  {
    clientName: 'TVHTML5',
    clientVersion: '7.20220325',
    headerNum: '7',
    ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
  },
  {
    clientName: 'WEB_EMBEDDED_PLAYER',
    clientVersion: '1.20220731.00.00',
    headerNum: '56',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
  {
    clientName: 'WEB',
    clientVersion: '2.20220801.00.00',
    headerNum: '1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
];

function parseVtt(text) {
  const lines = [];
  let prev = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('WEBVTT') || t.startsWith('NOTE') ||
        t.startsWith('Kind:') || t.startsWith('Language:') ||
        /^\d+$/.test(t) || t.includes('-->')) continue;
    const clean = t.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
    if (clean && clean !== prev) { lines.push(clean); prev = clean; }
  }
  return lines.join(' ');
}

function parseXml(text) {
  const lines = [];
  let prev = '';
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clean = m[1].replace(/<[^>]+>/g,'')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g,' ').trim();
    if (clean && clean !== prev) { lines.push(clean); prev = clean; }
  }
  return lines.join(' ');
}

function pickTrack(tracks) {
  return (
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    tracks.find(t => (t.languageCode||'').startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en') ||
    tracks.find(t => (t.languageCode||'').startsWith('en')) ||
    tracks.find(t => t.kind !== 'asr') ||
    tracks[0]
  );
}

// Strategy 1: timedtext API directly (no page fetch needed)
async function tryTimedtext(videoId) {
  const langs = ['en', 'en-US', 'en-GB'];
  const kinds = ['', 'asr'];
  
  for (const lang of langs) {
    for (const kind of kinds) {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kind ? '&kind='+kind : ''}&fmt=vtt`;
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) continue;
        const text = await res.text();
        if (text && text.includes('WEBVTT') && text.length > 100) {
          const parsed = parseVtt(text);
          if (parsed && parsed.length > 20) {
            return { text: parsed, lang, kind: kind || 'manual' };
          }
        }
      } catch {}
    }
  }
  return null;
}

// Strategy 2: InnerTube POST to get signed caption URLs
async function tryInnertube(videoId) {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.ua,
          'X-YouTube-Client-Name': client.headerNum,
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
              hl: 'en', gl: 'US',
            }
          }
        })
      });

      if (!res.ok) continue;
      const data = await res.json();

      // Check if actually blocked (bot detection returns 200 but with error status)
      const playStatus = data?.playabilityStatus?.status;
      if (playStatus === 'ERROR') continue; // try next client, might be IP block not real error
      if (playStatus === 'LOGIN_REQUIRED') return { blocked: true, reason: 'Video is age-restricted or private' };

      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || tracks.length === 0) continue;

      const track = pickTrack(tracks);
      if (!track?.baseUrl) continue;

      const captionRes = await fetch(track.baseUrl + '&fmt=vtt', { headers: HEADERS });
      if (!captionRes.ok) continue;
      const captionText = await captionRes.text();

      const parsed = captionText.includes('WEBVTT') ? parseVtt(captionText) : parseXml(captionText);
      if (parsed && parsed.length > 20) {
        return {
          text: parsed,
          title: data?.videoDetails?.title,
          lang: track.languageCode,
          kind: track.kind || 'manual',
        };
      }
    } catch {}
  }
  return null;
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

  // Try timedtext first (lightest request, no page scraping)
  const timedtext = await tryTimedtext(videoId);
  if (timedtext) {
    res.status(200).json({ title: videoId, text: timedtext.text, lang: timedtext.lang, kind: timedtext.kind });
    return;
  }

  // Fall back to InnerTube
  const innertube = await tryInnertube(videoId);
  if (innertube?.blocked) {
    res.status(403).json({ error: innertube.reason }); return;
  }
  if (innertube) {
    res.status(200).json({ title: innertube.title || videoId, text: innertube.text, lang: innertube.lang, kind: innertube.kind });
    return;
  }

  // Both failed — be honest about why
  res.status(502).json({
    error: 'Could not fetch transcript. YouTube is blocking requests from this server\'s IP. The video likely has captions — try again in a few minutes, or use a different video to test.'
  });
}
