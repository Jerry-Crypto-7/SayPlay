import { describe, expect, it, vi } from 'vitest';

import { detectRuntime } from '../../model/local/capability';
import { frozenGrammar } from '../../model/client';
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
