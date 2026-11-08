#!/usr/bin/env node
/**
 * P78 T5 (b): 20 souběžných návštěvníků proti produkci, každý jiná věta, jen rychlá verze. Návštěvník pošle větu
 * (`POST /api/play/games`) a otevře vzniklou hru (`GET /api/play/games/<id>`), jako to dělá stránka `/play`.
 * Všechny požadavky jdou z jedné IP adresy; serverový limit na adresu se zapíše jako výsledek, ne jako chyba sondy.
 *
 *   node scripts/play/p78-load.mjs --base https://worldstream-sigma.vercel.app --out evals/play/p78/load.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const SENTENCES = [
  'a hedgehog rolls through autumn leaves collecting acorns',
  'a robot janitor dodges spilled soup in a space cafeteria',
  'a penguin waiter balances fish on a tray across an ice rink',
  'a moth chases the last streetlight across a sleeping town',
  'a tiny knight defends a sandcastle from crabs',
  'a goat climbs a cliff while rocks tumble down',
  'a ghost collects lost socks in a laundromat at midnight',
  'a frog races paper boats down a rainy gutter',
  'a squirrel steals pine cones from a grumpy owl',
  'a submarine dodges glowing mines in a deep trench',
  'a chef catches falling pancakes before they hit the floor',
  'a fox sneaks past sleeping hounds to reach the henhouse',
  'a balloon floats over a city avoiding pigeons',
  'a beetle pushes a ball of dung up a sandy hill',
  'a wizard zaps slimes in a mossy dungeon',
  'a kid on a skateboard grinds rails in an empty mall',
  'a crow drops pebbles on a picnic to scare the ants',
  'a snowman runs from the sun across a melting village',
  'a bat hunts mosquitoes over a swamp at dusk',
  'a turtle crosses a busy beach to reach the sea',
];

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

async function visitor(base, sentence, index) {
  const started = Date.now();
  const row = { index, sentence };
  try {
    const posted = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
    const body = await posted.json().catch(() => ({}));
    row.postStatus = posted.status;
    row.postMs = Date.now() - started;
    row.code = body.error?.code ?? null;
    if (!posted.ok) return { ...row, ok: false, totalMs: Date.now() - started };
    const opened = await fetch(`${base}/api/play/games/${body.versionId}`, { cache: 'no-store' });
    row.getStatus = opened.status;
    row.totalMs = Date.now() - started;
    return { ...row, ok: opened.ok };
  } catch (error) {
    return { ...row, ok: false, error: String(error).slice(0, 200), totalMs: Date.now() - started };
  }
}

const { values } = parseArgs({ options: { base: { type: 'string' }, out: { type: 'string' } } });
if (values.base === undefined) throw new Error('needs --base <url>');
const measuredAt = new Date().toISOString();
const build = await (await fetch(`${values.base}/api/build-id`, { cache: 'no-store' })).json().catch(() => null);
const rows = await Promise.all(SENTENCES.map((sentence, index) => visitor(values.base, sentence, index)));
const ok = rows.filter((row) => row.ok);
const report = {
  about: 'P78 T5 (b): 20 concurrent visitors, one sentence each, quick version only, all from one IP address.',
  base: values.base,
  build,
  measuredAt,
  visitors: rows.length,
  ok: ok.length,
  errors: rows.length - ok.length,
  statuses: Object.fromEntries([...new Set(rows.map((row) => `${row.postStatus ?? 'none'}${row.code ? ` ${row.code}` : ''}`))].map((key) => [key, rows.filter((row) => `${row.postStatus ?? 'none'}${row.code ? ` ${row.code}` : ''}` === key).length])),
  postMs: { p50: quantile(ok.map((row) => row.postMs), 0.5), p95: quantile(ok.map((row) => row.postMs), 0.95), max: quantile(ok.map((row) => row.postMs), 1) },
  totalMs: { p50: quantile(ok.map((row) => row.totalMs), 0.5), p95: quantile(ok.map((row) => row.totalMs), 0.95), max: quantile(ok.map((row) => row.totalMs), 1) },
  rows,
};
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify({ ...report, rows: undefined }));
