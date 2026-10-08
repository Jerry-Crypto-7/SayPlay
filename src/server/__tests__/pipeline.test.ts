import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { frozenGrammar, frozenPrompts } from '../../model/client';
import { buildEmissionRequest, type Grammar } from '../../model/prompt';
import { moderatePrompt, type DeniedTopic } from '../moderation';
import { runPipeline, type GenerationBranch, type GenerationFailureReason } from '../pipeline';
import { SpendCap } from '../spend-cap';
import { upstreamBranch, type UpstreamConfig } from '../upstream';

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

const promptsRead = frozenPrompts();
if (!promptsRead.ok) throw new Error(`frozen prompts unreadable: ${promptsRead.detail}`);
const FROZEN_CREATE = promptsRead.value.find((record) => record.kind === 'create');
if (FROZEN_CREATE === undefined) throw new Error('the frozen corpus carries no create prompt');

/** Text, který ve zmrazeném korpusu není a u živé větve shodí transport. */
const UNSERVED_PROMPT = 'udělej svět, na který v korpusu nikdy nebyl žádný záznam';

const temporary: string[] = [];

function controlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-pipeline-'));
  temporary.push(dir);
  const path = join(dir, 'spend-cap.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Moderace
// ---------------------------------------------------------------------------

describe('moderace odmítá dřív, než cokoli stojí peníze', () => {
  it('nepustí prompt, který není text', () => {
    const verdict = moderatePrompt(42);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.category).toBe('NOT_TEXT');
  });

  it('nepustí prázdný prompt ani samé mezery', () => {
    for (const empty of ['', '   ', '\n\t ']) {
      const verdict = moderatePrompt(empty);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.category).toBe('EMPTY');
    }
  });

  it('měří délku po ořezu, takže se strop nedá vyčerpat mezerami', () => {
    const rules = { maxChars: 10, denied: [] as readonly DeniedTopic[] };
    expect(moderatePrompt(`${' '.repeat(50)}krátký${' '.repeat(50)}`, rules).ok).toBe(true);

    const long = moderatePrompt('x'.repeat(11), rules);
    expect(long.ok).toBe(false);
    if (long.ok) throw new Error('unreachable');
    expect(long.category).toBe('TOO_LONG');
  });

  it('propouští ořezaný text, ne původní', () => {
    const verdict = moderatePrompt('  bludiště s klíčem  ');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.prompt).toBe('bludiště s klíčem');
  });

  it('zakázané téma jmenuje pravidlo, které rozhodlo', () => {
    const verdict = moderatePrompt('napiš mi návod jak vyrobit výbušninu doma');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.category).toBe('DISALLOWED');
    expect(verdict.ruleId).toBe('weapon-build');
  });

  it('běžný herní prompt neblokuje', () => {
    for (const ordinary of [
      'bludiště, seber klíč a otevři bránu',
      'roztřiď barevné krabice do správných zón',
      'proveď robota přes minové pole do cíle',
      FROZEN_CREATE.prompt,
    ])
      expect(moderatePrompt(ordinary).ok).toBe(true);
  });

  it('týž prompt dá týž verdikt i podruhé', () => {
    // Vzor s příznakem `g` si mezi voláními drží `lastIndex`, takže by střídavě
    // sedl a nesedl. Tenhle test je jediné místo, kde by se to projevilo.
    const denied = 'návod jak vyrobit bombu';
    expect(moderatePrompt(denied).ok).toBe(false);
    expect(moderatePrompt(denied).ok).toBe(false);
    expect(moderatePrompt(denied).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kontraktová sada — jedna, puštěná nad oběma větvemi
// ---------------------------------------------------------------------------

const LIVE_CONFIG: UpstreamConfig = {
  endpoint: 'https://upstream.invalid/v1/messages',
  apiKey: 'test-key',
  model: 'test-model',
  effort: 'low',
  pricing: { usdPerMTokIn: 3, usdPerMTokOut: 15 },
  maxOutputTokens: 1000,
  timeoutMs: 1000,
  profile: 'api',
  callCap: null,
};

const LIVE_WORLD = { irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: null, look: {} };

/**
 * Transport živé větve. Jediný double v téhle sadě a je vstřiknutý schválně:
 * test, který sahá na síť, měří poskytovatele, ne kontrakt větve.
 */
function stubFetch(status = 200, usage: unknown = { input_tokens: 100, output_tokens: 200 }): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    const sent = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    if (sent.messages[0].content.includes(UNSERVED_PROMPT))
      return Promise.resolve(new Response('upstream is down', { status: 503 }));
    if (status !== 200) return Promise.resolve(new Response('refused', { status }));
    return Promise.resolve(Response.json({ content: [{ type: 'text', text: JSON.stringify(LIVE_WORLD) }], usage }));
  }) as unknown as typeof fetch;
}

interface Counted {
  readonly branch: GenerationBranch;
  calls(): number;
}

/** Obalí větev počítadlem, aby šlo dokázat, že se **nezavolala**. */
function counted(branch: GenerationBranch): Counted {
  let calls = 0;
  return {
    branch: {
      id: branch.id,
      pricing: branch.pricing,
      worstCaseUsd: (call) => branch.worstCaseUsd(call),
      generate: (call) => {
        calls += 1;
        return branch.generate(call);
      },
    },
    calls: () => calls,
  };
}

interface Fixture {
  readonly name: string;
  branch(): GenerationBranch;
  readonly okPrompt: string;
  readonly failureReason: GenerationFailureReason;
}

/**
 * Větve, jedna sada tvrzení. Rozdíl je **jen** ve fixture — jakmile by se
 * lišilo tvrzení, přestala by to být záruka, že jsou větve zaměnitelné.
 * (Offline větev nad zmrazeným korpusem odešla se starým studiem, P44D T7.)
 */
const FIXTURES: readonly Fixture[] = [
  {
    name: 'živá větev přes HTTP',
    branch: () => upstreamBranch(LIVE_CONFIG, stubFetch()),
    okPrompt: 'bludiště s klíčem a bránou',
    failureReason: 'UPSTREAM_UNAVAILABLE',
  },
];

for (const fixture of FIXTURES)
  describe(`kontrakt generování — ${fixture.name}`, () => {
    it('projde řetěz moderace → generování a vydá tělo', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 100 });
      const result = await runPipeline(fixture.okPrompt, { branch: fixture.branch(), cap, grammar: GRAMMAR });

      expect(result.outcome).toBe('GENERATED');
      if (result.outcome !== 'GENERATED') throw new Error(result.detail);
      expect(typeof result.body).toBe('object');
      expect(result.provenance.branch).toBe(result.branch);
      expect(Number.isFinite(result.costUsd)).toBe(true);
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    });

    it('po úspěchu je rezervace vyrovnaná skutečnou cenou', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 100 });
      const result = await runPipeline(fixture.okPrompt, { branch: fixture.branch(), cap, grammar: GRAMMAR });
      if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');

      expect(cap.snapshot().reservedUsd).toBe(0);
      expect(cap.snapshot().spentUsd).toBeCloseTo(result.costUsd, 10);
    });

    it('odmítnutý prompt se nikam nevolá', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 100 });
      const branch = counted(fixture.branch());
      const result = await runPipeline('', { branch: branch.branch, cap, grammar: GRAMMAR });

      expect(result.outcome).toBe('REFUSED');
      if (result.outcome !== 'REFUSED') throw new Error('unreachable');
      expect(result.stage).toBe('moderation');
      expect(branch.calls()).toBe(0);
      // Odmítnutý prompt nesmí ani zamluvit rozpočet.
      expect(cap.snapshot().reservedUsd).toBe(0);
      expect(cap.snapshot().spentUsd).toBe(0);
    });

    it('strop odmítá PŘED voláním, ne po něm', async () => {
      // Vypínač rozbitý schválně: je to jediné odmítnutí stropu, které nezávisí
      // na odhadu ceny, takže se dá vyžádat od obou větví stejně. Vyčerpání
      // rozpočtu má vlastní test u živé větve — offline větev neutrácí nic, a
      // strop, který by ji odmítl, by demo jen shodil.
      const cap = new SpendCap({ enabled: true, capUsd: 100 }, controlFile('{ rozbito'));
      const branch = counted(fixture.branch());
      const result = await runPipeline(fixture.okPrompt, { branch: branch.branch, cap, grammar: GRAMMAR });

      expect(result.outcome).toBe('REFUSED');
      if (result.outcome !== 'REFUSED') throw new Error('unreachable');
      expect(result.stage).toBe('spend-cap');
      expect(branch.calls()).toBe(0);
    });

    it('selhání generování je strukturovaný výsledek a rezervaci nenechá viset', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 100 });
      const result = await runPipeline(UNSERVED_PROMPT, { branch: fixture.branch(), cap, grammar: GRAMMAR });

      expect(result.outcome).toBe('FAILED');
      if (result.outcome !== 'FAILED') throw new Error('expected a failure');
      expect(result.stage).toBe('generation');
      expect(result.reason).toBe(fixture.failureReason);
      expect(result.detail.length).toBeGreaterThan(0);
      // Neuvolněná rezervace by strop po pár selháních utáhla na provoz, který
      // nic nestál.
      expect(cap.snapshot().reservedUsd).toBe(0);
    });

    it('výjimka z větve se nepropadne ven a rezervaci vyrovná', async () => {
      const cap = new SpendCap({ enabled: true, capUsd: 100 });
      const inner = fixture.branch();
      const throwing: GenerationBranch = {
        id: inner.id,
        pricing: inner.pricing,
        worstCaseUsd: (call) => inner.worstCaseUsd(call),
        generate: () => Promise.reject(new Error('transport exploded')),
      };

      const result = await runPipeline(fixture.okPrompt, { branch: throwing, cap, grammar: GRAMMAR });
      expect(result.outcome).toBe('FAILED');
      if (result.outcome !== 'FAILED') throw new Error('unreachable');
      expect(result.reason).toBe('UPSTREAM_UNAVAILABLE');
      expect(cap.snapshot().reservedUsd).toBe(0);
    });
  });

// ---------------------------------------------------------------------------
// Účtování, které se dá vyžádat jen od placené větve
// ---------------------------------------------------------------------------

describe('co se účtuje, když se volání nepovede', () => {
  it('vyčerpaný rozpočet odmítne další volání, aniž by se kamkoli sáhlo', async () => {
    let fetches = 0;
    const fetchImpl = ((url: string, init: RequestInit) => {
      fetches += 1;
      return stubFetch()(url, init);
    }) as unknown as typeof fetch;

    const cap = new SpendCap({ enabled: true, capUsd: 0.000_001 });
    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(LIVE_CONFIG, fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') throw new Error('unreachable');
    expect(result.stage).toBe('spend-cap');
    if (result.stage !== 'spend-cap') throw new Error('unreachable');
    expect(result.reason).toBe('CAP_EXHAUSTED');
    expect(fetches).toBe(0);
  });

  it('odmítnutý požadavek (4xx) se neúčtuje — odpověď se negenerovala', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(LIVE_CONFIG, stubFetch(400)),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.reason).toBe('UPSTREAM_REJECTED');
    expect(result.costUsd).toBe(0);
    expect(cap.snapshot().spentUsd).toBe(0);
  });

  it('výpadek bez ohlášené spotřeby se účtuje celým odhadem', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const branch = upstreamBranch(LIVE_CONFIG, stubFetch());
    const result = await runPipeline(UNSERVED_PROMPT, { branch, cap, grammar: GRAMMAR });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.reason).toBe('UPSTREAM_UNAVAILABLE');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(cap.snapshot().spentUsd).toBeCloseTo(result.costUsd, 10);
  });

  it('nepoužitelná odpověď s ohlášenou spotřebou se účtuje skutečností, ne odhadem', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    // Odpověď dorazí, nese spotřebu a její textový blok není JSON.
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({ content: [{ type: 'text', text: 'tohle není JSON' }], usage: { input_tokens: 10, output_tokens: 20 } }),
      )) as unknown as typeof fetch;

    const branch = upstreamBranch(LIVE_CONFIG, fetchImpl);
    const worstCase = branch.worstCaseUsd({
      prompt: 'bludiště',
      request: { model: 'test-model', system: '', user: 'bludiště' },
    });
    const result = await runPipeline('bludiště s klíčem', { branch, cap, grammar: GRAMMAR });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.reason).toBe('MALFORMED_RESPONSE');
    expect(result.costUsd).toBeCloseTo((10 * 3 + 20 * 15) / 1_000_000, 12);
    expect(result.costUsd).toBeLessThan(worstCase);
  });

  it('nenakonfigurovaná živá větev neúčtuje nic a nikam nevolá', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(null),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.reason).toBe('BRANCH_UNCONFIGURED');
    expect(result.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hranice proti měřicí vrstvě
// ---------------------------------------------------------------------------

/**
 * **Hlášená cena se musí rovnat té stržené.** Je to jediný účetní údaj, který
 * produkt vydává — `/api/generate` z něj píše `ACCOUNTING costUsd=…` — takže
 * operátor, který hledá, kam se rozpočet poděl, nemá jak si ho ověřit jinde.
 *
 * Do 1. 9. 2026 to neplatilo a vada byla starší než pravidlo dvojité nuly:
 * `settle()` účtenku, která nedává smysl, zahodí a strhne celou rezervaci, ale
 * nikomu to neřekl — `runPipeline` vracel dál to číslo, které poslal. Naměřeno:
 * `{input_tokens: -1e9}` strhlo 0,2195 USD a ohlásilo `-5000`; `1e999` ohlásilo
 * `Infinity`, a to nekonečno pak rušilo mez operátorského logu úplně.
 */
describe('hlášená cena se rovná té, kterou strop doopravdy strhl', () => {
  /** Kolik strop na tenhle prompt drží. Jediné číslo, které se dá znát nezávisle. */
  function reservationFor(prompt: string): number {
    return upstreamBranch(LIVE_CONFIG, (() => {
      throw new Error('worstCaseUsd nikam nevolá');
    }) as unknown as typeof fetch).worstCaseUsd({
      prompt,
      request: buildEmissionRequest(prompt, GRAMMAR),
    });
  }

  /** Účtenka, kterou `release()` odmítne, ať je nesmysl v kterékoli složce. */
  function poisonedFetch(rawUsage: string): typeof fetch {
    // Tělo jde jako text, ne přes `Response.json`: to by `Infinity` uložilo
    // jako `null`. `JSON.parse('1e999')` dá `Infinity` typu number.
    return (() =>
      Promise.resolve(
        new Response(`{"content":[{"type":"text","text":${JSON.stringify(JSON.stringify(LIVE_WORLD))}}],"usage":${rawUsage}}`, {
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;
  }

  it('záporná účtenka se ohlásí rezervací, ne záporným číslem', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(LIVE_CONFIG, poisonedFetch('{"input_tokens":-1e9,"output_tokens":1}')),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');
    expect(result.costUsd).toBe(cap.snapshot().spentUsd);
    // **Proti rezervaci, ne proti nule.** `toBeGreaterThan(0)` tady stálo do
    // 1. 9. 2026 a nedokázalo nic: prošlo by i účtence za 0,000005 USD, tedy
    // přesně tomu podhlášení, kvůli kterému tenhle blok vznikl. A `costUsd`
    // JE návratová hodnota `settle()`, takže rovnost o řádek výš je taky jen
    // pojmenování téhož čísla dvakrát. Jediné nezávisle známé číslo je
    // rezervace. Nález nezávislé revize 1. 9. 2026 nad `df4a6b5`.
    expect(result.costUsd).toBeCloseTo(reservationFor('bludiště s klíčem'), 10);
    // **Hlášená spotřeba je od 1. 9. 2026 nečitelná, ne záporná.** Dřív tady
    // stálo, že se ven vrací to, co poskytovatel řekl; pak se ukázalo, že
    // záporná složka umí zaplatit kladnou a součet projde `release()` jako
    // drobné (`readableUsage()` v `../upstream.ts`). Účtenka se zápornou
    // složkou se proto zahazuje celá a ven jde totéž `{0, 0}` jako u každé
    // jiné nečitelné. Jediné číslo, které tu něco tvrdí, je `costUsd` výš.
    //
    // ⚠ Nekonečná účtenka o dva testy níž se ven pořád vrací tak, jak přišla —
    // je „čitelná, ale nesmyslná". Ten rozpor patří `T9-usagereport`, ne sem.
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('nekonečná účtenka se ohlásí konečným číslem', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(LIVE_CONFIG, poisonedFetch('{"input_tokens":1e999,"output_tokens":1}')),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');
    expect(Number.isFinite(result.costUsd), String(result.costUsd)).toBe(true);
    expect(result.costUsd).toBe(cap.snapshot().spentUsd);
  });

  it('platí to i na cestě selhání, ne jen na úspěchu', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    // Textový blok, který není JSON, plus otrávená účtenka: `BILLED_ON_FAILURE`
    // dá přednost účtence před odhadem, takže sem teče totéž otrávené číslo.
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"content":[{"type":"text","text":"tohle není JSON"}],"usage":{"input_tokens":-1e9,"output_tokens":1}}', {
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;

    const result = await runPipeline('bludiště s klíčem', {
      branch: upstreamBranch(LIVE_CONFIG, fetchImpl),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.costUsd).toBe(cap.snapshot().spentUsd);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('výjimka, ze které nejde přečíst zpráva, nenechá rezervaci viset', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    // `Promise.reject(null)` je jediný tvar, u kterého sestavení odpovědi spadne
    // dřív, než se stihne vyrovnat — `(null as Error).message` je TypeError.
    // Rezervace se přesto musí uvolnit: visící rezervace strop trvale zmenší,
    // takže nasazení začne odmítat 429 na rozpočtu, který nic neutratil.
    const branch: GenerationBranch = {
      id: 'live',
      pricing: { usdPerMTokIn: 3, usdPerMTokOut: 15 },
      worstCaseUsd: () => 0.02,
      generate: () => Promise.reject(null),
    };

    await expect(runPipeline('bludiště s klíčem', { branch, cap, grammar: GRAMMAR })).rejects.toThrow();
    expect(cap.snapshot().reservedUsd).toBe(0);
    expect(cap.snapshot().spentUsd).toBeCloseTo(0.02, 12);
  });

  it('poctivá účtenka se ohlásí sama sebou, ne rezervací', async () => {
    // Druhý směr téhož tvrzení: rovnost se nesmí zařídit tím, že se vždycky
    // hlásí rezervace. To by strop nafouklo u každého levného volání.
    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const branch = upstreamBranch(LIVE_CONFIG, stubFetch());
    const worstCase = branch.worstCaseUsd({
      prompt: 'bludiště',
      request: { model: 'test-model', system: '', user: 'bludiště' },
    });
    const result = await runPipeline('bludiště s klíčem', { branch, cap, grammar: GRAMMAR });

    if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');
    // **Ne `toBe`, a od P15 T29 nesmí být.** Účtenka je pod rezervací, takže se
    // kniha posouvá dvěma přičteními (rezervace, pak rozdíl) a její součet je od
    // ohlášené ceny vzdálený o zbytek plovoucí čárky: naměřeno
    // `0.0032999999999999974` proti `0.0033`. Tři sesterské aserce výš `toBe`
    // mít smějí, protože tam se účtenka rovná rezervaci a druhé přičtení se
    // vůbec nezapisuje. Vlastnost, o kterou tu jde — hlásí se stržené, ne
    // rezervace — drží dál a pinuje ji řádek pod tímhle na dvanáct míst.
    expect(result.costUsd).toBeCloseTo(cap.snapshot().spentUsd, 12);
    expect(result.costUsd).toBeCloseTo((100 * 3 + 200 * 15) / 1_000_000, 12);
    expect(result.costUsd).toBeLessThan(worstCase);
  });
});

describe('strop endpointu a strop měřicích běhů o sobě nesmějí vědět', () => {
  // Skenují se jen produkční soubory. Tenhle test sám prefix proměnných jmenuje,
  // takže kdyby se skenoval i on, shodil by sám sebe — táž past jako zástupné
  // jméno na seznamu zakázaných jmen v `ops/cleanroom-provisioning.md`.
  const production = readdirSync('src/server', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes('__tests__'));

  it('skenuje skutečné soubory, ne prázdný seznam', () => {
    expect(production.length).toBeGreaterThanOrEqual(4);
  });

  it('žádný produkční soubor nečte proměnné měřicí vrstvy', () => {
    const offenders = production.filter((path) => readFileSync(path, 'utf8').includes('EVAL_'));
    expect(offenders).toEqual([]);
  });

  it('žádný produkční soubor neimportuje z evals/', () => {
    const offenders = production.filter((path) => /from\s+'[^']*evals\//.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Strop na jednu účtenku
// ---------------------------------------------------------------------------

/**
 * **Jedna účtenka nesmí strhnout částku, kterou strop nikdy nedržel.**
 *
 * `reserve()` hlídá to, co se rezervuje; čísla, která pošle poskytovatel,
 * nehlídalo do 1. 9. 2026 nic. `release()` odmítá záporná a nekonečná, ale
 * `1e12` je konečné kladné číslo a prošlo: naměřeno nezávislou revizí celou
 * cestou přes `runPipeline`, že `{1e12, 0}` strhlo **5 000 000 USD** proti
 * rezervaci 0,2195 USD a stropu 5 USD (`{0, 1e12}` pak 25 000 000 USD), takže
 * každý další požadavek dostal do konce života procesu 429 `CAP_EXHAUSTED`.
 *
 * **Ořez je tvrdý a smí být, protože rezervace je od téhož dne strop, ne odhad.**
 * Zřejmá oprava `Math.min(spent, reservedUsd)` sama o sobě podúčtovala poctivé
 * volání: při odhadu vstupu po třech znacích na token stála účtenka
 * `{8000, 8000}` 0,240000 USD proti rezervaci 0,219505 USD, tedy legitimně
 * o 9,3 % víc. Proto se vstup rezervuje po **jednom** tokenu na znak; druhý
 * test to drží, a bez něj by se dala mez v `worstCaseUsd()` vrátit k průměru,
 * aniž by se cokoli ozvalo.
 */
describe('jedna účtenka nestrhne víc, než se na ni drželo', () => {
  const PROMPT = 'bludiště s klíčem';

  /** Kolik strop na tenhle prompt drží. Počítá se, neopisuje. */
  function reservationUsd(): number {
    return upstreamBranch(LIVE_CONFIG, (() => {
      throw new Error('worstCaseUsd nikam nevolá');
    }) as unknown as typeof fetch).worstCaseUsd({
      prompt: PROMPT,
      request: buildEmissionRequest(PROMPT, GRAMMAR),
    });
  }

  function answering(usage: string): typeof fetch {
    const world = JSON.stringify({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim: null, look: {} });
    return (() =>
      Promise.resolve(
        new Response(`{"content":[{"type":"text","text":${JSON.stringify(world)}}],"usage":${usage}}`, {
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;
  }

  it.each([
    ['{"input_tokens":1e12,"output_tokens":0}', 5_000_000],
    ['{"input_tokens":0,"output_tokens":1e12}', 25_000_000],
  ])('řádový nesmysl %s se ořízne na rezervaci', async (usage, unclampedUsd) => {
    const cap = new SpendCap({ enabled: true, capUsd: 5 });
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(LIVE_CONFIG, answering(usage)),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');
    expect(result.costUsd).toBeCloseTo(reservationUsd(), 10);
    // A hlavně: strop tím nesmí být vyčerpaný. Tohle je ten skutečný následek —
    // bez ořezu odpoví nasazení 429 každému dalšímu porotci až do restartu.
    expect(cap.snapshot().spentUsd).toBeLessThan(1);
    expect((await cap.reserve(reservationUsd())).ok).toBe(true);
    // Ať je vidět, o kolik šlo, a ať to číslo nikdo nemusí dopočítávat.
    expect(unclampedUsd).toBeGreaterThan(cap.snapshot().spentUsd * 1_000_000);
  });

  it('poctivá účtenka až po strop rezervace se zaúčtuje celá', async () => {
    // Jeden token na znak vstupu a celý povolený výstup: přesně to, co
    // `worstCaseUsd()` drží. Kdyby se mez vrátila k ~3 znakům na token,
    // rezervace spadne pod cenu téhle účtenky, ořez ji utne a tenhle test
    // zčervená — což je přesně ta vada, kterou plán označil za vyvrácenou
    // zřejmou opravu.
    const request = buildEmissionRequest(PROMPT, GRAMMAR);
    const inputTokens = request.system.length + request.user.length;
    const honestUsd =
      (inputTokens * LIVE_CONFIG.pricing.usdPerMTokIn +
        LIVE_CONFIG.maxOutputTokens * LIVE_CONFIG.pricing.usdPerMTokOut) /
      1_000_000;

    const cap = new SpendCap({ enabled: true, capUsd: 5 });
    const result = await runPipeline(PROMPT, {
      branch: upstreamBranch(
        LIVE_CONFIG,
        answering(`{"input_tokens":${inputTokens},"output_tokens":${LIVE_CONFIG.maxOutputTokens}}`),
      ),
      cap,
      grammar: GRAMMAR,
    });

    if (result.outcome !== 'GENERATED') throw new Error('expected a generated world');
    expect(result.costUsd).toBeCloseTo(honestUsd, 10);
    expect(honestUsd).toBeCloseTo(reservationUsd(), 10);
  });
});
