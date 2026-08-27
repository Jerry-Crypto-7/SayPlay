import { describe, expect, it, vi } from 'vitest';

import { detectRuntime } from '../../model/local/capability';
import { frozenGrammar } from '../../model/client';
import { EMISSION_MODEL } from '../../model/prompt';
import type { Grammar } from '../../model/prompt';
import { runPipeline } from '../pipeline';
import { SpendCap } from '../spend-cap';
import { cloudBranchAvailable, upstreamBranch, upstreamConfigFromEnv } from '../upstream';

/**
 * Oracle T24 — **cloudová cesta jen pro stroje bez WebGPU, a jen když je klíč.**
 *
 * Dvě tvrzení, a to druhé je to důležité:
 *
 * 1. S klíčem jde emise přes `src/server/**` a **strop útraty ji vidí** — nad
 *    stropem se volání neuskuteční vůbec, ne že se zpětně zapíše.
 * 2. **Bez klíče se cloudová cesta vůbec nenabídne**: `detectRuntime()` z ní
 *    nevyjde a živá větev nesáhne na síť ani jednou.
 *
 * ## Proč se tu nespouští prohlížeč
 *
 * Rozhodnutí, jestli cloud vůbec existuje, je čtení prostředí na serveru;
 * `detectRuntime()` je čistá funkce nad tím, co o sobě stroj řekne. Obojí jde
 * změřit přesně, kdežto prohlížeč by sem přinesl jen šum. Tentýž dělený vzor
 * jede v `e2e/webgpu-detect.spec.ts`: fakta z prostředí, rozhodnutí produkční
 * funkcí.
 *
 * ## Co se tu nesmí obejít
 *
 * Transport je podvržený (`fetchImpl`), protože test, který sahá na síť, měří
 * poskytovatele, ne nás. **Strop ani čtení klíče podvržené nejsou** — jdou přes
 * `SpendCap` a `upstreamConfigFromEnv` tak, jak je volá `/api/generate`.
 */

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

/** Vymyšlený klíč. Nikde jinde než v tomhle souboru neexistuje. */
const TEST_KEY = 'test-key-not-a-real-credential';

const CONFIGURED_ENV = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://provider.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: TEST_KEY,
  WORLDSMITH_USD_PER_MTOK_IN: '3',
  WORLDSMITH_USD_PER_MTOK_OUT: '15',
  WORLDSMITH_MAX_OUTPUT_TOKENS: '1000',
} as const;

/** Stroj bez WebGPU. Jediné, čím se ty dva případy liší, je nakonfigurovaný cloud. */
const NO_WEBGPU = { hasWebGpu: false, deviceMemoryGb: undefined } as const;

const PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

/** Odpověď poskytovatele v jeho tvaru. Spotřeba je skutečná, ne odhad. */
function providerAnswer(inputTokens: number, outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ world: 'emitted by the provider' }) }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('bez klíče se cloudová cesta vůbec nenabídne', () => {
  it('prázdné prostředí cloud nenabízí', () => {
    expect(cloudBranchAvailable({})).toBe(false);
  });

  it('objednaná živá větev bez klíče cloud nenabízí', () => {
    // Nejnebezpečnější z těch tří: někdo přepnul větev a klíč nedoplnil. Kdyby
    // se tady odpovědělo `true`, produkt by nabídl cestu, která nemá čím jet.
    const { WORLDSMITH_MODEL_KEY: _omitted, ...withoutKey } = CONFIGURED_ENV;
    expect(cloudBranchAvailable(withoutKey)).toBe(false);
  });

  it('klíč bez objednané živé větve cloud taky nenabízí', () => {
    // Přítomný klíč sám o sobě nesmí nic zapnout — jinak by proměnná zděděná
    // z jiného projektu tiše přepnula produkt na placenou cestu.
    expect(cloudBranchAvailable({ ...CONFIGURED_ENV, WORLDSMITH_BRANCH: 'offline' })).toBe(false);
  });

  it('stroj bez WebGPU a bez cloudu jede na deterministických tvarech', () => {
    expect(detectRuntime({ ...NO_WEBGPU, cloudConfigured: cloudBranchAvailable({}) })).toBe('none');
  });

  it('bez ceny výstupu se cloud nenabídne, protože strop by nedržel nic', () => {
    // Naměřeno nezávislou revizí 21. 8. 2026: bez ceny vyjde rezervace nula,
    // projde i při stropu nula, a 25 z 25 požadavků odešlo k poskytovateli, aniž
    // by se zůstatek hnul. Vzniká to zkopírováním `.env.example`, kde je cena
    // prázdná — tedy cestou, kterou dokumentace přímo předepisuje.
    const { WORLDSMITH_USD_PER_MTOK_OUT: _omitted, ...withoutPrice } = CONFIGURED_ENV;
    expect(cloudBranchAvailable(withoutPrice)).toBe(false);
    expect(upstreamConfigFromEnv(withoutPrice)).toBeNull();
  });

  it('nevyplněná cena vstupu se dopočítá z ceny výstupu, ne z nuly', () => {
    // Naměřeno 21. 8. 2026: tichá nula na vstupu podhodnotila rezervaci o celý
    // vstup (~3000 tokenů na volání). Při ceníku vstup 3 / výstup 15 to strop
    // přestřelil o 61 %. Náhradou je proto cena výstupu — přestřelená rezervace
    // je u stropu bezpečná strana.
    for (const missing of [undefined, '', '0,003', 'zdarma', '-2']) {
      const env: Record<string, string | undefined> = {
        ...CONFIGURED_ENV,
        WORLDSMITH_USD_PER_MTOK_OUT: '15',
        WORLDSMITH_USD_PER_MTOK_IN: missing,
      };
      if (missing === undefined) delete env.WORLDSMITH_USD_PER_MTOK_IN;
      expect(
        upstreamConfigFromEnv(env)?.pricing.usdPerMTokIn,
        `cena vstupu ${JSON.stringify(missing)} se nedopočítala`,
      ).toBe(15);
    }
  });

  it('výslovná nula na vstupu se respektuje — je to rozhodnutí, ne tichá výchozí hodnota', () => {
    const cfg = upstreamConfigFromEnv({
      ...CONFIGURED_ENV,
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_USD_PER_MTOK_IN: '0',
    });
    expect(cfg?.pricing.usdPerMTokIn).toBe(0);
  });

  it('nula ani překlep v ceně výstupu cloud nenabídne', () => {
    // `0,003` s desetinnou čárkou je `NaN`. Tichá náhrada za nulu je přesně to,
    // co strop vypne, takže se odmítá obojí.
    for (const price of ['0', '', '0,003', '-1', 'zdarma']) {
      expect(
        cloudBranchAvailable({ ...CONFIGURED_ENV, WORLDSMITH_USD_PER_MTOK_OUT: price }),
        `cena výstupu ${JSON.stringify(price)} prošla jako platná`,
      ).toBe(false);
    }
  });

  it('konfigurace bez ceny nepustí ven jediný požadavek', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { WORLDSMITH_USD_PER_MTOK_OUT: _omitted, ...withoutPrice } = CONFIGURED_ENV;

    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(upstreamConfigFromEnv(withoutPrice), fetchImpl),
      cap: new SpendCap({ enabled: true, capUsd: 0 }),
      grammar: GRAMMAR,
    });

    expect(fetchImpl, 'bez ceny výstupu odešel požadavek ven').not.toHaveBeenCalled();
    expect(result.outcome).toBe('FAILED');
  });

  it('nenakonfigurovaná živá větev nesáhne na síť ani jednou', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const branch = upstreamBranch(upstreamConfigFromEnv({}), fetchImpl);

    const result = await runPipeline(PROMPT, {
      branch,
      cap: new SpendCap({ enabled: true, capUsd: 10 }),
      grammar: GRAMMAR,
    });

    expect(fetchImpl, 'bez klíče odešel požadavek ven').not.toHaveBeenCalled();
    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') throw new Error('unreachable');
    expect(result.reason).toBe('BRANCH_UNCONFIGURED');
    // Nenastalé volání nesmí nic stát. Jinak by nenakonfigurovaný server dokázal
    // vyčerpat strop tím, že nic nedělá.
    expect(result.costUsd).toBe(0);
  });
});

describe('s klíčem jde emise přes server a strop ji vidí', () => {
  it('stroj bez WebGPU s nakonfigurovaným cloudem dostane cloudovou větev', () => {
    expect(detectRuntime({ ...NO_WEBGPU, cloudConfigured: cloudBranchAvailable(CONFIGURED_ENV) })).toBe(
      'cloud',
    );
  });

  it('volání odejde právě jednou, klíč jde v hlavičce a zůstatek klesne přesně o cenu', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => providerAnswer(1_000, 200));
    const config = upstreamConfigFromEnv(CONFIGURED_ENV);
    expect(config).not.toBeNull();
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const before = cap.snapshot().remainingUsd;

    const result = await runPipeline(PROMPT, { branch: upstreamBranch(config, fetchImpl), cap, grammar: GRAMMAR });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CONFIGURED_ENV.WORLDSMITH_MODEL_ENDPOINT);
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe(TEST_KEY);

    expect(result.outcome).toBe('GENERATED');
    if (result.outcome !== 'GENERATED') throw new Error('unreachable');

    // 1000 vstupních po 3 USD/Mtok a 200 výstupních po 15 USD/Mtok = 0,006 USD.
    // Číslo je napsané ručně schválně: dopočítat ho ze stejného vzorce, jaký se
    // testuje, by znamenalo netestovat nic.
    expect(result.costUsd).toBeCloseTo(0.006, 10);
    expect(cap.snapshot().remainingUsd).toBeCloseTo(before - 0.006, 10);
    // Rezervace se musí vyrovnat, jinak by strop držel nejhorší případ navždy.
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('prázdné jméno modelu se nahradí výchozím, ne prázdným řetězcem', async () => {
    // `.env.example` `WORLDSMITH_MODEL=` je prázdné schválně. `??` prázdný
    // řetězec propustí, takže k poskytovateli odejde `{"model": ""}` a ten na to
    // odpoví 400 — živá větev je mrtvá přesně v dokumentované konfiguraci.
    const fetchImpl = vi.fn<typeof fetch>(async () => providerAnswer(10, 10));
    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        upstreamConfigFromEnv({ ...CONFIGURED_ENV, WORLDSMITH_MODEL: '' }),
        fetchImpl,
      ),
      cap: new SpendCap({ enabled: true, capUsd: 10 }),
      grammar: GRAMMAR,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { model?: unknown };
    expect(body.model).toBe(EMISSION_MODEL);
  });

  it('nečitelná účtenka účtuje rezervaci, ne nulu', async () => {
    // Úspěšné volání, jehož `usage` se nedá přečíst. Tokeny se spálily, takže
    // nulová útrata by znamenala volání zadarmo a strop by ho nikdy neuviděl.
    // Naměřeno 21. 8. 2026: `usage` se sráželo na `{0, 0}` a účtovalo 0 USD.
    const unreadable = new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"entities":[]}' }], usage: { input_tokens: null } }),
      { headers: { 'content-type': 'application/json' } },
    );
    // Nad jedním nejhorším případem: 1000 výstupních × 15 + ~3000 vstupních × 3
    // za Mtok je ~0,024 USD, jinak by se rezervace odmítla a nikam by se nešlo.
    const cap = new SpendCap({ enabled: true, capUsd: 0.05 });

    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        upstreamConfigFromEnv(CONFIGURED_ENV),
        vi.fn<typeof fetch>(async () => unreadable),
      ),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('GENERATED');
    expect(cap.snapshot().spentUsd, 'nečitelná účtenka se zaúčtovala nulou').toBeGreaterThan(0);
    expect(cap.reserve(0.05).ok, 'po nečitelné účtence strop pustil další volání').toBe(false);
  });

  it('Infinity v účtence strop nevypne', async () => {
    // `1e400` musí přijít jako SYROVÝ JSON — `JSON.stringify(Infinity)` je
    // `null`, takže přes `stringify` se tenhle případ vůbec nepostaví.
    // `JSON.parse` z něj udělá `Infinity`, `typeof Infinity === 'number'`, a
    // cena pak vyjde `Infinity` nebo `NaN`. Dřív `NaN` otrávilo součet útraty a
    // podmínka `wouldHold > capUsd` byla napořád nepravda — strop vypnutý.
    const poisoned = new Response(
      '{"content":[{"type":"text","text":"{\\"entities\\":[]}"}],"usage":{"input_tokens":1e400,"output_tokens":1e400}}',
      { headers: { 'content-type': 'application/json' } },
    );
    const cap = new SpendCap({ enabled: true, capUsd: 0.05 });

    await runPipeline(PROMPT, {
      branch: upstreamBranch(
        upstreamConfigFromEnv(CONFIGURED_ENV),
        vi.fn<typeof fetch>(async () => poisoned),
      ),
      cap,
      grammar: GRAMMAR,
    });

    const spent = cap.snapshot().spentUsd;
    expect(Number.isFinite(spent), `útrata je ${String(spent)} — součet je otrávený`).toBe(true);
    expect(cap.reserve(0.05).ok, 'po otrávené účtence strop pustil další volání').toBe(false);
  });

  it('klíč se nedostane do výsledku, který jde volajícímu', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => providerAnswer(10, 10));
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(upstreamConfigFromEnv(CONFIGURED_ENV), fetchImpl),
      cap: new SpendCap({ enabled: true, capUsd: 10 }),
      grammar: GRAMMAR,
    });

    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });
});

describe('nad stropem se nevolá vůbec', () => {
  it('vyčerpaný strop odmítne dřív, než požadavek vznikne', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => providerAnswer(10, 10));
    // Strop nižší než rezervace nejhoršího případu. Odmítnutí musí přijít
    // z rezervace, tedy PŘED voláním — účtenka po volání je pozdě.
    const cap = new SpendCap({ enabled: true, capUsd: 0.000_001 });

    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(upstreamConfigFromEnv(CONFIGURED_ENV), fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    expect(fetchImpl, 'nad stropem přesto odešel požadavek ven').not.toHaveBeenCalled();
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED' || result.stage !== 'spend-cap') throw new Error('unreachable');
    expect(result.reason).toBe('CAP_EXHAUSTED');
    // Odmítnuté volání nesmí zůstat viset v rezervaci.
    expect(cap.snapshot().reservedUsd).toBe(0);
  });
});
