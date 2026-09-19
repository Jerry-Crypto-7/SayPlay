/**
 * **Úsilí se přiřazuje kusu, ne celému běhu (P21 T6).**
 *
 * Naměřeno 14. 9. 2026: `gpt-6-astra@high` má medián 258 s a tři světy ze
 * sedmi přes 300 s, což je mez, ve které hosting spojení utne; `astra@low`
 * doručila 8 z 8 při mediánu 142 s. Plošně snížit úsilí ale nejde — 3D je to
 * jediné, co tenhle produkt prodává. Od rozřezání požadavku na kusy (T4) se
 * proto vysoké úsilí platí jen tam, odkud geometrie pochází, a pravidla
 * světa jedou nízko.
 *
 * Špatně přiřazené úsilí nikde nekřičí: svět vznikne a jen se o minutu
 * protáhne, nebo zhorší. Tenhle soubor proto pojmenovává dvojici kus → úsilí
 * a **zároveň to, že ji volání doopravdy nese** — samotná tabulka by byla
 * ozdoba, kdyby požadavek dál odcházel s úsilím z prostředí.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../../model/__fixtures__/archived-compiler-answer.json';
import { EMISSION_CHUNKS, EMISSION_CHUNKS_TWO } from '../../model/emission-merge';
import { buildIntentRequest, readPlannerEmission } from '../../model/worldstream-intent';
import { buildCompilerRequest, requestChunk, requestStage } from '../../model/worldstream-prompt';
import { REFINE_ANSWER_FIELDS } from '../../model/worldstream-refine';
import { frozenGrammar } from '../../model/client';
import type { Grammar } from '../../model/prompt';
import { CHUNK_EFFORT, STAGE_EFFORT, effortForCall, upstreamBranch, upstreamConfigFromEnv, type UpstreamConfig } from '../upstream';

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

const LIVE_ENV = {
  WORLDSMITH_BRANCH: 'live',
  WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
  WORLDSMITH_MODEL_KEY: 'test-key',
  WORLDSMITH_USD_PER_MTOK_OUT: '25',
} as const;

function liveConfig(overrides: Partial<Record<string, string>> = {}): UpstreamConfig {
  const config = upstreamConfigFromEnv({ ...LIVE_ENV, ...overrides });
  if (config === null) throw new Error('testovací prostředí mělo dát platnou konfiguraci');
  return config;
}

function plan() {
  const parsed = readPlannerEmission(fixture.plan, { requireSceneSpec: false });
  if (!parsed.ok) throw new Error(`archivovaný plán se nepřečetl: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

function callFor(chunk?: 'architecture' | 'objects' | 'rules') {
  return { prompt: 'a spiral library where the stairs are the shelves', request: buildCompilerRequest(plan(), GRAMMAR, chunk) };
}

/** Požadavek druhé věty: `requestStage()` ho pozná podle téhož seznamu polí jako sklad. */
function refineCall() {
  return {
    prompt: 'make the bridge woven roots',
    request: { model: 'm', system: `Answer with exactly: ${REFINE_ANSWER_FIELDS.join(', ')}.`, user: 'u' },
  };
}

/** Odpověď Messages API, kterou větev přijme jako úspěch. */
function ok() {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 10 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('kus se pozná zpátky z požadavku', () => {
  it('každý kus se ze svého požadavku přečte, a nikdo jiný', () => {
    for (const chunk of [...EMISSION_CHUNKS, ...EMISSION_CHUNKS_TWO]) expect(requestChunk(buildCompilerRequest(plan(), GRAMMAR, chunk))).toBe(chunk);
  });

  it('celý požadavek ani plánovač žádný kus nenesou', () => {
    expect(requestChunk(buildCompilerRequest(plan(), GRAMMAR))).toBeNull();
    expect(requestChunk(buildIntentRequest('a spiral library'))).toBeNull();
  });
});

describe('úsilí podle kusu', () => {
  it('geometrie jede vysoko, pravidla nízko', () => {
    const config = liveConfig({ WORLDSMITH_MODEL_EFFORT: 'medium' });
    expect(effortForCall(callFor('architecture'), config)).toBe('high');
    expect(effortForCall(callFor('objects'), config)).toBe('high');
    expect(effortForCall(callFor('rules'), config)).toBe('low');
  });

  it('požadavek bez kusu spadne na úsilí z prostředí', () => {
    expect(effortForCall(callFor(), liveConfig({ WORLDSMITH_MODEL_EFFORT: 'medium' }))).toBe('medium');
    expect(effortForCall(callFor(), liveConfig())).toBe('low');
    expect(effortForCall({ prompt: 'p', request: { model: 'm', system: 's', user: 'u' } }, liveConfig({ WORLDSMITH_MODEL_EFFORT: 'xhigh' }))).toBe('xhigh');
  });

  it('plánovač jede nízko bez ohledu na prostředí, kompilátor a změna z prostředí (P21 T19)', () => {
    const planner = { prompt: 'a spiral library', request: buildIntentRequest('a spiral library') };
    expect(requestStage(planner.request)).toBe('planner');
    expect(requestStage(callFor().request)).toBe('compiler');
    expect(requestStage(refineCall().request)).toBe('refine');

    const medium = liveConfig({ WORLDSMITH_MODEL_EFFORT: 'medium' });
    const xhigh = liveConfig({ WORLDSMITH_MODEL_EFFORT: 'xhigh' });
    expect(STAGE_EFFORT.planner).toBe('low');
    expect(effortForCall(planner, medium)).toBe('low');
    expect(effortForCall(planner, xhigh)).toBe('low');
    expect(effortForCall(callFor(), medium)).toBe('medium');
    expect(effortForCall(refineCall(), medium)).toBe('medium');
    expect(effortForCall(callFor('rules'), xhigh)).toBe('low');
  });

  it('nastavení je na jednom místě a pokrývá všechny kusy obou řezů', () => {
    const chunks = [...new Set([...EMISSION_CHUNKS, ...EMISSION_CHUNKS_TWO])];
    for (const chunk of chunks) expect(CHUNK_EFFORT[chunk]).toBeDefined();
    expect(Object.keys(CHUNK_EFFORT).sort()).toEqual(chunks.sort());
    // Dvoukusý řez: `scene` píše geometrii i tvary, tedy 3D – jede vysoko jako architecture a objects.
    expect(CHUNK_EFFORT.scene).toBe('high');
  });
});

describe('úsilí odchází s voláním, ne z konfigurace', () => {
  it('tělo požadavku nese úsilí toho kusu, ne úsilí z prostředí', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return ok();
    }) as unknown as typeof fetch;

    const branch = upstreamBranch(liveConfig({ WORLDSMITH_MODEL_EFFORT: 'medium' }), fetchImpl);
    await branch.generate(callFor('architecture'));
    await branch.generate(callFor('rules'));
    await branch.generate(callFor());

    expect(bodies.map((body) => (body as { output_config: { effort: string } }).output_config.effort)).toEqual(['high', 'low', 'medium']);
  });
});
