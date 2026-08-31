import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { frozenGrammar, frozenPrompts } from '../../model/client';
import type { Grammar } from '../../model/prompt';
import { moderatePrompt, type DeniedTopic } from '../moderation';
import { mockBranch } from '../mock';
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
 * Obě větve, jedna sada tvrzení. Rozdíl je **jen** ve fixture — jakmile by se
 * lišilo tvrzení, přestala by to být záruka, že jsou obě větve zaměnitelné.
 */
const FIXTURES: readonly Fixture[] = [
  {
    name: 'offline větev nad zmrazeným korpusem',
    branch: () => mockBranch(),
    okPrompt: FROZEN_CREATE.prompt,
    failureReason: 'NO_SOURCE',
  },
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

  it('rozbitý korpus je výpadek zdroje, ne chybějící odpověď', async () => {
    // Rozdíl rozhoduje o stavovém kódu nad tímhle: `NO_SOURCE` je naměřený
    // výsledek, výpadek je rozbité prostředí, o kterém se nesmí nic skórovat.
    // Testuje se nad KOPIÍ korpusu — `evals/frozen/` je zamčený.
    const root = mkdtempSync(join(tmpdir(), 'worldsmith-frozen-'));
    temporary.push(root);
    cpSync(join(process.cwd(), 'evals', 'frozen'), join(root, 'evals', 'frozen'), { recursive: true });
    writeFileSync(join(root, 'evals', 'frozen', 'prompts.v1.jsonl'), '{"id":"podvrh"}\n', 'utf8');

    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.resetModules();
    const { mockBranch: branchAtRoot } = await import('../mock');

    const cap = new SpendCap({ enabled: true, capUsd: 100 });
    const result = await runPipeline(FROZEN_CREATE.prompt, { branch: branchAtRoot(), cap, grammar: GRAMMAR });

    if (result.outcome !== 'FAILED') throw new Error('expected a failure');
    expect(result.reason).toBe('UPSTREAM_UNAVAILABLE');
    expect(result.detail).toContain('MANIFEST_MISMATCH');
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
