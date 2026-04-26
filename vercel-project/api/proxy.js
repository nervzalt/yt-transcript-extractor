/**
 * Vercel Serverless Function — /api/proxy
 * Proxies YouTube pages server-side (no CORS, real browser headers)
 */

const YT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+294; PREF=f4=4000000&hl=en&gl=US; YSC=DwKYllHNwuw",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // Health check via ?health=1
  if (req.query.health) { res.status(200).send("ok"); return; }

  const target = req.query.url;
  if (!target) { res.status(400).send("Missing ?url= param"); return; }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.status(400).send("Invalid URL"); return;
  }

  const host = targetUrl.hostname;
  if (!host.endsWith("youtube.com") && !host.endsWith("googlevideo.com")) {
    res.status(403).send("Only youtube.com URLs allowed"); return;
  }

  try {
    const ytRes = await fetch(target, {
      headers: YT_HEADERS,
      redirect: "follow",
    });
    const body = await ytRes.text();
    res.status(ytRes.status)
      .setHeader("Content-Type", ytRes.headers.get("content-type") || "text/plain; charset=utf-8")
      .send(body);
  } catch (err) {
    res.status(502).send(`Upstream error: ${err.message}`);
  }
}
