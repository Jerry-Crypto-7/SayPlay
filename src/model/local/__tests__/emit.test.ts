/**
 * Prohlížečová emise (P11 T6).
 *
 * Testuje se to, co se v prohlížeči nedá vidět: že verdikt vzniká **týmž
 * řetězem** jako na serveru, že rozbité prostředí není verdikt o světě, a že
 * rozpoznaná věta model vůbec nespustí.
 *
 * Platný svět se **nepíše sem**, ale bere se z příkladu v produkčním promptu.
 * Vlastní ruční fixture by kontrolovala, jestli si test správně opsal schéma;
 * tahle bere přesně ten objekt, který uvidí model.
 */

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '../../client';
import { buildEmissionRequest, EXAMPLE_MARKER } from '../../prompt';
import { emitLocally, localGrammar, stripThinking } from '../emit';
import { completionRequest, LARGE_MODEL, MAX_OUTPUT_TOKENS, modelForRuntime, SMALL_MODEL, type ChatEngine } from '../engine';

const EXAMPLE_WORLD: Record<string, unknown> = (() => {
  const system = buildEmissionRequest('libovolná věta', localGrammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(system.indexOf('{', at))) as Record<string, unknown>;
})();

/** Model, který vrátí, co se mu předepíše. Žádné GPU, žádná síť. */
function scriptedEngine(raw: string, finishReason = 'stop'): ChatEngine {
  return {
    modelId: LARGE_MODEL,
    complete: () => Promise.resolve({ raw, finishReason }),
    unload: () => Promise.resolve(),
  };
}

/** Model, jehož spuštění je samo o sobě chyba testu. */
const forbiddenEngine: ChatEngine = {
  modelId: LARGE_MODEL,
  complete: () => Promise.reject(new Error('model se neměl spustit')),
  unload: () => Promise.resolve(),
};

describe('gramatika v prohlížeči', () => {
  it('je táž jako ta, kterou čte server ze zmrazeného protokolu', () => {
    const server = frozenGrammar();
    expect(server.ok).toBe(true);
    if (!server.ok) return;

    // Kdyby se rozešly, model by dostal jiný slovník, než jakým se jeho
    // odpověď soudí — a vina by padla na model.
    expect(localGrammar()).toEqual(server.value);
  });
});

describe('emitLocally', () => {
  it('platnou emisi certifikuje týmž verdiktem jako server', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(EXAMPLE_WORLD)),
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
    expect(outcome.body.doc).not.toBeNull();
  });

  it('vadnou emisi odmítne, nevydá ji za rozbité prostředí', async () => {
    const broken = { ...EXAMPLE_WORLD, sim: { layout: { width: 1, height: 1 } } };
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(broken)),
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('REJECTED');
  });

  it('svět, jehož svědek nedojde do výhry, v prohlížeči neprojde', async () => {
    // Tvrzení „nic vadného neprojde přijetím" platí i tady, ne jen na serveru.
    // Bez téhle aserce by prohlížečová větev spoléhala na to, že sdílený řetěz
    // někdo otestoval jinde — a to je přesně ta díra, kterou nikdo neuvidí.
    // Stopa je tvarem v pořádku, jen skončí dřív, než dojde k bráně — tedy
    // přesně ten případ, který musí projít schématem a padnout až na svědkovi.
    const sim = EXAMPLE_WORLD.sim as { witness: { ops: unknown[] } };
    const noWin = {
      ...EXAMPLE_WORLD,
      sim: { ...sim, witness: { ...sim.witness, ops: sim.witness.ops.slice(0, 2) } },
    };
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(noWin)),
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('REJECTED');
    expect(outcome.body.rejection).toMatchObject({ stage: 'witness' });
  });

  it('odpověď, která není JSON, je pořád verdikt o emisi', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine('promiňte, tomu nerozumím'),
    });

    // Model odpověděl — jen ne dokumentem. To je vada emise, ne prostředí.
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.rejection).toMatchObject({ reason: 'NOT_A_DOCUMENT' });
  });

  it('spadlý model je rozbité prostředí, ne verdikt o světě', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: {
        modelId: LARGE_MODEL,
        complete: () => Promise.reject(new Error('Unable to find a compatible GPU')),
        unload: () => Promise.resolve(),
      },
    });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.detail).toContain('compatible GPU');
  });

  it('rozpoznanou větu model vůbec nespustí', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      engine: forbiddenEngine,
      recognize: () => EXAMPLE_WORLD,
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
    expect(outcome.body.provenance).toEqual({ source: 'shapes' });
  });

  it('nerozpoznanou větu předá modelu, `null` není chyba', async () => {
    const outcome = await emitLocally({
      sentence: 'něco, co rozpoznávač nezná',
      engine: scriptedEngine(JSON.stringify(EXAMPLE_WORLD)),
      recognize: () => null,
    });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.provenance).toMatchObject({ source: 'model' });
  });

  it('ohlásí průběh po každém kroku, který prošel', async () => {
    const phases: string[] = [];
    await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(EXAMPLE_WORLD)),
      onProgress: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(['emitted', 'schema', 'references', 'look', 'lowering', 'witness']);
  });

  it('nepřipíše svět modelu, který se ho nedotkl', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(EXAMPLE_WORLD)),
    });

    if (outcome.kind !== 'verdict') return;
    // `buildEmissionRequest()` sem sám od sebe píše serverový model. Kdyby se
    // nepřepsal, stopa by tvrdila, že svět v prohlížeči napsal cloud.
    expect(outcome.body.upstream).toMatchObject({ model: LARGE_MODEL });
    expect(outcome.body.provenance).toMatchObject({ source: 'model', model: LARGE_MODEL });
  });

  it('věta se do verdiktu propíše, aby bylo vidět, co porotce napsal', async () => {
    const outcome = await emitLocally({
      sentence: 'páka otevře bránu',
      recognize: () => null,
      engine: scriptedEngine(JSON.stringify(EXAMPLE_WORLD)),
    });

    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.promptId).toBe('páka otevře bránu');
  });

  it('odřízne uvozující blok <think>, ale nic jiného', () => {
    expect(stripThinking('<think>plánuju</think>\n{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('vysvětlení\n{"a":1}')).toBe('vysvětlení\n{"a":1}');
  });
});

describe('engine', () => {
  it('každá větev s modelem má právě jedny váhy', () => {
    expect(modelForRuntime('large')).toBe(LARGE_MODEL);
    expect(modelForRuntime('small')).toBe(SMALL_MODEL);
  });

  it('větve bez modelu v prohlížeči nic nestahují', () => {
    expect(modelForRuntime('cloud')).toBeNull();
    expect(modelForRuntime('none')).toBeNull();
  });

  it('požadavek je deterministický a svázaný tvarem', () => {
    const request = completionRequest('systém', 'uživatel') as {
      temperature: number;
      seed: number;
      max_tokens: number;
      messages: { role: string; content: string }[];
      extra_body: { enable_thinking: boolean };
      response_format: { type: string; schema: string };
    };

    expect(request.temperature).toBe(0);
    expect(request.seed).toBe(1);
    expect(request.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(request.extra_body.enable_thinking).toBe(false);
    expect(request.messages[0]).toEqual({ role: 'system', content: 'systém\n\n/no_think' });
    expect(request.response_format.type).toBe('json_object');
    expect(JSON.parse(request.response_format.schema).required).toEqual([
      'irVersion',
      'simRevision',
      'lookRevision',
      'sim',
      'look',
    ]);
  });
});
