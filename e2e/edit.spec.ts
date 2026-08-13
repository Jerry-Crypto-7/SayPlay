/**
 * `POST /api/edit` — oracle úlohy T14.
 *
 * Testuje se **běžící produkční server** (`next build` + `next start`), ne
 * zavolaná funkce. Route má vlastní runtime (`nodejs`), vlastní serializaci
 * a čte zmrazený korpus přes `process.cwd()`; kdyby se volala přímo, prošlo by
 * i potrubí, které se z `next start` nedá spustit.
 *
 * **Žádný `page.route`.** Zmrazený korpus je jediný povolený double a je až za
 * hranicí (`src/model/client.ts` proti `MANIFEST.lock`). Odchycení `/api/edit`
 * v testu by udělalo z oracle sebe sama.
 *
 * **Oracle nečte tutéž cestu jako implementace.** Základní svět se bere z reálné
 * odpovědi `/api/emit`, patch se aplikuje **znovu tady** knihovnou `rfc6902`,
 * dosah se rozvíjí vlastním průchodem (ne přes `src/patch/scope.ts`) a verdikt
 * se počítá znovu přes `buildRuntimeWorld` + `verifyWitness`, ne z `certificate`
 * v odpovědi. Kdyby obojí četlo touž funkci, test by dokázal jen to, že se
 * implementace shoduje sama se sebou — tatáž vada, kvůli které vznikl bod (2)
 * AC T8b.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import { applyPatch, type Operation } from 'rfc6902';

import { buildRuntimeWorld } from '../src/ir/build';
import { worldDocSchema } from '../src/ir/worlddoc';
import type { TraceInput } from '../src/sim/interpreter';
import { verifyWitness, type VerifiableWorld } from '../src/verify/witness';

interface EmitResponse {
  readonly outcome: string;
  readonly doc: Record<string, unknown> | null;
}

interface EditResponse {
  readonly requestId: string;
  readonly promptId: string;
  readonly baseWorld: string;
  readonly outcome: 'CERTIFIED' | 'REJECTED';
  readonly patch: readonly Operation[];
  readonly label: string | null;
  readonly lanes: readonly string[];
  readonly applied: readonly string[];
  readonly changedLeaves: readonly string[];
  readonly revisions: {
    readonly sim: { readonly before: number; readonly after: number };
    readonly look: { readonly before: number; readonly after: number };
  };
  readonly certificate: { readonly verdict: string } | null;
  readonly anomalies: readonly { readonly kind: string; readonly label: string }[];
  readonly rejection: { readonly stage: string; readonly reason: string } | null;
  readonly upstream: { readonly user: string };
}

interface AllowedPath {
  readonly op: string;
  readonly path: string;
}

function jsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

/** Kontrakt se čte přímo ze zmrazeného souboru, ne přes `src/model/`. */
function contractOf(id: string): { baseWorld: string; allowedPaths: readonly AllowedPath[] } {
  const found = jsonl<{ id: string; kind: string; baseWorld?: string; allowedPaths?: AllowedPath[] }>(
    'evals/frozen/contracts.v1.jsonl',
  ).find((entry) => entry.id === id && entry.kind === 'edit');
  if (found === undefined) throw new Error(`frozen edit contract ${id} is missing — the corpus moved under the test`);
  return { baseWorld: found.baseWorld as string, allowedPaths: found.allowedPaths ?? [] };
}

function frozenPromptText(id: string): string {
  const record = jsonl<{ id: string; prompt: string }>('evals/frozen/prompts.v1.jsonl').find((entry) => entry.id === id);
  if (record === undefined) throw new Error(`frozen prompt ${id} is missing`);
  return record.prompt;
}

async function baseWorld(request: APIRequestContext, promptId: string): Promise<Record<string, unknown>> {
  const response = await request.post('/api/emit', { data: { promptId } });
  expect(response.status(), `emit ${promptId}`).toBe(200);
  const body = (await response.json()) as EmitResponse;
  expect(body.doc, `${promptId} nevydal dokument, proti kterému by šlo editovat`).not.toBeNull();
  return body.doc as Record<string, unknown>;
}

async function edit(
  request: APIRequestContext,
  promptId: string,
  doc: Record<string, unknown>,
  baseRevision?: { sim: number; look: number },
): Promise<EditResponse> {
  const response = await request.post('/api/edit', {
    data: {
      worldDoc: doc,
      baseRevision: baseRevision ?? { sim: doc.simRevision as number, look: doc.lookRevision as number },
      promptId,
    },
  });
  expect(response.status(), `edit ${promptId} musí odpovědět 200 s verdiktem`).toBe(200);
  return (await response.json()) as EditResponse;
}

// --- vlastní rozvinutí dosahu, nezávislé na `src/patch/scope.ts` -------------

const escape = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = (tokens: readonly string[]): string => tokens.map((token) => `/${escape(token)}`).join('');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function leavesOf(value: unknown, tokens: string[], out: Set<string>): void {
  if (value === undefined) return;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return void out.add(pointer(tokens));
    for (const key of keys) leavesOf(value[key], [...tokens, key], out);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return void out.add(pointer(tokens));
    value.forEach((item, index) => leavesOf(item, [...tokens, String(index)], out));
    return;
  }
  out.add(pointer(tokens));
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isRecord(a) && isRecord(b))
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => same(a[key], b[key]));
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => same(item, b[index]));
  return false;
}

/** `same` rozlišuje `null` od chybějícího klíče — `Object.is(null, undefined)` je `false`. */
function diffLeaves(before: unknown, after: unknown, tokens: string[], out: Map<string, LeafEffect>): void {
  if (same(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      diffLeaves(before[key], after[key], [...tokens, key], out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i += 1)
      diffLeaves(before[i], after[i], [...tokens, String(i)], out);
    return;
  }
  const effect: LeafEffect = before === undefined ? 'add' : after === undefined ? 'remove' : 'replace';
  const touched = new Set<string>();
  leavesOf(before, tokens, touched);
  leavesOf(after, tokens, touched);
  for (const path of touched) out.set(path, effect);
}

/** Svět po aplikaci patche — spočítaný **tady**, ne převzatý z odpovědi. */
function applied(doc: Record<string, unknown>, patch: readonly Operation[]): Record<string, unknown> {
  const draft = structuredClone(doc);
  const failures = applyPatch(draft, structuredClone(patch) as Operation[]).filter(
    (failure) => failure !== null && failure !== undefined,
  );
  expect(failures, 'patch se v testu nedal aplikovat, ačkoli endpoint hlásil commit').toEqual([]);
  return draft;
}

type LeafEffect = 'add' | 'remove' | 'replace';

interface MeasuredLeaf {
  readonly path: string;
  readonly effect: LeafEffect;
}

function changedLeafEffectsOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): MeasuredLeaf[] {
  const out = new Map<string, LeafEffect>();
  diffLeaves(before.sim, after.sim, ['sim'], out);
  diffLeaves(before.look, after.look, ['look'], out);
  return [...out.keys()].sort().map((path) => ({ path, effect: out.get(path) as LeafEffect }));
}

function changedLeavesOf(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return changedLeafEffectsOf(before, after).map((leaf) => leaf.path);
}

/**
 * Na deklarované cestě, nebo pod ní — nikdy nad ní, a **se shodnou operací**.
 * Odůvodnění obou půlek je v route testu u `insideContract`.
 */
function outsideContract(leaves: readonly MeasuredLeaf[], allowed: readonly AllowedPath[]): MeasuredLeaf[] {
  return leaves.filter(
    (leaf) =>
      !allowed.some((entry) => {
        if (leaf.path === entry.path) return leaf.effect === entry.op;
        if (!leaf.path.startsWith(`${entry.path}/`)) return false;
        return entry.op === 'replace' || leaf.effect === entry.op;
      }),
  );
}

function replay(doc: Record<string, unknown>): { world: VerifiableWorld; witness: readonly TraceInput[] } {
  const built = buildRuntimeWorld(doc.sim);
  expect(built.ok, 'svět po editaci se nedal znovu snížit').toBe(true);
  if (!built.ok) throw new Error(built.reason);
  return { world: built.world, witness: built.world.trace as readonly TraceInput[] };
}

// ---------------------------------------------------------------------------

test('vrátí patch, ne celý svět — a ten patch se transakčně aplikuje a projde verifikátorem', async ({ request }) => {
  const contract = contractOf('E01');
  const doc = await baseWorld(request, contract.baseWorld);
  const body = await edit(request, 'E01', doc);

  expect(body.outcome).toBe('CERTIFIED');
  expect(body.rejection).toBeNull();

  // **Patch, ne svět.** Failure signal Oracle úlohy doslova.
  expect(Array.isArray(body.patch)).toBe(true);
  expect(body).not.toHaveProperty('doc');
  expect(body).not.toHaveProperty('worldDoc');
  for (const operation of body.patch) expect(operation.path).toMatch(/^\/(sim|look)(\/|$)/);

  // Aplikace **tady**, ne přečtený výsledek — a teprve nad ní verifikátor.
  const after = applied(doc, body.patch);
  expect(worldDocSchema.safeParse(after).error?.issues ?? []).toEqual([]);
  const { world, witness } = replay(after);
  const verdict = verifyWitness(world, witness);
  expect(verdict.verdict, 'svět po editaci neprošel verifikátorem').toBe('CERTIFIED');
  expect(body.certificate?.verdict).toBe('CERTIFIED');

  // Zaznamenaný upstream nese text promptu — bez toho se nedá prokázat, že
  // odpověď patří k tomuhle zadání a ne k jinému běhu.
  expect(body.upstream.user).toContain(frozenPromptText('E01'));
});

test('rozvinutá množina změněných listů, ne přečtené operace', async ({ request }) => {
  // Review v4 (Q3/T14): kontrola cest v operacích nestačí, protože `replace` na
  // povoleném **předkovi** přepíše nepovolené potomky a formálně projde. Dosah
  // se proto počítá diffem stavu před a po — a tenhle test to dělá vlastním
  // průchodem, aby neměřil implementaci implementací.
  const contract = contractOf('E03');
  const doc = await baseWorld(request, contract.baseWorld);
  const body = await edit(request, 'E03', doc);
  expect(body.outcome).toBe('CERTIFIED');

  const after = applied(doc, body.patch);
  const measured = changedLeafEffectsOf(doc, after);
  expect(measured.length, 'patch bez jediného změněného listu je no-op, ne editace').toBeGreaterThan(0);
  expect(body.changedLeaves, 'endpoint počítá dosah jinak než nezávislé měření').toEqual(
    changedLeavesOf(doc, after),
  );
  expect(outsideContract(measured, contract.allowedPaths), 'dosah vystoupil z `allowedPaths`').toEqual([]);
});

test('`replace` na povoleném předkovi selže na rozvinuté množině listů', async ({ request }) => {
  // Konstruovaný případ, **schválně ne z korpusu**: tohle je jádro AC a nesmí
  // viset na tom, co zrovna zmrazená sada obsahuje.
  const contract = contractOf('E01');
  const doc = await baseWorld(request, contract.baseWorld);
  const ancestor = '/sim/state/timers/flood';
  const sneaky: Operation[] = [
    { op: 'replace', path: ancestor, value: { durationTicks: 2400, init: 1, min: 0, max: 2400 } },
  ];

  // Děravá kontrola: cesta operace je prefixem povolené cesty, takže projde.
  const byOperations = sneaky.every((operation) =>
    contract.allowedPaths.some(
      (entry) => entry.path === operation.path || entry.path.startsWith(`${operation.path}/`),
    ),
  );
  expect(byOperations, 'předpoklad testu padl: čtení operací už tenhle patch nepouští').toBe(true);

  // Rozvinutý dosah ukáže i `init`, který se změnil s ním.
  const outside = outsideContract(changedLeafEffectsOf(doc, applied(doc, sneaky)), contract.allowedPaths);
  expect(outside.map((leaf) => leaf.path)).toContain('/sim/state/timers/flood/init');
});

test('dráhu rozhodly cesty, ne štítek — a neshoda je telemetrie, ne odmítnutí', async ({ request }) => {
  const mislabelled = jsonl<{ forPrompt: string; branch: string; modelLabel?: string }>(
    'evals/frozen/responses/index.jsonl',
  ).filter((record) => record.branch === 'edit' && record.modelLabel !== undefined && record.modelLabel !== 'sim');
  expect(mislabelled.length, 'zmrazená sada přestala nést špatně oštítkovaný patch').toBeGreaterThan(0);

  const record = mislabelled[0];
  const contract = contractOf(record.forPrompt);
  const doc = await baseWorld(request, contract.baseWorld);
  const body = await edit(request, record.forPrompt, doc);

  expect(body.label, 'štítek se nezaznamenal').toBe(record.modelLabel);
  expect(body.lanes, 'štítek přebil cesty').toEqual(['rules']);
  expect(body.anomalies.map((anomaly) => anomaly.kind)).toEqual(['label-mismatch']);
  expect(body.rejection?.stage, 'neshoda štítku nesmí být důvod k odmítnutí').not.toBe('routing');
});

test('zastaralá revize je 409, a porovnává se ta, ke které patch podle cest patří', async ({ request }) => {
  const contract = contractOf('E01');
  const doc = await baseWorld(request, contract.baseWorld);
  const sim = doc.simRevision as number;
  const look = doc.lookRevision as number;

  // `sim` patch se **zastaralou `lookRevision`** projít musí — §13.1.1. Se
  // sdílenou revizí by ho vzhledový commit odmítl, ačkoli se na `sim` nic
  // nezměnilo.
  const staleLook = await request.post('/api/edit', {
    data: { worldDoc: doc, baseRevision: { sim, look: look + 7 }, promptId: 'E01' },
  });
  expect(staleLook.status(), 'zastaralá `lookRevision` zastavila patch pravidel').toBe(200);
  expect(((await staleLook.json()) as EditResponse).outcome).toBe('CERTIFIED');

  // Opačný případ musí být 409 — jinak by kontrola zastaralosti neexistovala.
  const staleSim = await request.post('/api/edit', {
    data: { worldDoc: doc, baseRevision: { sim: sim + 7, look }, promptId: 'E01' },
  });
  expect(staleSim.status()).toBe(409);
  const stale = (await staleSim.json()) as { error: { code: string; field: string }; revisions: unknown };
  expect(stale.error.code).toBe('STALE_REVISION');
  expect(stale.error.field).toBe('baseRevision/sim');
  // Rozhodlo se PŘED aplikací: revize se nepohnuly.
  expect(stale.revisions).toEqual({ sim: { before: sim, after: sim }, look: { before: look, after: look } });
});

test('naměřené odmítnutí je 200 s verdiktem a s atribucí, ne 5xx', async ({ request }) => {
  // Tentýž rozdíl, který hlídá `/api/emit`: vadný patch není spadlé potrubí.
  // `E21` je záměna cíle, po které stará vítězná stopa přestane vyhrávat —
  // endpoint ji proto neaplikuje a řekne kde.
  const contract = contractOf('E21');
  const doc = await baseWorld(request, contract.baseWorld);
  const body = await edit(request, 'E21', doc);

  expect(body.outcome).toBe('REJECTED');
  expect(body.rejection?.stage).toBe('witness');
  expect(body.applied, 'necertifikovaná `sim` se přesto aplikovala').not.toContain('sim');
  expect(body.changedLeaves, 'neaplikovaný patch vykázal dosah').toEqual([]);
  expect(body.revisions.sim.after, 'revize se zvedla i bez commitu').toBe(body.revisions.sim.before);
});

test('nevalidní vstup vrátí 400, cizí svět 404 nad dvojicí', async ({ request }) => {
  const doc = await baseWorld(request, 'C02');

  const noPrompt = await request.post('/api/edit', { data: { worldDoc: doc, baseRevision: { sim: 0, look: 0 } } });
  expect(noPrompt.status()).toBe(400);
  expect(((await noPrompt.json()) as { error: { field: string } }).error.field).toBe('promptId');

  // `baseRevision` musí být dvojice — jedno číslo znamená jednu revizi pro obě
  // části, tedy přesně ten konflikt, který §13.1.1 řeší.
  const oneNumber = await request.post('/api/edit', {
    data: { worldDoc: doc, baseRevision: 0, promptId: 'E01' },
  });
  expect(oneNumber.status()).toBe(400);
  expect(((await oneNumber.json()) as { error: { field: string } }).error.field).toBe('baseRevision');

  // Rozbité tělo se dá poslat jen po bajtech; řetězec by Playwright zabalil do
  // platného JSON a případ by tiše měřil tentýž kód jako ten nad ním.
  const notJson = await request.post('/api/edit', {
    data: Buffer.from('{ worldDoc: ', 'utf8'),
    headers: { 'content-type': 'application/json' },
  });
  expect(notJson.status()).toBe(400);
  expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe('MALFORMED_BODY');

  // `E01` je autorovaný proti `C02`. Proti jinému platnému světu pro něj
  // zmrazený záznam neexistuje — Oracle povoluje double jen vázaný na dvojici.
  const otherWorld = await baseWorld(request, 'C01');
  const wrongPair = await request.post('/api/edit', {
    data: {
      worldDoc: otherWorld,
      baseRevision: { sim: otherWorld.simRevision as number, look: otherWorld.lookRevision as number },
      promptId: 'E01',
    },
  });
  expect(wrongPair.status()).toBe(404);
  expect(((await wrongPair.json()) as { error: { code: string } }).error.code).toBe('UNKNOWN_PAIR');
});
