/**
 * **Živá cloudová větev (P13 T9).** Pět tvrzení, na kterých P13 stojí, sebraných
 * na jedno místo — dosud byla roztroušená po `no-webgpu-route.test.ts`
 * a `pipeline.test.ts`, kde je nikdo nehledal.
 *
 *   1. volá se **nakonfigurovaný** koncový bod, nikdy adresa zapsaná v kódu
 *   2. rezervuje se nejhorší případ **před** voláním a doúčtuje se po něm
 *   3. neznámá cena se **nikdy** neúčtuje nulou
 *   4. při vypnutém přepínači neodejde **žádný** požadavek
 *   5. jméno ani hodnota secretu se nedostanou do klientského bundlu
 *
 * ## Co je u pátého tvrzení mechanismus a co jen proxy — čti dřív, než se
 * o něj opřeš
 *
 * **Mechanismus** je jen jeden a je to `NEXT_PUBLIC_`: Next do klientského
 * bundlu vpisuje **hodnoty** výhradně u proměnných s touhle předponou. Aserce,
 * že žádná `NEXT_PUBLIC_WORLDSMITH_*` neexistuje, tedy skutečně uzavírá cestu,
 * kterou by hodnota klíče odešla do prohlížeče. Totéž platí o `build-env.allow`:
 * co na něm není, to hermetický build fyzicky nevidí.
 *
 * **Proxy** je aserce o tom, kde se jméno `WORLDSMITH_MODEL_KEY` v repozitáři
 * čte. Je lexikální, běží nad zdrojáky a **žádný bundle při ní nevzniká**.
 * Skutečný oracle je grep nad `.next/` po buildu; ten sem nepatří, protože by
 * z jednotkové sady udělal několikaminutový build. Patří k nasazení (vlna 7).
 * **Dokud ten grep nikdo nepustil, nesmí se nikde tvrdit, že bundle byl
 * prohlédnutý.**
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { frozenGrammar } from '../../model/client';
import type { Grammar } from '../../model/prompt';
import { runPipeline } from '../pipeline';
import { SpendCap } from '../spend-cap';
import { upstreamBranch, upstreamConfigFromEnv, type UpstreamConfig } from '../upstream';

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Prostředí, ve kterém je cloudová větev objednaná i schopná jet. */
const LIVE_ENV = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '25',
  WORLDSMITH_USD_PER_MTOK_IN: '5',
} as const;

const PROMPT = 'a spiral library where the stairs are the shelves';

function liveConfig(overrides: Partial<Record<string, string>> = {}): UpstreamConfig {
  const config = upstreamConfigFromEnv({ ...LIVE_ENV, ...overrides });
  if (config === null) throw new Error('testovací prostředí mělo dát platnou konfiguraci');
  return config;
}

/** Nejmenší platná odpověď Messages API, kterou větev přijme jako úspěch. */
function messagesResponse(body: unknown, usage: { input_tokens: number; output_tokens: number } | null) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(body) }],
      ...(usage === null ? {} : { usage }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Odpověď 200 s textovým blokem, jehož obsah se dá zvolit — i nevalidní JSON. */
function textBlockResponse(text: string, usage: { input_tokens: number; output_tokens: number }) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Odpověď 200, která projde jako JSON, ale nenese žádný textový blok. */
function contentlessResponse(usage: { input_tokens: number; output_tokens: number }) {
  return new Response(JSON.stringify({ content: [], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const MINIMAL_WORLD = { irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: null, look: {} };

/** Zaznamenává každé volání transportu i to, co drží strop v okamžiku volání. */
function recordingFetch(cap: SpendCap | null, response: () => Response) {
  const calls: { url: string; init: RequestInit; reservedAtCallUsd: number }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      reservedAtCallUsd: cap?.snapshot().reservedUsd ?? 0,
    });
    return Promise.resolve(response());
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function openCap(): SpendCap {
  return new SpendCap({ enabled: true, capUsd: 5, callCap: 200 });
}

describe('1. volá se nakonfigurovaný koncový bod', () => {
  it('adresa, klíč i verze protokolu jdou z konfigurace', async () => {
    const { calls, fetchImpl } = recordingFetch(null, () => messagesResponse(MINIMAL_WORLD, null));
    await upstreamBranch(liveConfig(), fetchImpl).generate({
      prompt: PROMPT,
      request: { model: 'm', system: 's', user: 'u' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://upstream.invalid/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('v těle jde model, strop výstupu a úsilí', async () => {
    const { calls, fetchImpl } = recordingFetch(null, () => messagesResponse(MINIMAL_WORLD, null));
    await upstreamBranch(liveConfig({ WORLDSMITH_MODEL: 'claude-sonnet-5' }), fetchImpl).generate({
      prompt: PROMPT,
      request: { model: 'm', system: 'system text', user: 'user text' },
    });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.system).toBe('system text');
    expect(body.messages).toEqual([{ role: 'user', content: 'user text' }]);
    // `effort` uvnitř `output_config`, ne nahoře — nahoře ho API neuvidí.
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.top_level_effort).toBeUndefined();
  });

  it('úsilí se dá přebít prostředím a neznámá hodnota padá na `low`', () => {
    expect(liveConfig({ WORLDSMITH_MODEL_EFFORT: 'xhigh' }).effort).toBe('xhigh');
    expect(liveConfig({ WORLDSMITH_MODEL_EFFORT: 'HIGH' }).effort).toBe('high');
    expect(liveConfig({ WORLDSMITH_MODEL_EFFORT: 'turbo' }).effort).toBe('low');
    expect(liveConfig({ WORLDSMITH_MODEL_EFFORT: '' }).effort).toBe('low');
    expect(liveConfig().effort).toBe('low');
  });
});

describe('2. rezervace je před voláním, vyrovnání po něm', () => {
  it('v okamžiku, kdy odchází požadavek, strop už drží nejhorší případ', async () => {
    const cap = openCap();
    const config = liveConfig();
    const { calls, fetchImpl } = recordingFetch(cap, () =>
      messagesResponse(MINIMAL_WORLD, { input_tokens: 10, output_tokens: 10 }),
    );

    const worstCase = upstreamBranch(config, fetchImpl).worstCaseUsd({
      prompt: PROMPT,
      request: { model: 'm', system: '', user: '' },
    });
    expect(worstCase).toBeGreaterThan(0);

    await runPipeline(PROMPT, { branch: upstreamBranch(config, fetchImpl), cap, grammar: GRAMMAR });

    expect(calls).toHaveLength(1);
    // Kdyby se rezervovalo až po odpovědi, bylo by tohle číslo nula.
    expect(calls[0]!.reservedAtCallUsd).toBeGreaterThan(0);
    // A po vyrovnání už nic drženého nezůstane.
    expect(cap.snapshot().reservedUsd).toBe(0);
    expect(cap.snapshot().spentUsd).toBeGreaterThan(0);
  });

  it('skutečná spotřeba je levnější než rezervace, takže se vrací', async () => {
    const cap = openCap();
    const config = liveConfig();
    const { fetchImpl } = recordingFetch(cap, () =>
      messagesResponse(MINIMAL_WORLD, { input_tokens: 1, output_tokens: 1 }),
    );

    const worstCase = upstreamBranch(config, fetchImpl).worstCaseUsd({
      prompt: PROMPT,
      request: { model: 'm', system: '', user: '' },
    });
    await runPipeline(PROMPT, { branch: upstreamBranch(config, fetchImpl), cap, grammar: GRAMMAR });

    expect(cap.snapshot().spentUsd).toBeLessThan(worstCase);
  });
});

describe('3. neznámá cena se neúčtuje nulou', () => {
  it('odpověď bez pole `usage` stojí víc než tatáž odpověď s účtenkou', async () => {
    const config = liveConfig();

    const withReceipt = openCap();
    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(withReceipt, () => messagesResponse(MINIMAL_WORLD, { input_tokens: 1, output_tokens: 1 }))
          .fetchImpl,
      ),
      cap: withReceipt,
      grammar: GRAMMAR,
    });

    const withoutReceipt = openCap();
    // Táž odpověď, jen bez účtenky. Bez pojistky by tohle bylo volání zdarma.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(withoutReceipt, () => messagesResponse(MINIMAL_WORLD, null)).fetchImpl,
      ),
      cap: withoutReceipt,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(withoutReceipt.snapshot().spentUsd).toBeGreaterThan(0);
    // Tohle je celé to tvrzení: neznámá spotřeba se neúčtuje nulou a ani
    // levněji než známá. Účtuje se rezervací, tedy horním odhadem.
    expect(withoutReceipt.snapshot().spentUsd).toBeGreaterThan(withReceipt.snapshot().spentUsd);
    expect(withoutReceipt.snapshot().spentUsd).toBe(
      result.outcome === 'GENERATED' ? result.costUsd : Number.NaN,
    );
  });

  it('účtenka na dvojitou nulu je nečitelná účtenka, ne volání zdarma', async () => {
    const config = liveConfig();

    const withReceipt = openCap();
    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(withReceipt, () => messagesResponse(MINIMAL_WORLD, { input_tokens: 1, output_tokens: 1 }))
          .fetchImpl,
      ),
      cap: withReceipt,
      grammar: GRAMMAR,
    });

    const zeroed = openCap();
    // Odpověď nese text, ale hlásí nula spálených tokenů. Takový běh
    // neexistuje — je to špatně vyplněná účtenka, ne volání zdarma.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(zeroed, () => messagesResponse(MINIMAL_WORLD, { input_tokens: 0, output_tokens: 0 }))
          .fetchImpl,
      ),
      cap: zeroed,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    // Tohle je celé to tvrzení: doslovná nula by tady nechala strop stát.
    expect(zeroed.snapshot().spentUsd).toBeGreaterThan(0);
    expect(zeroed.snapshot().spentUsd).toBeGreaterThan(withReceipt.snapshot().spentUsd);
    // Účtuje se rezervací, tedy stejně jako odpověď úplně bez pole `usage`.
    expect(zeroed.snapshot().spentUsd).toBe(result.outcome === 'GENERATED' ? result.costUsd : Number.NaN);
    // Hlášená spotřeba zůstává poctivá nula — mění se účet, ne to, co se říká.
    if (result.outcome === 'GENERATED') expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('odmítnutá odpověď se neúčtuje rezervací jen proto, že nese nuly', async () => {
    const config = liveConfig();
    const cap = openCap();

    // Pravidlo dvojité nuly platí jen pro **úspěšnou** odpověď. Kdyby platilo
    // i tady, dala by se rezervace vyčerpat odpověďmi, které nic nestály:
    // naměřeno 0,2195 USD na jednu, tedy strop 5 USD asi za 23 odpovědí.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(cap, () => contentlessResponse({ input_tokens: 0, output_tokens: 0 })).fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.outcome === 'FAILED' && result.reason).toBe('MALFORMED_RESPONSE');
    expect(cap.snapshot().spentUsd).toBe(0);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('vadný JSON v textovém bloku je pořád odpověď, která text nesla', async () => {
    const config = liveConfig();
    const cap = openCap();

    // Zrcadlová díra k té výš: text tady **je**, takže vynulovaná účtenka je
    // i tady nečitelná. Kdyby se pravidlo použilo jen na úspěšné cestě, hnul by
    // se jen počet volání a dolarový strop by ukazoval nulu.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(cap, () => textBlockResponse('tohle není JSON', { input_tokens: 0, output_tokens: 0 }))
          .fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.outcome === 'FAILED' && result.reason).toBe('MALFORMED_RESPONSE');
    expect(cap.snapshot().spentUsd).toBeGreaterThan(0);
  });

  it('nula jen na jedné straně účtenky je pořád čitelná účtenka', async () => {
    const config = liveConfig();
    const cap = openCap();

    // Nula na vstupu je legitimní (celý prompt z cache), a výstup se spálil.
    // Kdyby se odmítala i tahle účtenka, účtovala by se rezervace a operátor
    // by za levné volání platil horní odhad — vada opačným směrem.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        config,
        recordingFetch(cap, () => messagesResponse(MINIMAL_WORLD, { input_tokens: 0, output_tokens: 900 }))
          .fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(result.outcome === 'GENERATED' && result.usage).toEqual({ inputTokens: 0, outputTokens: 900 });
    // 900 tokenů po 25 USD/Mtok = 0,0225 USD. Účtuje se skutečnost, ne rezervace.
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.0225, 10);
  });

  it('chybějící cena výstupu cloudovou větev vůbec nepustí', () => {
    const { WORLDSMITH_USD_PER_MTOK_OUT: _omitted, ...withoutPrice } = LIVE_ENV;
    expect(upstreamConfigFromEnv(withoutPrice)).toBeNull();
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '0' })).toBeNull();
    // Desetinná čárka je nečíslo a chová se stejně jako nula.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '0,003' })).toBeNull();
  });

  it('nevyplněná cena vstupu se dopočítá z ceny výstupu, ne z nuly', () => {
    const { WORLDSMITH_USD_PER_MTOK_IN: _omitted, ...withoutInput } = LIVE_ENV;
    expect(upstreamConfigFromEnv(withoutInput)?.pricing.usdPerMTokIn).toBe(25);
    // Výslovná nula je rozhodnutí operátora a respektuje se.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_IN: '0' })?.pricing.usdPerMTokIn).toBe(0);
  });
});

describe('4. při vypnutém přepínači neodejde žádný požadavek', () => {
  it('nenakonfigurovaná větev nesáhne na transport', async () => {
    const { calls, fetchImpl } = recordingFetch(null, () => {
      throw new Error('sem se nesmí dostat');
    });

    const outcome = await upstreamBranch(null, fetchImpl).generate({
      prompt: PROMPT,
      request: { model: 'm', system: 's', user: 'u' },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('BRANCH_UNCONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('vyčerpaný strop odmítne dřív, než se transport dotkne', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 0, callCap: 200 });
    const { calls, fetchImpl } = recordingFetch(cap, () => messagesResponse(MINIMAL_WORLD, null));

    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(liveConfig(), fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('REFUSED');
    expect(calls).toHaveLength(0);
  });

  /**
   * **`enabled: false` NENÍ nouzový vypínač provozu — je to vypnutí stropu.**
   *
   * Zjištěno při psaní téhle sady 31. 8. 2026: napsala se aserce, že vypnutý
   * přepínač odmítne, a spadla — požadavek prošel. `reserve()` se na `enabled`
   * ptá jen u dvou refusalů, takže `false` znamená „neomezené utrácení", ne
   * „stůj". Je to zdokumentované chování, ne vada, ale čte se přesně naopak, než
   * jak zní slovo „vypínač" v `.env.example`. Pinuje se to tady, aby se to
   * příště nespletlo znovu — a aby změna toho významu shodila test, ne demo.
   */
  it('`enabled: false` provoz nezastaví, jen přestane odmítat', async () => {
    const cap = new SpendCap({ enabled: false, capUsd: 0, callCap: 0 });
    const { calls, fetchImpl } = recordingFetch(cap, () => messagesResponse(MINIMAL_WORLD, null));

    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(liveConfig(), fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    // Strop nula, počet volání nula — a přesto se zavolalo.
    expect(result.outcome).toBe('GENERATED');
    expect(calls).toHaveLength(1);
    // Účtování ale běží dál, takže po zapnutí se strop vrátí k platnému číslu.
    expect(cap.snapshot().spentUsd).toBeGreaterThan(0);
  });
});

describe('5. secret se nedostane do klientského bundlu', () => {
  /** Jména, u kterých Next vpisuje HODNOTU do klientského bundlu. */
  it('žádná proměnná modelu nemá předponu NEXT_PUBLIC_', () => {
    // `__tests__` se vynechává ze stejného důvodu jako u aserce pod tímhle:
    // do klientského bundlu se nepřekládá a jméno v próze je fixture, ne čtení.
    // Bez filtru se aserce trefí do vlastního doc komentáře nahoře v souboru.
    // Že se to poznalo až po commitu, byla druhá vada téhož nástroje: hledání
    // tehdy nesledované soubory vůbec nevidělo, takže sada byla zelená přesně
    // do chvíle, kdy se sama stala sledovanou. Dnes vidí obojí — ale filtr
    // `__tests__` musí zůstat, jinak spadne znovu na vlastní próze.
    //
    // Slovní alternativa je táž jako u aserce o `build-env.allow` níž a musí
    // taková zůstat: bez `TOKEN` projde `NEXT_PUBLIC_ANTHROPIC_TOKEN`, což je
    // hodnota vepsaná do klientského bundlu úplně stejně jako klíč.
    const hits = grepRepo(/NEXT_PUBLIC_[A-Z0-9_]*(WORLDSMITH|MODEL|KEY|SECRET|TOKEN|PASSWORD)/).filter(
      (path) => !path.includes('__tests__'),
    );
    expect(hits).toEqual([]);
  });

  it('klíč se čte jedině na serverové cestě', () => {
    // Testy se vynechávají schválně: jméno proměnné v testu je fixture, ne
    // čtení. Do bundlu se `__tests__` nepřekládá.
    const readers = grepRepo(/WORLDSMITH_MODEL_KEY/).filter(
      (path) => path.startsWith('src/') && !path.includes('__tests__'),
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const path of readers) expect(path.startsWith('src/server/'), path).toBe(true);
  });

  it('kořenový next.config.mjs vpisuje do bundlu jen jednu povolenou proměnnou', async () => {
    // **Prefix `NEXT_PUBLIC_` tady není potřeba, a to je celý ten nález.**
    // Blok `env:` vpisuje hodnotu do každého klientského chunku pod jménem, jaké
    // se mu napíše, takže `env: { WORLDSMITH_MODEL_KEY: … }` je únik, který
    // aserce nad `NEXT_PUBLIC_` nevidí — a ta o čtenářích klíče ho zahodí
    // filtrem na `src/`. Nález nezávislé revize 1. 9. 2026.
    //
    // **Seznam povolených nad rozparsovaným objektem, ne zakázaná slova nad
    // textem souboru** — druhý nález téže revize, a ten první pokus byl obojí
    // špatně: `env: { ...process.env }` i přejmenování (`WS_UPSTREAM:
    // process.env.WORLDSMITH_MODEL_ENDPOINT`) mu prošly, zatímco *varovný
    // komentář* o tom, že se sem klíč psát nemá, ho položil. Seznam povolených
    // se přejmenováním obejít nedá a komentáře nečte.
    //
    // Specifikátor se skládá za běhu schválně: `tsc` pro `.mjs` v kořeni typy
    // nemá, a tohle je jediný tvar, u kterého si o ně neřekne.
    const configUrl = new URL('../../../next.config.mjs', import.meta.url).href;
    const loaded = (await import(configUrl)) as { readonly default: { readonly env?: Record<string, string> } };

    expect(Object.keys(loaded.default.env ?? {})).toEqual(['WORLDSMITH_BUILD_TREE']);
  });

  it('hermetický build klíč vůbec nevidí — není na allowlistu', () => {
    const allow = readFileSync(`${repoRoot}ops/build-env.allow`, 'utf8');
    const host = allow.slice(allow.indexOf('[host]'), allow.indexOf('[platform]'));
    const names = host
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('['));

    expect(names).not.toContain('WORLDSMITH_MODEL_KEY');
    // Ani nic jiného, co nese tajemství. Seznam roste, tahle aserce ne.
    for (const name of names) expect(/KEY|SECRET|TOKEN|PASSWORD/.test(name), name).toBe(false);
  });
});

/**
 * Lexikální hledání nad zdrojáky — **sledovanými i nesledovanými**. `git grep`
 * schválně, ne vlastní procházení stromu: `node_modules` a `.next` tím vypadnou
 * samy a nemůže se stát, že by aserce byla zelená jen proto, že se dívala jinam.
 *
 * Dvě věci tady drží celou hodnotu hledání a obě jsou naměřené vady, ne obezřetnost:
 *
 * - **`--untracked`.** Bez něj se nesledované soubory nekontrolují vůbec, a
 *   nesledované zdrojáky v tomhle stromě právě teď jsou. Ignorované soubory tím
 *   nepřibývají — `.gitignore` platí dál, takže `node_modules` a `.next` zůstávají venku.
 * - **`next.config.mjs`.** Leží mimo `src ops scripts` a jeho blok `env:` vpisuje
 *   hodnoty do klientského bundlu pro **všechen** kód. Je to tedy jediné místo
 *   v repozitáři, kde se dá secret vystavit prohlížeči jedním řádkem mimo `src`.
 */
function grepRepo(pattern: RegExp): string[] {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync(
      'git',
      ['grep', '--untracked', '-lE', pattern.source, '--', 'src', 'ops', 'scripts', 'next.config.mjs'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (thrown) {
    // `git grep` vrací 1, když nic nenajde. To je prázdný výsledek, ne chyba.
    if ((thrown as { status?: number }).status === 1) return [];
    throw thrown;
  }
}
