/**
 * `POST /api/play/games/:id/remix` – nová verze z rodiče: čipem
 * („CHANGE ONE THING" – RFC 6902 záplata režiséra, `remixPatch`) nebo hotovým specem. Rodič se nemění nikdy; dítě nese
 * `parentId` a publikuje se toutéž cestou jako `POST /api/play/games`.
 *
 * Semínko dítěte se odvozuje z rodiče a čipu, takže týž čip na téhož rodiče
 * dá tutéž verzi – druhý klik je `200`, ne druhá hra.
 */

import { z } from 'zod';

import { applyRemix, REMIX_CHIPS, remixPatch } from '@/play/director/remix';
import type { GameSpecV1 } from '@/play/spec';

import { getCompiler } from '../../../_compiler';
import { fail, notFound, readJsonBody, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, derivedSeeds, isSeed, publishReadSpec, publishedResponse, readSpecOrFail, seedFrom, store } from '../../../_publish';
import { reportFor } from '../../../_report';

const bodySchema = z
  .object({
    chip: z.enum(REMIX_CHIPS).optional(),
    spec: z.unknown().optional(),
    seed: z.unknown().optional(),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return fail(400, 'BAD_REQUEST', 'send a chip from the list, or a spec');
  const { chip, spec, seed } = parsed.data;
  if ((chip === undefined) === (spec === undefined)) return fail(400, 'BAD_REQUEST', 'send exactly one of chip or spec');
  if (seed !== undefined && !isSeed(seed)) return fail(400, 'BAD_REQUEST', 'seed must be a whole number from 1 to 2^31 - 1');

  const versions = store();
  const parent = await versions.get(id);
  if (parent === null) return notFound();

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
