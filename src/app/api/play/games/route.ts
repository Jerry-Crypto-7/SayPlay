/**
 * `POST /api/play/games` – publikace hry z věty nebo z hotového specu.
 *
 * Tělo: `{ sentence?: string; spec?: GameSpecV1; seed?: number; parentId?: string | null }`,
 * právě jedno ze `sentence`/`spec`. Odpověď `201 { versionId, title, parentId,
 * archetype, url }`; táž hra podruhé `200` téhož tvaru. Kódy chyb a jejich
 * pořadí: `docs/play/shell.md`.
 */

import { z } from 'zod';

import { getDirector } from '../_director';
import { fail, readJsonBody } from '../_errors';
import { admit, derivedSeeds, isSeed, MAX_SENTENCE_CHARS, parentOf, publishReadSpec, publishedResponse, readSpecOrFail, seedFrom, store } from '../_publish';

const bodySchema = z
  .object({
    sentence: z.string().optional(),
    spec: z.unknown().optional(),
    seed: z.unknown().optional(),
    parentId: z.string().nullable().optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return fail(400, 'BAD_REQUEST', 'the request body has fields this door does not read');
  const { sentence, spec, seed, parentId = null } = parsed.data;
  if ((sentence === undefined) === (spec === undefined)) return fail(400, 'BAD_REQUEST', 'send exactly one of sentence or spec');
  if (sentence !== undefined && sentence.length > MAX_SENTENCE_CHARS) return fail(413, 'BODY_TOO_LARGE', `the sentence is longer than ${String(MAX_SENTENCE_CHARS)} characters`);
  if (seed !== undefined && !isSeed(seed)) return fail(400, 'BAD_REQUEST', 'seed must be a whole number from 1 to 2^31');

  const versions = store();
  if (parentId !== null && (await parentOf(versions, parentId)) === null) return fail(404, 'UNKNOWN_PARENT', 'the parent game does not exist');

  if (sentence !== undefined) {
    // Režisér vrací vždy hru: autorskou od modelu, nebo návrh ze slov.
    const directed = await getDirector()(sentence);
    const published = await publishReadSpec(versions, directed.spec, seed !== undefined ? [seed] : derivedSeeds(seedFrom(sentence.trim())), parentId);
    return published.ok ? publishedResponse(published.value) : published.response;
  }

  const read = readSpecOrFail(spec);
  if (!read.ok) return read.response;
  const published = await publishReadSpec(versions, read.value, seed !== undefined ? [seed] : derivedSeeds(seedFrom(read.value)), parentId);
  return published.ok ? publishedResponse(published.value) : published.response;
}
