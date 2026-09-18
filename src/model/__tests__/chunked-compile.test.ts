/**
 * **Slepený svět musí být týž svět.**
 *
 * Rozřezání kompilátorového požadavku na souběžné kusy se vyplatí jen tehdy,
 * když se odpovědi dají slepit zpátky beze ztráty. Svět, kde si dva kusy
 * odporují v identitě nebo kde placement míří na uzel, který napsal někdo
 * jiný, přitom vypadá na první pohled hotově — pozná se až tím, že v něm něco
 * chybí. Proto se to měří nad archivem, kde je správný výsledek znám.
 *
 * Archivovaná odpověď (`create-raw.json`, běh 6. 9. 2026, seed 4021) se
 * rozřeže `splitAnswerIntoChunks`, slepí `mergeEmissionChunks` a výsledek se
 * zkompiluje. Blueprint se porovnává **bajtově** proti blueprintu z celé
 * odpovědi.
 *
 * Archiv je gitignorovaný, takže tenhle test běží nad výřezem v `__fixtures__`;
 * celý archiv projde měřicí soubor `evals/worldstream/chunked-compile.measure.ts`.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../__fixtures__/archived-compiler-answer.json';
import {
  CHUNK_FIELDS,
  EMISSION_CHUNKS,
  mergeEmissionChunks,
  splitAnswerIntoChunks,
  type ChunkAnswer,
} from '../emission-merge';
import { type Grammar } from '../prompt';
import { ANSWER_FIELDS, compileBlueprint } from '../worldstream-compiler';
import { compileWithRepair } from '../worldstream-repair';
import { readPlannerEmission } from '../worldstream-intent';
import { buildCompilerRequest, requestStage } from '../worldstream-prompt';

const ANSWER = fixture.answer as Record<string, unknown>;
const OPTIONS = { sessionSeed: 4021, upstream: { model: 'archived', system: 'system', user: 'user' } };

function plan() {
  const parsed = readPlannerEmission(fixture.plan, { requireSceneSpec: false });
  expect(parsed.ok, parsed.ok ? '' : `archivovaný plán se nepřečetl: ${JSON.stringify(parsed)}`).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

/** Kus s jedním polem přepsaným — na výrobu rozporů. */
function withField(chunk: ChunkAnswer, field: string, value: unknown): ChunkAnswer {
  return { chunk: chunk.chunk, answer: { ...(chunk.answer as Record<string, unknown>), [field]: value } };
}

describe('řezání a slepování kompilátorové odpovědi', () => {
  it('rozřezaná a slepená odpověď dá bajtově týž blueprint', () => {
    const merged = mergeEmissionChunks(splitAnswerIntoChunks(ANSWER));
    expect(merged.ok, merged.ok ? '' : `slepení selhalo: ${JSON.stringify(merged)}`).toBe(true);
    if (!merged.ok) return;

    const reference = compileBlueprint(ANSWER, plan(), OPTIONS);
    const fromChunks = compileBlueprint(merged.answer, plan(), OPTIONS);

    // Bez tohohle by se porovnávala dvě odmítnutí a test by byl ozdoba.
    expect(
      reference.ok,
      reference.ok ? '' : `archivovaná odpověď se nezkompilovala: ${JSON.stringify(reference).slice(0, 300)}`,
    ).toBe(true);
    expect(JSON.stringify(fromChunks)).toBe(JSON.stringify(reference));
  });

  it('řez nenechá žádné pole odpovědi bez majitele', () => {
    const owned = EMISSION_CHUNKS.flatMap((chunk) => CHUNK_FIELDS[chunk]);
    for (const field of Object.keys(ANSWER))
      expect(owned, `pole ${field} nepatří žádnému kusu, takže by se slepením ztratilo`).toContain(field);

    // A obráceně: co se rozřezalo, to se i vrátilo.
    const parts = splitAnswerIntoChunks(ANSWER);
    const back = parts.flatMap((part) => Object.keys(part.answer as Record<string, unknown>));
    expect(back.sort()).toEqual(Object.keys(ANSWER).sort());
  });

  it('pole cizího kusu je pojmenovaný rozpor, ne poslední zápis', () => {
    const parts = splitAnswerIntoChunks(ANSWER);
    const architecture = parts.find((part) => part.chunk === 'architecture');
    expect(architecture).toBeDefined();
    if (architecture === undefined) return;

    // Kus `objects` sáhne po geometrii, která patří kusu `architecture`.
    const trespass: ChunkAnswer = withField(
      parts.find((part) => part.chunk === 'objects')!,
      'geometry',
      ANSWER.geometry,
    );

    expect(mergeEmissionChunks([...parts.filter((p) => p.chunk !== 'objects'), trespass])).toMatchObject({
      ok: false,
      reason: 'FIELD_NOT_IN_CHUNK',
    });
  });

  it('dvě odpovědi na jeden kus se odmítnou, ne že vyhraje poslední', () => {
    // Stejný kus přišel dvakrát — třeba po opravném kole, které nezahodilo
    // první odpověď. Bez stráže by druhá `world` tiše přepsala první a svět
    // by vypadal hotově s pravidly, která nikdo nekontroloval.
    const parts = splitAnswerIntoChunks(ANSWER);
    const again: ChunkAnswer = {
      chunk: 'rules',
      answer: { world: { ...(ANSWER.world as Record<string, unknown>), rules: [] } },
    };
    const merged = mergeEmissionChunks([...parts, again]);

    expect(merged).toMatchObject({ ok: false, reason: 'FIELD_WRITTEN_TWICE' });
    if (merged.ok) return;
    expect(merged.detail).toContain('world');
  });

  it('každé pole, které kompilátor přijme, má svůj kus — i volitelná architektura', () => {
    // Archivovaná odpověď `architecture` nenese, takže test nad ní tuhle
    // vazbu nepřipíchne: kus by o to pole mohl přijít a slepení by pak
    // hmotový náhled odmítalo jako cizí zápis.
    const owned = EMISSION_CHUNKS.flatMap((chunk) => CHUNK_FIELDS[chunk]);
    for (const field of ANSWER_FIELDS) expect(owned, `pole ${field} nemá kus`).toContain(field);

    const parts = splitAnswerIntoChunks({ ...ANSWER, architecture: { rooms: [] } });
    expect(parts.find((part) => part.chunk === 'architecture')?.answer).toHaveProperty('architecture');

    const merged = mergeEmissionChunks(parts);
    expect(merged.ok, merged.ok ? '' : JSON.stringify(merged)).toBe(true);
    if (!merged.ok) return;
    expect(merged.answer.architecture).toEqual({ rooms: [] });
  });

  it('dva zápisy jedné identity se odmítnou, ne slijí', () => {
    const parts = splitAnswerIntoChunks(ANSWER);
    const objects = parts.find((part) => part.chunk === 'objects');
    expect(objects).toBeDefined();
    if (objects === undefined) return;

    const placements = (objects.answer as Record<string, unknown>).placements as unknown[];
    expect(placements.length, 'archiv nemá placement, na kterém by šel rozpor předvést').toBeGreaterThan(0);

    const doubled = withField(objects, 'placements', [...placements, placements[0]]);
    const merged = mergeEmissionChunks([...parts.filter((p) => p.chunk !== 'objects'), doubled]);

    expect(merged).toMatchObject({ ok: false, reason: 'IDENTITY_CONFLICT' });
  });

  it('placement na uzel, který žádný kus nenapsal, se odmítne', () => {
    const parts = splitAnswerIntoChunks(ANSWER);
    const nodes = ((ANSWER.geometry as Record<string, unknown>).nodes as unknown[]).length;

    const objects = parts.find((part) => part.chunk === 'objects')!;
    const placements = (objects.answer as Record<string, unknown>).placements as Record<string, unknown>[];
    const pointed = placements.map((entry, index) =>
      index === 0 ? { ...entry, source: { kind: 'geom', node: nodes + 5 } } : entry,
    );

    const merged = mergeEmissionChunks([
      ...parts.filter((p) => p.chunk !== 'objects'),
      withField(objects, 'placements', pointed),
    ]);

    expect(merged).toMatchObject({ ok: false, reason: 'DANGLING_GEOM_NODE' });
  });

  it('kus, který nepřišel jako objekt, se pozná', () => {
    expect(mergeEmissionChunks([{ chunk: 'rules', answer: 'not an object' }])).toMatchObject({
      ok: false,
      reason: 'CHUNK_MISSING',
    });
  });
});

describe('požadavek na jeden kus', () => {
  const grammar = (): Grammar => ({
    surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
    conditions: ['flagIs', 'hasItem'],
    actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
    simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
    lookFields: ['modules', 'palette'],
  });

  it('zůstane compilerovým požadavkem, ať jde o kterýkoli kus', () => {
    // `requestStage` pozná fázi podle seznamu polí a čte ho přehrávání archivu.
    // Kdyby zúžení ten řádek přepsalo, spadne rozpoznání fáze, ne tenhle kus.
    expect(requestStage(buildCompilerRequest(plan(), grammar()))).toBe('compiler');
    for (const chunk of EMISSION_CHUNKS)
      expect(requestStage(buildCompilerRequest(plan(), grammar(), chunk)), `kus ${chunk}`).toBe('compiler');
  });

  it('jmenuje svoje pole a odmítne cizí', () => {
    for (const chunk of EMISSION_CHUNKS) {
      const system = buildCompilerRequest(plan(), grammar(), chunk).system;
      const theirs = EMISSION_CHUNKS.filter((name) => name !== chunk).flatMap((name) => CHUNK_FIELDS[name]);

      expect(system, `kus ${chunk} nejmenuje svoje pole`).toContain(CHUNK_FIELDS[chunk].join(', '));
      expect(system, `kus ${chunk} neřekl, co nepsat`).toContain(theirs.join(', '));
    }
  });

  it('tři požadavky dají jeden blueprint, týž jako jedno volání', async () => {
    const parts = splitAnswerIntoChunks(ANSWER);
    const asked: string[] = [];

    // Emitor odpovídá podle toho, o který kus si požadavek řekl — to je jediné
    // místo, kde se pozná, že se doopravdy poslaly tři různé požadavky.
    const outcome = await compileWithRepair({
      plan: plan(),
      grammar: grammar(),
      sessionSeed: 4021,
      chunked: true,
      now: () => 0,
      emit: (request) => {
        const chunk = EMISSION_CHUNKS.find((name) =>
          request.system.includes(`and no others: ${CHUNK_FIELDS[name].join(', ')}.`),
        );
        expect(chunk, 'požadavek se nehlásí k žádnému kusu').toBeDefined();
        asked.push(chunk!);
        return Promise.resolve(parts.find((part) => part.chunk === chunk)?.answer ?? {});
      },
    });

    expect(asked).toEqual([...EMISSION_CHUNKS]);
    expect(outcome.kind, outcome.kind === 'compiled' ? '' : JSON.stringify(outcome).slice(0, 300)).toBe('compiled');
    if (outcome.kind !== 'compiled') return;

    const reference = compileBlueprint(ANSWER, plan(), OPTIONS);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(JSON.stringify(outcome.result.value)).toBe(JSON.stringify(reference.value));
  });

  it('rozpor mezi kusy je odmítnutí, ne tichý přechod na jedno volání', async () => {
    const parts = splitAnswerIntoChunks(ANSWER);
    let calls = 0;

    const outcome = await compileWithRepair({
      plan: plan(),
      grammar: grammar(),
      sessionSeed: 4021,
      chunked: true,
      now: () => 0,
      emit: (request) => {
        calls += 1;
        // Kus `rules` sáhne po geometrii, která patří kusu `architecture`.
        if (request.system.includes(`and no others: ${CHUNK_FIELDS.rules.join(', ')}.`))
          return Promise.resolve({ world: (ANSWER as Record<string, unknown>).world, geometry: ANSWER.geometry });
        const chunk = EMISSION_CHUNKS.find((name) =>
          request.system.includes(`and no others: ${CHUNK_FIELDS[name].join(', ')}.`),
        );
        return Promise.resolve(parts.find((part) => part.chunk === chunk)?.answer ?? {});
      },
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.fault.detail).toContain('FIELD_NOT_IN_CHUNK');
    // Přesně tři volání: kdyby se po rozporu potichu zkusilo jedno velké,
    // zaplatil by se čtvrtý požadavek a report by ukázal úspěch.
    expect(calls).toBe(EMISSION_CHUNKS.length);
  });

  it('bez kusu se text požadavku nehne', () => {
    // Dnešní jediné volání musí zůstat bajtově tím, čím bylo — jinak by se
    // zrychlení platilo změnou zadání, kterou nikdo neměřil.
    const before = buildCompilerRequest(plan(), grammar());
    expect(before.system).not.toContain('YOU ARE WRITING ONE PART');
    expect(buildCompilerRequest(plan(), grammar())).toEqual(before);
  });
});
