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
 * Věta, kterou `chainOrSingle` pošle do řetězu mikroher (P56C T10), dostane hru
 * s `chain` a odpověď bez `upgrade` – řetěz AI verzi nemá.
 */

import { z } from 'zod';

import { draftGameSpecWithMeta } from '@/play/draft';
import { loadRapier } from '@/play/arcade/physics/world';
import { buildChain } from '@/play/chain/build';
import { chainOrSingle } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { honestyOf } from '@/play/draft/unsupported';
import { classifyGenre } from '@/play/genre/classify';
import { readBeforeDraft } from '@/play/read/client';
import { beatOf, decodeCursor, feedPage, hiddenFromEnv, keptFromEnv, RECENT_CAP, remixParents } from '@/play/version';

import { getDirector } from '../_director';
import { fail, readJsonBody, refuseSentence } from '../_errors';
import { admit, derivedSeeds, directorCallerOf, isSeed, markVolatileStore, MAX_SENTENCE_CHARS, parentOf, publishChain, publishReadSpec, publishRefusal, playabilityIssues, publishedResponse, readSpecOrFail, seedFrom, store } from '../_publish';
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
 * `GET /api/play/games?recent=N[&cursor=C]` – feed (P23-D T4, stránky P27B T2):
 * `{ games: [{ versionId, title, archetype, createdAt, parentId, remixes, beat,
 * goal, mood }], next }` podle smyčky (`beat` = „N% beat this“ nebo `null`, P37C T5) – dohrání, výzvy a remixy výš, každá třetí
 * pozice nejnovější hra (P36B T9; bez čítačů od nejnovější); `goal`/`mood`
 * z řádku seznamu, starší řádky `null`; v každé osmici nejvýš tři hry téhož
 * archetypu (`diversify`); `next` je kurzor další stránky nebo `null`. Kdo do
 * feedu smí, říká `feedEligible` – kontrakt v `docs/play/feed.md`. Stojí dva
 * příkazy úložiště (seznam a čítače s počty dětí), vlastní páku `feed` a strop jako každé čtení;
 * hrana ho smí 15 s držet, a proto dotaz nesmí nést nic jiného než `recent`
 * a `cursor` – náhodný parametr navíc by cache obešel pokaždé.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = await admit(request, 'feed');
  if (refused !== null) return refused;

  const query = new URL(request.url).searchParams;
  const text = query.get('recent');
  const limit = Number(text);
  const keys = [...query.keys()];
  const known = keys.every((key) => key === 'recent' || key === 'cursor') && new Set(keys).size === keys.length;
  if (text === null || !known || !/^[1-9]\d?$/.test(text) || limit > MAX_FEED) {
    return fail(400, 'BAD_REQUEST', `send recent, a whole number from 1 to ${String(MAX_FEED)}, and optionally the cursor from the last page`);
  }
  const cursorText = query.get('cursor');
  const cursor = cursorText === null ? null : decodeCursor(cursorText);
  if (cursorText !== null && cursor === null) return fail(400, 'BAD_REQUEST', 'the cursor is not one this feed gave out');

  const versions = store();
  // Celý seznam (jeden příkaz): stránka se počítá ze snímku, viz `feed.ts`.
  const rows = await versions.recent(RECENT_CAP);
  // Čítače smyčky a počty remixů všech řádků (druhý příkaz) řadí feed (P36B T9).
  const heat = await versions.loopHeat(rows.map((row) => row.versionId));
  // Skryté: provozovatel (`PLAY_FEED_HIDE`) a hry nahlášené z feedu (P54A T11, třetí příkaz),
  // kromě her, které provozovatel z hlasů vyjmul (`PLAY_FEED_KEEP`, T11a).
  const kept = keptFromEnv(process.env);
  // Rodiče remixů taky: skrytý rodič skryje i remix (`feedPage`), i když sám v seznamu už není.
  const asked = [...new Set([...rows.map((row) => row.versionId), ...remixParents(rows)])];
  const reported = await versions.reportHidden(asked.filter((id) => !kept.has(id)));
  const page = feedPage(rows, limit, cursor, new Set([...hiddenFromEnv(process.env), ...reported]), heat);
  return markVolatileStore(
    Response.json(
      {
        games: page.games.map((row) => ({
          versionId: row.versionId,
          title: row.title,
          archetype: row.archetype,
          createdAt: row.createdAt,
          parentId: row.parentId,
          remixes: heat.get(row.versionId)?.remixes ?? 0,
          beat: beatOf(heat.get(row.versionId)),
          goal: row.goal ?? null,
          mood: row.mood ?? null,
        })),
        next: page.next,
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=15' } },
    ),
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
  const blocked = sentence === undefined ? null : refuseSentence(sentence);
  if (blocked !== null) return blocked;
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
    // P29B T5: zapnutá lokální čtečka větu nejdřív přečte, nejvýš za `PLAY_READER_BUDGET_MS`.
    const reading = await readBeforeDraft(sentence);
    // P56C T10: věta bez jednoho jasného slovesa hraje řetěz mikroher – bez AI verze a remixu (debata T9).
    // Řetěz, který stavba nebo brána nepustí, hraje dnešní cesta jako jedna hra; zakázaný text a úložiště ne.
    const read = readForChain(sentence, reading);
    if (chainOrSingle(sentence, read, classifyGenre(sentence, reading)) === 'chain') {
      const built = buildChain(sentence, read, seeds[0]!);
      if (built.ok) {
        const chained = await publishChain(versions, built.chain, parentId, { origin: { sentence, seed: seed ?? null, ...(reading === null ? {} : { readBy: 'model' as const }) } });
        if (chained.ok) return publishedResponse(chained.value);
        if (chained.response.status !== 422 || chained.issues?.[0] === 'CONTENT_REJECTED') return chained.response;
      }
    }
    // Návrh ze slov jde ven hned; autorská verze od režiséra doběhne na pozadí (T2).
    // Ball composition verifies a real physics run before returning a draft.
    // Await the cold engine here; background preloading alone is a race. Always, not only
    // when the sentence says ball: the model reader may pick a ball game the words missed.
    await loadRapier();
    const meta = draftGameSpecWithMeta(sentence, 1, { reading });
    const drafted = meta.spec;
    const origin = { sentence, seed: seed ?? null, ...(meta.readBy === 'model' ? { readBy: 'model' as const } : {}) };
    const draft = await publishReadSpec(versions, drafted, seeds, parentId, { origin });
    if (draft.ok) {
      void upgradeOf(versions, draft.value.game, { sentence, seed: seed ?? null, ackMs, draftReadyMs: performance.now() - received, startedAt, caller });
      return publishedResponse(draft.value, true, await honestyOf(versions, draft.value.game));
    }
    // Návrh se zakázaným textem (P40 T2) nečeká na režiséra: rychlá verze se nevrátí a model se neplatí.
    if (draft.response.status !== 422 || draft.issues?.[0] === 'CONTENT_REJECTED') return draft.response;
    if (refused !== null) return refused;
    // Návrh, který se nedá hrát, nemá co ukázat hned – věta čeká na režiséra jako před T2.
    // Na slot ale nečeká (P53 T3b): při plných slotech hned 422 s návrhem jako před P53, ne mlčení až 240 s.
    const directed = await getDirector(startedAt, caller, (candidate) => playabilityIssues(candidate, seeds), undefined, undefined, false)(sentence);
    if (directed.source === 'draft') return draft.response;
    // Věta jde k verzi, aby `/play/[id]` ukázal tutéž hlášku jako odpověď (R1).
    const published = await publishReadSpec(versions, directed.spec, seeds, parentId, { sentence });
    return published.ok ? publishedResponse(published.value, false, await honestyOf(versions, published.value.game)) : published.response;
  }

  const read = readSpecOrFail(spec);
  if (!read.ok) return read.response;
  const published = await publishReadSpec(versions, read.value, seed !== undefined ? [seed] : derivedSeeds(seedFrom(read.value)), parentId);
  return published.ok ? publishedResponse(published.value) : published.response;
}
