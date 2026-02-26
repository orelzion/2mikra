// GET /api/daily-insights
// Returns the pre-generated insights for today (Jerusalem date) from Vercel Blob.

import { list } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // Get today's date in Jerusalem timezone
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date()); // "YYYY-MM-DD"

  const { blobs } = await list({ prefix: `insights/${dateKey}.json` });

  if (!blobs.length) {
    return res.status(200).json({ insights: {} });
  }

  const blobRes = await fetch(blobs[0].url);
  const text = await blobRes.text();

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(text);
}
