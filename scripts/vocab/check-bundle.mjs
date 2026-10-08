#!/usr/bin/env node
/**
 * Tabulka sloves P44C jen na serveru (T12): po `npm run build` (webpack) nesmí být v `.next/static`
 * a musí být v `.next/server`. Kód 1 při porušení, 2 bez buildu.
 *
 *   node scripts/vocab/check-bundle.mjs
 *
 * Značky: strážní klíč `p44c-vocab-verbs` a první řádek tabulky (`"abscond":[…]`). Klíč sám nestačí –
 * webpack z JSON vyhodí pole, které nikdo nečte, takže v serverovém balíku chybí, i když tam tabulka je.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const verbs = readFileSync(join(root, 'src/play/vocab/verbs.json'), 'utf8');
const markers = ['p44c-vocab-verbs', verbs.split('\n')[1].replace(/,$/, '')];

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const hits = (dir) => filesUnder(join(root, dir)).filter((file) => {
  const text = readFileSync(file, 'utf8');
  return markers.some((marker) => text.includes(marker));
});

if (!existsSync(join(root, '.next/static')) || !existsSync(join(root, '.next/server'))) {
  console.error('no .next build – run npm run build first');
  process.exit(2);
}
const client = hits('.next/static');
const server = hits('.next/server');
if (client.length > 0) console.error(`verb table in the client bundle: ${client.join(', ')}`);
if (server.length === 0) console.error('verb table missing from the server bundle');
if (client.length > 0 || server.length === 0) process.exit(1);
console.log(`verb table only on the server (${server.length} chunk${server.length === 1 ? '' : 's'})`);
