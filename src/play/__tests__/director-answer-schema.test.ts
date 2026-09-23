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
import { DIRECTOR_ANSWER_SCHEMA } from '../director/answer-schema';
import { unwrapAnswer } from '../director/read';
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

describe('director answer schema (strict mode)', () => {
  it('is strict in every node: all keys required, no extras, a type or anyOf, no const/default/$ref', () => {
    const problems: string[] = [];
    walk(DIRECTOR_ANSWER_SCHEMA, (node, path) => {
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
    expect(codexArgs('m', 'high', 'C:/tmp/x', true).join(' ')).toMatch(/--output-schema \S*answer-schema\.json/);
    expect(codexArgs('m', 'high', 'C:/tmp/x')).not.toContain('--output-schema');
  });
});
