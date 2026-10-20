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
const { sharedStoreFromEnv } = await import('../../src/server/spend-store.ts');

/** Řádky výpisu: id, hlasy a titul (`null` = hra v úložišti už není). */
export async function reportedRows(store) {
  const rows = [];
  for (const { versionId, votes } of await store.reportedGames()) rows.push({ versionId, votes, title: (await store.get(versionId))?.version.title ?? null });
  return rows;
}

/**
 * S `--prefix` sdílené úložiště jako server (`sharedStoreFromEnv`: výslovný pár `WORLDSMITH_SPEND_STORE_*`
 * má přednost i napůl vyplněný), jinak soubory jako `next start`. `where` říká, co se četlo – špatná
 * předpona (preview píše pod `…:preview`) by jinak vypadala jako „nic nahlášeno“ (nález revize T11a-1 #2).
 */
export function storeFrom(argv, env) {
  const limits = writeLimitsFromEnv(env);
  const at = argv.indexOf('--prefix');
  if (at < 0) {
    const dir = fileStoreDirFromEnv(env);
    if (dir === null) throw new Error('no file store here: pass --prefix with KV_REST_API_URL and KV_REST_API_TOKEN');
    return { store: fileVersionStore(dir, limits), where: `file store ${dir}` };
  }
  const prefix = argv[at + 1]?.trim() ?? '';
  const shared = sharedStoreFromEnv(env);
  if (prefix === '' || prefix.startsWith('--') || shared === null) throw new Error('--prefix needs a value, and KV_REST_API_URL and KV_REST_API_TOKEN must be set');
  return { store: httpVersionStore({ url: shared.url, token: shared.token, prefix, timeoutMs: VERSION_STORE_TIMEOUT_MS, limits }), where: `shared store, prefix ${prefix}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { store, where } = storeFrom(process.argv.slice(2), process.env);
  const rows = await reportedRows(store);
  console.log(`${String(rows.length)} reported games in the ${where}`);
  for (const row of rows) console.log(`${String(row.votes)}\t${row.versionId}\t${row.title ?? '(no longer stored)'}`);
}
