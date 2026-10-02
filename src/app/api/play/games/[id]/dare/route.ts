/**
 * `POST /api/play/games/:id/dare` – výzva Dare (P36B T5). Klient pošle vstupy
 * svého běhu (zhuštěné běhy, `src/play/score/dare.ts`) a živé změny, které za
 * běhu přijal; server je přehraje na publikované hře (`scoredReplay`) a uloží
 * výsledek, který spočítal sám. **Skóre, čas ani hash od klienta se nečtou**
 * – pole navíc v těle se zahodí, neodmítnou (schéma bez `.strict()`).
 *
 * Odpověď `201 { dareId, score, ticks }`; týž běh podruhé `200` s týmž
 * `dareId` – id je hash obsahu (hra, vstupy, změny), opakovaný požadavek
 * výzvu nezdvojí. Výzva žije stejně dlouho jako hra a nenese nic o hráči.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ARCADE_LIMITS } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { type LiveEntry, TIMES_OF_DAY, WEATHERS } from '@/play/arcade/live';
import { loadRapier } from '@/play/arcade/physics/world';
import { packInputs, unpackInputs } from '@/play/score/dare';
import { scoredReplay } from '@/play/score/replay';
import { type DareRecord, VersionStoreUnavailable } from '@/play/version';

import { fail, notFound, readJsonBody, VERSION_ID_PATTERN } from '../../../_errors';
import { rateLimitCode, takeRateSlot } from '@/server/rate-limit';

import { admit, callerOf, markVolatileStore, store } from '../../../_publish';

/** Živých změn za jeden běh – hráč jich v okénku udělá pár; strop drží cenu přehrání. */
export const MAX_DARE_PATCHES = 32;

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
});

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
  const slot = takeRateSlot('play/dare', callerOf(request));
  if (!slot.allowed) {
    const code = rateLimitCode(slot);
    return fail(429, code, code === 'SERVER_AT_CAPACITY' ? 'this instance is at capacity right now' : 'too many requests from this client', { 'retry-after': String(slot.retryAfterSeconds) });
  }
  if (worldHasPhysics(game.arcade)) await loadRapier();

  const run = scoredReplay(game.arcade, inputs, patches);
  if (run.refusedPatch !== null) return fail(422, 'DARE_REJECTED', `a live change does not fit this game: ${run.refusedPatch}`);
  if (run.outcome !== 'won') return fail(422, 'DARE_REJECTED', 'this run does not win this game, so it cannot be a dare');

  // Id jen z toho, co se opravdu přehrálo (vstupy a změny před koncem, změny podle tiku):
  // přeházené pořadí nebo vstup po konci jinak dá tentýž běh pod novým id.
  const played = [...patches].filter((entry) => entry.tick < run.tick).sort((a, b) => a.tick - b.tick);
  const dareId = createHash('sha256')
    .update(JSON.stringify({ versionId: id, inputs: packInputs(inputs.filter((event) => event.tick < run.tick)), patches: played }))
    .digest('hex')
    .slice(0, 32);
  const dare: DareRecord = { dareId, versionId: id, score: run.score, ticks: run.tick, hash: run.hash, liveChanges: played.length, createdAt: new Date().toISOString() };
  let outcome;
  try {
    outcome = await versions.putDare(dare);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the dare could not be saved right now');
    throw thrown;
  }
  if (outcome === 'quota') return fail(429, 'DARE_QUOTA', "today's dare quota is used up; try again tomorrow", { 'retry-after': '3600' });
  return markVolatileStore(
    Response.json({ dareId, score: run.score, ticks: run.tick }, { status: outcome === 'stored' ? 201 : 200, headers: { 'cache-control': 'no-store' } }),
  );
}
