// GET /api/daily-insights
// Returns pre-generated insights for a date (Jerusalem date by default).
// Reads verseRefs from KV date index, then batch-fetches verse insights.

import { Redis } from '@upstash/redis';
import { refToKvKey } from './_sefaria.js';

function getJerusalemDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date());
}

function resolveDateKey(req) {
  try {
    const url = new URL(req.url, 'https://mikra.local');
    const requested = url.searchParams.get('date') || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
  } catch {}
  return getJerusalemDateKey();
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
  const redis = Redis.fromEnv();

  const verseRefs = await redis.get(`date:${dateKey}`);
  if (!verseRefs || verseRefs.length === 0) {
    return res.status(200).json({ insights: {} });
  }

  const kvKeys = verseRefs.map(refToKvKey);
  const values = await redis.mget(...kvKeys);

  const insightsObj = {};
  values.forEach((val, idx) => {
    if (val != null) insightsObj[verseRefs[idx]] = val;
  });

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ insights: insightsObj });
}
