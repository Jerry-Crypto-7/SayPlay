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

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamRequest } from '../../../src/model/prompt';
import { verifyWitness, type VerifiableWorld } from '../../../src/verify/witness';
import { frozenResponses, stageHash } from '../chain';
import {
  MAX_OUTPUT_TOKENS,
  PreflightError,
  ProfileGateError,
  anthropicTransport,
  assertGateProfile,
  canonicalHash,
  extractJson,
  frozenBodyHashes,
  openAiTransport,
  reportPath,
  responsesDir,
  runLiveChain,
  storeResponse,
  transportFor,
  type LiveCompletion,
  type LiveReport,
  type ProviderTransport,
} from '../live';
import {
  LIVE_MODELS,
  costUsd,
  describeConfig,
  preflight,
  withLiveModel,
  type ApiConfig,
  type Env,
  type ProviderProfile,
  type SubscriptionConfig,
  type Usage,
} from '../preflight';

// Schválně NEMÁ tvar skutečného klíče (`sk-…`). Kontrola 6 v `blind-check.mjs`
// hledá ten tvar v commitnutém obsahu a fixture, která ho napodobuje, by bránu
// shazovala na vlastním repozitáři — a bránu, co pořád křičí, někdo vypne.
const KEY = 'TEST-CREDENTIAL-NOT-A-REAL-KEY-0123456789';

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

const okConfig = (): ApiConfig => {
  const result = preflight(FULL);
  if (!result.ok) throw new Error(`fixture je rozbitá: ${result.reason}`);
  if (!result.metered) throw new Error('fixture je rozbitá: FULL má být metrovaný profil');
  return result;
};

/** Profil předplatného: bez klíče, bez ceny, se stropem počtu volání. */
const SUBSCRIPTION: Env = {
  EVAL_MODEL: 'gpt-5.6-sol@proxy',
  EVAL_CALL_CAP: '3',
};

const subscriptionConfig = (): SubscriptionConfig => {
  const result = preflight(SUBSCRIPTION);
  if (!result.ok) throw new Error(`fixture je rozbitá: ${result.reason}`);
  if (result.metered) throw new Error('fixture je rozbitá: proxy model má být nemetrovaný');
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
    expect(preflight(FULL, { usd: 49.999, calls: 0 })).toMatchObject({ ok: true, remainingUsd: expect.any(Number) });
    expect(preflight(FULL, { usd: 50, calls: 0 })).toMatchObject({ ok: false, reason: 'CAP_EXHAUSTED' });
    expect(preflight(FULL, { usd: 61, calls: 0 })).toMatchObject({ ok: false, reason: 'CAP_EXHAUSTED' });
  });

  it('kompletní prostředí projde a zbytek stropu se dopočítá', () => {
    const result = preflight(FULL, { usd: 12.5, calls: 0 });
    expect(result).toMatchObject({ ok: true, capUsd: 50, spentUsd: 12.5, remainingUsd: 37.5 });
    expect(result.ok === true && result.model.id).toBe(LIVE_MODELS[0].id);
  });

  it('ptá se na MODEL první, protože z něj plyne profil', () => {
    // Pořadí se změnilo, když přibyly profily, a je to vynucené: dokud není
    // znám model, není známo, jestli je klíč a cena za token vůbec na místě.
    // Ptát se dřív na klíč by u profilu předplatného hlásilo chybějící věc,
    // kterou ten profil nepotřebuje.
    //
    // Vlastnost, kterou původní test hlídal, platí dál: prázdné prostředí
    // musí dostat tu nejakčnější hlášku, ne libovolnou z konce řetězu.
    const empty = preflight({});
    expect(empty).toMatchObject({ ok: false, reason: 'NO_MODEL' });
    expect(empty.ok === false && empty.detail).toContain('Povolené modely');
    for (const downstream of ['NO_PRICE', 'INVALID_PRICE', 'NO_SPEND_CAP'])
      expect(empty.ok === false && empty.reason).not.toBe(downstream);
  });
});

// ---------------------------------------------------------------------------
// Profily — co ten běh smí dokázat
// ---------------------------------------------------------------------------

describe('profil předplatného má vlastní strop a nečte klíč', () => {
  it('projde bez klíče, bez stropu v dolarech i bez ceny za token', () => {
    const result = subscriptionConfig();
    expect(result).toMatchObject({ profile: 'subscription', metered: false, callCap: 3, callsRemaining: 3 });
    expect(result.model.url).toContain('localhost');
    expect(result.model.wire).toBe('anthropic-messages');
  });

  it('klíč v prostředí se u předplatného ignoruje, ne přenáší', () => {
    const withKey = preflight({ ...SUBSCRIPTION, OPENAI_API_KEY: KEY });
    expect(withKey.ok).toBe(true);
    // Konfigurace nemetrovaného běhu klíč vůbec nenese, takže ho nemá kam pustit.
    expect(JSON.stringify(withKey)).not.toContain(KEY);
  });

  it('bez stropu počtu volání se nespustí', () => {
    expect(preflight({ EVAL_MODEL: 'gpt-5.6-sol@proxy' })).toMatchObject({ ok: false, reason: 'NO_CALL_CAP' });
    for (const value of ['0', '-1', '2.5', 'hodně', 'Infinity'])
      expect(preflight({ ...SUBSCRIPTION, EVAL_CALL_CAP: value }), value).toMatchObject({
        ok: false,
        reason: 'INVALID_CALL_CAP',
      });
  });

  it('vyčerpaný strop volání zastavuje stejně tvrdě jako strop v dolarech', () => {
    expect(preflight(SUBSCRIPTION, { usd: 0, calls: 2 })).toMatchObject({ ok: true, callsRemaining: 1 });
    expect(preflight(SUBSCRIPTION, { usd: 0, calls: 3 })).toMatchObject({ ok: false, reason: 'CALL_CAP_EXHAUSTED' });
    expect(preflight(SUBSCRIPTION, { usd: 0, calls: 99 })).toMatchObject({ ok: false, reason: 'CALL_CAP_EXHAUSTED' });
  });

  it('utracené dolary strop volání neposunou a naopak', () => {
    // Kdyby preflight bral jedno číslo „spotřebováno", zvolily by se špatné
    // jednotky a strop by hlídal něco jiného, než co běh utrácí.
    expect(preflight(SUBSCRIPTION, { usd: 9_999, calls: 0 })).toMatchObject({ ok: true });
    expect(preflight(FULL, { usd: 0, calls: 9_999 })).toMatchObject({ ok: true });
  });

  it('popis konfigurace přizná, že dolary u předplatného neplatí', () => {
    const described = describeConfig(subscriptionConfig());
    expect(described).toContain('profile=subscription');
    expect(described).toContain('cap=3 calls');
    expect(described).toContain('usd=neplatné');
    expect(described).not.toContain('USD');
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
      const result = preflight(env);
      return result.ok ? '' : result.detail;
    });
    const exhausted = preflight(FULL, { usd: 999, calls: 0 });
    details.push(exhausted.ok ? '' : exhausted.detail);
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
        profile: 'api',
        endpoint: 'https://api.openai.com/v1/chat/completions',
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
      profile: 'api' as const,
      endpoint: 'https://api.openai.com/v1/chat/completions',
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

/**
 * Doprava, která počítá volání a **pamatuje si, co dostala**.
 *
 * Počítadlo je jediný způsob, jak dokázat, že se NEvolalo; seznam požadavků
 * je jediný způsob, jak dokázat, že uložený artefakt patří k tomu volání.
 */
function fakeProvider(
  bodies: readonly unknown[],
  usage?: Usage,
): ProviderTransport & { calls: number; sent: UpstreamRequest[] } {
  const state = {
    calls: 0,
    sent: [] as UpstreamRequest[],
    complete: async (request: UpstreamRequest): Promise<LiveCompletion> => {
      const body = bodies[Math.min(state.calls, bodies.length - 1)];
      state.calls += 1;
      state.sent.push(request);
      const result = completion(body, `resp_${state.calls}`);
      return usage === undefined ? result : { ...result, usage };
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
    // Cena vstupu je nula schválně: rezerva pak nezávisí na délce promptu a
    // vyjde přesně `MAX_OUTPUT_TOKENS × cena_výstupu`, tedy 0.016 USD.
    // Skutečná cena volání je 500 výstupních tokenů = 0.0005 USD.
    // Strop 0.0165 pokryje dvě volání a před třetím rezerva nevyjde.
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({
      env: { ...FULL, EVAL_SPEND_CAP_USD: '0.0165', EVAL_USD_PER_MTOK_IN: '0', EVAL_USD_PER_MTOK_OUT: '1' },
      provider,
      replay,
      promptIds: ['C01', 'C02', 'C04'],
      root: tempRoot(),
    });

    expect(report.complete, 'useknutý běh se vykázal jako úplný').toBe(false);
    expect(report.stoppedReason).toContain('CAP_RESERVE');
    expect(report.total).toBe(3);
    // Přesně dvě volání. `toBeLessThan` by prošlo i s nulou odbavených promptů.
    expect(provider.calls, 'strop nezastavil přesně po druhém volání').toBe(2);
    expect(report.attempted).toBe(2);
    expect(report.spentUsd).toBeCloseTo(0.001, 10);
    // A hlavně: schválený strop se NEPŘEKROČIL. Bez rezervy by běh pustil
    // ještě třetí volání, protože do stropu „ještě něco zbývalo".
    expect(report.spentUsd!).toBeLessThanOrEqual(report.capUsd!);
  });

  it('rezerva zastaví běh dřív, než se překročí strop o celé volání', async () => {
    // Strop menší než rezerva jednoho volání: neodbaví se ANI JEDEN prompt,
    // přestože strop je kladný a preflight sám by start pustil.
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({
      env: { ...FULL, EVAL_SPEND_CAP_USD: '0.001', EVAL_USD_PER_MTOK_IN: '0', EVAL_USD_PER_MTOK_OUT: '1' },
      provider,
      replay,
      promptIds: ['C01'],
      root: tempRoot(),
    });

    expect(provider.calls, 'volání proběhlo, i když ho strop nemohl pokrýt').toBe(0);
    expect(report.complete).toBe(false);
    expect(report.stoppedReason).toContain('CAP_RESERVE');
    expect(report.spentUsd).toBe(0);
  });

  it('neznámá útrata běh ZASTAVÍ a účtuje se jako nejhorší možná', async () => {
    // Volání proběhlo, takže ho poskytovatel účtovat mohl — jen jeho odpověď
    // nejde přečíst. Kdyby se to počítalo jako nula a běh pokračoval, zbylých
    // 14 promptů se zavolá s cenou, kterou nikdo nesčítá, a strop nesepne ani
    // po patnácté. Tři prompty, jedna vadná odpověď hned na první.
    const provider = fakeProvider([freshBody()], { inputTokens: Number.NaN, outputTokens: 500 });
    const report = await runLiveChain({
      env: FULL,
      provider,
      replay,
      promptIds: ['C01', 'C02', 'C04'],
      root: tempRoot(),
    });

    expect(report.failures.map((failure) => failure.kind)).toEqual(['provider']);
    expect(report.failures[0].detail).toContain('usage');
    expect(provider.calls, 'běh volal dál s nezapočítanou útratou').toBe(1);
    expect(report.spentUsd, 'neznámá útrata se započítala jako nula').toBeGreaterThan(0);
    expect(report.complete).toBe(false);
    expect(report.stoppedReason).toContain('PROVIDER_UNUSABLE');
    expect(report.cases).toEqual([]);
    expect(report.ok, 'běh, který nezměřil nic, se vykázal jako v pořádku').toBe(false);
  });

  it('nulová cena výstupu neprojde — jinak je rezerva i strop nula', async () => {
    // Při ceně výstupu 0 vyjde nula i nejhorší možná cena volání, rezerva nic
    // nezadrží a celá sada se protočí, zatímco poskytovatel účtuje.
    const provider = fakeProvider([freshBody()]);
    await expect(
      runLiveChain({
        env: { ...FULL, EVAL_USD_PER_MTOK_IN: '0', EVAL_USD_PER_MTOK_OUT: '0', EVAL_SPEND_CAP_USD: '0.000001' },
        provider,
        replay,
        promptIds: ['C01', 'C02', 'C04'],
        root: tempRoot(),
      }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(provider.calls, 'při nulové ceně se přesto volalo').toBe(0);
  });

  it('sada bez jediného promptu není úplný běh', async () => {
    // `promptIds` s překlepem: `total: 0`. Bez ošetření by vyšlo
    // `complete: true, ok: true` — hotové měření, které nezměřilo nic.
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['NEEXISTUJE'], root: tempRoot() });

    expect(provider.calls).toBe(0);
    expect(report.total).toBe(0);
    expect(report.complete, 'prázdná sada se vykázala jako úplný běh').toBe(false);
    expect(report.ok, 'prázdná sada se vykázala jako v pořádku').toBe(false);
  });

  it('uložený požadavek je ten, který doopravdy odešel', async () => {
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['C01'], root: tempRoot() });

    const stored = JSON.parse(readFileSync(report.cases[0].responsePath, 'utf8')) as { request: UpstreamRequest };
    expect(provider.sent).toHaveLength(1);
    // Ne „stejně vypadající", ale týž obsah jako objekt předaný dopravě.
    // Druhá konstrukce téhož požadavku by artefakt s voláním nespojila.
    expect(stored.request).toEqual(provider.sent[0]);
    expect(stored.request.model, 'záznam nese jméno modelu, který se nezavolal').toBe(LIVE_MODELS[0].id);
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

    // Neúplnost musí umět říct proč. `complete: false` se `stoppedReason: null`
    // je report, který si protiřečí — čtenář pak hledá chybu ve stropu.
    expect(report.complete).toBe(false);
    expect(report.stoppedReason, 'neúplný běh neřekl proč').toContain('PROVIDER_UNUSABLE');
    expect(report.ok).toBe(false);
  });
});

describe('chyba poskytovatele se hlásí bez jeho těla', () => {
  it('401 nevypíše tělo odpovědi, jen kód a typ', async () => {
    // U 401 poskytovatel odesílaný klíč v těle cituje a špatně nastavená proxy
    // ho umí vrátit celý. Hláška končí v logu běhu a v CI výstupu.
    const leaky = JSON.stringify({
      error: { type: 'invalid_request_error', code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` },
    });
    const fakeFetch = (async () =>
      new Response(leaky, { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const thrown = await openAiTransport(fakeFetch)
      .complete({ model: 'gpt-5.6', system: 'S', user: 'U' }, okConfig())
      .then(() => null, (error: Error) => error);

    expect(thrown, 'volání s 401 neselhalo').not.toBeNull();
    expect(thrown!.message).not.toContain(KEY);
    expect(thrown!.message, 'z hlášky nejde poznat, co se stalo').toContain('401');
    expect(thrown!.message).toContain('invalid_api_key');
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

  it('zmrazené tělo s přeskládanými klíči branou neproklouzne', async () => {
    // `JSON.stringify` je citlivý na pořadí klíčů, takže zmrazené tělo
    // protažené čímkoli, co objekty přeskládá, dá jiný hash — a významově je
    // to pořád tentýž záznam. Kanonický tvar tuhle skulinu zavírá.
    const reordered = JSON.parse(JSON.stringify(c01.body)) as Record<string, unknown>;
    const flipped = Object.fromEntries(Object.entries(reordered).reverse());
    expect(stageHash(flipped), 'přeskládání nic nezměnilo, test by netvrdil nic').not.toBe(stageHash(c01.body));
    expect(canonicalHash(flipped)).toBe(canonicalHash(c01.body));

    const provider = fakeProvider([flipped]);
    const report = await runLiveChain({ env: FULL, provider, replay, promptIds: ['C01'], root: tempRoot() });
    expect(report.failures.map((failure) => failure.kind)).toContain('frozen-leak');
  });
});

// ---------------------------------------------------------------------------
// Doprava k předplatnému a brána profilu
// ---------------------------------------------------------------------------

const VALID_USAGE = { input_tokens: 12, output_tokens: 7 };

/**
 * Odpověď anthropicského tvaru — jiná pole než u chat completions.
 *
 * `usage` je **povinný parametr, i pro šťastnou cestu**. Výchozí hodnota by
 * spolkla právě ten tvar, o který tu jde nejvíc: `undefined` znamená „pole
 * `usage` v odpovědi vůbec není" (`JSON.stringify` klíč s `undefined` zahodí),
 * jenže jako výchozí argument by se místo něj tiše dosadilo platné `usage` a
 * test chybějícího pole by procházel nad odpovědí, které nic nechybí.
 */
const anthropicReply = (text: string, usage: unknown): Response =>
  new Response(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('doprava k předplatnému', () => {
  const request: UpstreamRequest = { model: 'gpt-5.6-sol', system: 'SYSTEM', user: 'USER' };

  it('posílá systémovou zprávu jako vlastní pole, ne jako roli v messages', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const transport = anthropicTransport(async (url, init) => {
      sent = { url: String(url), init: init! };
      return anthropicReply('{"a":1}', VALID_USAGE);
    });

    const result = await transport.complete(request, subscriptionConfig());
    const body = JSON.parse(String(sent!.init.body)) as Record<string, unknown>;

    expect(body.system).toBe('SYSTEM');
    expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    // `response_format` tenhle tvar nezná; poslat ho je 400, ne tichá tolerance.
    expect(body).not.toHaveProperty('response_format');
    expect(sent!.url).toContain('localhost');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.text).toBe('{"a":1}');
  });

  it('klíč se k předplatnému neposílá, protože ho konfigurace nemá', async () => {
    let headers: Record<string, string> = {};
    const transport = anthropicTransport(async (_url, init) => {
      headers = init!.headers as Record<string, string>;
      return anthropicReply('{}', VALID_USAGE);
    });
    await transport.complete(request, subscriptionConfig());
    expect(JSON.stringify(headers)).not.toContain(KEY);
    expect(headers.authorization).toBe('Bearer unused');
  });

  it('slepí víc textových bloků a ty netextové zahodí', async () => {
    const transport = anthropicTransport(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: '{"a":' },
              { type: 'thinking', thinking: 'ignoruj mě' },
              { type: 'text', text: '1}' },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    expect((await transport.complete(request, subscriptionConfig())).text).toBe('{"a":1}');
  });

  it('chybějící usage je selhání, ne nula — i když se neplatí za tokeny', async () => {
    for (const usage of [undefined, {}, { input_tokens: 5 }, { input_tokens: 5, output_tokens: -1 }]) {
      const transport = anthropicTransport(async () => anthropicReply('{}', usage));
      await expect(transport.complete(request, subscriptionConfig())).rejects.toThrow(/usage/);
    }
  });

  it('chybu nepřepisuje tělem odpovědi', async () => {
    const transport = anthropicTransport(
      async () =>
        new Response(JSON.stringify({ error: { type: 'overloaded_error', message: `token ${KEY}` } }), { status: 529 }),
    );
    await expect(transport.complete(request, subscriptionConfig())).rejects.toThrow(/529/);
    await expect(transport.complete(request, subscriptionConfig())).rejects.not.toThrow(new RegExp(KEY));
  });
});

describe('doprava a profil k sobě musí sedět', () => {
  const request: UpstreamRequest = { model: 'gpt-5.6', system: 'S', user: 'U' };
  const never = async (): Promise<Response> => {
    throw new Error('doprava se zavolala, přestože měla odmítnout dřív');
  };

  it('metrovaná doprava odmítne nemetrovanou konfiguraci', async () => {
    await expect(openAiTransport(never).complete(request, subscriptionConfig())).rejects.toThrow(/openai-chat/);
  });

  it('anthropicská doprava odmítne model mluvící jiným tvarem', async () => {
    await expect(anthropicTransport(never).complete(request, okConfig())).rejects.toThrow(/anthropic-messages/);
  });

  it('žádná položka allowlistu nespojuje placený profil s anthropickým tvarem', () => {
    // Kontrola nad SKUTEČNÝM artefaktem, ne nad ručně složeným objektem.
    // Kdyby taková položka vznikla, mířil by placený klíč na adresu, kterou
    // určuje ta položka — a to je jediná cesta, jak by mohl uniknout.
    expect(LIVE_MODELS.filter((model) => model.profile === 'api' && model.wire === 'anthropic-messages')).toEqual([]);
  });

  it('anthropicská doprava odmítne i metrovanou konfiguraci, ne jen cizí tvar', async () => {
    // Dnes nesestavitelné z allowlistu — proto ta konfigurace vzniká ručně.
    // Je to pojistka pro chvíli, kdy do allowlistu někdo takovou položku
    // přidá: má spadnout na dopravě, ne tiše odeslat klíč.
    const proxyModel = LIVE_MODELS.find((model) => model.wire === 'anthropic-messages')!;
    const metered = { ...okConfig(), model: proxyModel };
    await expect(anthropicTransport(never).complete(request, metered)).rejects.toThrow(/nemetrovaná doprava/);
  });

  it('dopravu vybírá allowlist podle tvaru drátu', async () => {
    let hit = '';
    const toProxy = async (url: RequestInfo | URL): Promise<Response> => {
      hit = String(url);
      return anthropicReply('{}', VALID_USAGE);
    };
    await transportFor(subscriptionConfig(), toProxy).complete(request, subscriptionConfig());
    expect(hit).toContain('localhost');

    const toApi = async (url: RequestInfo | URL): Promise<Response> => {
      hit = String(url);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    };
    await transportFor(okConfig(), toApi).complete(request, okConfig());
    expect(hit).toContain('api.openai.com');
  });
});

describe('bez předané dopravy ji vybere allowlist', () => {
  // Tohle je ta cesta, kterou jede `e2e/live-chain.spec.ts`. Dokud si spec
  // dopravu předával sám, mířila natvrdo na placený endpoint a profil
  // předplatného neprošel ani jedním voláním.
  // Úklid patří vitestu, ne `finally`: `finally` doběhne až se ten příslib
  // usadí, takže kdyby běh někdy zamrznul, zůstane atrapa nainstalovaná a
  // další testy v souboru by prošly proti podvržené odpovědi. `afterEach`
  // uklidí i po testu, který spadl na timeout.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const urlsHitBy = async (env: Env, reply: () => Response): Promise<string[]> => {
    const hits: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL): Promise<Response> => {
      hits.push(String(url));
      return reply();
    });
    await runLiveChain({ env, provider: 'allowlist', replay, promptIds: ['C01'], root: tempRoot() });
    return hits;
  };

  it('profil předplatného jde na lokální proxy, ne na placený endpoint', async () => {
    const hits = await urlsHitBy(
      SUBSCRIPTION,
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(freshBody()) }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    expect(hits, 'nezavolalo se nic — výchozí doprava chybí').toHaveLength(1);
    expect(hits[0]).toContain('localhost');
    expect(hits[0]).not.toContain('api.openai.com');
  });

  it('metrovaný profil jde na endpoint poskytovatele', async () => {
    const hits = await urlsHitBy(
      FULL,
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(freshBody()) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('api.openai.com');
  });
});

describe('brána profilu — co smí být výsledek brány', () => {
  const report = (profile: ProviderProfile, caseProfiles: readonly ProviderProfile[]): LiveReport =>
    ({
      runId: 'R',
      model: 'm',
      profile,
      cases: caseProfiles.map((each, index) => ({ id: `C0${index}`, profile: each })),
      records: [],
      counts: { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 },
      fulfilled: 0,
      attempted: caseProfiles.length,
      total: caseProfiles.length,
      complete: true,
      stoppedReason: null,
      spentUsd: 0,
      capUsd: 50,
      calls: caseProfiles.length,
      callCap: null,
      browserReplays: 0,
      responsesDir: '',
      failures: [],
      ok: true,
    }) as unknown as LiveReport;

  it('celý api běh projde', () => {
    expect(() => assertGateProfile(report('api', ['api', 'api']))).not.toThrow();
  });

  it('běh přes předplatné neprojde, i když je jinak bez chyby', () => {
    expect(() => assertGateProfile(report('subscription', ['subscription']))).toThrow(ProfileGateError);
  });

  it('smíchaný běh neprojde — kontroluje se po případech, ne hlavička', () => {
    // Hlavička říká `api`, ale polovina čitatele vznikla přes předplatné.
    // Kontrola nad jednou hodnotou by tenhle běh pustila.
    expect(() => assertGateProfile(report('api', ['api', 'subscription']))).toThrow(ProfileGateError);
    expect(() => assertGateProfile(report('api', ['api', 'subscription']))).toThrow(/subscription/);
  });

  it('prázdný běh neprojde — nic nedokazuje', () => {
    // `every()` nad prázdným polem je `true`, takže bez téhle podmínky by
    // report bez jediného případu prošel jako čistý.
    expect(() => assertGateProfile(report('api', []))).toThrow(ProfileGateError);
    // A hláška musí říct PROČ. Společná věta pro obě vady tady vypisovala
    // „smí vzniknout jedině z api, ale běh nese api", což si protiřečí.
    expect(() => assertGateProfile(report('api', []))).toThrow(/jediný případ/);
    expect(() => assertGateProfile(report('api', []))).not.toThrow(/ale běh nese api\./);
  });

  it('vyhrazené jméno souboru dostane jedině api běh', () => {
    expect(reportPath(report('api', ['api']), '/x')).toBe(join('/x', 'evals', 'kill-gate-report.json'));
    expect(reportPath(report('subscription', ['subscription']), '/x')).toBe(
      join('/x', 'evals', 'dev-report.subscription.json'),
    );
    // A smíchaný běh nedostane ani jedno jméno — spadne dřív.
    expect(() => reportPath(report('api', ['subscription']), '/x')).toThrow(ProfileGateError);
  });
});

describe('běh přes předplatné', () => {
  it('razítkuje profil do uložené odpovědi i do výsledku případu', async () => {
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({ env: SUBSCRIPTION, provider, replay, promptIds: ['C01'], root: tempRoot() });

    expect(report.profile).toBe('subscription');
    expect(report.cases[0].profile).toBe('subscription');
    // Dolary jsou `null`, ne nula: nula by tvrdila, že se měřila útrata.
    expect(report.spentUsd).toBeNull();
    expect(report.capUsd).toBeNull();
    expect(report.cases[0].costUsd).toBeNull();
    expect(report.calls).toBe(1);
    expect(report.callCap).toBe(3);

    const stored = JSON.parse(readFileSync(report.cases[0].responsePath, 'utf8')) as Record<string, unknown>;
    expect(stored.profile, 'razítko chybí v artefaktu na disku').toBe('subscription');
    expect(stored.endpoint).toContain('localhost');
    expect(stored.costUsd).toBeNull();

    // A ten běh se nesmí dostat do brány, i když je jinak bezvadný.
    expect(report.failures).toEqual([]);
    expect(() => assertGateProfile(report)).toThrow(ProfileGateError);
  });

  it('strop počtu volání zastaví běh přesně na svém čísle', async () => {
    const provider = fakeProvider([freshBody()]);
    const report = await runLiveChain({
      env: { ...SUBSCRIPTION, EVAL_CALL_CAP: '2' },
      provider,
      replay,
      promptIds: ['C01', 'C02', 'C03', 'C04'],
      root: tempRoot(),
    });

    expect(provider.calls, 'strop nezastavil přesně po druhém volání').toBe(2);
    expect(report.attempted).toBe(2);
    expect(report.complete).toBe(false);
    expect(report.stoppedReason).toContain('CALL_CAP_EXHAUSTED');
  });

  it('padající volání se do stropu počítá — jinak by šla opakovat donekonečna', async () => {
    const exploding: ProviderTransport = {
      complete: async () => {
        throw new Error('poskytovatel vrátil 500');
      },
    };
    const report = await runLiveChain({
      env: { ...SUBSCRIPTION, EVAL_CALL_CAP: '2' },
      provider: exploding,
      replay,
      promptIds: ['C01', 'C02', 'C03'],
      root: tempRoot(),
    });

    expect(report.calls).toBe(1);
    expect(report.attempted).toBe(0);
    expect(report.ok).toBe(false);
  });
});
