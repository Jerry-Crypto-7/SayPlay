/**
 * `POST /api/play/games/:id/remix` – nová verze z rodiče: čipem
 * („CHANGE ONE THING" – RFC 6902 záplata režiséra, `remixPatch`), hotovým
 * specem, nebo vlastní větou (P27C T4). Rodič se nemění nikdy; dítě nese
 * `parentId` a publikuje se toutéž cestou jako `POST /api/play/games`.
 *
 * Semínko dítěte se odvozuje z rodiče a čipu, takže týž čip na téhož rodiče
 * dá tutéž verzi – druhý klik je `200`, ne druhá hra.
 *
 * Věta, kterou `chipOf` pozná, jde cestou čipu (201 hned). Ostatní spustí
 * placenou práci na pozadí (`_remix-jobs.ts`) a odpoví `202
 * { status: 'pending', job, deadlineAt }`; stav vrací `GET …/remix?job=<id>`.
 */

import { z } from 'zod';

import { applyRemix, chipOf, REMIX_CHIPS, remixPatch } from '@/play/director/remix';
import type { GameSpecV1 } from '@/play/spec';

import { getCompiler } from '../../../_compiler';
import { fail, notFound, readJsonBody, refuseSentence, VERSION_ID_PATTERN } from '../../../_errors';
import {
  admit,
  derivedSeeds,
  directorCallerOf,
  isSeed,
  publishReadSpec,
  publishedResponse,
  publishRefusal,
  readSpecOrFail,
  seedFrom,
  store,
} from '../../../_publish';
import { cleanRemixSentence, remixStatus, startRemix } from '../../../_remix-jobs';
import { reportFor } from '../../../_report';

/** Nejdelší remixová věta – jedna změna, ne nová hra. */
export const MAX_REMIX_SENTENCE_CHARS = 140;

/** Práce spuštěná odsud běží v `after()` a potřebuje týž strop jako upgrade (R7). */
export const maxDuration = 300;

const bodySchema = z
  .object({
    chip: z.enum(REMIX_CHIPS).optional(),
    spec: z.unknown().optional(),
    sentence: z.string().max(4 * MAX_REMIX_SENTENCE_CHARS).optional(),
    seed: z.unknown().optional(),
  })
  .strict();

const JOB_PATTERN = /^[0-9a-f]{32}$/;

function noStore(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const startedAt = Date.now();
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return fail(400, 'BAD_REQUEST', 'send a chip from the list, a spec, or a sentence');
  const { spec, seed } = parsed.data;
  let { chip } = parsed.data;
  if ([chip, spec, parsed.data.sentence].filter((part) => part !== undefined).length !== 1) return fail(400, 'BAD_REQUEST', 'send exactly one of chip, spec or sentence');
  if (seed !== undefined && !isSeed(seed)) return fail(400, 'BAD_REQUEST', 'seed must be a whole number from 1 to 2^31 - 1');

  let sentence: string | null = null;
  if (parsed.data.sentence !== undefined) {
    sentence = cleanRemixSentence(parsed.data.sentence);
    if (sentence.length === 0 || sentence.length > MAX_REMIX_SENTENCE_CHARS) return fail(400, 'BAD_REQUEST', `the change must be 1 to ${String(MAX_REMIX_SENTENCE_CHARS)} characters`);
    // I věta, která je čipem: čip i placená úloha vydají dítě do veřejného feedu.
    const blocked = refuseSentence(sentence);
    if (blocked !== null) return blocked;
    // Věta, která je čipem, jde cestou čipu – bez modelu a hned.
    chip = chipOf(sentence) ?? undefined;
  }

  const versions = store();
  const parent = await versions.get(id);
  if (parent === null) return notFound();

  if (sentence !== null && chip === undefined) {
    // Úložiště, které by dítě stejně nezapsalo, nesmí nejdřív zaplatit model.
    const full = await publishRefusal(versions);
    if (full !== null) return full;
    return noStore(startRemix(versions, parent, { sentence, startedAt, caller: directorCallerOf(request) }), 202);
  }

  // Čip mění spec deterministicky ze semínka, proto semínko čipu vzniká dřív než spec dítěte.
  const chipSeed = seed ?? seedFrom({ parentId: id, chip: chip ?? null });
  let child;
  if (chip !== undefined) {
    // Twist smí přidat jen mechaniku, se kterou hra projde svými kontrolami –
    // stejnou kompilací a zprávou jako publikace níž.
    const compile = getCompiler();
    const acceptSeed = derivedSeeds(chipSeed)[0];
    const accept = (candidate: GameSpecV1): boolean => {
      const compiled = compile(candidate, acceptSeed);
      return compiled.ok && reportFor(compiled.value).publishEligible;
    };
    const ops = remixPatch(chip, parent.spec, chipSeed, accept);
    // Čip, který na téhle hře nemá co změnit, by vydal rodiče pod novým id.
    if (ops.length === 0) return fail(422, 'SPEC_REJECTED', 'this change does not apply to this game');
    const applied = applyRemix(parent.spec, ops);
    if (!applied.ok) return fail(422, 'SPEC_REJECTED', `${applied.reason}: the change could not be applied`);
    child = applied.spec;
  } else {
    const read = readSpecOrFail(spec);
    if (!read.ok) return read.response;
    child = read.value;
  }
  const childSeed = chip !== undefined ? chipSeed : (seed ?? seedFrom(child));
  const published = await publishReadSpec(versions, child, seed !== undefined ? [seed] : derivedSeeds(childSeed), id);
  return published.ok ? publishedResponse(published.value) : published.response;
}

/**
 * `GET /api/play/games/:id/remix?job=<id>` – stav remixu vlastní větou:
 * `pending` | `ready { versionId, changed }` | `final { reason }`. Práci
 * nespouští, proto jde přes páku `snapshots` jako ostatní čtení.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;
  const { id } = await context.params;
  const job = new URL(request.url).searchParams.get('job') ?? '';
  if (!VERSION_ID_PATTERN.test(id) || !JOB_PATTERN.test(job)) return notFound();
  const status = await remixStatus(store(), id, job);
  return status === null ? notFound() : noStore(status);
}
