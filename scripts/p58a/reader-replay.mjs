/**
 * Přehrávač čtení věty (P58A T1/T8): `llama-server` s OpenAI chat API, který místo modelu vrátí čtení nahrané
 * `evals/play/p56a/read-set.ts`. Server hry s `PLAY_READER_ENDPOINT=llamacpp:http://127.0.0.1:<port>` tak dostane
 * u výchozího stavu i u dev kontroly po opravách totéž čtení – viditelnost se mění jen tím, co P58A kreslí.
 * Věta bez nahraného čtení (vypršelo) odpoví 503 jako nedostupný model: hra jede bez čtení, jako při nahrávání.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/p58a/reader-replay.mjs --port 8793 evals/play/p58a/readings/audit-12.gpt-oss-20b.json evals/play/p58a/readings/p56a-holdout.gpt-oss-20b.json
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { normalizeSentence } from '../play-fidelity.mjs';

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port = portAt === -1 ? 8793 : Number(args[portAt + 1]);
const files = args.filter((value, index) => value !== '--port' && index !== portAt + 1);

const readings = new Map();
for (const file of files) {
  for (const row of JSON.parse(readFileSync(file, 'utf8')).readings) if (row.reading !== null) readings.set(normalizeSentence(row.text), row.reading);
}

let served = 0;
let missed = 0;
createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/v1/chat/completions')) {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const user = JSON.parse(body).messages?.find((message) => message.role === 'user')?.content ?? '';
    const reading = readings.get(normalizeSentence(user));
    if (reading === undefined) {
      missed += 1;
      console.log(`miss ${missed}: no recorded reading`);
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"no recorded reading"}');
      return;
    }
    served += 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(reading) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }));
    if (served % 10 === 0) console.log(`served ${served}`);
  });
}).listen(port, '127.0.0.1', () => console.log(`reader replay on 127.0.0.1:${port}, ${readings.size} readings from ${files.length} files`));
