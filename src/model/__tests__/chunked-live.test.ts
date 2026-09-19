/**
 * **Tři kusy naráz, každý zaplacený zvlášť, a odmítnutý kus nechá relaci
 * v pojmenovaném stavu.**
 *
 * T4 poslal kusy po jednom, protože souběh bez účtování po kusech by strop
 * útraty obešel. Tenhle soubor připíchne, co T5 mění a co ne:
 *
 * - všechny tři požadavky jsou u poskytovatele **dřív, než první odpoví** —
 *   jinak by celý svět trval součet tří volání místo nejdelšího z nich;
 * - každý kus je **vlastní rezervace** u stropu — tři kusy = tři započtená
 *   volání, ne jedno;
 * - strop odmítne kus, který by ho překročil, a výsledek je `unavailable`
 *   s `cause` typu `SpendRefusalError`, aby relace skončila `SPEND_CAP_BLOCKED`
 *   a ne „the model could not be reached"; kusy, které už letí, se **dočkají**
 *   a vyrovnají, takže po odmítnutí nic nedrží peníze;
 * - mlčící poskytovatel uprostřed souběhu je výpadek, jmenuje kus, a **nikdy**
 *   se po něm tiše nezkouší jedno velké volání.
 *
 * Emitor tady platí stejně jako `cloudEmitter` v `src/server/worldstream-emitter.ts`:
 * rezervace před voláním, vyrovnání po něm, `SpendRefusalError` při odmítnutí.
 * Ten tvar se sem opisuje schválně — tenhle test soudí souběh v `emitChunks`,
 * ne prostředí serveru, které `cloudEmitter` potřebuje.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../__fixtures__/archived-compiler-answer.json';
import { EMISSION_CHUNKS, splitAnswerIntoChunks, type ChunkName } from '../emission-merge';
import { type Grammar } from '../prompt';
import type { UpstreamRequest } from '../prompt';
import { compileBlueprint } from '../worldstream-compiler';
import { compileWithRepair } from '../worldstream-repair';
import { readPlannerEmission } from '../worldstream-intent';
import { requestChunk } from '../worldstream-prompt';
import { SpendCap, SpendRefusalError } from '../../server/spend-cap';

const ANSWER = fixture.answer as Record<string, unknown>;
const PARTS = splitAnswerIntoChunks(ANSWER);
const OPTIONS = { sessionSeed: 4021, upstream: { model: 'archived', system: 'system', user: 'user' } };

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

function plan() {
  const parsed = readPlannerEmission(fixture.plan, { requireSceneSpec: false });
  if (!parsed.ok) throw new Error(`archivovaný plán se nepřečetl: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

function chunkOf(request: UpstreamRequest): ChunkName {
  const chunk = requestChunk(request);
  if (chunk === null) throw new Error('požadavek se nehlásí k žádnému kusu');
  return chunk;
}

function answerFor(chunk: ChunkName): unknown {
  return PARTS.find((part) => part.chunk === chunk)?.answer ?? {};
}

/** Slib, který se vyřídí až zvenčí — na řízení pořadí odpovědí. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Emitor, který platí jako `cloudEmitter`: rezervace, volání, vyrovnání. */
function payingEmitter(cap: SpendCap, worstCaseUsd: number, provider: (chunk: ChunkName) => Promise<unknown>) {
  const settled: ChunkName[] = [];
  const emit = async (request: UpstreamRequest): Promise<unknown> => {
    const chunk = chunkOf(request);
    const reservation = await cap.reserve(worstCaseUsd);
    if (!reservation.ok) throw new SpendRefusalError(reservation);
    try {
      return await provider(chunk);
    } finally {
      await reservation.settle(worstCaseUsd / 2);
      settled.push(chunk);
    }
  };
  return { emit, settled };
}

describe('kusy letí souběžně', () => {
  it('všechny tři požadavky jsou u poskytovatele dřív, než první odpoví', async () => {
    const asked: ChunkName[] = [];
    const gates = new Map<ChunkName, ReturnType<typeof deferred<unknown>>>();
    for (const chunk of EMISSION_CHUNKS) gates.set(chunk, deferred<unknown>());

    const running = compileWithRepair({
      plan: plan(),
      grammar: grammar(),
      sessionSeed: 4021,
      chunked: true,
      now: () => 0,
      emit: (request) => {
        const chunk = chunkOf(request);
        asked.push(chunk);
        return gates.get(chunk)!.promise;
      },
    });

    // Sekvenční cesta by tady měla jediný požadavek a čekala na jeho odpověď.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([...EMISSION_CHUNKS]);

    // Odpovědi v opačném pořadí, než se ptalo — slepení se řídí kusem, ne časem.
    for (const chunk of [...EMISSION_CHUNKS].reverse()) gates.get(chunk)!.resolve(answerFor(chunk));

    const outcome = await running;
    expect(outcome.kind, outcome.kind === 'compiled' ? '' : JSON.stringify(outcome).slice(0, 300)).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    const reference = compileBlueprint(ANSWER, plan(), OPTIONS);
    if (!reference.ok) throw new Error('archivovaná odpověď se nezkompilovala');
    expect(JSON.stringify(outcome.result.value)).toBe(JSON.stringify(reference.value));
  });
});

describe('každý kus je vlastní započtené volání', () => {
  it('tři kusy jsou tři volání u stropu a po slepení nic nedrží peníze', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 10 });
    const paying = payingEmitter(cap, 1, (chunk) => Promise.resolve(answerFor(chunk)));

    const outcome = await compileWithRepair({ plan: plan(), grammar: grammar(), sessionSeed: 4021, chunked: true, now: () => 0, emit: paying.emit });

    expect(outcome.kind).toBe('compiled');
    expect(cap.snapshot().callsMade).toBe(EMISSION_CHUNKS.length);
    expect(cap.snapshot().spentUsd).toBeCloseTo(EMISSION_CHUNKS.length * 0.5);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('strop odmítne kus, který by ho překročil, a relace skončí pojmenovaně, ne v půlce světa', async () => {
    // Dvě volání se vejdou, třetí ne. Kusy, které prošly, dostanou odpověď
    // až po odmítnutí — přesně stav „jeden kus odmítnut, dva letí".
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 2 });
    const gate = deferred<unknown>();
    let inFlight = 0;
    const paying = payingEmitter(cap, 1, async (chunk) => {
      inFlight += 1;
      await gate.promise;
      return answerFor(chunk);
    });

    const running = compileWithRepair({ plan: plan(), grammar: grammar(), sessionSeed: 4021, chunked: true, now: () => 0, emit: paying.emit });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inFlight).toBe(2);
    gate.resolve(null);

    const outcome = await running;
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeInstanceOf(SpendRefusalError);
    expect(outcome.detail).toContain('CALL_CAP_EXHAUSTED');
    // Kusy, které letěly, se dočkaly a vyrovnaly — výsledek se nevrátil dřív.
    expect(paying.settled).toHaveLength(2);
    expect(cap.snapshot().reservedUsd).toBe(0);
    expect(cap.snapshot().callsMade).toBe(2);
  });

  it('mlčící poskytovatel uprostřed souběhu je výpadek, jmenuje kus a nezkouší jedno velké volání', async () => {
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 10 });
    let calls = 0;
    const paying = payingEmitter(cap, 1, (chunk) => {
      calls += 1;
      if (chunk === 'objects') return Promise.reject(new Error('codex exec ran past the timeout'));
      return Promise.resolve(answerFor(chunk));
    });

    const outcome = await compileWithRepair({ plan: plan(), grammar: grammar(), sessionSeed: 4021, chunked: true, now: () => 0, emit: paying.emit });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).not.toBeInstanceOf(SpendRefusalError);
    expect(outcome.detail).toContain('chunk objects');
    expect(outcome.detail).toContain('ran past the timeout');
    expect(calls).toBe(EMISSION_CHUNKS.length);
    expect(paying.settled).toHaveLength(EMISSION_CHUNKS.length);
    expect(cap.snapshot().reservedUsd).toBe(0);
  });

  it('odmítnutí stropem má přednost před výpadkem, když padne obojí', async () => {
    // Relace musí říct SPEND_CAP_BLOCKED i tehdy, když jiný kus zároveň
    // vypršel — „model nedostupný" by operátora poslal hledat do sítě.
    const cap = new SpendCap({ enabled: true, capUsd: 10, callCap: 2 });
    const paying = payingEmitter(cap, 1, (chunk) =>
      chunk === 'architecture' ? Promise.reject(new Error('codex exec ran past the timeout')) : Promise.resolve(answerFor(chunk)),
    );

    const outcome = await compileWithRepair({ plan: plan(), grammar: grammar(), sessionSeed: 4021, chunked: true, now: () => 0, emit: paying.emit });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeInstanceOf(SpendRefusalError);
    expect(outcome.detail).toContain('chunk rules');
    expect(outcome.detail).toContain('chunk architecture');
  });
});
