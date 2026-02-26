// GET /api/daily-insights
// Returns the pre-generated insights for today (Jerusalem date) from Vercel Blob.

import { list } from '@vercel/blob';

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // Get today's date in Jerusalem timezone
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
  }).format(new Date()); // "YYYY-MM-DD"

  const { blobs } = await list({ prefix: `insights/${dateKey}.json` });

  if (!blobs.length) {
    return new Response(JSON.stringify({ insights: {} }), {
      status: 200,
      headers: corsHeaders,
    });
  }

  const blobRes = await fetch(blobs[0].url);
  const text = await blobRes.text();

  return new Response(text, {
    status: 200,
    headers: corsHeaders,
  });
}
