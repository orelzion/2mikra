// GET /api/daily-insights
// Returns pre-generated insights for a date (Jerusalem date by default).
// Reads verseRefs from the texts blob, then batch-fetches insights from Upstash KV.

import { list } from '@vercel/blob';
import { Redis } from '@upstash/redis';

function getJerusalemDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date());
}

function getRequestedDateFromUrl(reqUrl) {
  if (typeof reqUrl !== 'string' || reqUrl.length === 0) return '';

  try {
    const url = new URL(reqUrl, 'https://mikra.local');
    return url.searchParams.get('date') || '';
  } catch {
    return '';
  }
}

function resolveDateKey(req) {
  const requestedDate = getRequestedDateFromUrl(req.url);
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return requestedDate;
  }
  return getJerusalemDateKey();
}

function refToKvKey(ref) {
  // "Genesis 1:1" → "insights:Genesis:1:1"
  const spaceIdx = ref.lastIndexOf(' ');
  const book = ref.slice(0, spaceIdx);
  const [chapter, verse] = ref.slice(spaceIdx + 1).split(':');
  return `insights:${book}:${chapter}:${verse}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const dateKey = resolveDateKey(req);
  const textsBlobPath = `texts/${dateKey}.json`;

  const { blobs } = await list({ prefix: textsBlobPath });
  const textsBlob = blobs.find(b => b.pathname === textsBlobPath);

  if (!textsBlob) {
    return res.status(200).json({ insights: {} });
  }

  const textsRes = await fetch(textsBlob.url, { cache: 'no-store' });
  if (!textsRes.ok) {
    return res.status(200).json({ insights: {} });
  }

  const { verseRefs } = await textsRes.json();
  if (!verseRefs || verseRefs.length === 0) {
    return res.status(200).json({ insights: {} });
  }

  const redis = Redis.fromEnv();
  const kvKeys = verseRefs.map(refToKvKey);
  const values = await redis.mget(...kvKeys);

  const insightsObj = {};
  values.forEach((val, idx) => {
    if (val != null) insightsObj[String(idx)] = val;
  });

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ insights: insightsObj });
}
