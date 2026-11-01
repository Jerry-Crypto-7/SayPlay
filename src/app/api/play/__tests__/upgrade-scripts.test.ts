/**
 * Skript úrovně v AI verzi (P68 T13) jen za `PLAY_SCRIPTS=on`. Vypnutý přepínač (výchozí) = `_upgrade` beze změny:
 * písař skriptu se nezavolá a publikovaná AI verze je přesně spec režiséra. Zapnutý: úroveň ze skriptu se uloží
 * k verzi (`scriptLevel` s otiskem kódu); dvakrát neplatný skript = AI verze bez skriptu, druhé volání neslo chyby.
 * Revize T13: písař bez času v okně trasy se nevolá a nenačtený QuickJS AI verzi neshodí – obojí nechá spec režiséra.
 */

import { createHash } from 'node:crypto';

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';
import type { ScriptRequest, ScriptWriter } from '@/play/scripts/generate';
import type { GameSpecV1 } from '@/play/spec';
import { memoryVersionStore } from '@/play/version';

import { DIRECTOR_BUDGET_MS } from '../_director';
import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';
import { SCRIPT_WRITER_MIN_MS, directUpgrade } from '../_upgrade';

vi.mock('quickjs-emscripten-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('quickjs-emscripten-core')>();
  return { ...actual, newQuickJSWASMModuleFromVariant: vi.fn(actual.newQuickJSWASMModuleFromVariant) };
});

const SENTENCE = 'a chicken crossing a busy road';
const LEVEL = 'function build(api) { const rows = api.param("rows"); for (let z = 4; z < rows - 2; z += 4) { api.place("road", 2, z); api.place("road", 6, z + 1); } }';
const BROKEN = 'function build(api) { api.place("road", 4, Date.now() % 40); }';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Rychlá verze přes publikaci, nad ní AI verze: spec rychlé hry s novým názvem od „režiséra“. */
async function upgradeWith(writer: ScriptWriter, startedAt = Date.now()) {
  const store = memoryVersionStore();
  const quickSpec = draftGameSpecWithMeta(SENTENCE, 1).spec;
  expect(quickSpec.control).toBe('hop');
  const quick = await publishReadSpec(store, quickSpec, derivedSeeds(seedFrom(SENTENCE)), null, { origin: { sentence: SENTENCE, seed: null } });
  if (!quick.ok) throw new Error(JSON.stringify(quick.issues));
  // Název sám AI verzi nedělá (`UNCHANGED`), jiné místo ano.
  const ai: GameSpecV1 = { ...quickSpec, title: 'Chicken Rush', theme: { ...quickSpec.theme, setting: 'farm road' } };
  const outcome = await directUpgrade(
    store,
    quick.value.game,
    { sentence: SENTENCE, seed: null, ackMs: null, draftReadyMs: null, startedAt, caller: 'upgrade-scripts' },
    () => async () => ({ ok: true, spec: ai, source: 'authored', repairRounds: 0, fallbackReason: null, warnings: [], ms: 1, calls: 1, callerLimited: false }),
    undefined,
    writer,
  );
  if (outcome.status !== 'ready') throw new Error(`no AI version: ${outcome.reason}`);
  return { ai, published: (await store.get(outcome.versionId))!.spec };
}

describe('PLAY_SCRIPTS gates the level script of the AI version', () => {
  it('off (default): the writer is never called and the AI version is the director spec as before', async () => {
    const writer = vi.fn<ScriptWriter>(async () => ({ code: LEVEL, costUsd: 0 }));
    const { ai, published } = await upgradeWith(writer);
    expect(writer).not.toHaveBeenCalled();
    expect(published.scriptLevel).toBeUndefined();
    expect(published).toEqual(ai);
  }, 120_000);

  it('any value but "on" keeps it off', async () => {
    vi.stubEnv('PLAY_SCRIPTS', '1');
    const writer = vi.fn<ScriptWriter>(async () => ({ code: LEVEL, costUsd: 0 }));
    const { published } = await upgradeWith(writer);
    expect(writer).not.toHaveBeenCalled();
    expect(published.scriptLevel).toBeUndefined();
  }, 120_000);

  // Modul QuickJS se drží na proces: tenhle test musí být v souboru první, který ho načte.
  it('on: a QuickJS module that fails to load leaves the director version, and the next upgrade loads it again', async () => {
    vi.stubEnv('PLAY_SCRIPTS', 'on');
    const load = vi.mocked(newQuickJSWASMModuleFromVariant);
    const loadsBefore = load.mock.calls.length;
    load.mockRejectedValueOnce(new Error('emscripten-module.wasm is missing from the bundle'));
    const writer = vi.fn<ScriptWriter>(async () => ({ code: LEVEL, costUsd: 0 }));
    const failed = await upgradeWith(writer);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(failed.published).toEqual(failed.ai);
    const again = await upgradeWith(writer);
    expect(load.mock.calls.length - loadsBefore).toBe(2);
    expect(again.published.scriptLevel?.codeDigest).toBe(createHash('sha256').update(LEVEL).digest('hex'));
  }, 120_000);

  it('on: with too little of the route window left the writer is not called and the director version publishes', async () => {
    vi.stubEnv('PLAY_SCRIPTS', 'on');
    const writer = vi.fn<ScriptWriter>(async () => ({ code: LEVEL, costUsd: 0 }));
    const { ai, published } = await upgradeWith(writer, Date.now() - DIRECTOR_BUDGET_MS + SCRIPT_WRITER_MIN_MS - 1_000);
    expect(writer).not.toHaveBeenCalled();
    expect(published).toEqual(ai);
  }, 120_000);

  it('on: the level from the script is stored with the version, with the digest of the code', async () => {
    vi.stubEnv('PLAY_SCRIPTS', 'on');
    const writer = vi.fn<ScriptWriter>(async () => ({ code: LEVEL, costUsd: 0 }));
    const { published } = await upgradeWith(writer);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0]?.[0]).toMatchObject({ sentence: SENTENCE, game: 'hop', params: { rows: 50 }, repair: null });
    // Timeout volání je zbytek okna režie, ne pevná mez písaře.
    expect(writer.mock.calls[0]?.[0].timeoutMs).toBeGreaterThanOrEqual(SCRIPT_WRITER_MIN_MS);
    expect(writer.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(DIRECTOR_BUDGET_MS);
    expect(published.scriptLevel?.codeDigest).toBe(createHash('sha256').update(LEVEL).digest('hex'));
    expect(published.scriptLevel?.levelData.lanes[0]).toEqual({ row: 4, kind: 'road', side: 'left' });
    expect(published.scriptLevel?.runtimeVersion).toMatch(/quickjs/);
  }, 120_000);

  it('on: a script that fails twice gets one repair round with the errors, then the AI version ships without it', async () => {
    vi.stubEnv('PLAY_SCRIPTS', 'on');
    const requests: ScriptRequest[] = [];
    const writer = vi.fn<ScriptWriter>(async (request) => {
      requests.push(request);
      return { code: BROKEN, costUsd: 0 };
    });
    const { ai, published } = await upgradeWith(writer);
    expect(writer).toHaveBeenCalledTimes(2);
    expect(requests[1]?.repair?.issues.join('; ')).toMatch(/Date/);
    expect(published.scriptLevel).toBeUndefined();
    expect(published).toEqual(ai);
  }, 120_000);
});
