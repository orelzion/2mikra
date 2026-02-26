// GET /api/daily-insights
// Returns the pre-generated insights for today (Jerusalem date) from Vercel KV.

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

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

  const insights = await kv.get(`insights:${dateKey}`);

  if (!insights) {
    return new Response(JSON.stringify({ insights: {} }), {
      status: 200,
      headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify(insights), {
    status: 200,
    headers: corsHeaders,
  });
}
