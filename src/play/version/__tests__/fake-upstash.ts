/**
 * Falešný Upstash pro testy úložiště (P36B T5, P37C T2, P44B T4): GET, MGET, EXISTS, SET (NX, EX), INCR, EXPIRE,
 * PTTL, ZADD (GT, CH), ZREM, ZREMRANGEBYRANK, ZREMRANGEBYSCORE, ZINTERSTORE (WEIGHTS), ZRANGE, ZREVRANK, ZCARD
 * a transakce `/multi-exec`; expirace jdou do `ttl`, s `clock` hodnoty po `EX` i vyprší. Každý požadavek nejdřív
 * pustí ostatní na řadu, ať se souběžné zápisy prolnou; transakce pak proběhne celá najednou. `requests` sbírá
 * adresy a těla požadavků.
 */
export function fakeUpstash(
  kv: Map<string, string>,
  ttl: Map<string, number>,
  zsets = new Map<string, Map<string, number>>(),
  options: { readonly clock?: () => number; readonly requests?: { url: string; body: unknown }[] } = {},
): typeof fetch {
  const deadlines = new Map<string, number>();
  const value = (key: string): string | undefined => {
    const deadline = deadlines.get(key);
    if (deadline !== undefined && options.clock !== undefined && options.clock() >= deadline) kv.delete(key);
    return kv.get(key);
  };
  // Seřazené množiny (P37C T2): pořadí Redisu – hodnocení, při shodě člen podle bajtů.
  const sorted = (key: string): [string, number][] =>
    [...(zsets.get(key) ?? new Map<string, number>())].sort(([am, ar], [bm, br]) => ar - br || (am < bm ? -1 : am > bm ? 1 : 0));
  const bound = (text: string, edge: 'min' | 'max'): ((score: number) => boolean) => {
    if (text === '-inf' || text === '+inf') return () => true;
    const limit = Number(text.replace('(', ''));
    const open = text.startsWith('(');
    return edge === 'min' ? (score) => (open ? score > limit : score >= limit) : (score) => (open ? score < limit : score <= limit);
  };
  const run = (parts: readonly string[]): unknown => {
    const [command, key = '', arg = '', ...flags] = parts;
    if (command === 'ZADD') {
      // `ZADD key [GT] [CH] score member`: GT nového člena přidá, stávajícího jen zvýší; CH vrací přidané i změněné.
      const modes = parts.slice(2, -2);
      const [score, member] = parts.slice(-2) as [string, string];
      const set = zsets.get(key) ?? new Map<string, number>();
      const before = set.get(member);
      const changed = before === undefined || (modes.includes('GT') ? Number(score) > before : Number(score) !== before);
      if (changed) set.set(member, Number(score));
      zsets.set(key, set);
      return modes.includes('CH') ? Number(changed) : Number(before === undefined);
    }
    if (command === 'ZREM') {
      for (const member of parts.slice(2)) zsets.get(key)?.delete(member);
      return 1;
    }
    if (command === 'ZREVRANK') {
      const all = sorted(key);
      const index = all.findIndex(([member]) => member === arg);
      return index === -1 ? null : all.length - 1 - index;
    }
    if (command === 'ZCARD') return zsets.get(key)?.size ?? 0;
    if (command === 'PTTL') {
      if (value(key) === undefined) return -2;
      const deadline = deadlines.get(key);
      if (deadline !== undefined && options.clock !== undefined) return deadline - options.clock();
      const seconds = ttl.get(key);
      return seconds === undefined ? -1 : seconds * 1000;
    }
    if (command === 'ZREMRANGEBYSCORE') {
      const [above, below] = [bound(arg, 'min'), bound(flags[0] as string, 'max')];
      zsets.set(key, new Map(sorted(key).filter(([, score]) => !(above(score) && below(score)))));
      return 1;
    }
    if (command === 'ZINTERSTORE') {
      const sources = parts.slice(3, 3 + Number(arg));
      const weights = parts.slice(4 + Number(arg)).map(Number);
      const [first = '', ...rest] = sources;
      const result = new Map<string, number>();
      for (const [member, score] of zsets.get(first) ?? new Map<string, number>()) {
        if (rest.every((source) => zsets.get(source)?.has(member) === true))
          result.set(member, sources.reduce((sum, source, index) => sum + (weights[index] ?? 1) * (zsets.get(source)?.get(member) as number), 0));
      }
      zsets.set(key, result);
      return result.size;
    }
    // Rozsah pořadí jako v Redisu: záporný index od konce, začátek oříznutý na 0, konec pod nulou = prázdný rozsah.
    const all = sorted(key);
    const at = (index: number): number => (index < 0 ? all.length + index : index);
    const start = Math.max(0, at(Number(arg)));
    const stop = at(Number(flags[0]));
    if (command === 'ZREMRANGEBYRANK') {
      zsets.set(key, new Map(all.filter((_, index) => index < start || index > stop)));
      return 1;
    }
    if (command === 'ZRANGE') return all.slice(start, stop + 1).flatMap(([member, rank]) => [member, String(rank)]);
    if (command === 'MGET') return parts.slice(1).map((k) => value(k) ?? null);
    if (command === 'EXISTS') return value(key) === undefined ? 0 : 1;
    if (command === 'INCR') {
      kv.set(key, String(Number(kv.get(key) ?? '0') + 1));
      return Number(kv.get(key));
    }
    if (command === 'EXPIRE') {
      ttl.set(key, Number(arg));
      return 1;
    }
    if (command === 'GET') return value(key) ?? null;
    if (command !== 'SET') throw new Error(`fake store does not know ${String(command)}`);
    if (flags.includes('NX') && value(key) !== undefined) return null;
    kv.set(key, arg);
    if (flags.includes('EX')) {
      const seconds = Number(flags[flags.indexOf('EX') + 1]);
      ttl.set(key, seconds);
      if (options.clock !== undefined) deadlines.set(key, options.clock() + seconds * 1000);
    }
    return 'OK';
  };
  return async (input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    options.requests?.push({ url: String(input), body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) });
    const getMatch = /\/get\/(.+)$/.exec(String(input));
    if (getMatch !== null) return Response.json({ result: value(decodeURIComponent(getMatch[1] as string)) ?? null });
    const body = JSON.parse(String(init?.body)) as unknown[];
    if (String(input).endsWith('/multi-exec')) return Response.json((body as string[][]).map((parts) => ({ result: run(parts) })));
    return Response.json({ result: run(body as string[]) });
  };
}
