import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { costUsd, DEFAULT_CALL_CAP, DEFAULT_CAP_USD, SpendCap, spendCapFromEnv } from '../spend-cap';

const PRICING = { usdPerMTokIn: 3, usdPerMTokOut: 15 };

const temporary: string[] = [];

function controlFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-cap-'));
  temporary.push(dir);
  const path = join(dir, 'spend-cap.json');
  if (contents !== null) writeFileSync(path, contents, 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cena se počítá z ohlášené spotřeby', () => {
  it('sčítá vstup a výstup po vlastních sazbách', () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, PRICING)).toBe(3);
    expect(costUsd({ inputTokens: 0, outputTokens: 1_000_000 }, PRICING)).toBe(15);
    expect(costUsd({ inputTokens: 500_000, outputTokens: 100_000 }, PRICING)).toBeCloseTo(3, 10);
  });

  it('nulová spotřeba stojí nulu', () => {
    expect(costUsd({ inputTokens: 0, outputTokens: 0 }, PRICING)).toBe(0);
  });
});

describe('strop rezervuje dopředu, nezaznamenává zpětně', () => {
  it('odmítne volání, které by rozpočet přeteklo', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const refused = cap.reserve(1.5);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CAP_EXHAUSTED');
    // Odmítnuté volání nesmí nic držet, jinak by strop tekl po každém odmítnutí.
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('volání přesně na strop projde — strop je mez, ne zákaz posledního dolaru', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    expect(cap.reserve(1).ok).toBe(true);
  });

  it('rozpracované volání drží svůj nejhorší případ ostatním', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const first = cap.reserve(0.6);
    expect(first.ok).toBe(true);
    // Kdyby se počítala jen utracená částka, obě volání by prošla — v okamžiku
    // rozhodnutí totiž ani jedno ještě nic neutratilo.
    expect(cap.reserve(0.6).ok).toBe(false);
  });

  it('vyrovnání skutečnou cenou uvolní rozdíl proti odhadu', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = cap.reserve(0.6);
    if (!reservation.ok) throw new Error('unreachable');
    reservation.settle(0.1);
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.1, 10);
    expect(cap.snapshot().reservedUsd).toBe(0);
    expect(cap.reserve(0.6).ok).toBe(true);
  });

  it('neznámá cena se účtuje celým odhadem', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = cap.reserve(0.6);
    if (!reservation.ok) throw new Error('unreachable');
    reservation.settle('unknown');
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.6, 10);
    // Padající poskytovatel tím pádem není cesta, jak strop obejít.
    expect(cap.reserve(0.6).ok).toBe(false);
  });

  it('druhé vyrovnání téže rezervace nedělá nic', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const reservation = cap.reserve(1);
    if (!reservation.ok) throw new Error('unreachable');
    reservation.settle(0.5);
    reservation.settle(0.5);
    reservation.settle('unknown');
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.5, 10);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('záporná ohlášená cena účtuje rezervaci, ne nulu', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = cap.reserve(0.5);
    if (!reservation.ok) throw new Error('unreachable');
    reservation.settle(-5);
    // Dřív se tady účtovala nula a test to tvrdil jako vlastnost. Nula ale
    // znamená, že poskytovatel, který ohlásí nesmysl, volá **zadarmo** — táž
    // díra jako u NaN, jen mírnější. Nesmyslná účtenka proto účtuje celou
    // rezervaci. Původní vlastnost (nikdy záporná útrata) platí dál.
    expect(cap.snapshot().spentUsd).toBe(0.5);
    expect(cap.snapshot().spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('NaN ani Infinity v účtence strop nevypnou', () => {
    // Naměřeno revizí 21. 8. 2026: `Math.max(0, NaN)` je `NaN`, takže jediná
    // vadná účtenka otrávila součet a od té chvíle byla podmínka
    // `wouldHold > capUsd` napořád nepravda — strop byl do konce běhu procesu
    // vypnutý. Poskytovatel to spustí jediným `1e400` v `usage`.
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const cap = new SpendCap({ enabled: true, capUsd: 1 });
      const first = cap.reserve(0.5);
      if (!first.ok) throw new Error('unreachable');
      first.settle(poison);

      expect(Number.isFinite(cap.snapshot().spentUsd), `${String(poison)} otrávil součet`).toBe(true);
      const second = cap.reserve(0.9);
      expect(second.ok, `po účtence ${String(poison)} strop pustil další volání`).toBe(false);
    }
  });

  it('odhad, který není konečné nezáporné číslo, volání odmítne', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    // `NaN > cap` je `false`, takže bez téhle kontroly by prošlo cokoli a strop
    // by se choval jako vypnutý.
    for (const estimate of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const refused = cap.reserve(estimate);
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('INVALID_ESTIMATE');
    }
  });
});

describe('vypínač mění chování za běhu, bez nové instance', () => {
  it('vypnutý strop pustí volání přes rozpočet a útratu pořád počítá', () => {
    const path = controlFile(JSON.stringify({ enabled: false, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    const reservation = cap.reserve(100);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('unreachable');
    reservation.settle(100);
    expect(cap.snapshot().spentUsd).toBe(100);
  });

  it('zapnutí za běhu platí od dalšího rozhodnutí', () => {
    const path = controlFile(JSON.stringify({ enabled: false, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    expect(cap.reserve(100).ok).toBe(true);

    writeFileSync(path, JSON.stringify({ enabled: true, capUsd: 1 }), 'utf8');
    expect(cap.reserve(100).ok).toBe(false);
  });

  it('zvednutí stropu za běhu pustí volání, které předtím neprošlo', () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    expect(cap.reserve(50).ok).toBe(false);

    writeFileSync(path, JSON.stringify({ enabled: true, capUsd: 100 }), 'utf8');
    expect(cap.reserve(50).ok).toBe(true);
  });

  it('chybějící ovládací soubor znamená výchozí hodnoty, ne odmítnutí', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, controlFile(null));
    expect(cap.reserve(0.5).ok).toBe(true);
    expect(cap.snapshot().capUsd).toBe(1);
  });

  it('vadný ovládací soubor odmítá, nepokračuje bez stropu', () => {
    for (const broken of ['{ not json', '{}', '{"enabled":"ano","capUsd":1}', '{"enabled":true,"capUsd":-1}']) {
      const cap = new SpendCap({ enabled: true, capUsd: 100 }, controlFile(broken));
      const refused = cap.reserve(0.01);
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CONTROL_UNREADABLE');
    }
  });
});

describe('strop z prostředí', () => {
  it('bez proměnné jede výchozí hodnota', () => {
    expect(spendCapFromEnv({}).snapshot().capUsd).toBe(DEFAULT_CAP_USD);
  });

  it('platná hodnota se přebírá', () => {
    expect(spendCapFromEnv({ WORLDSMITH_SPEND_CAP_USD: '2.5' }).snapshot().capUsd).toBe(2.5);
  });

  it('vadná hodnota je nula, ne výchozí strop', () => {
    // Překlep v proměnné jinak tiše zvedne strop na výchozí hodnotu.
    expect(spendCapFromEnv({ WORLDSMITH_SPEND_CAP_USD: 'pět' }).snapshot().capUsd).toBe(0);
    expect(spendCapFromEnv({ WORLDSMITH_SPEND_CAP_USD: '-1' }).snapshot().capUsd).toBe(0);
  });

  it('cesta k vypínači se bere z prostředí', () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 42 }));
    expect(spendCapFromEnv({ WORLDSMITH_SPEND_CAP_FILE: path }).snapshot().capUsd).toBe(42);
  });
});

describe('strop na počet volání drží i tehdy, když je ceník opsaný špatně', () => {
  /**
   * Tenhle strop je tu kvůli jedné konkrétní vadě, kterou dolarový zachytit
   * nemůže: cena se opisuje ručně a překlep o tři řády (`0.000015` místo `15`)
   * roztáhne dolarový strop milionkrát, aniž by si toho kdokoli všiml. Cena se
   * nedá ověřit na správnost, jen na tvar. Počet volání ano.
   */
  it('odmítne po vyčerpání počtu, i když dolary ještě zbývají', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1000, callCap: 3 });
    for (let i = 0; i < 3; i++) expect(cap.reserve(0.000_001).ok, `volání ${i + 1}`).toBe(true);

    const refused = cap.reserve(0.000_001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
    // Dolarový strop by tady pustil ještě zhruba miliardu volání.
    expect(refused.snapshot.remainingUsd).toBeGreaterThan(999);
  });

  it('odmítnuté volání počet nespotřebuje', () => {
    const cap = new SpendCap({ enabled: true, capUsd: 0.01, callCap: 2 });
    expect(cap.reserve(1).ok, 'rezervace nad dolarový strop měla být odmítnuta').toBe(false);
    expect(cap.snapshot().callsMade, 'odmítnuté volání se započítalo').toBe(0);
    expect(cap.reserve(0.001).ok).toBe(true);
    expect(cap.snapshot().callsMade).toBe(1);
  });

  it('detail pro operátora čísla nese — ořez pro veřejnost dělá routa', () => {
    // Vlastnost „ven nejdou čísla" se testuje na routě, ne tady: tenhle text je
    // jediná diagnostika, kterou operátor má, a kdyby si ho ořezával strop sám,
    // nepřišel by o ni jen útočník. Viz `PUBLIC_REFUSAL` v route.ts.
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 1 });
    cap.reserve(0.001);
    const refused = cap.reserve(0.001);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.detail).toMatch(/\d/);
  });

  it('vypnutý vypínač počet volání neomezuje, ale pořád ho počítá', () => {
    const cap = new SpendCap({ enabled: false, capUsd: 0, callCap: 1 });
    expect(cap.reserve(5).ok).toBe(true);
    expect(cap.reserve(5).ok, 'vypnutý strop odmítl volání').toBe(true);
    expect(cap.snapshot().callsMade).toBe(2);
  });

  it('chybějící hodnota v prostředí je výchozí strop, vadná je NULA', () => {
    expect(spendCapFromEnv({}).snapshot().callCap).toBe(DEFAULT_CALL_CAP);
    for (const broken of ['', 'hodně', '3.5', '-1']) {
      const cap = spendCapFromEnv({ WORLDSMITH_CALL_CAP: broken });
      expect(cap.snapshot().callCap, `${JSON.stringify(broken)} neskončilo nulou`).toBe(0);
      // Nula znamená zastavený provoz, ne „bez stropu".
      expect(cap.reserve(0.001).ok, `${JSON.stringify(broken)} pustilo volání`).toBe(false);
    }
  });

  it('vadný počet v ovládacím souboru je rozbitý vypínač, ne bez stropu', () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1, callCap: -4 }));
    const refused = new SpendCap({ enabled: true, capUsd: 1 }, path).reserve(0.001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CONTROL_UNREADABLE');
  });

  it('ovládací soubor bez počtu dál platí — starší soubory se nesmí rozbít', () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    expect(cap.reserve(0.001).ok).toBe(true);
    expect(cap.snapshot().callCap).toBe(DEFAULT_CALL_CAP);
  });
});
