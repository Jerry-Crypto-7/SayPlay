#!/usr/bin/env node
/**
 * Nahlášené hry pro provozovatele (P54A T11a): id, počet hlasů a titul, od naposledy poprvé
 * nahlášené, nejvýš 500 (`REPORTED_KEPT`). Jen čte. Hru, kterou hlasy skryly neprávem, vrátí do
 * feedu `PLAY_FEED_KEEP` (čárkami oddělená `versionId` v prostředí serveru) – klíče hlasů se nemažou.
 *
 *   node --experimental-strip-types scripts/p37c/reported.mjs                     souborové úložiště (`PLAY_STORE_DIR`, jinak data/play/store)
 *   KV_REST_API_URL=… KV_REST_API_TOKEN=… node --experimental-strip-types scripts/p37c/reported.mjs --prefix <předpona>
 *
 * Předpona se píše výslovně (jako u `play-extend-ttl.mjs`): produkční je
 * `WORLDSMITH_SPEND_STORE_PREFIX` z Vercelu, bez něj `worldsmith:spend`.
 */

import { pathToFileURL } from 'node:url';

if (!process.env.VITEST) await import('../ts-paths.mjs');
const { VERSION_STORE_TIMEOUT_MS, fileStoreDirFromEnv, fileVersionStore, httpVersionStore, writeLimitsFromEnv } = await import('../../src/play/version/index.ts');

/** Řádky výpisu: id, hlasy a titul (`null` = hra v úložišti už není). */
export async function reportedRows(store) {
  const rows = [];
  for (const { versionId, votes } of await store.reportedGames()) rows.push({ versionId, votes, title: (await store.get(versionId))?.version.title ?? null });
  return rows;
}

/** S `--prefix` sdílené úložiště z `KV_REST_API_*`, jinak soubory jako `next start`. */
export function storeFrom(argv, env) {
  const limits = writeLimitsFromEnv(env);
  const at = argv.indexOf('--prefix');
  if (at < 0) {
    const dir = fileStoreDirFromEnv(env);
    if (dir === null) throw new Error('no file store here: pass --prefix with KV_REST_API_URL and KV_REST_API_TOKEN');
    return fileVersionStore(dir, limits);
  }
  const prefix = argv[at + 1]?.trim() ?? '';
  const url = env.WORLDSMITH_SPEND_STORE_URL || env.KV_REST_API_URL;
  const token = env.WORLDSMITH_SPEND_STORE_TOKEN || env.KV_REST_API_TOKEN;
  if (prefix === '' || prefix.startsWith('--') || !url || !token) throw new Error('--prefix needs a value, and KV_REST_API_URL and KV_REST_API_TOKEN must be set');
  return httpVersionStore({ url, token, prefix, timeoutMs: VERSION_STORE_TIMEOUT_MS, limits });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = await reportedRows(storeFrom(process.argv.slice(2), process.env));
  if (rows.length === 0) console.log('no reported games');
  for (const row of rows) console.log(`${String(row.votes)}\t${row.versionId}\t${row.title ?? '(no longer stored)'}`);
}
