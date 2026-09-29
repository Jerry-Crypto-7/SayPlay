/**
 * Schéma odpovědi režiséra (P26 T6).
 *
 * Tři vlastnosti: (1) je přísné v každém uzlu, jinak ho API odmítne celé
 * (naměřeno 23. 9.: chybějící klíč v `required` = `invalid_json_schema`);
 * (2) přijme každou šablonu hry – schéma, které platnou hru nepustí, by model
 * donutilo psát jinou; (3) nepustí, co tabulka schopností zakazuje. Validátor
 * je malý a pokrývá jen podmnožinu, kterou `strictSchema` vyrábí.
 */

import { describe, expect, it } from 'vitest';

import chaseEscape from '../__fixtures__/chase_escape.json';
import collectExit from '../__fixtures__/collect_exit.json';
import combatLite from '../__fixtures__/combat_lite.json';
import switchPuzzle from '../__fixtures__/switch_puzzle.json';
import arena from '../arcade/__fixtures__/arena.json';
import duel from '../arcade/__fixtures__/duel.json';
import runner from '../arcade/__fixtures__/runner.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import steer from '../arcade/__fixtures__/steer.json';
import throwGame from '../arcade/__fixtures__/throw.json';
import { goldenPrompts } from '../../../evals/play/golden';
import { DIRECTOR_ANSWER_SCHEMA, GENRE_ANSWER_SCHEMA } from '../director/answer-schema';
import { readGenreAnswer, unwrapAnswer } from '../director/read';
import { draftGameSpecWithMeta } from '../draft';
import { GENRE_MODULES } from '../genre/index';
import { heroClass } from '../genre/roles';
import { readGameSpec } from '../spec';
import { codexArgs } from '@/server/upstream';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Chyby hodnoty proti schématu; prázdné = platí. */
function validate(schema: Json, value: unknown, path = ''): string[] {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Json[]).some((branch) => validate(branch, value, path).length === 0) ? [] : [`${path}: no anyOf branch fits`];
  }
  const types = ([] as string[]).concat(schema.type as string | string[]);
  const actual = typeOf(value);
  if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: ${actual} is not ${types.join('|')}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in enum`];
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return [`${path}: below minimum`];
    if (typeof schema.maximum === 'number' && value > schema.maximum) return [`${path}: above maximum`];
  }
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return [`${path}: too long`];
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return [`${path}: too short`];
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return [`${path}: pattern`];
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return [`${path}: too many items`];
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return [`${path}: too few items`];
    return value.flatMap((item, index) => validate(schema.items as Json, item, `${path}/${String(index)}`));
  }
  if (isObject(value)) {
    const properties = schema.properties as Record<string, Json>;
    const extra = Object.keys(value).filter((key) => !(key in properties));
    if (extra.length > 0) return [`${path}: extra ${extra.join(',')}`];
    return (schema.required as string[]).flatMap((key) => (key in value ? validate(properties[key], value[key], `${path}/${key}`) : [`${path}/${key}: missing`]));
  }
  return [];
}

/** Spec → tvar přísné odpovědi: chybějící pole jako `null`, slovníky jako dvojice. Větev unie volí validátor. */
function encode(schema: Json, value: unknown): unknown {
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf as Json[]) {
      const candidate = encode(branch, value);
      if (validate(branch, candidate).length === 0) return candidate;
    }
    return value;
  }
  if (schema.type === 'array' && isObject(value)) return Object.entries(value).map(([key, item]) => ({ key, value: item }));
  if (Array.isArray(value)) return value.map((item) => encode(schema.items as Json, item));
  if (isObject(value) && isObject(schema.properties)) {
    const properties = schema.properties as Record<string, Json>;
    return Object.fromEntries(Object.keys(properties).map((key) => [key, value[key] === undefined ? null : encode(properties[key], value[key])]));
  }
  return value;
}

function walk(node: unknown, visit: (node: Json, path: string) => void, path = ''): void {
  if (Array.isArray(node)) node.forEach((item, index) => walk(item, visit, `${path}/${String(index)}`));
  else if (isObject(node)) {
    visit(node, path);
    for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}/${key}`);
  }
}

const SPEC = (DIRECTOR_ANSWER_SCHEMA.properties as Record<string, Json>).spec;
const GENRE_SPEC = (GENRE_ANSWER_SCHEMA.properties as Record<string, Json>).spec;

describe.each([
  ['GameSpec', DIRECTOR_ANSWER_SCHEMA],
  ['GenreSpec', GENRE_ANSWER_SCHEMA],
])('director answer schema for a %s (strict mode)', (_name, schema) => {
  it('is strict in every node: all keys required, no extras, a type or anyOf, no const/default/$ref', () => {
    const problems: string[] = [];
    walk(schema, (node, path) => {
      // Uzel schématu, ne mapa `properties` – ta nese jména polí.
      if (path.endsWith('/properties')) return;
      if (node.type === undefined && node.anyOf === undefined) problems.push(`${path}: no type`);
      for (const key of ['const', 'default', '$ref', '$defs', 'propertyNames']) if (key in node) problems.push(`${path}: ${key}`);
      if (node.type === 'object') {
        if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        const keys = Object.keys((node.properties as Json | undefined) ?? {});
        if (JSON.stringify(node.required) !== JSON.stringify(keys)) problems.push(`${path}: required ≠ properties`);
      }
    });
    expect(problems).toEqual([]);
  });
});

describe('director answer schema (strict mode)', () => {
  it('turns the contact pair of a rule into an array of exactly two roles (strict mode has no tuples)', () => {
    const contacts: Json[] = [];
    walk(DIRECTOR_ANSWER_SCHEMA, (node, path) => {
      if (path.endsWith('/properties/contact')) contacts.push(node);
    });
    expect(contacts.length).toBeGreaterThan(0);
    for (const node of contacts) {
      const pair = (Array.isArray(node.anyOf) ? (node.anyOf as Json[]).find((branch) => branch.type === 'array') : node) as Json;
      expect(pair).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
      expect('prefixItems' in pair).toBe(false);
      expect(validate(pair, ['player', 'coin'])).toEqual([]);
      expect(validate(pair, ['player'])).not.toEqual([]);
      expect(validate(pair, ['player', 'coin', 'door'])).not.toEqual([]);
    }
  });

  it.each([
    ['collect_exit', collectExit],
    ['chase_escape', chaseEscape],
    ['switch_puzzle', switchPuzzle],
    ['combat_lite', combatLite],
    ['runner', runner],
    ['steer', steer],
    ['arena', arena],
    ['shooter', shooter],
    ['throw', throwGame],
    ['duel', duel],
  ])('accepts the %s template and unwraps it back to the same spec', (_name, fixture) => {
    const read = readGameSpec(fixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const spec = read.value;
    const arcade = spec.control !== undefined && spec.control !== 'tap_go';
    // Arkáda `verification` nepíše, dostane ji zpátky z `unwrapAnswer`.
    const { verification, ...rest } = spec;
    const answer = { plan: 'keep the template', spec: encode(SPEC, arcade ? rest : { ...spec, control: 'tap_go' }) };
    expect(validate(DIRECTOR_ANSWER_SCHEMA, answer)).toEqual([]);
    const back = readGameSpec(unwrapAnswer(answer));
    if (!back.ok) throw new Error(back.issues.join('; '));
    expect(back.value).toEqual(arcade ? { ...spec, verification: [{ id: 'wins', kind: 'reachability', assert: { runState: 'won' } }] } : spec);
    if (arcade) expect(verification).toHaveLength(1);
  });

  it('rejects what the capability table forbids', () => {
    const read = readGameSpec(runner);
    if (!read.ok) throw new Error('fixture');
    const { verification: _v, ...rest } = read.value;
    const ok = encode(SPEC, rest) as Json;
    expect(validate(SPEC, ok)).toEqual([]);
    // Běžec nehraje hazard_zone, mřížka nezná `controlParams`, arkáda nepíše `verification`.
    expect(validate(SPEC, { ...ok, mechanics: [{ id: 'hazard_zone', params: { role: 'obstacle', effect: 'lose', pulse: null } }] })).not.toEqual([]);
    expect(validate(SPEC, { ...ok, controlParams: { speed: 'warp' } })).not.toEqual([]);
    expect(validate(SPEC, { ...ok, verification: [] })).not.toEqual([]);
  });

  it('codex gets the schema file only when the request carries one', () => {
    // Za `exec`, ne před ním: `codex --output-schema … exec` končí „unexpected argument“.
    expect(codexArgs('m', 'high', 'C:/tmp/x', true).join(' ')).toMatch(/^exec .*--output-schema \S*answer-schema\.json/);
    expect(codexArgs('m', 'high', 'C:/tmp/x')).not.toContain('--output-schema');
  });
});

// P32B T4: nová hra je `GenreSpec`; hru skládá modul žánru, ne model.
describe('director answer schema for a GenreSpec', () => {
  const READY = Object.values(GENRE_MODULES).flatMap((module) => module.modes.filter((mode) => (module.availability as (mode: string) => string)(mode) === 'ready').map((mode) => `${module.id}.${mode}`));

  it('offers exactly the ready modes of every genre, with the module param bounds', () => {
    const offered = (GENRE_SPEC.anyOf as Json[]).flatMap((variant) => {
      const properties = variant.properties as Record<string, Json>;
      return (properties.mode.enum as string[]).map((mode) => `${(properties.genre.enum as string[])[0]}.${mode}`);
    });
    expect(offered.sort()).toEqual([...READY].sort());
    const voyage = (GENRE_SPEC.anyOf as Json[]).find((variant) => ((variant.properties as Record<string, Json>).genre.enum as string[])[0] === 'voyage')!;
    const lengthM = JSON.stringify((voyage.properties as Record<string, Json>).params);
    expect(lengthM).toContain(`"minimum":${String(GENRE_MODULES.voyage.paramBounds.lengthM!.min)}`);
    expect(lengthM).toContain(`"maximum":${String(GENRE_MODULES.voyage.paramBounds.lengthM!.max)}`);
  });

  it('reads a voyage answer with a pirate ship all the way to a GameSpec whose hero is a boat', () => {
    const answer = {
      plan: 'a ship race',
      spec: { genre: 'voyage', mode: 'race', hero: 'pirate ship', enemy: 'reef', collectible: null, target: null, setting: 'stormy sea', palette: 'ocean', params: { lengthM: null } },
    };
    expect(validate(GENRE_ANSWER_SCHEMA, answer)).toEqual([]);
    const read = readGenreAnswer(answer);
    if (!read.ok) throw new Error(read.detail);
    expect(read.genre).toEqual({ genre: 'voyage', mode: 'race', hero: 'pirate ship', enemy: 'reef', setting: 'stormy sea', palette: 'ocean', params: {} });
    expect(read.spec.genre?.id).toBe('voyage');
    const hero = read.spec.roles.find((role) => role.kind === 'player')!;
    expect(hero.label).toBe('pirate ship');
    expect(heroClass(hero.label)).toBe('boat');
  });

  it('accepts the GenreSpec the draft writes for every golden sentence in a ready mode', () => {
    let checked = 0;
    for (const { prompt } of goldenPrompts()) {
      const draft = draftGameSpecWithMeta(prompt);
      if (draft.genre === null || !READY.includes(`${draft.genre.genre}.${draft.genre.mode}`)) continue;
      const answer = { plan: 'keep', spec: encode(GENRE_SPEC, draft.genre) };
      expect(validate(GENRE_ANSWER_SCHEMA, answer), prompt).toEqual([]);
      const read = readGenreAnswer(answer);
      if (!read.ok) throw new Error(`${prompt}: ${read.detail}`);
      expect(read.spec, prompt).toEqual(draft.spec);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('refuses a mode of another genre, a param out of bounds and a GameSpec in its place', () => {
    const ok = { genre: 'arena', mode: 'escape', hero: 'fox', enemy: 'wolf', collectible: null, target: null, setting: 'forest', palette: null, params: { seconds: 30 } };
    expect(validate(GENRE_SPEC, ok)).toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, mode: 'race' })).not.toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, params: { seconds: 200 } })).not.toEqual([]);
    const out = readGenreAnswer({ plan: 'x', spec: { ...ok, params: { seconds: 200 } } });
    expect(out.ok ? null : out.reason).toBe('MALFORMED_SPEC');
    const legacy = readGenreAnswer(steer);
    expect(legacy.ok ? null : legacy.reason).toBe('MALFORMED_SPEC');
    expect(readGenreAnswer({ plan: 'x', spec: { sim: {}, world: {} } })).toMatchObject({ ok: false, reason: 'WRONG_DOCUMENT' });
  });
});
