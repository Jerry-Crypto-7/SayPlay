/**
 * P58E live check: preload for the `next start` process (`NODE_OPTIONS=--import <this file>`). Appends the provider's
 * own `usage` of every api.openai.com call to the JSONL file in `P58E_USAGE_LOG`, with the first line of the system
 * prompt so `live.mjs` can tell the reader from the director. Nothing of the request but that line is written.
 */

import { appendFileSync } from 'node:fs';

const LOG = process.env.P58E_USAGE_LOG;
const original = globalThis.fetch;

if (LOG) {
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (!url.includes('api.openai.com')) return response;
    let role = null;
    let model = null;
    try {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      model = body.model ?? null;
      role = String(body.messages?.[0]?.content ?? body.instructions ?? '').split('\n')[0].slice(0, 80);
    } catch {}
    let usage = null;
    try {
      usage = (await response.clone().json()).usage ?? null;
    } catch {}
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), model, role, status: response.status, usage })}\n`);
    return response;
  };
}
