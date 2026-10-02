/**
 * Prompt režiséra (P23-B T3; na žánrech od P32B T4). Prompt s ručně opsanou
 * nabídkou by vypadal úplně a zestárl by; test drží, že nabídka žánrů je
 * vyrenderovaná z modulů (jen režimy `ready`, třídy hrdinů, meze parametrů),
 * že v něm nezůstal seznam starých ovládání ani `tap_go` – prompt, který je
 * dál zmiňuje, vypadá v pořádku a model by psal hru, kterou odpověď nepustí –
 * a že velikost nepřeteče stropu 12 700 B.
 *
 * Do P32B T4 prompt vypisoval 11 ovládání, registr mechanik a tvar GameSpecu:
 * 12 691 B nad 40 zlatými větami. Žánrový prompt to celé nahrazuje.
 */

import { describe, expect, it, vi } from 'vitest';

import { EMISSION_MODEL } from '@/model/prompt';

import { goldenPrompts } from '../../../evals/play/golden';
import runnerFixture from '../arcade/__fixtures__/runner.json';
import shooterFixture from '../arcade/__fixtures__/shooter.json';
import { GENRE_ANSWER_SCHEMA, readyModes } from '../director/answer-schema';
import { buildCompactRequest } from '../director/compact';
import { DIRECTOR_PROMPT_VERSION, GENRE_RULES, GENRE_SHAPE_LINE, buildDirectorRequest, compactSchema, directorSystemPrompt, renderRegistry } from '../director/prompt';
import { readDirectorAnswer } from '../director/read';
import { repairDeterministically } from '../director/repair';
import { draftGameSpecWithMeta } from '../draft';
import type { GenreModule } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import { ARCHETYPE_IDS, MECHANIC_IDS } from '../registry';
import { CONTROLS } from '../spec';

const MODULES = Object.values(GENRE_MODULES) as GenreModule[];

describe('director prompt', () => {
  it('asks for a GenreSpec with the draft GenreSpec as the starting point', () => {
    const sentence = 'A wizard lights candles in a haunted castle';
    const request = buildDirectorRequest(sentence, draftGameSpecWithMeta(sentence).genre);
    expect(request.model).toBe(EMISSION_MODEL);
    expect(request.system.startsWith(GENRE_RULES)).toBe(true);
    expect(request.system).toContain(GENRE_SHAPE_LINE);
    expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(request.user).toContain('Starting point (keep or improve): {"genre":');
    expect(buildDirectorRequest(sentence, null).user).toBe(`${sentence}\n\nStarting point: none – choose from the sentence.`);
  });

  it('offers exactly the ready modes of each genre with its hero classes and param bounds', () => {
    const system = directorSystemPrompt();
    for (const module of MODULES) {
      const ready = readyModes(module);
      const line = system.split('\n').find((text) => text.startsWith(`- ${module.id} (`));
      if (ready.length === 0) {
        expect(line, module.id).toBeUndefined();
        continue;
      }
      expect(line, module.id).toContain(`modes ${ready.join('|')};`);
      expect(line, module.id).toContain(`hero ${module.heroClasses.join('/')}`);
      for (const [key, range] of Object.entries(module.paramBounds)) expect(line, module.id).toContain(`${key} ${String(range.min)}..${String(range.max)}`);
    }
  });

  it('names no legacy control and no tap_go in either prompt', () => {
    const words = new Set(MODULES.flatMap((module) => [module.id, ...module.cues]));
    const draft = draftGameSpecWithMeta('a fox runs through a forest').genre;
    for (const system of [buildDirectorRequest('x', draft).system, buildCompactRequest('x', draft).system]) {
      expect(system).not.toMatch(/tap_go|CONTROLS|controlParams/);
      for (const control of CONTROLS) {
        expect(system, control).not.toContain(`"${control}"`);
        // Ovládání, které je i žánrem nebo narážkou („runner“, „duel“), smí zaznít jako slovo.
        if (!words.has(control)) expect(system, control).not.toMatch(new RegExp(`\\b${control}\\b`));
      }
    }
  });

  it('keeps the registry of mechanics and archetypes for remix and repair rounds', () => {
    const registry = renderRegistry();
    for (const id of MECHANIC_IDS) expect(registry).toContain(`- ${id} {`);
    for (const id of ARCHETYPE_IDS) expect(registry).toContain(`- ${id}: objective=`);
  });

  // P32B T4: nejdelší je kompaktní s příklady, 3 633 B (do T4 plný prompt 12 691 B).
  // T5b: 6 282 B – první odpověď zas nese pravidla P29A (B-R5: gramatika a jeden příklad) a počty rolí (B-R4),
  // výchozí bod draftu k tomu parametry modulu a počty z věty. B-R8: 6 414 B – spouštěč `interact` a jeho meze v gramatice pravidel.
  // T7: 6 718 B – co má AI verze proti výchozímu bodu přidat, popisky v jednotném čísle, nepřítel není nástroj hráče.
  // Revize fáze 3: 6 746 B – `interact` jen jako vítězné pravidlo. Kolo 2: 6 777 B – vyhrává se až se všemi cíli.
  // O9: 6 788 B – po sloučení všech stop popisují moduly žánrů E, F a G víc parametrů výchozího bodu.
  // P35 T3: 6 828 B – skákačka počítá věci ke sběru (`items 1..8`, `counts collectible`) a výchozí bod nese cíl z věty.
  // P36A T4: 6 884 B – běžec natahuje trať podle počtů (`items 1..50, obstacles 1..50`, `counts enemy/collectible`).
  // P36A T8: 7 569 B – hloubka pro všechny žánry (`lives`, `targetScore`, `timeLimit`, `enemyMoves`), dva příklady s ní
  // a věta, že pravidlo prohry dokáže robot, který do něj vleze.
  // P36A T10: 7 989 B – dva žánry navíc (Střílečka, Hod) se svými režimy a parametry (`waves`, `enemies`, `targets`;
  // `goal`, `spareThrows`, `seconds`) a hloubkou.
  it('stays under 12 700 bytes for all forty golden sentences, with examples too (pin: 7 989 B)', () => {
    let max = 0;
    for (const entry of goldenPrompts()) {
      const draft = draftGameSpecWithMeta(entry.prompt).genre;
      for (const request of [buildDirectorRequest(entry.prompt, draft), buildCompactRequest(entry.prompt, draft, true)]) {
        max = Math.max(max, Buffer.byteLength(request.system + request.user));
      }
    }
    expect(max).toBeLessThanOrEqual(12_700);
    expect(max).toBeLessThanOrEqual(7_989);
  });

  it('rejects an addon the control does not take and the deterministic repair drops it', () => {
    const body = { ...(shooterFixture as object), addons: ['shoot'] };
    const read = readDirectorAnswer(body);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('MALFORMED_SPEC');
    const repaired = repairDeterministically(body, read.reason);
    expect(repaired?.spec.addons).toBeUndefined();
    expect(repaired?.applied.join()).toContain('dropped addons shoot');
    const kept = repairDeterministically({ ...(runnerFixture as object), addons: ['shoot', 'shoot', 'collect'] }, 'MALFORMED_SPEC');
    expect(kept?.spec.addons).toEqual(['shoot', 'collect']);
  });

  it('compacts schemas: role ids, enums, bounded ints, optional fields with defaults', () => {
    expect(compactSchema({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.]{0,63}$' })).toBe('roleId');
    expect(compactSchema({ type: 'string', enum: ['slow', 'fast'] })).toBe('slow|fast');
    expect(compactSchema({ type: 'integer', minimum: 1, maximum: 20 })).toBe('int 1..20');
    expect(
      compactSchema({ type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'integer', default: 1 } }, required: ['a', 'b'] }),
    ).toBe('{a: bool, b?: int=1}');
  });

  it('keeps the version stable across calls and moves it when a genre module changes', async () => {
    const again = await import('../director/prompt');
    expect(again.DIRECTOR_PROMPT_VERSION).toBe(DIRECTOR_PROMPT_VERSION);

    vi.resetModules();
    vi.doMock('../genre/index', async () => {
      const actual = await vi.importActual<typeof import('../genre/index')>('../genre/index');
      const voyage = { ...actual.GENRE_MODULES.voyage, cues: [...actual.GENRE_MODULES.voyage.cues, 'glide'] };
      return { ...actual, GENRE_MODULES: { ...actual.GENRE_MODULES, voyage } };
    });
    const mocked = await import('../director/prompt');
    expect(mocked.DIRECTOR_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    vi.doUnmock('../genre/index');
    vi.resetModules();
  });
});
