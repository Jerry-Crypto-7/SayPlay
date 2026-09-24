/**
 * Jednorázové prodloužení expirace publikovaných her (P27B T1, nález revize fáze 1).
 *
 * Výchozí TTL vzrostl z 60 na 180 dní, ale `EX` se zapisuje jen při publikaci:
 * hra uložená dřív by dál zmizela po 60 dnech – hra z 20. 9. 2026 už 19. 11.,
 * před vyhlášením 25. 11. Skript projde `<prefix>:play:v:*` a každé hře nastaví
 * `EXPIREAT` na `createdAt + ttl` u klíče hry, rodokmenu i dětí – tedy přesně
 * tu expiraci, kterou by dostala, kdyby ji psal dnešní kód.
 *
 * Bez `--apply` jen spočítá, co by udělal. Předpona se píše výslovně – odvození
 * ze `storePrefix` záleží na prostředí Vercelu a chyba by šla do cizích klíčů.
 *
 *   KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/play-extend-ttl.mjs --prefix <prefix> [--ttl-days 180] [--apply]
 */

import { pathToFileURL } from 'node:url';

/**
 * @param {{ url: string, token: string, prefix: string, ttlSeconds: number, apply: boolean, now: number }} config
 * @param {typeof fetch} fetchImpl
 */
export async function extendPlayTtl(config, fetchImpl = fetch) {
  const command = async (parts) => {
    const response = await fetchImpl(`${config.url}/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parts),
    });
    if (!response.ok) throw new Error(`store answered ${String(response.status)}`);
    return (await response.json()).result;
  };
  const head = `${config.prefix}:play:v:`;
  const report = { games: 0, extended: 0, expired: 0, unreadable: 0 };
  let cursor = '0';
  do {
    const [next, keys] = await command(['SCAN', cursor, 'MATCH', `${head}*`, 'COUNT', '200']);
    cursor = String(next);
    for (const key of keys) {
      report.games += 1;
      const id = key.slice(head.length);
      let createdAt = Number.NaN;
      try {
        createdAt = Date.parse(JSON.parse(await command(['GET', key])).version.createdAt);
      } catch {
        // Rozbitý nebo mezitím vypršelý záznam – nechat, jak je.
      }
      if (Number.isNaN(createdAt)) {
        report.unreadable += 1;
        continue;
      }
      const at = Math.floor(createdAt / 1000) + config.ttlSeconds;
      if (at * 1000 <= config.now) {
        report.expired += 1;
        continue;
      }
      report.extended += 1;
      if (!config.apply) continue;
      for (const target of [key, `${config.prefix}:play:lineage:${id}`, `${config.prefix}:play:children:${id}`]) {
        await command(['EXPIREAT', target, String(at)]);
      }
    }
  } while (cursor !== '0');
  return report;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.WORLDSMITH_SPEND_STORE_URL || process.env.KV_REST_API_URL;
  const token = process.env.WORLDSMITH_SPEND_STORE_TOKEN || process.env.KV_REST_API_TOKEN;
  const prefix = argValue('--prefix');
  const days = Number(argValue('--ttl-days') ?? '180');
  if (!url || !token || !prefix || !Number.isInteger(days) || days <= 0) {
    console.error('usage: KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/play-extend-ttl.mjs --prefix <prefix> [--ttl-days 180] [--apply]');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const report = await extendPlayTtl({ url, token, prefix, ttlSeconds: days * 24 * 3600, apply, now: Date.now() });
  console.log(`${apply ? 'extended' : 'would extend'} ${String(report.extended)} of ${String(report.games)} games under ${prefix}:play:v:* (already expired by the new TTL: ${String(report.expired)}, unreadable: ${String(report.unreadable)})`);
}
