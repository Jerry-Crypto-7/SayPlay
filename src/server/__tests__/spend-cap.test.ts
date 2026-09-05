import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { killState } from '../kill-switch';
import { mockBranch } from '../mock';
import type { GenerationCall } from '../pipeline';

import { readdirSync, readFileSync } from 'node:fs';

import {
  CAP_OFF_MAX_AGE_MS,
  costUsd,
  DEFAULT_CALL_CAP,
  DEFAULT_CAP_USD,
  processSpendCap,
  resetProcessSpendCap,
  SpendCap,
  spendCapFromEnv,
} from '../spend-cap';
// Okno ovládacího klíče je stav modulu (`CONTROL_CACHE_TTL_MS`); bez resetu
// by si dva testy sáhly do téhož letu a druhý by četl odpověď prvního.
import {
  __resetControlWindows,
  type ControlStore,
  memoryLedger,
  type SpendLedger,
} from '../spend-store';

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
  __resetControlWindows();
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
  it('odmítne volání, které by rozpočet přeteklo', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const refused = await cap.reserve(1.5);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CAP_EXHAUSTED');
    // Odmítnuté volání nesmí nic držet, jinak by strop tekl po každém odmítnutí.
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('volání přesně na strop projde — strop je mez, ne zákaz posledního dolaru', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    expect((await cap.reserve(1)).ok).toBe(true);
  });

  it('rozpracované volání drží svůj nejhorší případ ostatním', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const first = await cap.reserve(0.6);
    expect(first.ok).toBe(true);
    // Kdyby se počítala jen utracená částka, obě volání by prošla — v okamžiku
    // rozhodnutí totiž ani jedno ještě nic neutratilo.
    expect((await cap.reserve(0.6)).ok).toBe(false);
  });

  it('vyrovnání skutečnou cenou uvolní rozdíl proti odhadu', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = await cap.reserve(0.6);
    if (!reservation.ok) throw new Error('unreachable');
    await reservation.settle(0.1);
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.1, 10);
    expect(cap.snapshot().reservedUsd).toBe(0);
    expect((await cap.reserve(0.6)).ok).toBe(true);
  });

  it('neznámá cena se účtuje celým odhadem', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = await cap.reserve(0.6);
    if (!reservation.ok) throw new Error('unreachable');
    await reservation.settle('unknown');
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.6, 10);
    // Padající poskytovatel tím pádem není cesta, jak strop obejít.
    expect((await cap.reserve(0.6)).ok).toBe(false);
  });

  it('druhé vyrovnání téže rezervace nedělá nic', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const reservation = await cap.reserve(1);
    if (!reservation.ok) throw new Error('unreachable');
    await reservation.settle(0.5);
    await reservation.settle(0.5);
    await reservation.settle('unknown');
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.5, 10);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('záporná ohlášená cena účtuje rezervaci, ne nulu', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    const reservation = await cap.reserve(0.5);
    if (!reservation.ok) throw new Error('unreachable');
    await reservation.settle(-5);
    // Dřív se tady účtovala nula a test to tvrdil jako vlastnost. Nula ale
    // znamená, že poskytovatel, který ohlásí nesmysl, volá **zadarmo** — táž
    // díra jako u NaN, jen mírnější. Nesmyslná účtenka proto účtuje celou
    // rezervaci. Původní vlastnost (nikdy záporná útrata) platí dál.
    expect(cap.snapshot().spentUsd).toBe(0.5);
    expect(cap.snapshot().spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('NaN ani Infinity v účtence strop nevypnou', async () => {
    // Naměřeno revizí 21. 8. 2026: `Math.max(0, NaN)` je `NaN`, takže jediná
    // vadná účtenka otrávila součet a od té chvíle byla podmínka
    // `wouldHold > capUsd` napořád nepravda — strop byl do konce běhu procesu
    // vypnutý. Poskytovatel to spustí jediným `1e400` v `usage`.
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const cap = new SpendCap({ enabled: true, capUsd: 1 });
      const first = await cap.reserve(0.5);
      if (!first.ok) throw new Error('unreachable');
      await first.settle(poison);

      expect(Number.isFinite(cap.snapshot().spentUsd), `${String(poison)} otrávil součet`).toBe(true);
      const second = await cap.reserve(0.9);
      expect(second.ok, `po účtence ${String(poison)} strop pustil další volání`).toBe(false);
    }
  });

  it('odhad, který není konečné nezáporné číslo, volání odmítne', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 });
    // `NaN > cap` je `false`, takže bez téhle kontroly by prošlo cokoli a strop
    // by se choval jako vypnutý.
    for (const estimate of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const refused = await cap.reserve(estimate);
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('INVALID_ESTIMATE');
    }
  });
});

describe('vypínač mění chování za běhu, bez nové instance', () => {
  it('vypnutý strop pustí volání přes rozpočet a útratu pořád počítá', async () => {
    const path = controlFile(JSON.stringify({ enabled: false, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    const reservation = await cap.reserve(100);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('unreachable');
    await reservation.settle(100);
    expect(cap.snapshot().spentUsd).toBe(100);
  });

  it('zapnutí za běhu platí od dalšího rozhodnutí', async () => {
    const path = controlFile(JSON.stringify({ enabled: false, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    expect((await cap.reserve(100)).ok).toBe(true);

    writeFileSync(path, JSON.stringify({ enabled: true, capUsd: 1 }), 'utf8');
    expect((await cap.reserve(100)).ok).toBe(false);
  });

  // ⚠ **Tenhle případ tvrdil do 4. 9. 2026 přesný OPAK a byl přepsán, ne
  // smazán** (P15 `T30-capfloor`). Původně sliboval, že zvednutí částky
  // v souboru za běhu pustí volání, které předtím neprošlo — jenže přesně tím
  // byl soubor pákou, kterou jde strop tiše UVOLNIT. Od podlahy z prostředí
  // umí soubor jen přitahovat, takže se aserce obrátila: platí, co je nižší.
  // Vlastnost, kvůli které test vznikl — změna platí od dalšího rozhodnutí,
  // bez nové instance — se pinuje dál, jen v tom směru, který soubor smí.
  it('změna za běhu platí hned, ale nad podlahu z prostředí strop nezvedne', async () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 100 }));
    const cap = new SpendCap({ enabled: true, capUsd: 100 }, path);
    expect((await cap.reserve(50)).ok, 'výchozí strop neplatil').toBe(true);

    writeFileSync(path, JSON.stringify({ enabled: true, capUsd: 1 }), 'utf8');
    expect((await cap.reserve(50)).ok, 'utažení za běhu se neprojevilo').toBe(false);

    writeFileSync(path, JSON.stringify({ enabled: true, capUsd: 1000 }), 'utf8');
    expect(
      (await cap.reserve(500)).ok,
      'soubor zvedl strop nad podlahu z prostředí — to je celá vada T30-capfloor',
    ).toBe(false);
    expect(cap.snapshot().capUsd, 'účinná částka není min(soubor, výchozí)').toBe(100);
  });

  it('chybějící ovládací soubor znamená výchozí hodnoty, ne odmítnutí', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, controlFile(null));
    expect((await cap.reserve(0.5)).ok).toBe(true);
    expect(cap.snapshot().capUsd).toBe(1);
  });

  it('vadný ovládací soubor odmítá, nepokračuje bez stropu', async () => {
    for (const broken of [
      '{ not json',
      '{"enabled":"ano","capUsd":1}',
      '{"enabled":true,"capUsd":-1}',
      // Vyplněný nesmysl je pokus stropem hnout, který se nepovedl — na rozdíl
      // od mlčení níž. Obojí je „validní JSON objekt", a právě proto je to tady.
      '{"capUsd":"pět"}',
      '{"enabled":1,"off":["refine"]}',
      // Nález revize 3. 9. 2026: překlep v klíči je pokus utáhnout strop, ne
      // mlčení o něm. `capusd` malým „u" by jinak dalo výchozích 5 USD, tedy
      // 500násobek napsaného.
      '{"enabled":true,"capusd":0.01}',
      '{"enabled":true,"capUSD":0.01}',
      '{"callcap":1}',
      // Vypnutí stropu se musí napsat celé, jinak je to nejkratší cesta
      // k neomezenému utrácení.
      '{"enabled":false}',
      '{"enabled":false,"off":["refine"]}',
      // P15 T30-capsilence, nález druhé revize 3. 9. 2026: opačný směr je
      // stejně tichý. Nad `{"enabled":true,"capUsd":0.5}` stačí přidat vypínač
      // a zapomenout přepsat částku — `capUsd` skočí zpátky na výchozích 5 USD
      // a `reserve(2)` projde tam, kde před chvílí neprošlo. Zmínka o stropu se
      // proto musí napsat celá, ne jen jeho vypnutí. Platí i pro `callCap`:
      // kdo píše mez na počet volání, píše zjevně o stropu.
      '{"enabled":true,"off":["refine"]}',
      '{"enabled":true}',
      '{"callCap":10}',
      '{"callCap":10,"off":["refine"]}',
    ]) {
      const cap = new SpendCap({ enabled: true, capUsd: 100 }, controlFile(broken));
      const refused = await cap.reserve(0.01);
      expect(refused.ok, `${broken} prošlo`).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CONTROL_UNREADABLE');
    }
  });

  // P15 T30-offonlyfile. Soubor, kterým se vypíná jedna vrstva, o stropu mlčí —
  // a do 3. 9. 2026 tím zastavil celý provoz.
  describe('soubor, který o stropu mlčí, platí výchozí hodnoty', () => {
    it('`{"off":["refine"]}` nechá zakládání světů běžet na výchozím stropu', async () => {
      const path = controlFile(JSON.stringify({ off: ['refine'] }));
      const cap = new SpendCap({ enabled: true, capUsd: 7, callCap: 5 }, path);

      const reservation = await cap.reserve(0.01);
      expect(reservation.ok, 'vypnutí refine zastavilo i strop').toBe(true);
      expect(cap.snapshot().capUsd).toBe(7);
      expect(cap.snapshot().callCap).toBe(5);
      // A vypínač, kvůli kterému ten soubor vznikl, pořád platí.
      expect((await killState({ WORLDSMITH_CONTROL_FILE: path })).refine).toBe(true);
    });

    // ⚠ **Tenhle případ tvrdil do 4. 9. 2026 přesný OPAK a byl přepsán, ne
    // smazán.** Vznikl proto, aby zabil mutanta, který mez „vypnutí se musí
    // napsat celé" rozšířil na každou zmínku o `enabled` — tehdy to bylo
    // správně, protože mez měla krýt jen vypnutí. Druhá nezávislá revize
    // (P15 `T30-capsilence`) pak naměřila, že opačný směr je stejně tichý:
    // nad `{"enabled":true,"capUsd":0.5}` stačí soubor přepsat na
    // `{"enabled":true,"off":["refine"]}` a strop se sám zvedne na výchozích
    // 5 USD, bez jediného řádku v logu. **Ten mutant se tím stal kódem,
    // a aserce proto musí říkat opak.** Mlčení o celé peněžní půlce
    // (`{"off":[…]}`, `{}`) platí dál — to hlídají případy nad a pod tímhle.
    it('`{"enabled":true, off}` je rozbitý soubor: půlka zmínky o stropu nestačí', async () => {
      const path = controlFile(JSON.stringify({ enabled: true, off: ['refine'] }));
      const cap = new SpendCap({ enabled: true, capUsd: 7 }, path);

      const refused = await cap.reserve(0.01);
      expect(refused.ok, 'zmínka o stropu bez částky prošla').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CONTROL_UNREADABLE');
      // Rozbitý soubor pořád zastavuje placené dveře a nechává běžet čtení —
      // vypínač z něj se tedy čte dál, stejně jako u každého jiného rozbití.
      expect((await killState({ WORLDSMITH_CONTROL_FILE: path })).refine).toBe(true);
    });

    // **Napsaná nula je rozhodnutí, ne mlčení.** Zabíjí verzi, která by mez psala
    // přes pravdivostní hodnotu (`!capUsd`) místo `=== undefined` — nad ní by
    // `{"enabled":true,"capUsd":0}` spadlo do „soubor o stropu mlčí" a strop by
    // vyskočil na výchozích 5 USD právě ve chvíli, kdy ho někdo utáhl na nulu.
    // (Verzi „odmítej každý soubor bez `capUsd`" zabíjejí případy `{}`
    // a `{"off":[…]}` výš, ne tenhle — naměřeno mutací 4. 9. 2026.)
    it('napsaná nula je pojmenovaná částka, ne mlčení', async () => {
      const path = controlFile(JSON.stringify({ enabled: true, capUsd: 0 }));
      const cap = new SpendCap({ enabled: true, capUsd: 7 }, path);

      const refused = await cap.reserve(0.01);
      expect(refused.ok, 'napsaná nula se nepočítala jako částka').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CAP_EXHAUSTED');
    });

    it('prázdný objekt je mlčení, ne rozbitý vypínač', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 3 }, controlFile('{}'));
      expect((await cap.reserve(0.01)).ok).toBe(true);
      expect(cap.snapshot().capUsd).toBe(3);
    });

    // ⚠ **Tenhle případ tvrdil do 4. 9. 2026 „zbytek třídy je otevřený" a byl
    // přepsán, ne smazán** (P15 `T30-capfloor`). Mlčení pořád vrací výchozí
    // částku — to platit MUSÍ, jinak by zaniklo `T30-offonlyfile` — jenže
    // podlaha z prostředí mezitím udělala z výchozí částky **strop všeho, co
    // soubor kdy smí povolit**. Návrat k ní tedy už není zvednutí nad
    // nastavený rozpočet, a tím se ta třída zavřela o patro výš, ne uvnitř
    // `parseControl()`. Aserce proto pinuje obě půlky naráz: mlčení vrací
    // výchozí hodnotu, a víc než výchozí hodnotu soubor nedostane ani když si
    // o to výslovně řekne.
    it('mlčení vrátí výchozí částku, a ta je zároveň strop toho, co soubor smí', async () => {
      const path = controlFile(JSON.stringify({ capUsd: 0.5 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);
      expect((await cap.reserve(2)).ok, 'utažená částka neplatila').toBe(false);

      writeFileSync(path, JSON.stringify({ off: ['refine'] }), 'utf8');
      expect((await cap.reserve(2)).ok, 'mlčení nevrátilo výchozí částku').toBe(true);
      expect(cap.snapshot().capUsd).toBe(5);

      // A druhá půlka: výslovné zvednutí na tomtéž souboru nedostane víc.
      writeFileSync(path, JSON.stringify({ capUsd: 1000 }), 'utf8');
      expect(cap.snapshot().capUsd, 'soubor přebil podlahu z prostředí').toBe(5);
      const refused = await cap.reserve(100);
      expect(refused.ok, 'soubor si vyprosil 1000 USD nad rozpočtem 5 USD').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CAP_EXHAUSTED');
    });

    it('chybí jen jedna půlka: `capUsd` platí ze souboru, `enabled` z výchozích', async () => {
      const path = controlFile(JSON.stringify({ capUsd: 0.005, off: ['refine'] }));
      const cap = new SpendCap({ enabled: true, capUsd: 100 }, path);

      const refused = await cap.reserve(0.01);
      expect(refused.ok, 'strop ze souboru se neuplatnil').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CAP_EXHAUSTED');
    });

    it('vypnutý výchozí strop se souborem o `off` nezapne', async () => {
      const path = controlFile(JSON.stringify({ off: ['upstream'] }));
      const cap = new SpendCap({ enabled: false, capUsd: 0 }, path);
      expect((await cap.reserve(100)).ok, 'mlčení souboru zapnulo vypnutý strop').toBe(true);
    });
  });

  // P15 `T30-capfloor`. Účinný strop je `min(soubor, výchozí)` — soubor umí
  // strop jen přitahovat, nikdy uvolňovat. Podlaha je jediná obrana proti
  // tomu, aby se ztrátou nebo přepsáním souboru dal strop dostat NAD rozpočet,
  // který někdo napsal vědomě do prostředí a mění se jen redeployem.
  describe('soubor umí strop jen přitáhnout, ne uvolnit', () => {
    it('utažená částka ze souboru platí — podlaha nebrání směru dolů', async () => {
      const path = controlFile(JSON.stringify({ capUsd: 0.5 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

      expect(cap.snapshot().capUsd).toBe(0.5);
      const refused = await cap.reserve(2);
      expect(refused.ok, 'utažení souborem se neprojevilo').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CAP_EXHAUSTED');
    });

    it('`callCap` ze souboru se uřízne na výchozí hodnotu konstruktoru', async () => {
      const path = controlFile(JSON.stringify({ capUsd: 5, callCap: 1000 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5, callCap: 2 }, path);

      expect(cap.snapshot().callCap, 'soubor zvedl počet volání nad výchozí').toBe(2);
      expect((await cap.reserve(0.001)).ok).toBe(true);
      expect((await cap.reserve(0.001)).ok).toBe(true);
      const refused = await cap.reserve(0.001);
      expect(refused.ok, 'třetí volání prošlo přes strop dvou').toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
    });

    // Když výchozí `callCap` vyplněný není, doopravdy platí `DEFAULT_CALL_CAP`
    // (dosazuje ho `snapshot()` i `reserve()`), takže podlahou musí být ono —
    // jinak by `{"callCap":1000}` zvedlo účinný strop z 200 na 1000 nad každým
    // konstruktorem, který počet volání neřešil. To je většina z nich.
    it('bez výchozího `callCap` je podlahou DEFAULT_CALL_CAP, ne částka ze souboru', () => {
      const path = controlFile(JSON.stringify({ capUsd: 5, callCap: DEFAULT_CALL_CAP + 800 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

      expect(cap.snapshot().callCap, 'soubor přebil DEFAULT_CALL_CAP').toBe(DEFAULT_CALL_CAP);
    });

    it('nižší `callCap` ze souboru platí i bez výchozí hodnoty', () => {
      const path = controlFile(JSON.stringify({ capUsd: 5, callCap: 3 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

      expect(cap.snapshot().callCap).toBe(3);
    });

    // ⚠ **Vědomá výjimka, ne díra** (`T30-callcapoff`). Podlaha zavírá tiché
    // uvolnění ČÍSLEM; `enabled:false` je napsaný povel „utrácej bez meze"
    // a mlčením nikdy nevznikne — bez `capUsd` je to rozbitý soubor. Kdyby
    // podlaha zavřela i tohle, spadl by pinovaný test v `upstream.test.ts`
    // („`enabled: false` provoz nezastaví, jen přestane odmítat").
    it('`enabled:false` v souboru strop pořád vypne, podlaha na něj neplatí', async () => {
      const path = controlFile(JSON.stringify({ enabled: false, capUsd: 0 }));
      const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

      expect((await cap.reserve(100)).ok, 'vypnutí souborem přestalo platit').toBe(true);
    });
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
    // Částka je schválně POD výchozími 5 USD: od podlahy z prostředí
    // (`T30-capfloor`) by se 42 uřízlo na 5 a test by tvrdil, že soubor nikdo
    // nečetl. Tohle je test o cestě, ne o číslu.
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 0.42 }));
    expect(spendCapFromEnv({ WORLDSMITH_CONTROL_FILE: path }).snapshot().capUsd).toBe(0.42);
  });

  it('staré jméno proměnné pořád platí, protože ho nese nasazení z doby před přejmenováním', () => {
    // **Nález nezávislé revize 3. 9. 2026, `VERDICT: blocking`.** Přejmenování
    // `WORLDSMITH_SPEND_CAP_FILE` → `WORLDSMITH_CONTROL_FILE` bez záchytu
    // znamená, že nasazení se starým jménem přestane soubor vidět v okamžiku
    // deploye: strop se tiše vrátí na výchozích 5 USD a operátorovo „vypnuto"
    // se stane mrtvým dopisem, aniž vznikne jediný řádek.
    // Soudí se `snapshot()`, ne `reserve()`: rezervace zapisuje do sdílené
    // knihy, takže by tenhle test utratil cent v každém testu za sebou.
    const path = controlFile(JSON.stringify({ enabled: false, capUsd: 0 }));
    const cap = spendCapFromEnv({ WORLDSMITH_SPEND_CAP_FILE: path }).snapshot();

    expect(cap.capUsd).toBe(0);
    expect(cap.enabled).toBe(false);
  });

  it('prázdné nové jméno staré nezastíní', () => {
    // `.env.example` ships řádek `WORLDSMITH_CONTROL_FILE=` a vymazané políčko
    // v dashboardu dá totéž. S `??` by prázdný řetězec platil za „nastaveno",
    // ukázal na neexistující soubor a strop by se tiše vrátil na výchozích
    // 5 USD — tedy přesně ta vada, kterou záchyt zavírá.
    const legacy = controlFile(JSON.stringify({ enabled: false, capUsd: 0 }));
    const cap = spendCapFromEnv({
      WORLDSMITH_CONTROL_FILE: '',
      WORLDSMITH_SPEND_CAP_FILE: legacy,
    }).snapshot();

    expect(cap.capUsd).toBe(0);
    expect(cap.enabled).toBe(false);
  });

  it('nové jméno má přednost, když jsou nastavená obě', () => {
    // Obě částky jsou pod výchozími 5 USD — s podlahou z prostředí
    // (`T30-capfloor`) by se 42 i 7 uřízly na tutéž pětku a test by přestal
    // rozlišovat, které jméno vyhrálo.
    const current = controlFile(JSON.stringify({ enabled: true, capUsd: 0.42 }));
    const legacy = controlFile(JSON.stringify({ enabled: true, capUsd: 0.07 }));

    expect(
      spendCapFromEnv({
        WORLDSMITH_CONTROL_FILE: current,
        WORLDSMITH_SPEND_CAP_FILE: legacy,
      }).snapshot().capUsd,
    ).toBe(0.42);
  });
});

describe('strop na počet volání drží i tehdy, když je ceník opsaný špatně', () => {
  /**
   * Tenhle strop je tu kvůli jedné konkrétní vadě, kterou dolarový zachytit
   * nemůže: cena se opisuje ručně a překlep o tři řády (`0.000015` místo `15`)
   * roztáhne dolarový strop milionkrát, aniž by si toho kdokoli všiml. Cena se
   * nedá ověřit na správnost, jen na tvar. Počet volání ano.
   */
  it('odmítne po vyčerpání počtu, i když dolary ještě zbývají', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1000, callCap: 3 });
    for (let i = 0; i < 3; i++) expect((await cap.reserve(0.000_001)).ok, `volání ${i + 1}`).toBe(true);

    const refused = await cap.reserve(0.000_001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
    // Dolarový strop by tady pustil ještě zhruba miliardu volání.
    expect(refused.snapshot.remainingUsd).toBeGreaterThan(999);
  });

  it('odmítnuté volání počet nespotřebuje', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 0.01, callCap: 2 });
    expect((await cap.reserve(1)).ok, 'rezervace nad dolarový strop měla být odmítnuta').toBe(false);
    expect(cap.snapshot().callsMade, 'odmítnuté volání se započítalo').toBe(0);
    expect((await cap.reserve(0.001)).ok).toBe(true);
    expect(cap.snapshot().callsMade).toBe(1);
  });

  it('detail pro operátora čísla nese — ořez pro veřejnost dělá routa', async () => {
    // Vlastnost „ven nejdou čísla" se testuje na routě, ne tady: tenhle text je
    // jediná diagnostika, kterou operátor má, a kdyby si ho ořezával strop sám,
    // nepřišel by o ni jen útočník. Viz `PUBLIC_REFUSAL` v route.ts.
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 1 });
    await cap.reserve(0.001);
    const refused = await cap.reserve(0.001);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.detail).toMatch(/\d/);
  });

  it('`enabled:false` vypíná obě meze: počet volání neomezuje, ale pořád ho počítá', async () => {
    // Rozhodnutí P15 `T30-callcapoff`, ne opomenutí: strop na počet je
    // nezávislý na CENÍKU, ne na vypínači. `enabled:false` je vědomý povel
    // „utrácej bez meze"; nouzová brzda jsou kill switche (`off`). Kdyby počet
    // držel i při vypnutém stropu, `callCap:0` by z `enabled:false` udělalo
    // úplnou zastávku provozu — a to pinuje jako nežádoucí `upstream.test.ts`
    // („`enabled: false` provoz nezastaví, jen přestane odmítat"). Hlavička
    // `CALL_CAP_EXHAUSTED` v `spend-cap.ts` říká totéž; tenhle test hlídá,
    // že se od ní chování neodchýlí.
    const cap = new SpendCap({ enabled: false, capUsd: 0, callCap: 1 });
    expect((await cap.reserve(5)).ok).toBe(true);
    expect((await cap.reserve(5)).ok, 'vypnutý strop odmítl volání').toBe(true);
    expect(cap.snapshot().callsMade).toBe(2);
  });

  it('chybějící hodnota v prostředí je výchozí strop, vadná je NULA', async () => {
    expect(spendCapFromEnv({}).snapshot().callCap).toBe(DEFAULT_CALL_CAP);
    for (const broken of ['', 'hodně', '3.5', '-1']) {
      const cap = spendCapFromEnv({ WORLDSMITH_CALL_CAP: broken });
      expect(cap.snapshot().callCap, `${JSON.stringify(broken)} neskončilo nulou`).toBe(0);
      // Nula znamená zastavený provoz, ne „bez stropu".
      expect((await cap.reserve(0.001)).ok, `${JSON.stringify(broken)} pustilo volání`).toBe(false);
    }
  });

  it('vadný počet v ovládacím souboru je rozbitý vypínač, ne bez stropu', async () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1, callCap: -4 }));
    const refused = await new SpendCap({ enabled: true, capUsd: 1 }, path).reserve(0.001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CONTROL_UNREADABLE');
  });

  it('ovládací soubor bez počtu dál platí — starší soubory se nesmí rozbít', async () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, path);
    expect((await cap.reserve(0.001)).ok).toBe(true);
    expect(cap.snapshot().callCap).toBe(DEFAULT_CALL_CAP);
  });

  // Druhá strana téhož: soubor, který počet **vyplní**, přebíjí výchozí hodnotu.
  // Bez téhle aserce projde i verze, která soubor přečte a pak ho zahodí —
  // naměřeno mutací 3. 9. 2026, přežila pátý mutant `T30-offonlyfile`.
  it('počet ze souboru přebíjí výchozí hodnotu, a platí hned', async () => {
    const path = controlFile(JSON.stringify({ enabled: true, capUsd: 1000, callCap: 1 }));
    const cap = new SpendCap({ enabled: true, capUsd: 1000, callCap: 9 }, path);

    expect(cap.snapshot().callCap).toBe(1);
    expect((await cap.reserve(0.001)).ok).toBe(true);
    const refused = await cap.reserve(0.001);
    expect(refused.ok, 'počet ze souboru se neuplatnil').toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
  });
});

/**
 * **Volání zdarma nesmí spotřebovat strop na placená volání.**
 *
 * Nález nezávislé revize 31. 8. 2026 nad commitem `df6f997`. `mock/index.ts`
 * o sobě v komentáři tvrdí, že „strop tuhle větev nikdy neodmítne, protože
 * odmítat cestu, která neutrácí, by demo jen shodilo" — a to tvrzení bylo
 * nepravdivé: `#callsMade` rostl při **každé** povolené rezervaci, tedy i při
 * nulové. Offline větev je přitom výchozí, takže nasazené demo umřelo po dvou
 * stech větách při útratě 0 USD.
 *
 * Nulu si sada nepíše sama — bere ji z **opravdové** offline větve. Kdyby jí
 * někdo cenu dal, tahle sada se ozve, místo aby dál měřila konstantu.
 */
describe('strop na počet volání počítá jen placená volání', () => {
  const FREE_CALL: GenerationCall = {
    prompt: 'a spiral library where the stairs are the shelves',
    request: { model: 'mock', system: 'system', user: 'user' },
  };
  const freeWorstCase = mockBranch().worstCaseUsd(FREE_CALL);

  it('offline větev doopravdy nic nestojí — jinak tenhle popis neplatí', () => {
    expect(freeWorstCase).toBe(0);
  });

  it('dvě stě vět do offline dema strop nevyčerpá', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: DEFAULT_CAP_USD, callCap: DEFAULT_CALL_CAP });
    for (let i = 0; i <= DEFAULT_CALL_CAP; i++)
      expect((await cap.reserve(freeWorstCase)).ok, `věta ${i + 1} dostala 429`).toBe(true);

    expect(cap.snapshot().callsMade, 'volání zdarma se započítala').toBe(0);
    expect(cap.snapshot().callsRemaining).toBe(DEFAULT_CALL_CAP);
  });

  it('placené volání se počítá dál a strop pořád drží', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1000, callCap: 3 });
    for (let i = 0; i < 3; i++) expect((await cap.reserve(0.000_001)).ok, `volání ${i + 1}`).toBe(true);

    const refused = await cap.reserve(0.000_001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
  });

  it('volání zdarma nezkrátí rozpočet těm placeným', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 1000, callCap: 2 });
    for (let i = 0; i < 50; i++) await cap.reserve(freeWorstCase);

    expect((await cap.reserve(0.001)).ok, 'první placené').toBe(true);
    expect((await cap.reserve(0.001)).ok, 'druhé placené').toBe(true);
    const refused = await cap.reserve(0.001);
    expect(refused.ok, 'třetí placené mělo být odmítnuto').toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
    expect(cap.snapshot().callsMade).toBe(2);
  });
});

describe('druhé vyrovnání téže rezervace', () => {
  it('vrátí totéž číslo jako to první a stropem nehne', async () => {
    // Kontrakt, který od 1. 9. 2026 stojí v docstringu `settle()`. Bez tohohle
    // testu ho nedrželo nic: mutace na `return 0` nechala celou sadu zelenou.
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const reservation = await cap.reserve(1);
    if (!reservation.ok) throw new Error('rezervace měla projít');

    expect(await reservation.settle(0.25)).toBe(0.25);
    // Druhé vyrovnání s úplně jiným číslem nesmí přepsat ani odpověď, ani strop.
    expect(await reservation.settle(9)).toBe(0.25);
    expect(cap.snapshot().spentUsd).toBe(0.25);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });
});

describe('jediný strop procesu', () => {
  afterEach(() => {
    resetProcessSpendCap();
  });

  it('vrátí pořád tutéž instanci, ne novou při každém volání', async () => {
    // **Dvě instance nejsou strop.** Každá si vede vlastní `#spentUsd`, takže
    // proces se dvěma z nich utratí dvojnásobek nastaveného stropu a obě
    // půlky přitom hlásí, že strop dodržely. Naměřeno nezávislou revizí
    // 3. 9. 2026 nad `/api/generate` a `/api/worldstream/sessions`.
    // Soudí se **sdílený stav**, ne reference: kdyby singleton vracel kopii se
    // stejnými čísly, test nad `toBe` by prošel a vada by zůstala.
    const first = processSpendCap();
    const reservation = await first.reserve(1);
    if (!reservation.ok) throw new Error('rezervace měla projít');
    await reservation.settle(1);

    expect(processSpendCap().snapshot().spentUsd).toBe(1);
  });

  it('žádná route si strop nevyrábí sama — chodí se přes singleton', () => {
    // Lexikální brána, protože tuhle vlastnost nejde zevnitř jednoho procesu
    // změřit: Next dává každé route vlastní bundle a test běží v jednom.
    // Kdyby si route zavolala `spendCapFromEnv()` sama, dostane vlastní
    // čítač a strop procesu přestane být strop.
    //
    // Prohledává se **celý produkční `src/`**, ne seznam dvou rout: revize
    // 3. 9. 2026 ukázala, že seznam nevidí třetí placenou routu ani pomocný
    // modul, který si strop postaví přes `new SpendCap(...)` místo přes
    // `spendCapFromEnv()`. Jediné místo, kde smí strop vzniknout, je
    // `spend-cap.ts` sám; testy se vynechávají, protože si stropy staví schválně.
    const stripComments = (code: string) =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const production = (readdirSync('src', { recursive: true }) as string[])
      .map((entry) => entry.replaceAll('\\', '/'))
      .filter((entry) => /\.tsx?$/.test(entry) && !entry.includes('__tests__'))
      .map((entry) => `src/${entry}`)
      .filter((path) => path !== 'src/server/spend-cap.ts');
    expect(production.length, 'sken produkčního src je prázdný').toBeGreaterThan(50);

    for (const path of production) {
      // **Komentáře se odstřihnou.** Jméno `spendCapFromEnv` v docstringu je
      // poctivé — vysvětluje, proč se sem přes něj nechodí — a brána, kterou
      // shodí vlastní komentář, je falešný poplach, ne ochrana.
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${path} si vyrábí vlastní strop přes spendCapFromEnv`).not.toContain('spendCapFromEnv(');
      expect(code, `${path} si vyrábí vlastní strop přes new SpendCap`).not.toContain('new SpendCap(');
      // Reset patří testům: po něm by routy držely starý strop a singleton vydával nový.
      expect(code, `${path} resetuje strop procesu`).not.toContain('resetProcessSpendCap(');
    }

    // A obě placené routy přes singleton chodí doopravdy, ne jen „nevyrábějí".
    for (const route of ['src/app/api/generate/route.ts', 'src/app/api/worldstream/sessions/route.ts'])
      expect(stripComments(readFileSync(route, 'utf8')), `${route} nechodí přes singleton`).toContain(
        'processSpendCap()',
      );
  });

  // P15 `T30-capfloor`, druhé kolo nezávislé revize 4. 9. 2026. Postup zotavení
  // z opuštěné rezervace stojí v repu ve **třech** kopiích a rozešel se už
  // dvakrát: podlaha z prostředí z rady „zvedni `capUsd` v ovládacím souboru"
  // udělala tichý no-op a první oprava přepsala jen jednu z těch tří. Je to
  // tvrzení o textu pro člověka, takže ho žádný běhový test nezkontroluje.
  //
  // **Předchozí podoba téhle brány byla blocklist zvedacích sloves a byla
  // nahrazena, ne rozšířena.** Měla dvě potvrzené vady: obejít se dala pořadím
  // slov, vsuvkou přes okno nebo anglickým „increase", a naopak **červenala na
  // správně napsaném záporu** („nejde zvednout `capUsd` v souboru"), tedy přesně
  // na té větě, kterou má oprava obsahovat.
  //
  // ⚠ **Návrh revize — „pinuj kladné tvrzení: blok musí nést
  // WORLDSMITH_SPEND_CAP_USD" — se změřil a NEPOSTAVIL.** Nad skutečným
  // historickým textem chytí **1 ze 3** vadných bloků: `spend-store.ts`
  // i `.env.example` proměnnou už tehdy jmenovaly, jen jako vercelskou
  // záložní cestu pod radou o souboru. Značka `T30-capfloor` chytí **3 ze 3**,
  // protože ta v žádném z nich být nemohla — vznikla až s podlahou.
  //
  // Co se tím vzdává, napsané nahlas: nová **čtvrtá** kopie v souboru, který
  // tady není vyjmenovaný, projde. Revize prošla všechny git-tracked soubory
  // a čtvrtou kopii nenašla, a nová by přišla s vlastní revizí.
  it('všechny tři popisy zotavení vědí, že soubor strop nezvedne', () => {
    const bloky = [
      ['src/server/spend-store.ts', 'Zotavení je ruční'],
      ['src/app/api/worldstream/sessions/route.ts', 'Zotavení pak není mazání klíče'],
      ['.env.example', 'POSTUP PŘI INCIDENTU'],
    ] as const;

    for (const [path, kotva] of bloky) {
      const text = readFileSync(path, 'utf8');
      const start = text.indexOf(kotva);
      expect(start, `${path}: kotva „${kotva}" zmizela — oprav kotvu, ne test`).toBeGreaterThan(-1);
      // Okno je 900 znaků, tedy celý odstavec postupu i s odůvodněním.
      const blok = text.slice(start, start + 900);
      expect(blok, `${path}: postup zotavení nejmenuje jedinou páku nahoru`).toContain(
        'WORLDSMITH_SPEND_CAP_USD',
      );
      expect(
        blok,
        `${path}: postup zotavení neví o podlaze — dopiš, že ovládacím souborem ` +
          'to od T30-capfloor nejde',
      ).toContain('T30-capfloor');
    }
  });

  // P15 `T30-capoffbound`. Vypnutí stropu je jediný povel, který peněženku
  // otevírá, a `.env.example` je jediné místo, kde se operátor za incidentu
  // dočte, jak dlouho to vypnutí vydrží. Do 5. 9. 2026 tam stálo „Nic to samo
  // neukončí." a byla to pravda; od meze na stáří je to lež, která stojí
  // peníze. Kotva je nadpis, který je tam OD DŘÍV — tvrzení se tím pinuje,
  // ne opakuje.
  it('rada o vypnutí stropu ví, že vypnutí vyprší', () => {
    const text = readFileSync('.env.example', 'utf8');
    const kotva = 'VYPNUTÍ JE VÝJIMKA';
    const start = text.indexOf(kotva);
    expect(start, `kotva „${kotva}" zmizela — oprav kotvu, ne test`).toBeGreaterThan(-1);

    // Okno je celá sekce o vypnutí i s odůvodněním, ne jen odstavec.
    const blok = text.slice(start, start + 1600);
    expect(blok, 'rada o vypnutí neříká, že okno má konec').toContain('T30-capoffbound');
    expect(blok, 'rada o vypnutí nepojmenovává délku okna').toMatch(/30 minut/);
  });
});

/**
 * **Strop nad SDÍLENOU knihou — to, kvůli čemu P15 T29 vznikla.**
 *
 * Do 3. 9. 2026 si `SpendCap` vedl součty v poli instance, takže platil přesně
 * tak daleko, jak sahá jeden proces. `vercel.json` nasazuje serverless: každá
 * studená instance je nový proces s plným zůstatkem, tedy dvacet lambd znamená
 * až dvacetinásobek nastaveného stropu. Naměřila to nezávislá revize
 * 31. 8. 2026 a je to jediný důvod, proč `./spend-store.ts` existuje.
 *
 * Autoritou je od té doby kniha. Testy níž proto **staví dva stropy nad jednou
 * knihou** — to je věrná náhrada za dvě instance nad jedním úložištěm a jediná,
 * kterou lze uvnitř jednoho procesu postavit.
 */
describe('strop drží i za hranicí jedné instance', () => {
  it('druhá instance vidí, co utratila první — restart procesu strop neresetuje', async () => {
    const ledger = memoryLedger();
    const first = new SpendCap({ enabled: true, capUsd: 1 }, null, ledger);
    const reservation = await first.reserve(0.9);
    if (!reservation.ok) throw new Error('rezervace měla projít');
    await reservation.settle(0.9);

    // Studený start: nová instance, tatáž kniha. Kdyby si stav vedla sama,
    // začne na nule a pustí další celý rozpočet.
    const second = new SpendCap({ enabled: true, capUsd: 1 }, null, ledger);
    expect((await second.reserve(0.9)).ok, 'studený start koupil rozpočet znovu').toBe(false);
  });

  it('počet volání přežije studený start stejně jako dolary', async () => {
    const ledger = memoryLedger();
    const control = { enabled: true, capUsd: 1000, callCap: 2 };
    await new SpendCap(control, null, ledger).reserve(0.001);
    await new SpendCap(control, null, ledger).reserve(0.001);

    const refused = await new SpendCap(control, null, ledger).reserve(0.001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CALL_CAP_EXHAUSTED');
  });

  /**
   * **Break-it-on-purpose z plánu:** dva paralelní požadavky na poslední kredit,
   * právě jeden smí projít.
   *
   * Pořadí uvnitř `reserve()` je „přičti, podívej se, případně vrať". Kdyby to
   * bylo „přečti, rozmysli, zapiš", oba požadavky přečtou týž zůstatek, oba se
   * pod strop vejdou a poslední kredit se prodá dvakrát.
   */
  it('dva souběžné požadavky na poslední kredit: projde právě jeden', async () => {
    const ledger = memoryLedger();
    const control = { enabled: true, capUsd: 1 };
    const [first, second] = await Promise.all([
      new SpendCap(control, null, ledger).reserve(1),
      new SpendCap(control, null, ledger).reserve(1),
    ]);

    expect([first.ok, second.ok].filter(Boolean).length, 'poslední kredit se prodal dvakrát').toBe(1);
  });

  it('odmítnutá rezervace se knize vrátí, jinak by strop po odmítnutí tekl', async () => {
    const ledger = memoryLedger();
    const cap = new SpendCap({ enabled: true, capUsd: 1 }, null, ledger);
    expect((await cap.reserve(5)).ok).toBe(false);

    // Kniha musí být zpátky na nule — jak v dolarech, tak v počtu volání.
    expect(await ledger.add(0, 0)).toEqual({ usd: 0, calls: 0 });
    // A snapshot to musí říkat taky: je to jediná diagnostika, kterou strop
    // vydává, a odmítnutí ji nese s sebou.
    expect(cap.snapshot().spentUsd).toBe(0);
    expect(cap.snapshot().callsMade).toBe(0);
  });

  /**
   * **Výpadek knihy je odmítnutí, ne průchod.**
   *
   * Neznámý zůstatek je přesně ten stav, ve kterém se placené volání dělat nemá.
   * Opačná volba by z výpadku úložiště udělala způsob, jak strop vypnout.
   */
  it('kniha, která neodpoví, volání odmítne', async () => {
    const broken: SpendLedger = {
      id: 'broken',
      add: () => Promise.reject(new Error('store is down')),
    };
    const refused = await new SpendCap({ enabled: true, capUsd: 100 }, null, broken).reserve(0.01);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('LEDGER_UNAVAILABLE');
    // Jméno knihy patří operátorovi; ven ho ořezává `PUBLIC_REFUSAL` v routě.
    expect(refused.detail).toContain('broken');
  });

  it('serverless bez sdíleného úložiště neudělá placené volání vůbec', async () => {
    const refused = await spendCapFromEnv({ VERCEL: '1' }).reserve(0.01);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('STORE_UNCONFIGURED');
  });

  it('serverless SE sdíleným úložištěm placené volání pustí', async () => {
    const cap = spendCapFromEnv({
      VERCEL: '1',
      WORLDSMITH_SPEND_STORE_URL: 'https://ledger.example.com',
      WORLDSMITH_SPEND_STORE_TOKEN: 'token',
      WORLDSMITH_SPEND_CAP_USD: '5',
    });
    // Kniha přes REST by tady letěla ven; test soudí jen to, že se strop
    // nezastaví na `STORE_UNCONFIGURED`. Samotnou rouru měří `spend-store.test.ts`.
    const attempt = await cap.reserve(0.01);
    if (attempt.ok) return;
    expect(attempt.reason).not.toBe('STORE_UNCONFIGURED');
  });

  /**
   * **`snapshot()` musí vydat strop, který doopravdy platí** (P15
   * `T30-snapshotstale`).
   *
   * Na serverless žádný ovládací soubor není, takže dokud `snapshot()` četl
   * výhradně disk, vracel pokaždé výchozí hodnoty — a jediný provozní
   * konzument (`accountingStepUsd()` v `/api/generate`) podle nich odvozuje
   * zrnitost účetního logu. Operátor přetáhl strop sdíleným klíčem a číslo
   * v logu ho dál sledovat přestalo, aniž o tom cokoli řeklo.
   *
   * Soudí se to **nad obchodem bez souboru**, tedy přesně v prostředí, kde ta
   * vada byla; s cestou k souboru by test prošel i před opravou.
   */
  it('strop ze sdíleného klíče se v `snapshot()` objeví po rezervaci', async () => {
    const store: ControlStore = {
      id: 'test',
      key: 'worldsmith:spend:control',
      read: () => Promise.resolve('{"enabled":true,"capUsd":0.5}'),
    };
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, null, memoryLedger(), store);

    // Před první rezervací platí záloha: soubor neexistuje, takže výchozí strop.
    expect(cap.snapshot().capUsd).toBe(5);

    const reserved = await cap.reserve(0.01);
    expect(reserved.ok).toBe(true);

    // A teď to, o co jde: rozhodovalo se stropem 0,5 USD a `snapshot()` to říká.
    expect(cap.snapshot().capUsd).toBe(0.5);
    // Zbytek se počítá z platného stropu, ne z výchozího.
    expect(cap.snapshot().remainingUsd).toBeCloseTo(0.49, 10);
  });

  it('odmítnutá rezervace je taky rozhodnutí a `snapshot()` ho vydá', async () => {
    const store: ControlStore = {
      id: 'test',
      key: 'worldsmith:spend:control',
      read: () => Promise.resolve('{"enabled":true,"capUsd":0.25}'),
    };
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, null, memoryLedger(), store);

    const refused = await cap.reserve(9);
    expect(refused.ok).toBe(false);
    expect(cap.snapshot().capUsd).toBe(0.25);
  });

  /**
   * **Rozbitý povel se pamatuje taky — a je to ta zajímavější půlka.**
   *
   * Napsané schválně po přeživším mutantovi: `if (outcome.kind === 'ok')` kolem
   * zápisu prošlo oběma testy výš, protože v obou byl povel čitelný. Rozbitý
   * ovládací klíč přitom rezervaci **odmítne**, takže je to rozhodnutí jako
   * každé jiné — a `snapshot()` po něm nesmí ukazovat strop ze zálohy, jako by
   * pořád platil. `capUsd: 0` je tu správná odpověď: neplatí žádný.
   */
  it('rozbitý povel `snapshot()` nepřebije zálohou ze souboru', async () => {
    const store: ControlStore = {
      id: 'test',
      key: 'worldsmith:spend:control',
      read: () => Promise.reject(new Error('the store is down')),
    };
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, null, memoryLedger(), store);

    const refused = await cap.reserve(0.01);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CONTROL_UNREADABLE');
    expect(cap.snapshot().capUsd).toBe(0);
  });
});

describe('rezervace, která se nevyrovná, drží peníze — a snapshot to musí ukázat', () => {
  /**
   * `reservedUsd` je jediné číslo ve `snapshot()`, které neurčuje kniha: měří
   * vlastnost volajícího („každá cesta ven svou rezervaci vyrovnala"), ne
   * zůstatek. Nevyrovnaná rezervace drží peníze až do konce procesu a strop se
   * sám utáhne — naměřeno v `runPipeline` 1. 9. 2026.
   */
  it('drží, dokud se nevyrovná, a pak je nula', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const reservation = await cap.reserve(2);
    if (!reservation.ok) throw new Error('rezervace měla projít');

    expect(cap.snapshot().reservedUsd, 'rozpracovaná rezervace nedrží nic').toBe(2);
    await reservation.settle(0.5);
    expect(cap.snapshot().reservedUsd, 'vyrovnaná rezervace pořád drží').toBe(0);
  });

  it('odečítá se jednou, ne při každém dalším vyrovnání', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10 });
    const reservation = await cap.reserve(2);
    if (!reservation.ok) throw new Error('rezervace měla projít');

    await reservation.settle(0.5);
    await reservation.settle(0.5);
    // Kdyby se odečítalo pokaždé, spadne to do záporu a aserce
    // `reservedUsd === 0` napříč `src/server/__tests__` přestanou něco měřit.
    expect(cap.snapshot().reservedUsd).toBe(0);
  });
});

/**
 * **Chladný start si rozpočet nekoupí znovu** (P15 `T9-capcoldstart`).
 *
 * Vada, kterou to zavírá: `spend-cap.ts` držel součty v poli instance, takže
 * každý nový proces startoval s plnými 5 USD a 200 voláními. Na Vercelu je
 * chladný start běžná událost, ne výjimka — a ceník je z veřejného repa
 * dopočitatelný, takže „počkej si na novou instanci" byla dostupná cesta, jak
 * strop obejít.
 *
 * Jede se přes **`httpLedger`**, ne přes knihu v paměti: paměťová varianta by
 * dokazovala jen to, že dva stropy sdílejí jeden objekt, kdežto tohle prochází
 * skutečným kódem adaptéru — serializací příkazů, rourou i čtením odpovědi.
 * Sdílené úložiště nahrazuje počítadlo v uzávěru, protože Redis samotný tu
 * netestujeme; testuje se, že strop **nemá vlastní paměť**.
 *
 * ⚠ **Co tenhle test NEpokrývá:** že si routa vytáhne prostředí až při načtení.
 * To drží lexikální brána „žádná route si strop nevyrábí sama" o kus výš.
 */
describe('chladný start rozpočet neresetuje', () => {
  /**
   * Úložiště jako uzávěr: dva klíče, dvě operace, tentýž protokol jako roura.
   *
   * ⚠ **Od `T30-controllever` umí i ovládací klíč**, protože do téhož obchodu
   * chodí i čtení vypínačů a stropu (`GET /get/…:control`). Dvojník, který
   * odpoví jen na rouru, by na tom čtení hodil pipeline-tvar, strop by ho
   * přečetl jako rozbitý povel a každá rezervace by skončila
   * `CONTROL_UNREADABLE` — tedy z docela jiného důvodu, než ten test měří.
   */
  function fakeStore(control: string | null = null) {
    const keys = new Map<string, number>();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      // Ovládací klíč se čte `GET`em, tedy bez těla. `null` je „nikdo
      // vypínačem nehnul", což je výchozí stav všech případů níž.
      if (init?.body === undefined)
        return new Response(JSON.stringify({ result: control }), {
          headers: { 'content-type': 'application/json' },
        });

      const commands = JSON.parse(String(init?.body)) as [string, string, string][];
      const answers = commands.map(([, key, delta]) => {
        const next = (keys.get(key) ?? 0) + Number(delta);
        keys.set(key, next);
        return { result: String(next) };
      });
      return new Response(JSON.stringify(answers), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { keys, fetchImpl };
  }

  const SERVERLESS_ENV = {
    VERCEL: '1',
    WORLDSMITH_SPEND_STORE_URL: 'https://ledger.example.com',
    WORLDSMITH_SPEND_STORE_TOKEN: 'token',
    WORLDSMITH_SPEND_CAP_USD: '1',
  };

  it('druhý start nad týmž úložištěm dostane odmítnutí, ne čerstvý rozpočet', async () => {
    const store = fakeStore();
    vi.stubGlobal('fetch', store.fetchImpl);
    try {
      // První instance spotřebuje rozpočet.
      const first = spendCapFromEnv(SERVERLESS_ENV);
      const held = await first.reserve(0.9);
      if (!held.ok) throw new Error('první rezervace měla projít');
      await held.settle(0.9);

      // Chladný start: nová instance, tytéž proměnné, tytéž klíče v úložišti.
      const second = await spendCapFromEnv(SERVERLESS_ENV).reserve(0.9);
      expect(second.ok, 'chladný start koupil rozpočet znovu').toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.reason).toBe('CAP_EXHAUSTED');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('počet placených volání přežije chladný start stejně jako dolary', async () => {
    const store = fakeStore();
    vi.stubGlobal('fetch', store.fetchImpl);
    try {
      const env = { ...SERVERLESS_ENV, WORLDSMITH_SPEND_CAP_USD: '1000', WORLDSMITH_CALL_CAP: '2' };
      await spendCapFromEnv(env).reserve(0.001);
      await spendCapFromEnv(env).reserve(0.001);

      const third = await spendCapFromEnv(env).reserve(0.001);
      expect(third.ok).toBe(false);
      if (third.ok) throw new Error('unreachable');
      expect(third.reason).toBe('CALL_CAP_EXHAUSTED');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a bez úložiště se ten rozpočet koupit nedá vůbec, protože se nevolá', async () => {
    // Druhá strana téhož: kdyby sdílené úložiště chybělo, nesmí strop spadnout
    // zpátky na paměť procesu — tam by chladný start fungoval dál.
    const { WORLDSMITH_SPEND_STORE_URL: _u, WORLDSMITH_SPEND_STORE_TOKEN: _t, ...withoutStore } =
      SERVERLESS_ENV;
    const refused = await spendCapFromEnv(withoutStore).reserve(0.001);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('STORE_UNCONFIGURED');
  });
});

// **Vypnutý strop je jediná páka, která uvolňuje — a jediná, kterou nic
// nekončilo** (P15 `T30-capoffbound`, routováno z revize `T30-capfloor`).
// Mez je stáří povelu, ne jeho obsah: `mtime` souboru plus třicet minut.
describe('vypnutý strop sám vyprší', () => {
  function agedControlFile(contents: string, ageMs: number): string {
    const path = controlFile(contents);
    // `utimesSync` bere sekundy. Razítko se posouvá do minulosti, protože
    // čekat třicet minut v testu není měření, ale zdržení.
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
    return path;
  }

  const CAP_OFF = JSON.stringify({ enabled: false, capUsd: 0 });

  it('čerstvé vypnutí platí dál', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, agedControlFile(CAP_OFF, 0));

    expect((await cap.reserve(100)).ok, 'vypnutí přestalo platit hned po zápisu').toBe(true);
  });

  it('těsně pod mezí pořád platí', async () => {
    const path = agedControlFile(CAP_OFF, CAP_OFF_MAX_AGE_MS - 60_000);
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

    expect((await cap.reserve(100)).ok).toBe(true);
  });

  it('po vypršení se strop vrátí a rezervace nad ním se odmítne', async () => {
    const path = agedControlFile(CAP_OFF, CAP_OFF_MAX_AGE_MS + 60_000);
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

    const refused = await cap.reserve(100);
    expect(refused.ok, 'zapomenutý soubor drží peněženku otevřenou dál').toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CAP_EXHAUSTED');
    // A říká to i diagnostika, ne jen odmítnutí — operátor se dívá sem.
    expect(refused.snapshot.enabled).toBe(true);
  });

  it('sdílený klíč vypnutí neprosadí vůbec, protože neumí říct, kdy vznikl', async () => {
    // Tohle je ta polovina, na které záleží: na Vercelu žádný soubor není,
    // takže kdyby `null` znamenalo „čerstvý", platila by mez lokálně a na
    // nasazení, kde jsou peníze doopravdy, ne.
    const store: ControlStore = {
      id: 'test',
      key: 'worldsmith:spend:control',
      read: () => Promise.resolve(CAP_OFF),
    };
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, null, memoryLedger(), store);

    const refused = await cap.reserve(100);
    expect(refused.ok, 'nedatovaný povel vypnul strop').toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toBe('CAP_EXHAUSTED');
  });

  it('vypnutý rozpočet mez nezapíná zpátky', async () => {
    // `enabled:false` ve VÝCHOZÍCH hodnotách je rozhodnutí z prostředí, tedy
    // z redeploye. Mez hlídá páku bez redeploye a do rozpočtu jí nic není.
    const path = agedControlFile(CAP_OFF, CAP_OFF_MAX_AGE_MS + 60_000);
    const cap = new SpendCap({ enabled: false, capUsd: 5 }, path);

    expect((await cap.reserve(100)).ok).toBe(true);
  });


  // ⚠ **Tyhle dva testy měří stáří v minutách, ne v násobcích konstanty** —
  // a je to oprava přeživšího mutanta, ne opakování. Zbytek téhle sady počítá
  // stáří jako `CAP_OFF_MAX_AGE_MS ± minuta`, takže se pohne spolu s ní:
  // naměřeno 5. 9. 2026, záměna třiceti minut za třicet HODIN nechala všech
  // 73 asercí zelených. Okno je slib operátorovi a musí ho pinovat číslo.
  it('čtvrt hodiny staré vypnutí ještě platí', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, agedControlFile(CAP_OFF, 15 * 60_000));

    expect((await cap.reserve(100)).ok, 'okno se zkrátilo pod čtvrt hodiny').toBe(true);
  });

  it('tříčtvrtěhodinové vypnutí už neplatí', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, agedControlFile(CAP_OFF, 45 * 60_000));

    expect((await cap.reserve(100)).ok, 'okno se protáhlo nad tři čtvrtě hodiny').toBe(false);
  });
  it('řádek do logu je jeden na proces, ne jeden na požadavek', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = agedControlFile(CAP_OFF, CAP_OFF_MAX_AGE_MS + 60_000);
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

    await cap.reserve(100);
    await cap.reserve(100);
    await cap.reserve(100);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('spend cap');
    warn.mockRestore();
  });

  it('přepsaný soubor vypnutí obnoví, a ozve se to znovu', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = agedControlFile(CAP_OFF, CAP_OFF_MAX_AGE_MS + 60_000);
    const cap = new SpendCap({ enabled: true, capUsd: 5 }, path);

    expect((await cap.reserve(100)).ok).toBe(false);

    // Operátor si všiml a soubor přepsal — nové razítko, nové okno.
    writeFileSync(path, CAP_OFF, 'utf8');
    expect((await cap.reserve(100)).ok, 'přepsání souboru okno neobnovilo').toBe(true);

    // A druhý zásah téhož procesu se musí ozvat znovu, ne mlčet.
    const when = (Date.now() - (CAP_OFF_MAX_AGE_MS + 60_000)) / 1000;
    utimesSync(path, when, when);
    expect((await cap.reserve(100)).ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
