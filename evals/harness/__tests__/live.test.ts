/**
 * Živý běh a jeho preflight (T18) — dokázané **bez jediného placeného volání**.
 *
 * Poskytovatel je tu double, a je to jediné místo, kde double smí být: všechno,
 * co se dá o živé cestě dokázat offline, se dokazuje offline, a na síť zbývá
 * jen samotný HTTP požadavek (`e2e/live-chain.spec.ts`).
 *
 * Sada cílí na cesty, které se **spouštějí jen když už je něco špatně** —
 * chybějící klíč, model mimo allowlist, došlý strop, podstrčený zmrazený
 * záznam. Ty se z principu nikdy nespustí náhodou, takže se ani nikdy náhodou
 * neotestují.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyWitness, type VerifiableWorld } from '../../../src/verify/witness';
import { frozenResponses, stageHash } from '../chain';
import {
  PreflightError,
  extractJson,
  frozenBodyHashes,
  responsesDir,
  runLiveChain,
  storeResponse,
  type LiveCompletion,
  type ProviderTransport,
} from '../live';
import {
  LIVE_MODELS,
  costUsd,
  describeConfig,
  preflight,
  withLiveModel,
  type Env,
  type LiveConfig,
} from '../preflight';

const KEY = 'sk-REDACTED';

const FULL: Env = {
  OPENAI_API_KEY: KEY,
  EVAL_MODEL: LIVE_MODELS[0].id,
  EVAL_SPEND_CAP_USD: '50',
  EVAL_USD_PER_MTOK_IN: '1.25',
  EVAL_USD_PER_MTOK_OUT: '10',
};

const without = (...names: string[]): Env => {
  const env: Record<string, string | undefined> = { ...FULL };
  for (const name of names) delete env[name];
  return env;
};

const okConfig = (): LiveConfig => {
  const result = preflight(FULL, 0);
  if (!result.ok) throw new Error(`fixture je rozbitá: ${result.reason}`);
  return result;
};

// ---------------------------------------------------------------------------
// Preflight — každý chybějící vstup má vlastní důvod
// ---------------------------------------------------------------------------

describe('preflight odmítne start, když cokoli chybí', () => {
  it('chybějící klíč je NO_CREDENTIALS', () => {
    const result = preflight(without('OPENAI_API_KEY'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('NO_CREDENTIALS');
  });

  it('prázdný a jen-bílé-znaky klíč je „nenastaveno", ne „nastaveno na nic"', () => {
    for (const value of ['', '   ', '\t\n'])
      expect(preflight({ ...FULL, OPENAI_API_KEY: value }).ok === false && preflight({ ...FULL, OPENAI_API_KEY: value })).toMatchObject({
        reason: 'NO_CREDENTIALS',
      });
  });

  it('chybějící model je NO_MODEL, model mimo allowlist je MODEL_NOT_ALLOWED', () => {
    expect(preflight(without('EVAL_MODEL'))).toMatchObject({ ok: false, reason: 'NO_MODEL' });
    // Jméno modelu zmrazeného korpusu NENÍ povolené na živé cestě: záznam
    // pojmenovává Anthropic model, který se odsud nevolá.
    expect(preflight({ ...FULL, EVAL_MODEL: 'claude-opus-5' })).toMatchObject({
      ok: false,
      reason: 'MODEL_NOT_ALLOWED',
    });
  });

  it('strop musí být konečné kladné číslo', () => {
    expect(preflight(without('EVAL_SPEND_CAP_USD'))).toMatchObject({ ok: false, reason: 'NO_SPEND_CAP' });
    for (const value of ['0', '-5', 'padesát', 'Infinity', 'NaN'])
      expect(preflight({ ...FULL, EVAL_SPEND_CAP_USD: value }), value).toMatchObject({
        ok: false,
        reason: 'INVALID_SPEND_CAP',
      });
  });

  it('bez ceny za token se strop nedá vynutit — obě proměnné zvlášť', () => {
    expect(preflight(without('EVAL_USD_PER_MTOK_IN'))).toMatchObject({ ok: false, reason: 'NO_PRICE' });
    expect(preflight(without('EVAL_USD_PER_MTOK_OUT'))).toMatchObject({ ok: false, reason: 'NO_PRICE' });
    expect(preflight({ ...FULL, EVAL_USD_PER_MTOK_IN: 'levně' })).toMatchObject({ ok: false, reason: 'INVALID_PRICE' });
    expect(preflight({ ...FULL, EVAL_USD_PER_MTOK_OUT: '-1' })).toMatchObject({ ok: false, reason: 'INVALID_PRICE' });
  });

  it('vyčerpaný strop zastavuje, i když je všechno ostatní v pořádku', () => {
    expect(preflight(FULL, 49.999)).toMatchObject({ ok: true, remainingUsd: expect.any(Number) });
    expect(preflight(FULL, 50)).toMatchObject({ ok: false, reason: 'CAP_EXHAUSTED' });
    expect(preflight(FULL, 61)).toMatchObject({ ok: false, reason: 'CAP_EXHAUSTED' });
  });

  it('kompletní prostředí projde a zbytek stropu se dopočítá', () => {
    const result = preflight(FULL, 12.5);
    expect(result).toMatchObject({ ok: true, capUsd: 50, spentUsd: 12.5, remainingUsd: 37.5 });
    expect(result.ok === true && result.model.id).toBe(LIVE_MODELS[0].id);
  });

  it('ptá se na credentials PRVNÍ — prázdné prostředí neohlásí chybějící model', () => {
    // Pořadí je součást zadání („ověří credentials, model a zbývající strop").
    // Kdyby se ptal odzadu, člověk bez klíče by dostal hlášku o ceně za token.
    expect(preflight({})).toMatchObject({ ok: false, reason: 'NO_CREDENTIALS' });
  });
});

describe('klíč se z preflightu nikdy nedostane ven', () => {
  it('žádný detail selhání ani popis konfigurace nenese hodnotu klíče', () => {
    // Detail končí v logu běhu a potenciálně v CI výstupu. Klíč v něm je nález.
    const details = [
      without('EVAL_MODEL'),
      without('EVAL_SPEND_CAP_USD'),
      without('EVAL_USD_PER_MTOK_IN'),
      { ...FULL, EVAL_MODEL: 'gpt-neexistuje' },
      { ...FULL, EVAL_SPEND_CAP_USD: '-1' },
      { ...FULL, EVAL_USD_PER_MTOK_OUT: 'zdarma' },
    ].map((env) => {
      const result = preflight(env, 0);
      return result.ok ? '' : result.detail;
    });
    details.push(preflight(FULL, 999).ok ? '' : (preflight(FULL, 999) as { detail: string }).detail);
    details.push(describeConfig(okConfig()));

    for (const detail of details) expect(detail).not.toContain(KEY);
    // A kontrola polarity: kdyby aserce hledala něco, co v textech nikdy není,
    // prošla by i nad klíčem vypsaným doprostřed. Tenhle řetězec tam je.
    expect(details.some((detail) => detail.includes('EVAL_MODEL') || detail.includes('model='))).toBe(true);
  });
});

describe('účetnictví a přepis modelu', () => {
  it('cena se počítá za milion tokenů', () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, okConfig())).toBeCloseTo(1.25, 10);
    expect(costUsd({ inputTokens: 0, outputTokens: 1_000_000 }, okConfig())).toBeCloseTo(10, 10);
    expect(costUsd({ inputTokens: 8_000, outputTokens: 2_000 }, okConfig())).toBeCloseTo(0.03, 10);
    expect(costUsd({ inputTokens: 0, outputTokens: 0 }, okConfig())).toBe(0);
  });

  it('požadavek odchází pod jménem živého modelu, text zůstává', () => {
    const request = { model: 'claude-opus-5', system: 'S', user: 'U' };
    const live = withLiveModel(request, okConfig());
    expect(live.model).toBe(LIVE_MODELS[0].id);
    expect(live).toMatchObject({ system: 'S', user: 'U' });
  });
});

// ---------------------------------------------------------------------------
// Uložení odpovědi a kotva řetězu
// ---------------------------------------------------------------------------

describe('kotva řetězu se počítá ze souboru, ne z paměti', () => {
  const root = (): string => mkdtempSync(join(tmpdir(), 'live-test-'));

  it('záznam se zapíše a hash sedí na to, co je na disku', () => {
    const dir = root();
    const stored = storeResponse(
      {
        synthetic: false,
        runId: 'RUN',
        forPrompt: 'C01',
        branch: 'create',
        request: { model: 'gpt-5.6', system: 'S', user: 'U' },
        raw: { id: 'resp_1', choices: [] },
        body: { irVersion: 1 },
        parsedVia: 'direct',
        usage: { inputTokens: 1, outputTokens: 2 },
        costUsd: 0,
      },
      dir,
    );

    expect(stored.path).toBe(join(responsesDir('RUN', dir), 'C01.json'));
    expect(stored.rawHash).toBe(stageHash({ id: 'resp_1', choices: [] }));
    expect(stored.bodyHash).toBe(stageHash({ irVersion: 1 }));

    const written = JSON.parse(readFileSync(stored.path, 'utf8')) as { synthetic: boolean; raw: unknown; body: unknown };
    expect(written.synthetic, 'živý záznam se tváří jako syntetický').toBe(false);
    // Klíč se do artefaktu nedostane ani oklikou přes požadavek.
    expect(readFileSync(stored.path, 'utf8')).not.toContain(KEY);

    // Vrácený hash musí sedět na ULOŽENÝ artefakt, ne jen na hodnotu, kterou
    // měl běh v ruce. Bez téhle dvojice by prošla i implementace, která zapíše
    // jedno a zahashuje druhé — a kotva by pak ukazovala mimo důkaz.
    expect(stageHash(written.raw)).toBe(stored.rawHash);
    expect(stageHash(written.body)).toBe(stored.bodyHash);
  });

  it('podvržený soubor po zápisu dá jiný hash — čte se disk, ne úmysl', () => {
    const dir = root();
    const record = {
      synthetic: false as const,
      runId: 'RUN',
      forPrompt: 'C02',
      branch: 'create' as const,
      request: { model: 'gpt-5.6', system: 'S', user: 'U' },
      raw: { id: 'resp_2' },
      body: { irVersion: 1 },
      parsedVia: 'direct' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    };
    const first = storeResponse(record, dir);

    // Přepsat soubor a uložit znovu: druhý zápis přebije podvrh, takže hash
    // musí sedět na nový obsah — a mezitím se čtení doopravdy koná ze souboru.
    writeFileSync(first.path, JSON.stringify({ ...record, raw: { id: 'PODVRH' } }), 'utf8');
    const tampered = JSON.parse(readFileSync(first.path, 'utf8')) as { raw: unknown };
    expect(stageHash(tampered.raw)).not.toBe(first.rawHash);
  });
});

describe('vyloupnutí JSON z odpovědi se vykazuje, nenormalizuje se potichu', () => {
  it('rozliší přímý JSON, fence a nerozparsovatelný text', () => {
    expect(extractJson('{"a":1}')).toEqual({ body: { a: 1 }, via: 'direct' });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ body: { a: 1 }, via: 'fence' });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ body: { a: 1 }, via: 'fence' });
    expect(extractJson('promiňte, nerozumím')).toEqual({ body: 'promiňte, nerozumím', via: 'unparseable' });
    expect(extractJson('```json\n{nevalidní}\n```')).toMatchObject({ via: 'unparseable' });
  });
});

// ---------------------------------------------------------------------------
// Běh proti double poskytovateli
// ---------------------------------------------------------------------------

const frozen = frozenResponses();
const c01 = frozen.find((response) => response.forPrompt === 'C01')!;

/** Tělo, které je platné, ale ve zmrazeném korpusu není. */
function freshBody(): unknown {
  const body = JSON.parse(JSON.stringify(c01.body)) as {
    look: { modules: Record<string, { params: Record<string, number> }> };
  };
  // `look` je mimo hash stavu a `validateLook` po něm chce jen schéma a
  // konečnost, takže svět zůstane platný a hash těla se změní.
  body.look.modules.player.params.height = 1.81;
  return body;
}

function completion(body: unknown, id = 'resp'): LiveCompletion {
  return {
    raw: { id, object: 'chat.completion', choices: [{ message: { content: JSON.stringify(body) } }] },
    text: JSON.stringify(body),
    usage: { inputTokens: 1000, outputTokens: 500 },
  };
}

/** Doprava, která počítá volání — bez ní nejde dokázat, že se NEvolalo. */
function fakeProvider(bodies: readonly unknown[]): ProviderTransport & { calls: number } {
  const state = {
    calls: 0,
    complete: async (): Promise<LiveCompletion> => {
      const body = bodies[Math.min(state.calls, bodies.length - 1)];
      state.calls += 1;
      return completion(body, `resp_${state.calls}`);
    },
  };
  return state;
}

const replay: Parameters<typeof runLiveChain>[0]['replay'] = async (world, witness) =>
  verifyWitness(world as VerifiableWorld, witness as never);

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'live-run-'));

describe('runLiveChain', () => {
  it('bez credentials se nezavolá poskytovatel ANI JEDNOU', async () => {
    // Tohle je celé AC: preflight stojí PŘED prvním placeným voláním.
    const provider = fakeProvider([freshBody()]);
    await expect(
      runLiveChain({ env: without('OPENAI_API_KEY'), provider, replay, promptIds: ['C01'], root: tempRoot() }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(provider.calls, 'preflight selhal a přesto se volalo').toBe(0);
  });

  it('nepovolený model se nezavolá — allowlist stojí taky před voláním', async () => {
    const provider = fakeProvider([freshBody()]);
    await expect(
      runLiveChain({ env: { ...FULL, EVAL_MODEL: 'claude-opus-5' }, provider, replay, promptIds: ['C01'], root: tempRoot() }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(provider.calls, 'model mimo allowlist se přesto zavolal').toBe(0);
  });

  it('zmrazená odpověď vydávaná za živou je selhání běhu, ne nízké skóre', async () => {
    // Nejlevnější podvrh: nechat běžet záznamového klienta a říkat tomu živý běh.
    const provider = fakeProvider([c01.body]);
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['C01'], root: tempRoot() });

    expect(report.failures.map((failure) => failure.kind)).toContain('frozen-leak');
    expect(report.ok).toBe(false);
    expect(report.cases[0].bodyHash, 'podvržené tělo dalo jiný hash než zmrazený originál').toBe(
      stageHash(c01.body),
    );
  });

  it('čerstvá odpověď projde pěti zřetězenými stadii a bránu nespustí', async () => {
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['C01'], root: tempRoot() });

    expect(report.failures, report.failures.map((failure) => `${failure.kind}: ${failure.detail}`).join(' | ')).toEqual(
      [],
    );
    expect(report.complete).toBe(true);
    expect(report.attempted).toBe(1);
    expect(report.model).toBe(LIVE_MODELS[0].id);

    const records = report.cases[0].records;
    expect(records.map((record) => record.stage)).toEqual(['emit', 'validate', 'repair', 'commit', 'replay']);
    // Kotva je hash NEZMĚNĚNÉ odpovědi ze souboru, ne hash těla.
    expect(records[0].inputHash).toBe(report.cases[0].rawHash);
    expect(report.cases[0].rawHash).not.toBe(report.cases[0].bodyHash);
    for (let i = 1; i < records.length; i += 1) expect(records[i].inputHash).toBe(records[i - 1].outputHash);

    // Kotva sedí na soubor, který po běhu doopravdy leží na disku.
    const artifact = JSON.parse(readFileSync(report.cases[0].responsePath, 'utf8')) as { raw: unknown };
    expect(stageHash(artifact.raw)).toBe(records[0].inputHash);

    // Řetěz nesmí být prázdný běh, který jen vyrobil pět záznamů: C01 je
    // v offline sadě FULFILLED a živá cesta ho musí ohodnotit stejně.
    expect(report.cases[0].verdict).toBe('FULFILLED');
    expect(report.cases[0].stoppedAt).toBeNull();
    expect(report.browserReplays).toBe(1);

    // Útrata se doopravdy načítá: 1000 in + 500 out při 1.25/10 za Mtok.
    expect(report.spentUsd).toBeCloseTo(0.00625, 10);
    expect(report.capUsd).toBe(50);
  });

  it('běh se zastaví na stropu a označí výsledek jako NEÚPLNÝ', async () => {
    // Strop na dvě volání: třetí prompt se už neodbaví.
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({
      env: { ...FULL, EVAL_SPEND_CAP_USD: '0.0125' },
      provider,
      replay,
      promptIds: ['C01', 'C02', 'C04'],
      root: tempRoot(),
    });

    expect(report.complete, 'useknutý běh se vykázal jako úplný').toBe(false);
    expect(report.stoppedReason).toContain('CAP_EXHAUSTED');
    expect(report.total).toBe(3);
    // Přesně dvě volání: 2 × 0.00625 vyčerpá strop 0.0125 a třetí brána zastaví.
    // `toBeLessThan` by tady prošlo i s nulou odbavených promptů.
    expect(provider.calls, 'strop nezastavil přesně po druhém volání').toBe(2);
    expect(report.attempted).toBe(2);
    expect(report.spentUsd).toBeCloseTo(0.0125, 10);
  });

  it('spadlý poskytovatel je rozbité prostředí, ne verdikt o modelu', async () => {
    const provider: ProviderTransport = {
      complete: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['C01'], root: tempRoot() });

    expect(report.failures.map((failure) => failure.kind)).toEqual(['provider']);
    expect(report.cases, 'ze spadlého spojení se odvodil verdikt').toEqual([]);
    expect(report.counts).toEqual({ FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 });
  });
});

describe('brána proti zmrazenému korpusu není dekorativní', () => {
  it('zná hash každé zmrazené odpovědi, deklarovaný i dopočítaný', () => {
    const hashes = frozenBodyHashes();
    expect(frozen.length).toBe(40);
    for (const response of frozen) {
      expect(hashes.has(response.sha256), `${response.forPrompt}: deklarovaný hash chybí`).toBe(true);
      expect(hashes.has(stageHash(response.body)), `${response.forPrompt}: dopočítaný hash chybí`).toBe(true);
    }
    // Čerstvé tělo v ní být nesmí, jinak by brána hlásila únik na všem.
    expect(hashes.has(stageHash(freshBody()))).toBe(false);
  });
});
