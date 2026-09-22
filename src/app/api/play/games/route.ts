/**
 * `POST /api/play/games` – publikace hry z věty nebo z hotového specu.
 *
 * Tělo: `{ sentence?: string; spec?: GameSpecV1; seed?: number; parentId?: string | null }`,
 * právě jedno ze `sentence`/`spec`. Odpověď `201 { versionId, title, parentId,
 * archetype, url }`; táž hra podruhé `200` téhož tvaru. Kódy chyb a jejich
 * pořadí: `docs/play/shell.md`.
 *
 * Věta dostane návrh ze slov synchronně a v odpovědi navíc `upgrade` – adresu,
 * kde se klient ptá na autorskou verzi, kterou režisér dopočítá na pozadí
 * (`_upgrade.ts`, P23-D T2). Věta, kterou knihovna ovládání neumí, dostane
 * navíc `honesty: { reason, closest }` (P25E T2) – hra se publikuje i tak.
 */

import { z } from 'zod';

import { draftGameSpec } from '@/play/draft';
import { unsupportedGame } from '@/play/draft/unsupported';
import { RECENT_CAP } from '@/play/version';
import { diversify } from '@/play/version/diversify';

import { getDirector } from '../_director';
import { fail, readJsonBody } from '../_errors';
import { admit, derivedSeeds, directorCallerOf, isSeed, MAX_SENTENCE_CHARS, parentOf, publishReadSpec, publishRefusal, publishedResponse, readSpecOrFail, seedFrom, store } from '../_publish';
import { upgradeOf } from '../_upgrade';

const bodySchema = z
  .object({
    sentence: z.string().optional(),
    spec: z.unknown().optional(),
    seed: z.unknown().optional(),
    parentId: z.string().nullable().optional(),
  })
  .strict();

/**
 * Strop trvání funkce (R7): drží synchronní režii i upgrade v `after()`.
 * Režisér se do něj vejde sám (`DIRECTOR_BUDGET_MS` v `_director.ts`);
 * Next.js čte hodnotu staticky, proto literál.
 */
export const maxDuration = 300;

/** Nejvíc karet na jeden dotaz feedu. Neexportuje se – route soubor smí vyvážet jen handlery. */
const MAX_FEED = 48;

/**
 * `GET /api/play/games?recent=N` – feed (P23-D T4): `{ games: [{ versionId,
 * title, archetype, createdAt, parentId, remixes }] }` od nejnovější, v každé
 * osmici nejvýš tři hry téhož archetypu (`diversify`). Jen autorské verze od
 * režiséra – proč, říká `put` v `store.ts`. Stojí dva příkazy úložiště
 * (seznam a počty dětí), vlastní páku `feed` a strop jako každé čtení; hrana
 * ho smí 15 s držet, a proto dotaz nesmí nést nic jiného než kanonické `recent`
 * – náhodný parametr navíc by cache obešel pokaždé.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = await admit(request, 'feed');
  if (refused !== null) return refused;

  const query = new URL(request.url).searchParams;
  const text = query.get('recent');
  const limit = Number(text);
  if (text === null || [...query.keys()].length !== 1 || !/^[1-9]\d?$/.test(text) || limit > MAX_FEED) {
    return fail(400, 'BAD_REQUEST', `send only recent, a whole number from 1 to ${String(MAX_FEED)}`);
  }

  const versions = store();
  // Rezerva nad `limit`: rozmanitost odkládá hry do dalších osmic.
  const rows = diversify(await versions.recent(Math.min(RECENT_CAP, limit * 4)), limit);
  const remixes = await versions.childCounts(rows.map((row) => row.versionId));
  return Response.json(
    {
      games: rows.map((row, index) => ({
        versionId: row.versionId,
        title: row.title,
        archetype: row.archetype,
        createdAt: row.createdAt,
        parentId: row.parentId,
        remixes: remixes[index] ?? 0,
      })),
    },
    { headers: { 'cache-control': 'public, max-age=0, s-maxage=15' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const received = performance.now();
  const startedAt = Date.now();
  const refused = await admit(request);
  if (refused !== null) return refused;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return fail(400, 'BAD_REQUEST', 'the request body has fields this door does not read');
  const { sentence, spec, seed, parentId = null } = parsed.data;
  if ((sentence === undefined) === (spec === undefined)) return fail(400, 'BAD_REQUEST', 'send exactly one of sentence or spec');
  if (sentence !== undefined && sentence.length > MAX_SENTENCE_CHARS) return fail(413, 'BODY_TOO_LARGE', `the sentence is longer than ${String(MAX_SENTENCE_CHARS)} characters`);
  // Prázdná věta by dala hru, kterou nikdo nepopsal – a pod jejím hashem jednu pro všechny.
  if (sentence !== undefined && sentence.trim() === '') return fail(400, 'BAD_REQUEST', 'the sentence is empty');
  if (seed !== undefined && !isSeed(seed)) return fail(400, 'BAD_REQUEST', 'seed must be a whole number from 1 to 2^31 - 1');

  const versions = store();
  const caller = directorCallerOf(request);
  if (parentId !== null && (await parentOf(versions, parentId)) === null) return fail(404, 'UNKNOWN_PARENT', 'the parent game does not exist');

  if (sentence !== undefined) {
    // Vyčerpaná kvóta ještě nezavírá: už publikovaná věta je `200` (R8) –
    // `publishReadSpec` čte dřív, než píše, a novou hru úložiště odmítne samo.
    const refused = await publishRefusal(versions);
    if (refused !== null && refused.status !== 429) return refused;
    const seeds = seed !== undefined ? [seed] : derivedSeeds(seedFrom(sentence.trim()));
    const ackMs = performance.now() - received;
    // Návrh ze slov jde ven hned; autorská verze od režiséra doběhne na pozadí (T2).
    const drafted = draftGameSpec(sentence);
    const draft = await publishReadSpec(versions, drafted, seeds, parentId, { origin: { sentence, seed: seed ?? null } });
    if (draft.ok) {
      void upgradeOf(versions, draft.value.game, { sentence, seed: seed ?? null, ackMs, draftReadyMs: performance.now() - received, startedAt, caller });
      return publishedResponse(draft.value, true, unsupportedGame(sentence, drafted));
    }
    if (draft.response.status !== 422) return draft.response;
    if (refused !== null) return refused;
    // Návrh, který se nedá hrát, nemá co ukázat hned – věta čeká na režiséra jako před T2.
    const directed = await getDirector(startedAt, caller)(sentence);
    if (directed.source === 'draft') return draft.response;
    const published = await publishReadSpec(versions, directed.spec, seeds, parentId);
    return published.ok ? publishedResponse(published.value, false, unsupportedGame(sentence, directed.spec)) : published.response;
  }

  const read = readSpecOrFail(spec);
  if (!read.ok) return read.response;
  const published = await publishReadSpec(versions, read.value, seed !== undefined ? [seed] : derivedSeeds(seedFrom(read.value)), parentId);
  return published.ok ? publishedResponse(published.value) : published.response;
}
