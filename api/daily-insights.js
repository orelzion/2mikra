// GET /api/daily-insights?refs=Genesis 12:1,Genesis 12:2
// Returns pre-generated insights keyed by verse ref:
//   { "insights": { "Genesis 12:1": [ {commentator, insight}, … ] } }
// Refs with no stored insights are simply omitted.

import { Redis } from '@upstash/redis';
import { refToKvKey } from './_sefaria.js';

const MAX_REFS  = 200;
// Book names may be multi-word and carry apostrophes/periods ("I Samuel",
// "Song of Songs"), followed by chapter:verse.
const REF_REGEX = /^[A-Za-z'’. ]{1,60} \d{1,3}:\d{1,3}$/;

function parseRefsParam(req) {
  let raw = '';
  try {
    const url = new URL(req.url, 'https://mikra.local');
    raw = url.searchParams.get('refs') || '';
  } catch {
    return [];
  }

  const seen = new Set();
  for (const part of raw.split(',')) {
    const ref = part.trim();
    if (ref && REF_REGEX.test(ref)) seen.add(ref);
    if (seen.size >= MAX_REFS) break;
  }
  return [...seen];
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

  const refs = parseRefsParam(req);
  if (refs.length === 0) {
    return res.status(400).json({ error: 'refs query parameter is required (e.g. ?refs=Genesis 12:1,Genesis 12:2)' });
  }

  const redis  = Redis.fromEnv();
  const values = await redis.mget(...refs.map(refToKvKey));

  const insights = {};
  values.forEach((val, idx) => {
    if (val != null) insights[refs[idx]] = val;
  });

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ insights });
}
