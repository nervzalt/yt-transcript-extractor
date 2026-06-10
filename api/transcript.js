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
    // format=text → plain text; include_timestamp=false → no [0.0s] markers;
    // send_metadata=true → adds metadata.title / metadata.author_name
    const apiRes = await fetch(
      `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=text&include_timestamp=false&send_metadata=true`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    const data = await apiRes.json();

    if (!apiRes.ok) {
      res.status(apiRes.status).json({
        error: data?.message || data?.error || `TranscriptAPI error ${apiRes.status}`
      }); return;
    }

    // Response: { video_id, language, transcript, metadata: { title, author_name, ... } }
    const text = typeof data.transcript === 'string'
      ? data.transcript
      : (data.transcript || data.segments || []).map(s => s.text).join(' ');

    if (!text || text.length < 10) {
      res.status(404).json({ error: 'No transcript content returned for this video' }); return;
    }

    res.status(200).json({
      title: data.metadata?.title || data.title || videoId,
      author: data.metadata?.author_name || null,
      text,
      lang: data.language || 'en',
      kind: 'transcript',
    });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
