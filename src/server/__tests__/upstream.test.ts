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

import { describe, expect, it, vi } from 'vitest';

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { frozenGrammar } from '../../model/client';
import type { Grammar } from '../../model/prompt';
import { runPipeline } from '../pipeline';
import { SpendCap } from '../spend-cap';
import { GENRE_ANSWER_SCHEMA } from '../../play/director/answer-schema';
import { OPENAI_ENUM_LIMIT, chatConfigFromEnv, killCodexTree, parseAnswerText, upstreamBranch, upstreamConfigFromEnv, type UpstreamConfig } from '../upstream';

// `execFile` se obaluje, ne nahrazuje: `taskkill` doopravdy běží a test sirotka
// jen čte, s čím se volal (`ship-pidreuse`).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

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

/**
 * Odpověď 200, která projde jako JSON, ale nenese žádný textový blok.
 *
 * `usage` je volitelná schválně: jediné, co u tohohle návratu jde poměřit, je
 * **otrávená účtenka proti žádné účtence**, a bez druhé půlky to srovnání nemá
 * s čím.
 */
function contentlessResponse(usage?: { input_tokens: number; output_tokens: number }) {
  return new Response(JSON.stringify({ content: [], ...usage ? { usage } : {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const MINIMAL_WORLD = { irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: null, look: {} };

/**
 * Svět, jehož JSON má **přesně** zadanou délku ve znacích.
 *
 * Spodní hranice účtu se odvozuje z délky textu, který odpověď nese, takže
 * test, který na ni sahá, musí tu délku držet v ruce. `MINIMAL_WORLD` má 72
 * znaků a hranici 6 tokenů — to je pro aritmetiku příliš malé číslo na to, aby
 * se dalo odlišit od šumu. Tři tisíce znaků je řádově skutečná emise.
 */
function worldOfTextLength(chars: number) {
  const base = { ...MINIMAL_WORLD, look: { note: '' } };
  return { ...base, look: { note: 'x'.repeat(chars - JSON.stringify(base).length) } };
}

/** Délka textu a hranice, kterou z ní `FLOOR_CHARS_PER_TOKEN = 12` udělá. */
const FLOORED_TEXT_CHARS = 3000;
const FLOOR_TOKENS = 250;
/** Cena výstupního tokenu z `LIVE_ENV`. Ne konstanta v kódu — konfigurace. */
const USD_PER_TOKEN_OUT = 25 / 1_000_000;

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

  it('otrávená účtenka bez textového bloku nesmí být levnější než žádná účtenka', async () => {
    // **Rozhodnutý spor, ne aktuální stav** — rozpad je v docstringu nad
    // `readableUsage()` v `../upstream.ts`. Do 3. 9. 2026 tenhle test tvrdil
    // opak: že dvojitá nula na návratu bez textu strop nechá stát. Naměřeno,
    // že to je asi **8600× levnější než neposlat účtenku vůbec** — a levnější
    // cesta k témuž vyčerpání stropu (prostě `usage` vynechat) zůstává
    // otevřená tak jako tak, takže ta sleva nekupovala nic.
    //
    // Soudí se to **srovnáním obou odpovědí v jednom testu**, ne připíchnutým
    // dolarem: absolutní číslo se hne s každou změnou ceníku, kdežto tvrzení
    // „otrávit účtenku se nesmí vyplatit" má platit vždycky.
    const spend = async (usage?: { input_tokens: number; output_tokens: number }) => {
      const cap = openCap();
      const { calls, fetchImpl } = recordingFetch(cap, () => contentlessResponse(usage));
      const result = await runPipeline(PROMPT, { branch: upstreamBranch(liveConfig(), fetchImpl), cap, grammar: GRAMMAR });
      expect(result.outcome).toBe('FAILED');
      expect(result.outcome === 'FAILED' && result.reason).toBe('MALFORMED_RESPONSE');
      return { spentUsd: cap.snapshot().spentUsd, reservedUsd: calls[0]!.reservedAtCallUsd };
    };

    // **Kotva je rezervace držená při tom volání, ne připíchnutý dolar.**
    // Bez ní by tvrzení „všechny stojí totéž" prošlo i pro samé nuly, tedy
    // přesně pro vadu, kterou zavírá; a dolar z ceníku by se hnul při každé
    // změně konfigurace. Třetí nález nezávislé revize 3. 9. 2026.
    const silent = await spend();
    expect(silent.spentUsd).toBeCloseTo(silent.reservedUsd, 10);
    expect(silent.spentUsd).toBeGreaterThan(0);

    // ⚠ **Sousedi dvojité nuly patří do téhož tvrzení, ne do vlastního testu** —
    // druhý nález téže revize. Rovnost na (0,0) je bod a podhlásit o jediný
    // token ho obcházelo: `{0,1}` stálo 0,000025 USD a `{1,0}` 0,000005 USD
    // proti rezervaci 0,2585 USD. Test, který by zkoušel jen (0,0), by tu vadu
    // certifikoval jako zavřenou. **Záporná složka je v seznamu ze stejného
    // důvodu** — dřív ji na tomhle návratu hlídal vlastní test, ale od chvíle,
    // kdy se tu účtenka zahazuje celá, by ten test procházel triviálně.
    for (const usage of [
      { input_tokens: 0, output_tokens: 0 },
      { input_tokens: 0, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 0 },
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: -1249, output_tokens: FLOOR_TOKENS },
    ]) {
      const poisoned = await spend(usage);
      expect(poisoned.spentUsd).toBeCloseTo(poisoned.reservedUsd, 10);
    }
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

  it('účtenka pod tím, co text odpovědi unese, se zvedne na hranici', async () => {
    const world = worldOfTextLength(FLOORED_TEXT_CHARS);
    // Kdyby pomocník ujel, přestala by aritmetika níž měřit hranici a začala
    // by měřit délku fixtury. Ať se to ozve tady, ne v číslech.
    expect(JSON.stringify(world)).toHaveLength(FLOORED_TEXT_CHARS);

    const cap = openCap();
    // Rovnost na (0, 0) je bod, ne mez: podhlásit o jediný token stačilo, aby
    // se celé pravidlo obešlo. {0, 1} stálo 0,000025 USD, tedy 7300× méně než
    // sousední {0, 0}, které padá na rezervaci.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        liveConfig(),
        recordingFetch(cap, () => messagesResponse(world, { input_tokens: 0, output_tokens: 1 })).fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(cap.snapshot().spentUsd).toBeCloseTo(FLOOR_TOKENS * USD_PER_TOKEN_OUT, 10);
    // A pro pořádek řádově: hranice je 250× dražší než ta podhlášená jednička.
    expect(cap.snapshot().spentUsd).toBeGreaterThan(200 * USD_PER_TOKEN_OUT);
  });

  it('nula na výstupu se zvedne i tehdy, když se vstup účtuje', async () => {
    const cap = openCap();
    // Dřív se {n, 0} pouštělo beze změny s odůvodněním „vstup se pořád účtuje,
    // takže volání zadarmo nevznikne". Jenže vstup se legitimně cachuje a
    // výstupní tokeny ne — text bez nich neexistuje.
    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        liveConfig(),
        recordingFetch(cap, () =>
          messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), { input_tokens: 100, output_tokens: 0 }),
        ).fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    // 100 vstupních po 5 USD/Mtok plus hranice 250 výstupních po 25 USD/Mtok.
    expect(cap.snapshot().spentUsd).toBeCloseTo(100 * (5 / 1_000_000) + FLOOR_TOKENS * USD_PER_TOKEN_OUT, 10);
  });

  it('poctivá účtenka nad hranicí se hranicí nepřepisuje', async () => {
    const cap = openCap();
    // 800 výstupních tokenů na 3000 znaků je běžný poměr ~3,75 znaku na token.
    // Hranice (250) je pod ním schválně: kdyby ho přerostla, přeúčtovalo by se
    // **každé** poctivé volání, a hlášená cena by přestala být tou strženou.
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        liveConfig(),
        recordingFetch(cap, () =>
          messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), { input_tokens: 0, output_tokens: 800 }),
        ).fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome === 'GENERATED' && result.usage).toEqual({ inputTokens: 0, outputTokens: 800 });
    expect(cap.snapshot().spentUsd).toBeCloseTo(800 * USD_PER_TOKEN_OUT, 10);
  });

  it('hranice je v tokenech, takže její cena roste s ceníkem', async () => {
    // Tohle je celá ta AC: hranice není částka opsaná do kódu. Kdyby byla,
    // zdvojnásobení ceny výstupu by s účtem nehnulo.
    const spentAt = async (usdPerMTokOut: string) => {
      const cap = openCap();
      await runPipeline(PROMPT, {
        branch: upstreamBranch(
          liveConfig({ WORLDSMITH_USD_PER_MTOK_OUT: usdPerMTokOut }),
          recordingFetch(cap, () =>
            messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), { input_tokens: 0, output_tokens: 1 }),
          ).fetchImpl,
        ),
        cap,
        grammar: GRAMMAR,
      });
      return cap.snapshot().spentUsd;
    };

    // Samotný poměr nestačí: `costUsd` je v ceně lineární pro **jakýkoli**
    // počet tokenů, takže dvojnásobek vyjde i bez hranice, z holé jedničky.
    // Absolutní hodnota u jedné ceny je to, co umírá oběma směry.
    expect(await spentAt('25')).toBeCloseTo(FLOOR_TOKENS * (25 / 1_000_000), 10);
    expect(await spentAt('50')).toBeCloseTo(2 * (await spentAt('25')), 10);
  });

  it('hranice nikdy nepřeroste rezervaci, kterou nahrazuje', async () => {
    const cap = openCap();
    // **Délku textu volí poskytovatel, ne my.** Odpověď delší, než kolik
    // `maxOutputTokens` unese, je porušení protokolu — a přesně takové porušení
    // tenhle soubor jinde odmítá předpokládat, že nenastane. Bez stropu na
    // hranici vyjde ze 200 kB textu 16 667 tokenů, tedy 0,42 USD proti
    // rezervaci 0,22 USD: jedna odpověď by strhla víc, než se na ni drželo,
    // a dost velká odpověď by vyčerpala celý dolarový strop naráz.
    const { calls, fetchImpl } = recordingFetch(cap, () =>
      messagesResponse(worldOfTextLength(200_000), { input_tokens: 0, output_tokens: 1 }),
    );
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(liveConfig(), fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(cap.snapshot().spentUsd).toBeLessThanOrEqual(calls[0]!.reservedAtCallUsd);
    // Strop hranice je výstupní půlka rezervace: 8000 tokenů po 25 USD/Mtok.
    expect(cap.snapshot().spentUsd).toBeCloseTo(8000 * USD_PER_TOKEN_OUT, 10);
  });

  it('záporný vstup na účtence hranice nezlevní — pořád platí rezervaci', async () => {
    const cap = openCap();
    // Záporná složka účtenky se dřív propočítala do záporné ceny, tu `release()`
    // odmítl a strhl celou rezervaci. Zvednutím výstupu by se součet vrátil nad
    // nulu, `release()` by ho přijal a otrávená účtenka by tím **zlevnila**:
    // naměřeno 0,2195 → 0,0062 USD, tedy 35× méně. Hranice se proto nepoužije,
    // dokud je druhá složka nesmyslná.
    const { calls, fetchImpl } = recordingFetch(cap, () =>
      messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), { input_tokens: -1, output_tokens: 0 }),
    );
    await runPipeline(PROMPT, { branch: upstreamBranch(liveConfig(), fetchImpl), cap, grammar: GRAMMAR });

    expect(cap.snapshot().spentUsd).toBeCloseTo(calls[0]!.reservedAtCallUsd, 10);
    expect(cap.snapshot().spentUsd).toBeGreaterThan(FLOOR_TOKENS * USD_PER_TOKEN_OUT);
  });

  it('účtenka, jejíž složky se vyruší, se nesečte na drobné — platí rezervaci', async () => {
    // Rovnost na (0, 0) i hranice zdola sahají každá jen na **jedno** ze dvou
    // polí, která `costUsd()` sčítá, takže ani jedna nevidí účtenku, jejíž
    // složky se vyruší. `{-1249, 250}` má výstup přesně na hranici, takže
    // hranice vůbec nespustí, a záporný vstup pak součet stlačí těsně nad nulu,
    // kde ho `release()` přijme jako poctivou cenu. Naměřeno nezávislou revizí
    // 1. 9. 2026: 0,000005 USD proti rezervaci 0,2195 USD, tedy 44 000× méně.
    //
    // `{-1000, 3}` je vedle toho **regrese, která se nesmí vrátit**: výstup pod
    // hranicí, takže by ho hranice zvedla na 250 a součet by se z −0,0049 USD
    // vrátil nad nulu, kde už ho `release()` neodmítne (0,0013 USD, 176×).
    const receipts = [
      { input_tokens: -1249, output_tokens: FLOOR_TOKENS },
      { input_tokens: -1000, output_tokens: 3 },
    ];

    for (const usage of receipts) {
      const cap = openCap();
      const { calls, fetchImpl } = recordingFetch(cap, () =>
        messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), usage),
      );
      const result = await runPipeline(PROMPT, {
        branch: upstreamBranch(liveConfig(), fetchImpl),
        cap,
        grammar: GRAMMAR,
      });

      expect(result.outcome).toBe('GENERATED');
      expect(cap.snapshot().spentUsd).toBeCloseTo(calls[0]!.reservedAtCallUsd, 10);

      // A řádově, ať je vidět, o kolik jde. Jen u té vyrušené — u druhé je
      // součet záporný, takže se dá říct jen „menší než nula", což je zpátky
      // podmínka téhle větve a nic to netvrdí.
      const summedUsd = (usage.input_tokens * 5 + usage.output_tokens * 25) / 1_000_000;
      if (summedUsd > 0) expect(cap.snapshot().spentUsd).toBeGreaterThan(summedUsd * 1000);
    }
  });

  // **Test „účtenka se zápornou složkou padne i tam, kde odpověď žádný text
  // nenese" tady stál do 3. 9. 2026 a je schválně smazaný, ne přehlédnutý.**
  // Od chvíle, kdy návrat bez textového bloku zahazuje účtenku celou, nemůže
  // selhat z důvodu, kvůli kterému vznikl: prošel by i pro pravidlo, které se
  // na zápornou složku vůbec nepodívá. Jeho případ se přestěhoval do seznamu
  // v testu „otrávená účtenka bez textového bloku…" výš, kde je jedním z pěti
  // a soudí se proti držené rezervaci.

  it('hranice platí i na vadném JSON, ne jen na úspěchu', async () => {
    const cap = openCap();
    // Zrcadlová díra, kterou tenhle soubor jednou zavíral už u pravidla dvojité
    // nuly: druhý návrat nese text taky, takže se na něj hranice musí vztáhnout.
    // Bez vlastní aserce ji tam mutant sundá a celá sada zůstane zelená —
    // jediné dva testy, které sem dosud došly, měly buď `{0, 0}` (spadne na
    // pravidlo dvojité nuly dřív), nebo text tak krátký, že hranice nespustí.
    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        liveConfig(),
        recordingFetch(cap, () =>
          textBlockResponse('x'.repeat(FLOORED_TEXT_CHARS), { input_tokens: 0, output_tokens: 1 }),
        ).fetchImpl,
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(cap.snapshot().spentUsd).toBeCloseTo(FLOOR_TOKENS * USD_PER_TOKEN_OUT, 10);
  });

  it('nesmyslná účtenka se hranicí nezlevňuje — pořád platí rezervaci', async () => {
    const cap = openCap();
    // Záporný, `NaN` i nekonečný výstup dnes stojí **celou rezervaci**, protože
    // je `release()` odmítne. Hranice je proti tomu o dva řády levnější, takže
    // kdyby účtenku přepsala, otrávená spotřeba by se tím stala výhodnou.
    const { calls, fetchImpl } = recordingFetch(cap, () =>
      messagesResponse(worldOfTextLength(FLOORED_TEXT_CHARS), { input_tokens: 0, output_tokens: -5 }),
    );
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(liveConfig(), fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(cap.snapshot().spentUsd).toBeCloseTo(calls[0]!.reservedAtCallUsd, 10);
    expect(cap.snapshot().spentUsd).toBeGreaterThan(FLOOR_TOKENS * USD_PER_TOKEN_OUT);
  });

  it('chybějící cena výstupu cloudovou větev vůbec nepustí', () => {
    const { WORLDSMITH_USD_PER_MTOK_OUT: _omitted, ...withoutPrice } = LIVE_ENV;
    expect(upstreamConfigFromEnv(withoutPrice)).toBeNull();
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '0' })).toBeNull();
    // Desetinná čárka je nečíslo a chová se stejně jako nula.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '0,003' })).toBeNull();
  });

/* ------------------------------------------------------------------ *
 * Profil poskytovatele: metrovaná cesta proti předplatnému.
 * ------------------------------------------------------------------ */

/**
 * **Předplatné neúčtuje po tokenech, takže dolarový strop tam nedrží nic.**
 *
 * Produkt tenhle pojem do 9. 9. 2026 neměl: `upstreamConfigFromEnv()` žádala
 * kladnou cenu výstupu vždycky, takže se přes předplatné cena **dosazovala jen
 * proto, aby konfigurace prošla** — a `WORLDSMITH_SPEND_CAP_USD` pak vypadal
 * jako mez, kterou nic nedrží. Naostro to tak proběhlo: běh z 6. 9. 2026 jel
 * na ceníku `1/1` za milion tokenů.
 *
 * Mez, která u předplatného doopravdy kousne, je počet volání, takže se stává
 * povinnou přesně tam. `evals/harness/preflight.ts` to u profilu
 * `subscription` dělá od P11; opisuje se ten rozdíl, ne kód.
 */
describe('profil poskytovatele rozhoduje, která mez je povinná', () => {
  const SUBSCRIPTION = { ...LIVE_ENV, WORLDSMITH_MODEL_PROFILE: 'subscription' };

  it('nenastavený profil je `api` a nic dalšího nežádá', () => {
    // Dnešní chování se nesmí pohnout: nasazení, které o profilu neví, jede dál.
    const config = upstreamConfigFromEnv(LIVE_ENV);
    expect(config?.profile).toBe('api');
    expect(config?.callCap).toBeNull();
    // Prázdná hodnota je totéž co chybějící — `.env.example` má proměnné prázdné.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_MODEL_PROFILE: '  ' })?.profile).toBe('api');
  });

  it('u předplatného je strop na počet volání povinný, stejně jako dnes cena', () => {
    // Failure path, a je to celý smysl úlohy: bez tohohle je jediná skutečná
    // mez předplatného nenastavená a nikdo se to nedozví.
    expect(upstreamConfigFromEnv(SUBSCRIPTION)).toBeNull();
    expect(upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '' })).toBeNull();
    expect(upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '0' })).toBeNull();
    expect(upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '-5' })).toBeNull();
    // Půlka volání neexistuje; desetinná čárka je nečíslo, stejně jako u ceny.
    expect(upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '2.5' })).toBeNull();
    expect(upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '2,5' })).toBeNull();
  });

  it('s vyplněným stropem projde a nese obojí', () => {
    const config = upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '200' });
    expect(config?.profile).toBe('subscription');
    expect(config?.callCap).toBe(200);
  });

  it('u `api` se strop na počet volání nevyžaduje', () => {
    // Tam meze drží dolary a počet je druhá pojistka s vlastní výchozí hodnotou
    // ve `spend-cap.ts`. Vyžadovat ho tady by odpojilo běžící nasazení.
    const config = upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_MODEL_PROFILE: 'api' });
    expect(config).not.toBeNull();
    expect(config?.callCap).toBeNull();
  });

  it('neznámý profil se odmítne, místo aby tiše spadl na jeden z těch dvou', () => {
    // Obě tichá spadnutí jsou drahá a každé jinak: překlep spadlý na `api` by
    // u předplatného vyžadoval cenu, která neexistuje, a překlep spadlý na
    // `subscription` by u placeného klíče odpojil dolarový strop.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_MODEL_PROFILE: 'subscribtion' })).toBeNull();
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_MODEL_PROFILE: 'free' })).toBeNull();
  });

  /**
   * ⚠ **Cena zůstává povinná i u předplatného, a je to měřením vynucené —
   * nestavěla se tedy druhá půlka toho, co úloha navrhovala.**
   *
   * Zadání žádalo, aby se u `subscription` „dolarová mez do rozhodování
   * nezapočítala". Doslova provedené to znamená nulový nejhorší případ, a ten
   * **vypne i strop na počet volání**: `spend-cap.ts` má jediné rozhodnutí
   * `costsMoney = worstCaseUsd > 0`, na kterém visí započítání volání i obě
   * odmítnutí (`CALL_CAP_EXHAUSTED` i `CAP_EXHAUSTED`). Pinuje to
   * `spend-cap.test.ts` větou „volání zdarma se nezapočítala".
   *
   * Odstranit cenu by tedy odstranilo tu jedinou mez, kterou tahle úloha dělá
   * povinnou. Cena se proto u předplatného pořád vyžaduje — je to nosič
   * počítadla, ne účtenka — a report u ní od `T14-subprofile` říká `derived`,
   * takže ji nikdo nepřečte jako stržené dolary.
   */
  it('cena je u předplatného pořád povinná, protože nese počítadlo volání', () => {
    const { WORLDSMITH_USD_PER_MTOK_OUT: _omitted, ...priceless } = SUBSCRIPTION;
    expect(upstreamConfigFromEnv({ ...priceless, WORLDSMITH_CALL_CAP: '200' })).toBeNull();

    // A s cenou je nejhorší případ kladný, tedy volání se počítá.
    const config = upstreamConfigFromEnv({ ...SUBSCRIPTION, WORLDSMITH_CALL_CAP: '200' });
    expect(config).not.toBeNull();
    const worstCase = upstreamBranch(config).worstCaseUsd({
      prompt: PROMPT,
      request: { model: 'test', system: 'system', user: PROMPT },
    });
    expect(worstCase).toBeGreaterThan(0);
  });
});

  it('nevyplněná cena vstupu se dopočítá z ceny výstupu, ne z nuly', () => {
    const { WORLDSMITH_USD_PER_MTOK_IN: _omitted, ...withoutInput } = LIVE_ENV;
    expect(upstreamConfigFromEnv(withoutInput)?.pricing.usdPerMTokIn).toBe(25);
    // Výslovná nula je rozhodnutí operátora a respektuje se.
    expect(upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_IN: '0' })?.pricing.usdPerMTokIn).toBe(0);
  });

  /**
   * **Podtečení plovoucí čárkou — `> 0` na ceně samotné nestačí** (P15 T29).
   *
   * `5e-324` je konečné i kladné, takže starou podmínkou prošlo, jenže
   * `(8000 × 5e-324) / 1e6` je **přesně nula**: nejhorší případ vyjde nula,
   * `reserve(0)` projde i při stropu nula a volání se ani nezapočítá, protože
   * počítadlo roste jen nad kladnou rezervací. Strop je pak dekorace úplně
   * stejně jako při chybějící ceně — a to je nález, kvůli kterému ten řádek
   * o pár set znaků výš vůbec vznikl.
   */
  it('cena tak malá, že nejhorší případ podteče na nulu, větev nepustí', () => {
    const underflowing = { ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '5e-324' };
    // Nejdřív ať je vidět, že stará podmínka by ji propustila.
    expect(Number.isFinite(5e-324) && 5e-324 > 0, 'fixtura přestala být podtékající').toBe(true);
    expect((8000 * 5e-324) / 1_000_000, 'fixtura přestala podtékat na nulu').toBe(0);

    expect(upstreamConfigFromEnv(underflowing)).toBeNull();
  });

  it('cena těsně nad podtečením projde — mez není na ceně, ale na součinu', () => {
    // `1e-300` je pořád nesmyslně malé číslo, ale `(8000 × 1e-300) / 1e6`
    // kladné vyjde, takže strop nad ním doopravdy drží a odmítat se nemá.
    // Bez tohohle testu by šlo tu mez utáhnout na libovolnou hodnotu a nikdo
    // by se nedozvěděl, že se vypnula i konfigurace, která funguje.
    const tiny = upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: '1e-300' });
    expect(tiny).not.toBeNull();
    expect((tiny!.maxOutputTokens * tiny!.pricing.usdPerMTokOut) / 1_000_000).toBeGreaterThan(0);
  });

  it('podteče i tehdy, když ji na nulu srazí až malý strop výstupu', () => {
    // Součin, ne cena: tatáž cena projde s výchozím stropem tokenů a neprojde
    // s jedním tokenem. Kdyby se soudila jen cena, tenhle případ propadne.
    const price = '1e-320';
    expect(
      upstreamConfigFromEnv({ ...LIVE_ENV, WORLDSMITH_USD_PER_MTOK_OUT: price }),
      'fixtura neprochází ani s výchozím stropem tokenů',
    ).not.toBeNull();
    expect(
      upstreamConfigFromEnv({
        ...LIVE_ENV,
        WORLDSMITH_USD_PER_MTOK_OUT: price,
        WORLDSMITH_MAX_OUTPUT_TOKENS: '1',
      }),
    ).toBeNull();
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

/**
 * Jména ze sekce `[host]` souboru `ops/build-env.allow`.
 *
 * Sekce se hledá **řádkem, který je přesně `[host]`**, ne prvním výskytem toho
 * řetězce v souboru: hlavička `build-env.allow` obě jména sekcí vysvětluje
 * v komentáři, takže `indexOf` trefí komentář a vykrojí prázdno. Aserce nad
 * prázdným seznamem je zelená vždycky — přesně to se tady dělo do 3. 9. 2026.
 */
function hostAllowlist(): string[] {
  const lines = readFileSync(`${repoRoot}ops/build-env.allow`, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const from = lines.indexOf('[host]');
  const to = lines.indexOf('[platform]');
  if (from === -1 || to === -1 || to < from)
    throw new Error('build-env.allow has no [host] and [platform] section lines');
  return lines.slice(from + 1, to).filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('5. secret se nedostane do klientského bundlu', () => {
  it('každé jméno s předponou NEXT_PUBLIC_ je na uzavřeném seznamu povolených', () => {
    // **Seznam povolených, ne zakázaných slov — a to je celý ten nález.**
    // Předchozí znění hledalo `NEXT_PUBLIC_[A-Z0-9_]*(WORLDSMITH|MODEL|KEY|
    // SECRET|TOKEN|PASSWORD)`, tedy jméno proti seznamu zakázaných slov. Takové
    // hledání se obejde pojmenováním a nezávislá revize 1. 9. 2026 naměřila tři
    // jména, která jím projdou: `NEXT_PUBLIC_ANTHROPIC_CREDENTIAL`,
    // `NEXT_PUBLIC_UPSTREAM_ENDPOINT` a `NEXT_PUBLIC_API_URL`. Každé z nich
    // vpisuje hodnotu do klientského bundlu úplně stejně jako klíč.
    //
    // Seznam povolených se přejmenováním obejít nedá a veřejných proměnných má
    // tenhle projekt hrstku. Táž doktrína jako u `next.config.mjs` výš.
    const found = grepNames(/NEXT_PUBLIC_[A-Z0-9_]+/).filter((name) => !(name in PUBLIC_NAMES_ALLOWED));
    expect(found).toEqual([]);

    // A druhá půlka, jinak by se seznam dal obejít tím, že se na něj něco
    // dopíše: povolené jméno samo nesmí být tvarem secretu. Táž aserce jako
    // u `build-env.allow` níž a ze stejného důvodu.
    for (const name of Object.keys(PUBLIC_NAMES_ALLOWED))
      expect(/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(name), name).toBe(false);
  });

  it('klíč se čte jedině na serverové cestě', () => {
    // Testy se vynechávají schválně: jméno proměnné v testu je fixture, ne
    // čtení. Do bundlu se `__tests__` nepřekládá.
    const readers = grepRepo(/WORLDSMITH_MODEL_KEY/).filter((path) => path.startsWith('src/'));
    expect(readers.length).toBeGreaterThan(0);
    for (const path of readers) expect(path.startsWith('src/server/'), path).toBe(true);
  });

  it('kořenový next.config.mjs vpisuje do bundlu jen povolené proměnné', async () => {
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

    // `PLAY_MUSIC` je přepínač hudby her (P29D T5), hodnota `on`/`off`, ne secret.
    expect(Object.keys(loaded.default.env ?? {})).toEqual(['WORLDSMITH_BUILD_TREE', 'PLAY_MUSIC']);
  });

  it('hermetický build klíč vůbec nevidí — není na allowlistu', () => {
    const names = hostAllowlist();

    // **Nejdřív že se vůbec něco změřilo.** Do 3. 9. 2026 se sekce hledala
    // `indexOf('[host]')`, jenže první výskyt toho řetězce je v hlavičkovém
    // komentáři souboru — stejně jako první `[platform]` o dva odstavce níž.
    // Vykrojený úsek tedy nebyl seznam, ale 152 znaků komentáře, po odfiltrování
    // `#` prázdné pole. Obě aserce pod tím byly zelené nad nulou položek: klíč
    // dopsaný na seznam by neshodil nic. Naměřeno při P15 T30.
    expect(names.length).toBeGreaterThan(10);

    expect(names).not.toContain('WORLDSMITH_MODEL_KEY');
    // Ani nic jiného, co nese tajemství. Seznam roste, tahle aserce ne.
    for (const name of names) expect(/KEY|SECRET|TOKEN|PASSWORD/.test(name), name).toBe(false);
  });

  it('a nevidí ani nic dalšího, co se čte za běhu', () => {
    // **Aserce o tvaru jména sama nestačí — tohle je ta druhá půlka** (P15 T30).
    // `WORLDSMITH_MODEL_ENDPOINT` ani `WORLDSMITH_CONTROL_FILE` nenesou ve jméně
    // `KEY`, `SECRET` ani `TOKEN`, takže by na seznam prošly — a adresa
    // poskytovatele v klientském bundlu je návod, kam posílat cizí požadavky,
    // zatímco cesta k ovládacímu souboru je rozvržení disku serveru.
    //
    // Seznam je proto uzavřený: build potřebuje **dvě** vlastní proměnné a nová
    // se sem dostane jedině tím, že ji někdo dopíše i sem.
    const ours = hostAllowlist().filter((name) => name.startsWith('WORLDSMITH_'));

    expect(ours.sort()).toEqual(['WORLDSMITH_BUILD_TREE', 'WORLDSMITH_ENV_REPORT']);
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
 * - **`.env.example`.** Nese `WORLDSMITH_MODEL_KEY=` a komentáře v kódu říkají
 *   operátorovi, ať si ho odsud zkopíruje. Řádek s předponou `NEXT_PUBLIC_`
 *   v tomhle souboru je tedy **návod, jak si klíč vystavit prohlížeči** — a do
 *   1. 9. 2026 ho hledání nevidělo, protože soubor ležel mimo cestu.
 *
 * **Ignorované soubory zůstávají neviditelné a je to tak správně.**
 * `--untracked` do nich nesahá a vzory `tmp-*`, `scratch-*`, `*.key` a `.env.*`
 * z `.gitignore` platí v jakékoli hloubce. Do nasazeného bundlu se ale ze
 * stromu, který build klonuje z gitu, nedostanou — revize to označila jako
 * PLAUSIBLE, ne CONFIRMED. Zapsané jako vědomé rozhodnutí, ne jako mezera.
 *
 * **Co tímhle zavřít NEJDE, a nepředstírej to:** doslova vepsaná hodnota
 * klíče v kódu nesedne na žádný z těch vzorů. To umí až grep nad `.next/`
 * po buildu, tedy vlna 7.
 */
const SWEPT_PATHS = [
  'src',
  'ops',
  'scripts',
  'next.config.mjs',
  '.env.example',
  // `__tests__` ven už na úrovni gitu, ne filtrem po něm: do klientského
  // bundlu se nepřekládá a jméno v próze je fixture, ne čtení. Bez toho se
  // aserce trefí do vlastního doc komentáře nahoře v tomhle souboru — což se
  // jednou stalo a poznalo se to až ve chvíli, kdy se soubor stal sledovaným.
  ':!*__tests__*',
];

/** Jména proměnných, u kterých Next vpisuje HODNOTU do klientského bundlu. */
const PUBLIC_NAMES_ALLOWED: Record<string, string> = {
  // Fixture znečištění: `scripts/build-from-tag.mjs` ji vstřikuje do okolního
  // prostředí, aby dokázal, že ji hermetický build **neuvidí**. Nikde se
  // nenastavuje a v žádném artefaktu neskončí.
  NEXT_PUBLIC_INJECTED: 'fixture, kterou hermetický build musí ignorovat',
  // Jen v próze: `src/app/embed/[layoutId]/site-url.ts` vysvětluje, proč se
  // absolutní adresa **nesmí** brát odsud (zapekla by se při buildu z tagu).
  NEXT_PUBLIC_SITE_URL: 'jmenovaná v komentáři jako zakázaná cesta',
};

function gitGrep(flags: string, pattern: RegExp): string[] {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync('git', ['grep', '--untracked', flags, pattern.source, '--', ...SWEPT_PATHS], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (thrown) {
    // `git grep` vrací 1, když nic nenajde. To je prázdný výsledek, ne chyba.
    if ((thrown as { status?: number }).status === 1) return [];
    throw thrown;
  }
}

/** Cesty souborů, ve kterých se vzor vyskytuje. */
function grepRepo(pattern: RegExp): string[] {
  return gitGrep('-lE', pattern);
}

/** Samotná nalezená jména, bez cest a bez opakování. */
function grepNames(pattern: RegExp): string[] {
  return [...new Set(gitGrep('-hoE', pattern))].sort();
}

/**
 * 7. Transport `codex-cli` — `WORLDSMITH_MODEL_ENDPOINT=codex-cli` spouští
 * `codex exec --json` místo HTTP. Testuje se **skutečnou cestou procesem**:
 * `WORLDSMITH_CODEX_JS` ukáže na skript, který zahraje Codex (přečte prompt
 * ze stdin, vypíše proud událostí), takže se soudí i to, jak se proces spouští
 * a čte, ne jen parser nad připraveným řetězcem.
 */
describe('7. transport codex-cli spustí proces a přečte proud událostí', () => {
  const CLI_ENV = { ...LIVE_ENV, WORLDSMITH_MODEL_ENDPOINT: 'codex-cli', WORLDSMITH_MODEL: 'gpt-6-astra', WORLDSMITH_MODEL_EFFORT: 'medium' };
  const scripts = mkdtempSync(join(tmpdir(), 'fake-codex-'));

  /** Skript, který se chová jako Codex: čte stdin, tiskne zadané řádky. */
  function fakeCodex(name: string, lines: readonly unknown[], extra = ''): string {
    const file = join(scripts, `${name}.cjs`);
    writeFileSync(file, [
      "const chunks = []; process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  const prompt = Buffer.concat(chunks).toString('utf8');",
      // Co proces dostal, jde stranou do souboru — do proudu ne: cesty Windows a
      // uvozovky argumentů by rozbily JSON, který se tu má soudit.
      `  require('node:fs').writeFileSync(${JSON.stringify(`${file}.seen.json`)}, JSON.stringify({ args: process.argv.slice(2), promptHead: prompt.slice(0, 20), cwd: process.cwd(), envKeys: Object.keys(process.env) }));`,
      `  const lines = ${JSON.stringify(lines)};`,
      '  for (const line of lines) process.stdout.write(JSON.stringify(line) + String.fromCharCode(10));',
      extra,
      '});',
    ].join('\n'));
    return file;
  }

  const answer = { hello: 'world' };
  const okStream = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: JSON.stringify(answer) } },
    { type: 'turn.completed', usage: { input_tokens: 12000, output_tokens: 300, reasoning_output_tokens: 20 } },
  ];

  function withScript(file: string, run: () => Promise<void>) {
    const previous = process.env.WORLDSMITH_CODEX_JS;
    process.env.WORLDSMITH_CODEX_JS = file;
    return run().finally(() => {
      if (previous === undefined) delete process.env.WORLDSMITH_CODEX_JS;
      else process.env.WORLDSMITH_CODEX_JS = previous;
    });
  }

  it('P70B T4: odpověď přes max_output_tokens skončí u prvního pokusu jako nepoužitelná, ne výpadek', async () => {
    // Skutečný codex po hlášce čeká a zkouší znovu (5×, pak HTTPS); skript tu visí 20 s – konec dřív = zastavil první pokus.
    const file = fakeCodex('cap', [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: Incomplete response returned, reason: max_output_tokens)' },
    ], "  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'error', message: 'second attempt' }) + String.fromCharCode(10)), 20000);");
    const started = Date.now();
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 'S', user: PROMPT } });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('MALFORMED_RESPONSE');
      expect(outcome.detail).toContain('max_output_tokens');
    });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('P70B T4: schéma režiséra dostane codex pod limitem výčtů OpenAI, se sdílenými $defs', async () => {
    // Naměřeno 4. 11.: plné schéma (3 181 hodnot výčtů) dalo „max_output_tokens“ 4/4, se sdílenými výčty odpověď 1/1.
    const enumValues = (node: unknown): number =>
      Array.isArray(node) ? node.reduce((sum: number, child) => sum + enumValues(child), 0)
      : node === null || typeof node !== 'object' ? 0
      : Array.isArray((node as { enum?: unknown }).enum) ? ((node as { enum: unknown[] }).enum).length
      : Object.values(node).reduce((sum: number, child) => sum + enumValues(child), 0);
    const file = fakeCodex('schema', okStream, [
      '  const args = process.argv.slice(2);',
      `  require('node:fs').copyFileSync(args[args.indexOf('--output-schema') + 1], ${JSON.stringify(join(scripts, 'schema.sent.json'))});`,
    ].join('\n'));
    expect(enumValues(GENRE_ANSWER_SCHEMA)).toBeGreaterThan(OPENAI_ENUM_LIMIT);
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 'S', user: PROMPT, outputSchema: GENRE_ANSWER_SCHEMA } });
      expect(outcome.ok).toBe(true);
    });
    const sent = JSON.parse(readFileSync(join(scripts, 'schema.sent.json'), 'utf8')) as Record<string, unknown>;
    expect(enumValues(sent)).toBeLessThanOrEqual(OPENAI_ENUM_LIMIT);
    expect(Object.keys(sent.$defs as object).length).toBeGreaterThan(0);
  });

  it('vrátí tělo z agent_message, účtenku z turn.completed a jméno modelu i úsilí předá procesu', async () => {
    const file = fakeCodex('ok', okStream);
    // Klíč aplikace v prostředí serveru: codex ho vidět nesmí (`ship-codexcli`).
    const previousKey = process.env.WORLDSMITH_MODEL_KEY;
    process.env.WORLDSMITH_MODEL_KEY = 'canary-key-that-must-not-reach-codex';
    try {
      await withScript(file, async () => {
        const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 'SYSTEM TEXT HERE', user: PROMPT } });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.body).toEqual(answer);
        const seen = JSON.parse(readFileSync(`${file}.seen.json`, 'utf8')) as { args: string[]; promptHead: string; cwd: string; envKeys: string[] };
        const args = seen.args.join(' ');
        expect(args).toContain('--model gpt-6-astra');
        expect(args).toContain('model_reasoning_effort="medium"');
        expect(args).toContain('--sandbox read-only');
        expect(args).toContain('features.shell_tool=false');
        expect(args).toContain('--ignore-rules');
        expect(args).toContain('features.view_image=false');
        expect(seen.promptHead).toBe('SYSTEM TEXT HERE\n\na ');
        expect(seen.envKeys).not.toContain('WORLDSMITH_MODEL_KEY');
        // Dočasný adresář, ne kořen repa – a po konci volání už neexistuje.
        expect(seen.cwd).not.toBe(process.cwd());
        expect(existsSync(seen.cwd)).toBe(false);
        expect(outcome.usage).toEqual({ inputTokens: 12000, outputTokens: 300 });
        expect(outcome.provenance).toMatchObject({ source: 'codex-cli', model: 'gpt-6-astra' });
      });
    } finally {
      if (previousKey === undefined) delete process.env.WORLDSMITH_MODEL_KEY;
      else process.env.WORLDSMITH_MODEL_KEY = previousKey;
    }
  });

  it('turn.failed je odmítnutí, ne výpadek', async () => {
    const file = fakeCodex('failed', [okStream[0], { type: 'turn.failed', error: { message: 'model not available' } }]);
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_REJECTED', usage: null });
    });
  });

  it('proud bez hotové zprávy a text, který není JSON, jsou vadné odpovědi', async () => {
    const noMessage = fakeCodex('nomsg', [okStream[0], okStream[1], okStream[3]]);
    await withScript(noMessage, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
    });
    const notJson = fakeCodex('notjson', [okStream[0], okStream[1], { type: 'item.completed', item: { type: 'agent_message', text: '{"extent": [ thirty ]}' } }, okStream[3]]);
    await withScript(notJson, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
      if (outcome.ok) return;
      // Tokeny se spálily, účtenka se tedy čte — s hranicí zdola jako u HTTP.
      expect(outcome.usage).not.toBeNull();
    });
  });

  it('proces, který nedoběhne do stropu, je výpadek a zabije se', async () => {
    const file = fakeCodex('slow', [okStream[0]], '  setTimeout(() => {}, 30_000);');
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig({ ...CLI_ENV, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '400' })).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
      if (outcome.ok) return;
      expect(outcome.detail).toContain('timeout');
    });
  });

  it('po stropu zabije celý strom, i vnuka za obalem', async () => {
    const marker = join(scripts, 'tree.cjs.grandchild');
    // Vnuk stojí za nativní binárkou, kterou skutečný `codex.js` spouští jako
    // dítě. Na Windows `detached`, jinak ho libuv strčí do job objectu obalu
    // a umře s ním sám – test by nepoznal zabitý strom od zabitého obalu
    // (totéž v `scripts/__tests__/fake-codex.mjs`).
    const file = fakeCodex('tree', [okStream[0]], [
      "  const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(grandchild.pid));`,
      '  setInterval(() => {}, 1000);',
    ].join('\n'));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let grandchild = 0;
    try {
      await withScript(file, async () => {
        const outcome = await upstreamBranch(liveConfig({ ...CLI_ENV, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '2000' })).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
        expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
        grandchild = Number(readFileSync(marker, 'utf8'));
        expect(grandchild).toBeGreaterThan(0);
        const deadline = Date.now() + 10_000;
        while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        expect(alive(grandchild), 'vnuk přežil timeout a dál by pálil předplatné').toBe(false);
      });
    } finally {
      if (grandchild > 0 && alive(grandchild)) process.kill(grandchild);
    }
  }, 20_000);

  // Revize `ship-codexcli` 15. 9. 2026.
  it('odpověď s diakritikou přes víc čtení roury nepoškodí', async () => {
    const name = 'ž€'.repeat(60_000);
    const file = fakeCodex('utf8', [okStream[0], okStream[1], { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ name }) } }, okStream[3]]);
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.body).toEqual({ name });
    });
  });

  it('skončí i s obalem, který umřel dřív než potomek držící rouru', async () => {
    const marker = join(scripts, 'orphan.cjs.orphan');
    // Obal hned skončí a stdout drží potomek. `taskkill /T` přes mrtvý PID
    // nenajde nic a `close` by přišel, až potomek skončí sám – za 60 s.
    const file = fakeCodex('orphan', [okStream[0]], [
      "  const orphan = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: process.platform === 'win32' });",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(orphan.pid));`,
      '  process.exit(0);',
    ].join('\n'));
    let orphan = 0;
    try {
      await withScript(file, async () => {
        vi.mocked(execFile).mockClear();
        const started = Date.now();
        const outcome = await upstreamBranch(liveConfig({ ...CLI_ENV, WORLDSMITH_UPSTREAM_TIMEOUT_MS: '1500' })).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
        orphan = Number(readFileSync(marker, 'utf8'));
        expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
        expect(Date.now() - started, 'volání čekalo na sirotka').toBeLessThan(10_000);
        // Obal skončil hned, takže jeho PID už smí patřit cizímu procesu (`ship-pidreuse`).
        expect(
          vi.mocked(execFile).mock.calls.filter(([file]) => file === 'taskkill'),
          'taskkill šel na PID obalu, který už skončil',
        ).toEqual([]);
      });
    } finally {
      try {
        if (orphan > 0) process.kill(orphan);
      } catch {
        /* už neběží */
      }
    }
  }, 30_000);

  // Security-reviewer před `/ship` 15. 9. 2026: zavřená roura sama obal ukončí
  // a jeho PID se uvolní; `taskkill`, který ho vyhledá o desítky milisekund
  // později, by trefil cizí proces. Roury se proto zavírají až po něm.
  it.runIf(process.platform === 'win32')('roury zavře až po doběhnutí taskkill, u mrtvého obalu hned', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const gone = actual.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    let goneClosed = false;
    killCodexTree(gone, () => {
      goneClosed = true;
    });
    expect(goneClosed, 'roury obalu, který už skončil, zůstaly otevřené').toBe(true);

    let returned = false;
    vi.mocked(execFile).mockImplementationOnce(((file: string, args: string[], options: object, callback: () => void) =>
      actual.execFile(file, args, options, () => {
        returned = true;
        callback();
      })) as never);
    const running = actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => running.once('spawn', resolve));
    const exited = new Promise((resolve) => running.once('exit', resolve));
    const closedAfterTaskkill = await new Promise<boolean>((resolve) => killCodexTree(running, () => resolve(returned)));
    expect(closedAfterTaskkill, 'roury se zavřely dřív, než taskkill doběhl').toBe(true);
    await exited;
  });

  // Revize testových mezer před /ship 15. 9. 2026: spadlý codex s rozepsaným
  // proudem je výpadek, ne vadná odpověď, která by si řekla o placenou opravu.
  it('proces, který skončí nenulovým kódem, je výpadek i s rozepsaným proudem', async () => {
    const file = fakeCodex('crash', [okStream[0]], '  process.exit(3);');
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
      if (outcome.ok) return;
      expect(outcome.detail).toContain('code 3');
    });
  });

  // Revize R2 z P19: jméno s diakritikou rozdělené mezi dvě čtení stderr nesmí
  // dostat U+FFFD, jinak ho redakce archivu nepozná.
  it('znak UTF-8 rozdělený mezi dvě čtení stderr zůstane celý', async () => {
    const file = fakeCodex('split-stderr', [okStream[0]], [
      '  process.stderr.write(Buffer.from([0x74, 0x6f, 0x6d, 0xc3]));',
      '  setTimeout(() => { process.stderr.write(Buffer.from([0xa1, 0x73])); setTimeout(() => process.exit(1), 50); }, 100);',
    ].join('\n'));
    await withScript(file, async () => {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.detail).toContain('tomás');
    });
  });

  it('proud delší než 8 MiB se utne jako výpadek', async () => {
    const file = fakeCodex('flood', [okStream[0]], "  process.stdout.write('x'.repeat(9 * 1024 * 1024));");
    await withScript(file, async () => {
      vi.mocked(execFile).mockClear();
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
      // Roury se zavírají až po `taskkill`, takže data mezitím tečou dál; další
      // kus nad stropem nesmí pouštět další `taskkill` (/ship 15. 9. 2026).
      expect(vi.mocked(execFile).mock.calls.filter(([name]) => name === 'taskkill').length).toBeLessThanOrEqual(1);
      if (outcome.ok) return;
      expect(outcome.detail).toContain('8 MiB');
    });
  });

  it('codex, který se nespustí, je výpadek, ne pád serveru', async () => {
    // `spawn` bez spustitelného souboru vystřelí `error` místo `close`; bez
    // posluchače by nezachycená událost shodila celý proces serveru
    // (`ship-testgaps2`). Prázdné `WORLDSMITH_CODEX_JS` znamená `codex` z PATH,
    // a PATH tady míří do prázdného adresáře.
    const empty = mkdtempSync(join(tmpdir(), 'no-codex-'));
    const saved = { script: process.env.WORLDSMITH_CODEX_JS, path: process.env.PATH };
    process.env.WORLDSMITH_CODEX_JS = '';
    process.env.PATH = empty;
    try {
      const outcome = await upstreamBranch(liveConfig(CLI_ENV)).generate({ prompt: PROMPT, request: { model: 'gpt-6-astra', system: 's', user: PROMPT } });
      expect(outcome).toMatchObject({ ok: false, reason: 'UPSTREAM_UNAVAILABLE' });
      if (outcome.ok) return;
      expect(outcome.detail).toContain('ENOENT');
    } finally {
      if (saved.script === undefined) delete process.env.WORLDSMITH_CODEX_JS;
      else process.env.WORLDSMITH_CODEX_JS = saved.script;
      process.env.PATH = saved.path;
    }
  });

  it('bez codex-cli v koncovém bodu zůstává výchozí strop 120 s, s ním 240 s', () => {
    expect(liveConfig().timeoutMs).toBe(120_000);
    expect(liveConfig(CLI_ENV).timeoutMs).toBe(240_000);
  });
});

/**
 * 8. `parseAnswerText` opraví jen konec dokumentu a nanejvýš o dvě závorky
 * (`ship-testgaps`, 15. 9. 2026). Cokoli uprostřed se odmítá tak, jak je.
 */
describe('8. parseAnswerText opraví jen konec, nanejvýš o dvě závorky', () => {
  it.each([
    ['celý dokument', '{"a":1}', { a: 1 }],
    ['jedna "}" navíc', '{"a":{"b":1}}}', { a: { b: 1 } }],
    ['dvě "}" navíc', '{"a":{"b":1}}}}', { a: { b: 1 } }],
    ['jedna "}" chybí', '{"a":{"b":1}', { a: { b: 1 } }],
    ['chybí "]" i "}"', '{"a":[1,2', { a: [1, 2] }],
  ])('přečte %s', (_name, text, expected) => {
    expect(parseAnswerText(text)).toEqual(expected);
  });

  it.each([
    ['tři chybějící závorky', '{"a":{"b":[1'],
    ['chybějící čárka uprostřed', '{"a":1 "b":2}'],
    ['useknutý řetězec', '{"a":"abc'],
  ])('odmítne %s', (_name, text) => {
    expect(() => parseAnswerText(text)).toThrow();
  });

  it('odpověď useknutou na max_tokens nedoplní, i když by jí stačily dvě závorky', async () => {
    const answer = (stopReason: string) => (async () => new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"a":[1,2' }], stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 10 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const call = { prompt: PROMPT, request: { model: 'm', system: 's', user: PROMPT } };
    const cut = await upstreamBranch(liveConfig(), answer('max_tokens')).generate(call);
    expect(cut).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE' });
    if (!cut.ok) expect(cut.detail).toContain('max_tokens');
    const finished = await upstreamBranch(liveConfig(), answer('end_turn')).generate(call);
    expect(finished).toMatchObject({ ok: true, body: { a: [1, 2] } });
    // Useknutí znamená jen `max_tokens`. Porovnání `!== 'end_turn'` by tuhle
    // odpověď odmítlo taky a obě věty nad tímhle řádkem by prošly dál.
    const stopped = await upstreamBranch(liveConfig(), answer('stop_sequence')).generate(call);
    expect(stopped).toMatchObject({ ok: true, body: { a: [1, 2] } });
  });
});

describe('9. chatConfigFromEnv staví zálohu režiséra i čtečku věty týmž kódem (P56A T4)', () => {
  const READER = { localModel: 'local-reader', localMaxOutputTokens: 1024, hostedMaxOutputTokens: 1024, timeoutMs: 700 };
  const groq = {
    PLAY_READER_ENDPOINT: 'openai:https://api.groq.com/openai',
    PLAY_READER_KEY: 'gsk-test',
    PLAY_READER_MODEL: 'openai/gpt-oss-20b',
    PLAY_READER_USD_PER_MTOK_IN: '0.075',
    PLAY_READER_USD_PER_MTOK_OUT: '0.30',
  };

  it('placená čtečka nese klíč, cenu a profil api', () => {
    expect(chatConfigFromEnv(groq, 'PLAY_READER', READER)).toEqual({
      endpoint: 'openai:https://api.groq.com/openai',
      apiKey: 'gsk-test',
      model: 'openai/gpt-oss-20b',
      effort: 'low',
      pricing: { usdPerMTokIn: 0.075, usdPerMTokOut: 0.3 },
      maxOutputTokens: 1024,
      timeoutMs: 700,
      profile: 'api',
      callCap: null,
    });
  });

  it.each(['PLAY_READER_KEY', 'PLAY_READER_MODEL', 'PLAY_READER_USD_PER_MTOK_OUT'])('placená čtečka bez %s není', (name) => {
    expect(chatConfigFromEnv({ ...groq, [name]: ' ' }, 'PLAY_READER', READER)).toBeNull();
  });

  it('chybějící cena vstupu se dopočítá z výstupu, ne nulou', () => {
    expect(chatConfigFromEnv({ ...groq, PLAY_READER_USD_PER_MTOK_IN: undefined }, 'PLAY_READER', READER)?.pricing).toEqual({ usdPerMTokIn: 0.3, usdPerMTokOut: 0.3 });
  });

  it('llama.cpp je zdarma, klíč smí chybět a model má výchozí jméno role', () => {
    expect(chatConfigFromEnv({ PLAY_READER_ENDPOINT: 'llamacpp:http://127.0.0.1:8792' }, 'PLAY_READER', READER)).toMatchObject({
      apiKey: '',
      model: 'local-reader',
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      maxOutputTokens: 1024,
      profile: 'subscription',
    });
  });

  it('proměnné jedné role druhou nezapnou', () => {
    expect(chatConfigFromEnv(groq, 'WORLDSMITH_FALLBACK', READER)).toBeNull();
    expect(chatConfigFromEnv({ WORLDSMITH_FALLBACK_ENDPOINT: 'llamacpp:http://127.0.0.1:8792' }, 'PLAY_READER', READER)).toBeNull();
  });
});
