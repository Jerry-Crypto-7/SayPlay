/**
 * Schéma odpovědi režiséra (P26 T6; `GenreSpec` od P32B T4).
 *
 * Tři vlastnosti: (1) je přísné v každém uzlu, jinak ho API odmítne celé
 * (naměřeno 23. 9.: chybějící klíč v `required` = `invalid_json_schema`);
 * (2) přijme každý `GenreSpec`, který píše draft – schéma, které platnou hru
 * nepustí, by model donutilo psát jinou; (3) nepustí režim, který nehraje,
 * ani parametr mimo meze modulu. Validátor je malý a pokrývá jen podmnožinu,
 * kterou `strictSchema` vyrábí, a odkazy `#/$defs/…` do kořene (P36A T7).
 */

import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import steer from '../arcade/__fixtures__/steer.json';
import { modelRulesSchema } from '../arcade/rules/schema';
import { goldenPrompts } from '../../../evals/play/golden';
import { GENRE_ANSWER_SCHEMA, strictSchema } from '../director/answer-schema';
import { readGenreAnswer } from '../director/read';
import { draftGameSpecWithMeta } from '../draft';
import { GENRE_MODULES } from '../genre/index';
import { heroClass } from '../genre/roles';
import { codexArgs } from '@/server/upstream';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Sdílené definice kořene; `{$ref: '#/$defs/<jméno>'}` míří sem (P36A T7). */
const DEFS = (GENRE_ANSWER_SCHEMA.$defs ?? {}) as Record<string, Json>;
const DEF_REF = /^#\/\$defs\/([A-Za-z]+)$/;
const deref = (schema: Json): Json => DEFS[DEF_REF.exec(schema.$ref as string)![1]!]!;

/** Chyby hodnoty proti schématu; prázdné = platí. */
function validate(schema: Json, value: unknown, path = ''): string[] {
  if (typeof schema.$ref === 'string') return validate(deref(schema), value, path);
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
  if (typeof schema.$ref === 'string') return encode(deref(schema), value);
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

const GENRE_SPEC = (GENRE_ANSWER_SCHEMA.properties as Record<string, Json>).spec;

describe('director answer schema (strict mode)', () => {
  it('is strict in every node: all keys required, no extras, a type, anyOf or a bare $ref, no const/default', () => {
    const problems: string[] = [];
    walk(GENRE_ANSWER_SCHEMA, (node, path) => {
      // Uzel schématu, ne mapa `properties` ani `$defs` – ty nesou jména.
      if (path.endsWith('/properties') || path === '/$defs') return;
      // Přísný režim OpenAI i Groq: `$defs` jen v kořeni, `$ref` jen do nich a bez sourozenců.
      if ('$ref' in node) {
        if (Object.keys(node).length !== 1) problems.push(`${path}: $ref with siblings`);
        const name = DEF_REF.exec(String(node.$ref))?.[1];
        if (name === undefined || !(name in DEFS)) problems.push(`${path}: $ref ${String(node.$ref)} is not a root definition`);
        return;
      }
      if ('$defs' in node && path !== '') problems.push(`${path}: $defs below the root`);
      if (node.type === undefined && node.anyOf === undefined) problems.push(`${path}: no type`);
      for (const key of ['const', 'default', 'propertyNames']) if (key in node) problems.push(`${path}: ${key}`);
      if (node.type === 'object') {
        if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        const keys = Object.keys((node.properties as Json | undefined) ?? {});
        if (JSON.stringify(node.required) !== JSON.stringify(keys)) problems.push(`${path}: required ≠ properties`);
      }
    });
    expect(problems).toEqual([]);
  });

  // P36A T7: pravidla, jejich role a doplňky jsou ve všech žánrech stejné – schéma je nese jednou, žánr na ně odkazuje.
  it('defines the rule grammar once in $defs and every genre refers to it', () => {
    const text = JSON.stringify(GENRE_ANSWER_SCHEMA);
    const variants = GENRE_SPEC.anyOf as Json[];
    // Uzel pravidla `{id, verb, when, if, do}` a efekt `throwHeld` zná jen gramatika pravidel: jednou = gramatika je ve schématu jednou.
    expect(text.split('"required":["id","verb","when","if","do"]').length - 1).toBe(1);
    expect(text.split('"required":["throwHeld"]').length - 1).toBe(1);
    expect(Object.keys(DEFS).sort()).toEqual(['ruleRoles', 'rules', 'things']);
    for (const key of Object.keys(DEFS)) {
      for (const variant of variants) expect((variant.properties as Record<string, Json>)[key]).toEqual({ anyOf: [{ $ref: `#/$defs/${key}` }, { type: 'null' }] });
      expect(text.split(`"#/$defs/${key}"`).length - 1).toBe(variants.length);
    }
    expect(DEFS.rules).toMatchObject({ type: 'array', maxItems: expect.any(Number), items: { type: 'object', required: ['id', 'verb', 'when', 'if', 'do'] } });
  });

  it('turns the contact pair of a rule into an array of exactly two roles (strict mode has no tuples)', () => {
    const contacts: Json[] = [];
    walk(strictSchema(z.toJSONSchema(modelRulesSchema, { io: 'input', unrepresentable: 'any' }) as Json), (node, path) => {
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
      // Přísný režim chce každý klíč: parametry skutečné plavby (T5b) a pravidla (B-R5) jako null; počty plavba nečte, v její variantě nejsou.
      spec: {
        genre: 'voyage',
        mode: 'race',
        hero: 'pirate ship',
        // P39: obsazení místo nepřítele, věci a cíle; volitelná pole položky jsou v přísném režimu null.
        cast: [{ label: 'reef', does: 'avoid', verb: null, states: null, patrol: null }],
        // P37A T3: činnost hrdiny rodiny slovesa.
        heroAction: null,
        setting: 'stormy sea',
        palette: 'ocean',
        params: { lengthM: null, topSpeed: null, gravity: null, lives: null, targetScore: null, timeLimit: null },
        ruleRoles: null,
        things: null,
        rules: null,
      },
    };
    expect(validate(GENRE_ANSWER_SCHEMA, answer)).toEqual([]);
    const read = readGenreAnswer(answer);
    if (!read.ok) throw new Error(read.detail);
    expect(read.genre).toEqual({ genre: 'voyage', mode: 'race', hero: 'pirate ship', cast: [{ label: 'reef', does: 'avoid' }], setting: 'stormy sea', palette: 'ocean', params: {} });
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
      // S větou jako v `director/index.ts`: cíl přenosu věty mimo hry (P37A T5) z GenreSpec sám nevyjde.
      const read = readGenreAnswer(answer, GENRE_MODULES, prompt);
      if (!read.ok) throw new Error(`${prompt}: ${read.detail}`);
      // Legacy parsing remains valid when today's quick draft selects a native cell.
      expect(read.genre, prompt).toEqual(draft.genre);
      expect(read.spec.genre?.id, prompt).toBe(draft.genre.genre);
      expect(read.spec.roles.find(role => role.kind === 'player')?.label, prompt).toBe(draft.genre.hero);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('refuses a mode of another genre, a param out of bounds and a GameSpec in its place', () => {
    const params = { seconds: 30, items: null, chasers: null, chaserSpeed: null, enemies: null, enemyHp: null, enemySpeed: null, playerHp: null, lives: null, targetScore: null, timeLimit: null };
    const ok = { genre: 'arena', mode: 'escape', hero: 'fox', cast: [{ label: 'wolf', does: 'chase_me', verb: null, states: null, patrol: null }], heroAction: null, setting: 'forest', palette: null, params, counts: null, ruleRoles: null, things: null, rules: null };
    expect(validate(GENRE_SPEC, ok)).toEqual([]);
    // Počty (B-R4): jen role, které Aréna počítá, v mezích parametru, do kterého jdou.
    expect(validate(GENRE_SPEC, { ...ok, counts: { enemy: 3, collectible: null } })).toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, counts: { enemy: 3, collectible: null, target: 2 } })).not.toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, counts: { enemy: 99, collectible: null } })).not.toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, mode: 'race' })).not.toEqual([]);
    expect(validate(GENRE_SPEC, { ...ok, params: { seconds: 200 } })).not.toEqual([]);
    const out = readGenreAnswer({ plan: 'x', spec: { ...ok, params: { seconds: 200 } } });
    expect(out.ok ? null : out.reason).toBe('MALFORMED_SPEC');
    const legacy = readGenreAnswer(steer);
    expect(legacy.ok ? null : legacy.reason).toBe('MALFORMED_SPEC');
    expect(readGenreAnswer({ plan: 'x', spec: { sim: {}, world: {} } })).toMatchObject({ ok: false, reason: 'WRONG_DOCUMENT' });
  });
});
