/**
 * /api/transcript?v=VIDEO_ID
 * Uses TranscriptAPI.com — 1 credit per successful request
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' }); return;
  }

  const apiKey = process.env.TRANSCRIPTAPI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'TRANSCRIPTAPI_API_KEY not set' }); return; }

  try {
    // format=text gives plain text, include_metadata=true adds title
    const apiRes = await fetch(
      `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=text&include_metadata=true`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    const data = await apiRes.json();

    if (!apiRes.ok) {
      res.status(apiRes.status).json({
        error: data?.message || data?.error || `TranscriptAPI error ${apiRes.status}`
      }); return;
    }

    // Response: { title, transcript, ... } or { title, segments, transcript }
    const text = typeof data.transcript === 'string'
      ? data.transcript
      : (data.segments || []).map(s => s.text).join(' ');

    if (!text || text.length < 10) {
      res.status(404).json({ error: 'No transcript content returned for this video' }); return;
    }

    res.status(200).json({
      title: data.title || videoId,
      text,
      lang: data.language || 'en',
      kind: 'transcript',
    });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
