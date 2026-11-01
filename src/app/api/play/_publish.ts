/**
 * Společná cesta spec → publikovaná verze (P23-C T3). Volají ji obě dveře,
 * které něco publikují: `POST /api/play/games` i `POST …/:id/remix`.
 *
 * Pořadí je smlouva: nejdřív brány, které nic nestojí (vypínač, strop
 * frekvence, tvar těla), pak rodič, pak kompilace, pak zápis. Odmítnutí
 * v kterémkoli kroku znamená, že do úložiště nešel ani bajt.
 *
 * **Táž hra podruhé je `200`, ne `409`.** `versionId` je hash obsahu, takže
 * když už pod ním něco leží, je to táž hra – jen s jiným `createdAt`. Čte se
 * proto dřív, než se píše; `conflict` z úložiště pak zbývá jen pro rozdíl
 * v tom, co do hashe nejde (zpráva o kvalitě), a to je poctivých 409.
 */

import { createHash } from 'node:crypto';

import { canonicalHash } from '@/ir/worlddoc';
import type { CompileGameReason, CompileGameResult } from '@/play/contracts';
import type { RepairIssue } from '@/play/director';
import { generatorOf, PHYSICS_NOT_LOADED, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { arcadeReport } from '@/play/arcade/verify';
import type { ChainWorld } from '@/play/chain/contract';
import { verifyChain } from '@/play/chain/verify';
import type { Honesty } from '@/play/draft/unsupported';
import { ROUTE_PENDING } from '@/play/genre/classify';
import { type GameSpecV1, readGameSpec } from '@/play/spec';
import { type PlayTimings, type PublishedGame, type PutOutcome, RECENT_CAP, type VersionStore, VersionStoreUnavailable, sealChainVersion, sealVersion, versionStoreFromEnv, volatileVersionStore } from '@/play/version';
import { BUILTIN_IDS } from '@/play/version/builtin';
import { previewOf } from '@/play/version/preview';
import { callerKey, rateLimitCode, takeRateSlot, trustedCallerKey } from '@/server/rate-limit';
import { killState, type KillState } from '@/server/kill-switch';
import { ownerIdentityRejection } from '@/server/owner-identity';
import { environmentScope, isServerless, sharedStoreFromEnv } from '@/server/spend-store';

import { getCompiler } from './_compiler';
import { startCustomEnv } from './_env';
import { blockedText, fail, SENTENCE_BLOCKED, VERSION_ID_PATTERN } from './_errors';
import { previewFor, reportFor } from './_report';
import { scheduleVoice } from './_voice';

/** Nejdelší věta, kterou dveře vezmou. Delší je 413, ne oříznutí. */
export const MAX_SENTENCE_CHARS = 500;

// Rapier pro fyzikální věci (P29A T13) se na serveru načítá hned: kontrola
// hratelnosti v opravném kole režiséra je synchronní a čekat na něj nemůže.
// Prohlížeč ho stahuje jen ke hře, která fyziku má (`ArcadePlay`).
loadRapier().catch(() => undefined);

/**
 * Semínko je celé číslo 1..2^31 − 1 (strop `sessionSeed` v blueprintu); bez něj
 * se odvodí z obsahu – nikde `Math.random`.
 */
export const MAX_SEED = 2 ** 31 - 1;

export function seedFrom(value: unknown): number {
  return (Number.parseInt(canonicalHash(value).slice(0, 8), 16) % MAX_SEED) + 1;
}

/**
 * Semínka, která dveře zkusí, když si volající žádné nevybral: odvozené a za
 * ním tři další, pořád deterministicky z něj. Rozvržení na některém semínku
 * umí vyjít nevyhratelné (naměřeno 21. 9. 2026: návrh „fragile cake" na
 * semínku z věty prohraje ve 6. tiku, na semínkách 1–3 vyhraje) – věta se
 * kvůli tomu nemá stát chybou. Semínko zvolené volajícím se nemění nikdy.
 */
export function derivedSeeds(base: number): readonly number[] {
  return [base, ...[1, 2, 3].map((attempt) => seedFrom({ base, attempt }))];
}

/** Důvody kompilace, které závisí na rozvržení, a proto má smysl zkusit jiné semínko. */
const SEED_DEPENDENT: ReadonlySet<CompileGameReason> = new Set(['UNWINNABLE', 'LAYOUT_FAILED']);

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEED;
}

export interface Published {
  readonly status: 200 | 201;
  readonly game: PublishedGame;
}

/** `issues`: proč kompilace nebo kontrola hru odmítla – pro záznam selhání, do odpovědi nejde. */
export type PublishResult = { readonly ok: true; readonly value: Published } | { readonly ok: false; readonly response: Response; readonly issues?: readonly string[] };

/**
 * Brány, které platí pro každé dveře: vypínač, ověřená identita za proxy a strop
 * frekvence. `null` = projdi. Zápis čte páku `sessions` (zakládání nového),
 * čtení páku `snapshots` (vydávání hotového – vypne ji jedině `all`).
 *
 * **Klíč stropu je z důvěryhodného konce, ne z `x-forwarded-for`.** Tu hlavičku
 * píše volající; s ní by si útočník kvótu resetoval každým požadavkem a naopak
 * uměl vyčerpat cizí (nález revize T3, táž třída jako `rate-limit.ts` 6. 9.).
 */
export async function admit(request: Request, lever: keyof KillState = 'sessions'): Promise<Response | null> {
  if ((await killState(process.env))[lever]) return fail(503, 'DISABLED', 'this part of PLAY is switched off right now');
  const identity = ownerIdentityRejection(request);
  if (identity !== null) return identity;
  const slot = takeRateSlot('play', callerOf(request));
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(
      429,
      code,
      code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client',
      { 'retry-after': String(slot.retryAfterSeconds) },
    );
  }
  return null;
}

/** Klíč volajícího pro strop frekvence. */
export function callerOf(request: Request): string {
  return trustedCallerKey(request) ?? callerKey(request);
}

/** Hlas volajícího pro čítače feedu (P36B T9): hash klíče `callerOf`, ať adresa do úložiště nejde. */
export function voterOf(request: Request): string {
  return createHash('sha256').update(callerOf(request)).digest('hex').slice(0, 16);
}

/** Společný počet všech volajících bez důvěryhodného klíče (R12). */
export const UNTRUSTED_DIRECTOR_CALLER = 'untrusted';

/**
 * Klíč denního počtu placených volání režiséra (R12). Jen z důvěryhodného
 * konce řetězu: mimo Vercel (a bez ověřené proxy vlastníka) žádný není a pád
 * `callerKey()` čte `x-forwarded-for`, kterou píše volající – každou novou
 * hlavičkou by si počet obnovil. Takoví volající proto sdílejí jeden počet:
 * pro poctivé horší mez, ale placená režie zůstane omezená. Lokální
 * `next start` je jeden stroj, tam je jeden počet správně.
 */
export function directorCallerOf(request: Request): string {
  return trustedCallerKey(request) ?? UNTRUSTED_DIRECTOR_CALLER;
}

export function store(): VersionStore {
  return versionStoreFromEnv(process.env);
}

/** Čtení z úložiště, které zmizí s procesem, to řekne hlavičkou (P27B T1); souborové úložiště (P40 T3) taky. */
export function markVolatileStore(response: Response): Response {
  if (sharedStoreFromEnv(process.env) === null && store().id === 'file') response.headers.set('x-play-store', 'file');
  else if (volatileVersionStore(process.env)) response.headers.set('x-play-store', 'memory');
  return response;
}

/** Rodič musí existovat dřív, než se kvůli němu něco kompiluje. */
export async function parentOf(versions: VersionStore, parentId: string): Promise<PublishedGame | null> {
  return VERSION_ID_PATTERN.test(parentId) ? versions.get(parentId) : null;
}

const COMPILE_MESSAGE: Readonly<Record<CompileGameReason, string>> = {
  SPEC_REJECTED: 'the game description was rejected',
  MECHANIC_UNSUPPORTED: 'the game uses a mechanic this build cannot compile yet',
  LAYOUT_FAILED: 'the game could not be laid out on the grid',
  WORLD_REJECTED: 'the game world did not pass verification',
  UNWINNABLE: 'no winning path was found for this game',
};

export type SpecRead = { readonly ok: true; readonly value: GameSpecV1 } | { readonly ok: false; readonly response: Response };

/**
 * Kde stráž nezapojených her P68 odmítá (R3): produkce podle `environmentScope` (jako kniha útraty), a nasazení,
 * které se nepředstavilo – vlastní jméno prostředí, nebo bez `VERCEL_ENV` na platformě či nad sdíleným úložištěm.
 * Preview a místní běh bez sdíleného úložiště pustí ruční specy kategorií (e2e). Místní `VERCEL_ENV=production`
 * (placený běh) je produkce i tady – e2e ruční spec P68 pak dostane 422 „not live yet“, schválně.
 * Veřejný server mimo Vercel bez sdíleného úložiště by vypadal jako místní běh; jediná taková cesta v repu
 * (`ops/host`) sdílenou knihu vyžaduje (`ops/host/preflight.mjs`), takže tam stráž odmítá (review R3).
 */
function servesPublicFeed(env: Record<string, string | undefined>): boolean {
  const scope = environmentScope(env);
  if (scope === 'production' || scope === 'unrecognized') return true;
  return scope === 'unset' && (isServerless(env) || sharedStoreFromEnv(env) !== null);
}

/** Generátory světů pěti her P68 (jména kusů zmrazená v T1, `src/play/arcade/library.ts`). */
const P68_GENERATORS: Readonly<Record<string, string>> = { stunt: 'stunt_track', minigolf: 'minigolf_course', railfps: 'railfps_rail', buildshift: 'buildshift_shop', drawsave: 'drawsave_level' };

/**
 * Spec od cizího projde `readGameSpec` dřív, než se z něj cokoli počítá –
 * i semínko. Hash nad surovým tělem by rekurzí spadl na hluboko vnořeném poli
 * (nález revize T3); validovaný spec má hloubku danou schématem.
 */
export function readSpecOrFail(input: unknown): SpecRead {
  const read = readGameSpec(input);
  if (!read.ok) return { ok: false, response: fail(422, 'SPEC_REJECTED', `${read.reason}: ${read.issues[0] ?? 'the game description was rejected'}`) };
  // P68I R1: hra P68 před „zapoj X“ nesmí do feedu ani ručním specem (POST hry, remix) – brána aktivace drží jen
  // klasifikátor a režiséra. Jen na produkci: e2e a testy kategorií publikují ruční specy her touto cestou.
  // Id ovládání pěti her P68 jsou shodná s id žánru, takže jedna množina hlídá `control` i `genre.id`; svět ale
  // vybírá generátor a ten staví hru pod jakýmkoli ovládáním (`controlParams.generator`, nález review R1).
  const pending = ROUTE_PENDING as ReadonlySet<string>;
  const generator = generatorOf(read.value);
  const unwired = pending.has(read.value.control ?? '') || pending.has(read.value.genre?.id ?? '') || [...pending].some((id) => P68_GENERATORS[id] === generator);
  if (unwired && servesPublicFeed(process.env)) {
    return { ok: false, response: fail(422, 'SPEC_REJECTED', 'this game type is not live yet') };
  }
  return { ok: true, value: read.value };
}

/**
 * Denní strop a zdraví úložiště **před** placeným voláním: věta, kterou by
 * úložiště stejně odmítlo, nesmí nejdřív zaplatit model (nález revize T1).
 * `null` = publikovat se dá.
 */
export async function publishRefusal(versions: VersionStore): Promise<Response | null> {
  try {
    if (await versions.canPublish()) return null;
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the game could not be saved right now');
    throw thrown;
  }
  return fail(429, 'PUBLISH_QUOTA', "today's publishing quota is used up; try again tomorrow", { 'retry-after': '3600' });
}

/**
 * Co se k publikované hře přidá mimo verzi (P23-D T2): původ návrhu, vztah
 * upgradu a vodopád bez kompilace a kontroly – ty dvě čísla změří tahle cesta.
 */
export interface PublishExtras {
  readonly origin?: PublishedGame['origin'];
  readonly sentence?: string;
  readonly relation?: PublishedGame['relation'];
  readonly timings?: Omit<PlayTimings, 'compileMs' | 'verifyMs'>;
}

function compileOnSeeds(spec: GameSpecV1, seeds: readonly number[]): CompileGameResult {
  const compile = getCompiler();
  let compiled = compile(spec, seeds[0]);
  for (const seed of seeds.slice(1)) {
    if (compiled.ok || !SEED_DEPENDENT.has(compiled.reason)) break;
    compiled = compile(spec, seed);
  }
  return compiled;
}

/**
 * Tatáž kompilace a kontrola jako `publishReadSpec`, ale jako nálezy pro
 * opravné kolo režiséra (P26 T10a): proč by publikace hru odmítla. Prázdné
 * pole = publikovat se dá.
 */
export function playabilityIssues(spec: GameSpecV1, seeds: readonly number[]): RepairIssue[] {
  const compiled = compileOnSeeds(spec, seeds);
  if (!compiled.ok && compiled.issues.includes(PHYSICS_NOT_LOADED)) {
    // Rapier se nenačetl: vada serveru, ne specu – model by kvůli ní fyziku zahodil.
    // Nálezy žádné; publikace (`publishReadSpec`) Rapier načte znovu a hru ověří sama.
    loadRapier().catch(() => undefined);
    return [];
  }
  if (!compiled.ok) {
    return [{ code: compiled.reason, path: '', evidence: compiled.issues.join('; ').slice(0, 500), repairHint: 'change the spec so the game compiles and the robot player can win it' }];
  }
  const report = reportFor(compiled.value);
  if (report.publishEligible) return [];
  const issues: RepairIssue[] = report.keypoints
    .filter((keypoint) => !keypoint.passed)
    .map((keypoint) => ({
      code: 'KEYPOINT_FAILED',
      path: `/verification/${String(spec.verification.findIndex((assertion) => assertion.id === keypoint.assertionId))}`,
      evidence: `keypoint ${keypoint.assertionId} failed: ${keypoint.failures.join('; ')}`.slice(0, 500),
      repairHint: 'either the game is wrong (fix the mechanics or roles so the world does what the keypoint claims) or the claim is wrong (fix the keypoint); decide which',
    }));
  if (!report.witness.certified) issues.push({ code: 'UNWINNABLE', path: '/verification', evidence: 'the robot player never won the game', repairHint: 'make the objective reachable' });
  if (!report.replayEqual) issues.push({ code: 'NOT_DETERMINISTIC', path: '', evidence: 'two replays of the witness ended in a different state', repairHint: 'remove what makes the run differ' });
  if (issues.length === 0) issues.push({ code: 'BUDGET', path: '/budgets', evidence: `the world has ${String(report.budgets.entities)} entities and ${String(report.budgets.rules)} rules`, repairHint: 'raise /budgets or reduce counts' });
  return issues;
}

/**
 * Smí remix tohohle rodiče do feedu? Jen když do feedu smí rodič sám: verze od režiséra,
 * remix, vestavěná hra, nebo kurátorský řádek, který feed ještě drží. Ruční spec a návrh
 * ze slov ne – jejich titul napsal volající a remix by ho přenesl do feedu.
 */
async function remixParentFeedable(versions: VersionStore, parentId: string | null): Promise<boolean> {
  if (parentId === null) return false;
  if (BUILTIN_IDS.has(parentId)) return true;
  const parent = await versions.get(parentId);
  if (parent === null) return false;
  if (parent.relation === 'upgrade' || parent.relation === 'remix') return true;
  return (await versions.recent(RECENT_CAP)).some((row) => row.versionId === parentId && row.curated === true);
}

export async function publishReadSpec(
  versions: VersionStore,
  spec: GameSpecV1,
  seeds: readonly number[],
  parentId: string | null,
  extras: PublishExtras = {},
): Promise<PublishResult> {
  // Feed je veřejný (P40 T2): text, který by dveře u věty odmítly, nesmí projít ani od režiséra, ani v hotovém specu.
  const blocked = blockedText(spec);
  if (blocked !== null) return { ok: false, response: fail(422, 'CONTENT_REJECTED', SENTENCE_BLOCKED), issues: ['CONTENT_REJECTED', blocked.slice(0, 120)] };

  await preloadPhysics(spec, loadRapier);
  const compileStarted = performance.now();
  const compiled = compileOnSeeds(spec, seeds);
  const compileMs = performance.now() - compileStarted;
  if (!compiled.ok) return { ok: false, response: fail(422, compiled.reason, COMPILE_MESSAGE[compiled.reason]), issues: [compiled.reason, ...compiled.issues] };

  // Hra, jejíž keypoint, svědek, replay nebo rozpočet neprošel, se nepublikuje –
  // odkaz by vedl na hru, která nedělá, co slibuje.
  const verifyStarted = performance.now();
  const report = reportFor(compiled.value);
  const verifyMs = performance.now() - verifyStarted;
  if (!report.publishEligible) {
    const keypoints = report.keypoints.filter((keypoint) => !keypoint.passed).map((keypoint) => keypoint.assertionId);
    return { ok: false, response: fail(422, 'NOT_PUBLISHABLE', 'the game did not pass its own checks', undefined, { keypoints }), issues: ['NOT_PUBLISHABLE', ...keypoints] };
  }
  const preview = previewFor(compiled.value);

  const version = sealVersion(compiled.value, parentId, Date.now);
  // Remix nese titul a texty rodiče: do feedu jen dítě rodiče, který do feedu smí (nález revize T10-2 #1).
  const relation = extras.relation === 'remix' && !(await remixParentFeedable(versions, parentId)) ? undefined : extras.relation;
  const game: PublishedGame = {
    version,
    spec,
    blueprint: compiled.value.blueprint,
    ...(compiled.value.arcade === undefined ? {} : { arcade: compiled.value.arcade }),
    report,
    ...(preview === null ? {} : { preview }),
    ...(extras.origin === undefined ? {} : { origin: extras.origin }),
    ...(extras.sentence === undefined ? {} : { sentence: extras.sentence }),
    ...(relation === undefined ? {} : { relation }),
    ...(extras.timings === undefined ? {} : { timings: { ...extras.timings, compileMs, verifyMs } }),
  };
  return storePublished(versions, game);
}

/**
 * Řetěz mikroher (P56C T10, kontrakt z debaty T9): projde `verifyChain` (každé kolo `verifyArcade`, celý řetěz
 * robotem, 30–90 s, ≥ 3 ovládání, hodiny každého kola do stropu záznamu Dare) a uloží se jako hra s `chain` bez
 * `arcade`. Zpráva o kvalitě je zpráva kola 1 s parem celého řetězu; náhled ve feedu je robot kola 1.
 */
export async function publishChain(versions: VersionStore, chain: ChainWorld, parentId: string | null, extras: Pick<PublishExtras, 'origin'> = {}): Promise<PublishResult> {
  const blocked = chain.rounds.map((round) => blockedText(round.spec)).find((text) => text !== null);
  if (blocked !== undefined) return { ok: false, response: fail(422, 'CONTENT_REJECTED', SENTENCE_BLOCKED), issues: ['CONTENT_REJECTED', blocked.slice(0, 120)] };

  const verdict = verifyChain(chain);
  if (verdict.failures.length > 0 || verdict.par === null) {
    return { ok: false, response: fail(422, 'NOT_PUBLISHABLE', 'the game did not pass its own checks'), issues: ['NOT_PUBLISHABLE', ...verdict.failures] };
  }
  const first = chain.rounds[0]!;
  const version = sealChainVersion(chain, parentId, Date.now);
  const report = arcadeReport(verdict.rounds[0]!, first.world, { specHash: version.specHash, worldHash: version.worldHash });
  const game: PublishedGame = {
    version,
    spec: first.spec,
    blueprint: null,
    chain,
    report: { ...report, witness: { certified: true, winsAtTick: verdict.par.ticks }, par: verdict.par },
    preview: previewOf(first.world, verdict.rounds[0]!.bot),
    ...(extras.origin === undefined ? {} : { origin: extras.origin }),
  };
  return storePublished(versions, game);
}

/** Zápis hotové hry: táž hra podruhé je `200` z úložiště, nová `201`; kvóta, konflikt a výpadek úložiště jako odpověď. */
async function storePublished(versions: VersionStore, game: PublishedGame): Promise<PublishResult> {
  const { version, spec } = game;
  const existing = await versions.get(version.versionId);
  if (existing !== null) {
    // Táž hra podruhé: hlas mohl minule spadnout se službou – služba má cache, zeptat se znovu nic nestojí.
    scheduleVoice(existing.spec);
    return { ok: true, value: { status: 200, game: existing } };
  }

  let outcome: PutOutcome;
  try {
    outcome = await versions.put(game);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable)
      return { ok: false, response: fail(503, 'STORE_UNAVAILABLE', 'the game could not be saved right now') };
    throw thrown;
  }
  if (outcome === 'quota')
    return { ok: false, response: fail(429, 'PUBLISH_QUOTA', "today's publishing quota is used up; try again tomorrow", { 'retry-after': '3600' }) };
  if (outcome === 'conflict')
    return { ok: false, response: fail(409, 'VERSION_CONFLICT', 'a different game already holds this version id') };
  // Prostředí, které knihovna nezná, se začne generovat hned (P29C T7); neblokuje.
  if (outcome === 'stored') startCustomEnv(spec.theme.setting);
  // Hlas vypravěče (P29D T11) na pozadí – publikace na něj nečeká a bez služby je stejná.
  scheduleVoice(spec);
  return { ok: true, value: { status: outcome === 'stored' ? 201 : 200, game } };
}

/**
 * Odpověď obou publikujících dveří: kam jít hrát, u návrhu z věty i kde čekat
 * na autorskou verzi. `honesty` (P25E) jen u věty, kterou knihovna neumí.
 */
export function publishedResponse(published: Published, upgrade = false, honesty: Honesty | null = null): Response {
  const { version, spec } = published.game;
  return Response.json(
    {
      versionId: version.versionId,
      title: version.title,
      parentId: version.parentId,
      archetype: spec.archetype,
      url: `/play/${version.versionId}`,
      ...(upgrade ? { upgrade: `/api/play/games/${version.versionId}/upgrade` } : {}),
      ...(honesty === null ? {} : { honesty }),
    },
    { status: published.status },
  );
}
