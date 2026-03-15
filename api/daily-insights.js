// GET /api/daily-insights
// Returns the pre-generated insights for a date key (Jerusalem date by default) from Vercel Blob.

import { list } from '@vercel/blob';

function getJerusalemDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date());
}

function resolveDateKey(req) {
  const requestedDate = typeof req.query?.date === 'string' ? req.query.date : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return requestedDate;
  }
  return getJerusalemDateKey();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const dateKey = resolveDateKey(req);
  const blobPath = `insights/${dateKey}.json`;

  const { blobs } = await list({ prefix: blobPath });
  const exactBlob = blobs.find((blob) => blob.pathname === blobPath);

  if (!exactBlob) {
    return res.status(200).json({ insights: {} });
  }

  const blobRes = await fetch(exactBlob.url, { cache: 'no-store' });
  const text = await blobRes.text();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(text);
}
