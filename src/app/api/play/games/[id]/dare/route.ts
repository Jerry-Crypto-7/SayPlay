/**
 * `POST /api/play/games/:id/dare` – výzva Dare (P36B T5). Klient pošle vstupy
 * svého běhu (zhuštěné běhy, `src/play/score/dare.ts`) a živé změny, které za
 * běhu přijal; server je přehraje na publikované hře (`scoredReplay`) a uloží
 * výsledek, který spočítal sám. **Skóre, čas ani hash od klienta se nečtou**
 * – pole navíc v těle se zahodí, neodmítnou (schéma bez `.strict()`).
 *
 * Odpověď `201 { dareId, score, ticks, board, beat }`; týž běh podruhé `200`
 * s týmž `dareId` – id je hash obsahu (hra, vstupy, změny), opakovaný požadavek
 * výzvu nezdvojí. Výzva žije stejně dlouho jako hra. Od P37C T1 nese i běh pro
 * ducha; čte ho `GET …/dare/:dareId`.
 *
 * Žebříček (P44B T5) píšou jen tyhle dveře: ověřená výhra bez živých změn pod
 * hráčem z podepsané cookie (bez cookie nebo s jedinou neplatnou se vydá nová),
 * jen když běh patří jemu – zapsal ho první (`by`) a není to posunutá kopie ducha
 * jiného hráče z žebříčku (T5b). `board: { place, of } | null`; `beat` = porazil běh
 * výzvu `against` téže hry (`null` = není s čím srovnat). Id hráče jde ven jen
 * v `set-cookie`.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ARCADE_LIMITS, type InputEvent } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { type LiveEntry, TIMES_OF_DAY, WEATHERS } from '@/play/arcade/live';
import { loadRapier } from '@/play/arcade/physics/world';
import { packInputs, unpackInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import { BOARD_READ_MAX, type BoardRow, bestRank, DARE_ID_PATTERN, type DareRecord, type DareReplay, type VersionStore, VersionStoreUnavailable } from '@/play/version';
import { identitySecret, playerCookieCount, playerOf } from '@/server/player-identity';

import { fail, notFound, readJsonBody, VERSION_ID_PATTERN } from '../../../_errors';
import { rateLimitCode, spendDareWindow, takeRateSlot } from '@/server/rate-limit';

import { mintPlayer } from '../../../_player';
import { admit, callerOf, markVolatileStore, store, voterOf } from '../../../_publish';

/** Živých změn za jeden běh – hráč jich v okénku udělá pár; strop drží cenu přehrání. */
export const MAX_DARE_PATCHES = 32;

/** O kolik tiků smí běh cizího hráče se stejným skóre ležet od řádku žebříčku, aby se porovnaly vstupy (T5b). */
export const NEAR_COPY_TICKS = 30;
/** Kolik takových řádků se porovná vstup po vstupu; každý stojí jedno čtení výzvy z úložiště. */
const NEAR_COPY_ROWS = 5;
/** Podíl tiků se vstupem (z obou běhů), ve kterých se běh po posunu shoduje s cizím; od něj je to kopie ducha. */
const NEAR_COPY_SHARE = 0.9;
/** Rozdíl osy (z ±1000), který ještě počítá jako tentýž vstup. */
const NEAR_COPY_AXIS = 50;

/** Tiky s nenulovým vstupem. */
function pressesOf(inputs: readonly InputEvent[]): Map<number, InputEvent> {
  return new Map(inputs.filter((event) => event.buttons !== 0 || event.axis !== 0).map((event) => [event.tick, event]));
}

/** Shoduje se `mine` s `theirs` posunutým o nejvýš `NEAR_COPY_TICKS` tiků aspoň v `NEAR_COPY_SHARE` tiků se vstupem? */
function copiesRun(mine: ReadonlyMap<number, InputEvent>, theirs: ReadonlyMap<number, InputEvent>): boolean {
  for (let shift = -NEAR_COPY_TICKS; shift <= NEAR_COPY_TICKS; shift += 1) {
    let same = 0;
    for (const [tick, event] of mine) {
      const other = theirs.get(tick - shift);
      if (other !== undefined && other.buttons === event.buttons && Math.abs(other.axis - event.axis) <= NEAR_COPY_AXIS) same += 1;
    }
    if (same >= NEAR_COPY_SHARE * (mine.size + theirs.size - same)) return true;
  }
  return false;
}

/**
 * Je běh téměř-kopie ducha jiného hráče v žebříčku téže hry (revize T5-1, T5b)? Duch je veřejný (`GET …/dare/:dareId`),
 * takže jeho vstupy posunuté o tik dají novou výzvu se stejným skóre. Shoda skóre a tiků sama nestačí: hry se skóre
 * po krocích a pevným koncem ji dávají i poctivým hráčům (přežití 60 s: každý vítěz 250 bodů v tiku 3 600) – proto
 * rozhodují vstupy.
 * simplified: celý běh posunutý najednou a jen `NEAR_COPY_ROWS` nejbližších řádků z `BOARD_READ_MAX`; kopie
 * s rozházenými tiky po jednom nebo se změněným skóre projde. Upgrade, až se kopie objeví: duch jako dráha místo vstupů.
 */
async function nearCopyOf(versions: VersionStore, versionId: string, playerId: string, run: { readonly score: number; readonly tick: number }, inputs: readonly InputEvent[]): Promise<boolean> {
  const rows = (await versions.board(versionId, BOARD_READ_MAX))
    .filter((row): row is BoardRow & { readonly dareId: string } => row.playerId !== playerId && row.dareId !== null && row.score === run.score && Math.abs(row.ticks - run.tick) <= NEAR_COPY_TICKS)
    .sort((a, b) => Math.abs(a.ticks - run.tick) - Math.abs(b.ticks - run.tick))
    .slice(0, NEAR_COPY_ROWS);
  const mine = pressesOf(inputs);
  for (const row of rows) {
    const replay = (await versions.getDare(row.dareId))?.replay;
    const theirs = replay === undefined ? null : unpackInputs(replay.inputs);
    if (Array.isArray(theirs) && copiesRun(mine, pressesOf(theirs))) return true;
  }
  return false;
}

const patchSchema = z.discriminatedUnion('kind', [
  // Roli kontroluje `patchProblem` při přehrání (jen role, které jde přidat a hra je má).
  z.object({ kind: z.literal('spawn'), role: z.string().max(32), count: z.number().int() }),
  z.object({ kind: z.literal('count'), counter: z.enum(['health', 'time', 'ammo']), amount: z.number().int() }),
  z.object({ kind: z.literal('visual'), weather: z.enum(WEATHERS).optional(), timeOfDay: z.enum(TIMES_OF_DAY).optional() }),
]);

const bodySchema = z.object({
  inputs: z.array(z.unknown()),
  patches: z
    .array(z.object({ tick: z.number().int().min(0).max(ARCADE_LIMITS.maxTicks - 1), patch: patchSchema }))
    .max(MAX_DARE_PATCHES)
    .optional(),
  // Výzva, kterou běh poráží (P44B T5); vadná hodnota výzvu neodmítne, jen `beat` je pak `null`.
  against: z.unknown().optional(),
});

/** Porazil běh uloženou výzvu `against` téže hry? `null` = není s čím srovnat: chybí, je cizí, neznámá, nebo jeden z běhů měnil hru. */
async function beatOf(versions: VersionStore, against: unknown, versionId: string, rank: number, liveChanges: number): Promise<boolean | null> {
  if (typeof against !== 'string' || !DARE_ID_PATTERN.test(against) || liveChanges > 0) return null;
  const rival = await versions.getDare(against);
  if (rival === null || rival.versionId !== versionId || rival.liveChanges > 0) return null;
  return rank > bestRank(rival.score, rival.ticks);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return fail(400, 'BAD_REQUEST', 'send the run as inputs, plus the live changes made during it');
  const inputs = unpackInputs(parsed.data.inputs);
  if (typeof inputs === 'string') return fail(400, 'BAD_REQUEST', inputs);
  const patches = (parsed.data.patches ?? []) as readonly LiveEntry[];

  const versions = store();
  const game = await versions.get(id);
  if (game === null) return markVolatileStore(notFound());
  if (game.arcade === undefined) return fail(422, 'DARE_REJECTED', 'this game cannot carry a dare');
  // Výzva přehrává celý běh (až ~250 ms CPU), proto má navíc vlastní, přísnější okno.
  // Slot bere až skutečné přehrání: levné vadné požadavky (400/404/422) jinak
  // zaplní strop instance a výzvy zavřou všem (nález 2. revize T5).
  const caller = callerOf(request);
  const slot = takeRateSlot('play/dare', caller);
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(429, code, code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client', { 'retry-after': String(slot.retryAfterSeconds) });
  }
  if (worldHasPhysics(game.arcade)) await loadRapier();

  const run = scoredReplay(game.arcade, inputs, patches);
  // Prohrané přehrání posílá cizí klient (náš jen po výhře): stojí ho zbytek okna výzev (T5r3r1).
  // Odmítnutá živá změna sem patří taky – přehrání v ní stojí, takže hra nikdy není `won`.
  if (run.outcome !== 'won') spendDareWindow(caller);
  if (run.refusedPatch !== null) return fail(422, 'DARE_REJECTED', `a live change does not fit this game: ${run.refusedPatch}`);
  if (run.outcome !== 'won') return fail(422, 'DARE_REJECTED', 'this run does not win this game, so it cannot be a dare');

  // Id z výsledku přehrání (hash konce, tik, skóre) a ze změn, které opravdu padly, seřazených
  // i uvnitř tiku – ne z poslaných bajtů: no-op vstup, vstup po konci nebo prohozené změny
  // v témž tiku by jinak daly tentýž běh pod novým id a každá kopie by ubrala denní strop (T5r1).
  const played = patches.filter((entry) => entry.tick < run.tick);
  const changes = played.map((entry) => JSON.stringify(entry)).sort();
  const dareId = createHash('sha256')
    .update(JSON.stringify({ versionId: id, hash: run.hash, ticks: run.tick, score: run.score, changes }))
    .digest('hex')
    .slice(0, 32);
  // Běh pro ducha (P37C T1): jen vstupy a změny, které přehrání opravdu spotřebovalo, znovu zhuštěné –
  // přehraje se k týmž bajtům hashe a vstupy po konci neberou místo v úložišti.
  const consumed = inputs.filter((event) => event.tick < run.tick);
  const replay: DareReplay = { v: 1, inputs: packInputs(consumed), patches: played };

  // Hráč (P44B T5) z platné cookie; bez cookie nebo s jedinou neplatnou (staré tajemství po restartu či rotaci –
  // od padělku k nerozeznání, T5b) dostane novou pod stropem T3. Zdvojená cookie ani vypnutá identita novou
  // nevydají a výzva platí bez autora – jako před P44B.
  const secret = identitySecret();
  let playerId = secret === null ? null : playerOf(request);
  let issued: Record<string, string> = {};
  if (secret !== null && playerId === null && playerCookieCount(request) <= 1) {
    const minted = await mintPlayer(request, versions, secret);
    if (minted.ok) {
      playerId = minted.id;
      issued = { 'set-cookie': minted.setCookie };
    }
  }

  const dare: DareRecord = {
    dareId,
    versionId: id,
    score: run.score,
    ticks: run.tick,
    hash: run.hash,
    liveChanges: played.length,
    createdAt: new Date().toISOString(),
    ...(playerId === null ? {} : { by: playerId }),
    replay,
  };
  let outcome;
  try {
    outcome = await versions.putDare(dare, voterOf(request));
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the dare could not be saved right now', issued);
    throw thrown;
  }
  if (outcome === 'quota') return fail(429, 'DARE_QUOTA', "today's dare quota is used up; try again tomorrow", { 'retry-after': '3600', ...issued });
  // Výzvu pro řazení feedu počítá server jen tady, u nové ověřené výzvy – ne podle slova klienta (P36B T9, revize T9-1).
  if (outcome === 'stored') await versions.countLoop(id, ['dare'], voterOf(request));

  // Do žebříčku jen výhra beze změn hry a jen hráči, kterému běh patří: zapsal ho první (debata T1).
  // Duch je veřejný: jeho kopie je táž výzva (`exists`), posunutá kopie nová výzva bez žebříčku (T5b) – cizímu hráči nepohne.
  let board: { place: number; of: number } | null = null;
  if (playerId !== null && played.length === 0 && (outcome === 'stored' || (await versions.getDare(dareId))?.by === playerId)) {
    try {
      const written = (await nearCopyOf(versions, id, playerId, run, consumed)) ? null : await versions.putBoardEntry(id, { playerId, dareId, score: run.score, ticks: run.tick });
      if (written !== null && written !== 'quota' && written.place !== null) board = { place: written.place, of: written.of };
    } catch (thrown) {
      // Žebříček je navíc: výzva je uložená a odkaz na ni platí.
      if (!(thrown instanceof VersionStoreUnavailable)) throw thrown;
    }
  }
  const beat = await beatOf(versions, parsed.data.against, id, bestRank(run.score, run.tick), played.length);
  // Trychtýř (P44B T12): porážku výzvy počítá jen server, jednou za den na hráče (bez identity na volajícího) a hru.
  if (beat === true) await versions.countFunnel('beat', id, playerId ?? voterOf(request));
  return markVolatileStore(
    Response.json(
      { dareId, score: run.score, ticks: run.tick, board, beat },
      { status: outcome === 'stored' ? 201 : 200, headers: { 'cache-control': 'no-store', ...issued } },
    ),
  );
}
