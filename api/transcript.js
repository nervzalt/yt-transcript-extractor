/**
 * /api/transcript?v=VIDEO_ID
 * Uses Supadata API — handles YouTube IP blocking on their end.
 * Free tier: 100 transcripts/month. supadata.ai
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' }); return;
  }

  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'SUPADATA_API_KEY not set in Vercel environment variables' }); return;
  }

  try {
    const supaRes = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );

    const data = await supaRes.json();

    if (!supaRes.ok) {
      res.status(supaRes.status).json({
        error: data?.message || data?.error || `Supadata error ${supaRes.status}`
      }); return;
    }

    // Supadata returns { content, lang } where content is plain text (when text=true)
    const text = typeof data.content === 'string'
      ? data.content
      : (data.content || []).map(c => c.text).join(' ');

    if (!text || text.length < 10) {
      res.status(404).json({ error: 'No transcript content returned' }); return;
    }

    res.status(200).json({
      title: videoId, // Supadata doesn't return title, we'll get it from RSS
      text,
      lang: data.lang || 'en',
      kind: 'transcript',
    });

  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
