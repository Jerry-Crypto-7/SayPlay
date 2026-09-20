/**
 * `POST /api/play/games/:id/remix` – nová verze z rodiče: čipem
 * („CHANGE ONE THING") nebo hotovým specem. Rodič se nemění nikdy; dítě nese
 * `parentId` a publikuje se toutéž cestou jako `POST /api/play/games`.
 *
 * Semínko dítěte se odvozuje z rodiče a čipu, takže týž čip na téhož rodiče
 * dá tutéž verzi – druhý klik je `200`, ne druhá hra.
 */

import { z } from 'zod';

import { applyChip, CHIPS } from '@/play/remix';

import { fail, notFound, readJsonBody, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, isSeed, publishReadSpec, publishedResponse, readSpecOrFail, seedFrom, store } from '../../../_publish';

const bodySchema = z
  .object({
    chip: z.enum(CHIPS).optional(),
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
  if (seed !== undefined && !isSeed(seed)) return fail(400, 'BAD_REQUEST', 'seed must be a whole number from 1 to 2^31');

  const versions = store();
  const parent = await versions.get(id);
  if (parent === null) return notFound();

  // Čip mění spec deterministicky ze semínka, proto semínko čipu vzniká dřív než spec dítěte.
  const chipSeed = seed ?? seedFrom({ parentId: id, chip: chip ?? null });
  const read = readSpecOrFail(chip !== undefined ? applyChip(parent.spec, chip, chipSeed) : spec);
  if (!read.ok) return read.response;
  const childSeed = chip !== undefined ? chipSeed : (seed ?? seedFrom(read.value));
  const published = await publishReadSpec(versions, read.value, childSeed, id);
  return published.ok ? publishedResponse(published.value) : published.response;
}
