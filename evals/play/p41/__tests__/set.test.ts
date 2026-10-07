/**
 * Sada skládání P41 (T2): věty s ručními štítky – hrdina, prostředí a podstatné
 * trojice aktér–sloveso–předmět ve slovníku `src/play/intent/contract.ts`.
 * Sada měří extraktor i skladatele, takže tu drží tvar, slovník, počty,
 * větu majitele a to, že nepootevře zapečetěnou `p30/test-200.json`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACTIONS, HERO, MOVES, OBJECTIVES, THREATS } from '@/play/intent/contract';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const ROOT = process.cwd();
const PLAY = join(ROOT, 'evals', 'play');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

type Triple = { actor: string; verb: string; object: string | null };
type Item = {
  id: string;
  sentence: string;
  hero: string | null;
  setting: string | null;
  essential: Triple[];
  unsupported: boolean;
  negated?: string[];
  family?: string;
  kind?: string;
};

const TUNING = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'] as const;
const PREFIX: Record<string, string> = { 'multi-action': 'ma', paraphrase: 'pa', negation: 'ne', unsupported: 'un', single: 'si', 'held-out': 'ho' };
const CANON = new Set<string>([...MOVES, ...ACTIONS, ...OBJECTIVES, ...THREATS]);
const WORD = /^[a-z]+$/;
const OWNER = 'game in a car with shooting and racing';

const SET: { version: number; groups: Record<string, Item[]> } = JSON.parse(readLf(join(PLAY, 'p41', 'sentences.json')));
const tuning = TUNING.flatMap((group) => SET.groups[group] ?? []);
const heldOut = SET.groups['held-out'] ?? [];
const all = [...tuning, ...heldOut];

const has = (item: Item, actor: string, verb: string, object?: string | null) =>
  item.essential.some((t) => t.actor === actor && t.verb === verb && (object === undefined || t.object === object));
const meaning = (item: Item) => [item.hero, ...item.essential.map((t) => `${t.actor}/${t.verb}/${t.object}`).sort()].join(' ');

/** Co je na štítku věty špatně; prázdné = v pořádku. */
function labelIssues(item: Item): string[] {
  const issues: string[] = [];
  if (typeof item.sentence !== 'string' || item.sentence.trim() === '' || item.sentence !== item.sentence.trim()) issues.push('sentence');
  if (item.hero !== null && !WORD.test(item.hero)) issues.push('hero');
  if (item.setting !== null && !WORD.test(item.setting)) issues.push('setting');
  if (typeof item.unsupported !== 'boolean') issues.push('unsupported flag');
  if (!Array.isArray(item.essential) || item.essential.length === 0) return [...issues, 'essential'];
  for (const t of item.essential) {
    if (!WORD.test(t.actor) || !WORD.test(t.verb) || (t.object !== null && !WORD.test(t.object))) issues.push(`triple ${JSON.stringify(t)}`);
  }
  // Mimo slovník smí sloveso jen u věty přiznané jako nepodporovaná – a ta ho mít musí.
  if (item.unsupported !== item.essential.some((t) => !CANON.has(t.verb))) issues.push('unsupported ≠ verb outside vocabulary');
  // Bez hrdiny jde za něj zástupce `hero`; se jménem ho nese aspoň jedna trojice.
  const nouns = item.essential.flatMap((t) => [t.actor, t.object]);
  if (item.hero === null ? !nouns.includes(HERO) : !nouns.includes(item.hero) || nouns.includes(HERO)) issues.push('hero not in triples');
  return issues;
}

describe('P41 composition set', () => {
  it('has the five tuning groups (≥ 160 sentences) and a separate held-out group (≥ 60)', () => {
    expect(SET.version).toBe(1);
    expect(Object.keys(SET.groups).sort()).toEqual([...TUNING, 'held-out'].sort());
    expect(tuning.length).toBeGreaterThanOrEqual(160);
    expect(heldOut.length).toBeGreaterThanOrEqual(60);
    for (const group of TUNING) expect(SET.groups[group].length, group).toBeGreaterThanOrEqual(20);
    // Held-out nese každý druh věty, ať závěrečné měření pokryje všechny skupiny.
    for (const kind of TUNING) expect(heldOut.filter((item) => item.kind === kind).length, kind).toBeGreaterThanOrEqual(4);
    expect(heldOut.filter((item) => !(TUNING as readonly string[]).includes(item.kind ?? '')).map((item) => item.id)).toEqual([]);
  });

  it('numbers ids per group and never repeats a sentence', () => {
    for (const [group, items] of Object.entries(SET.groups)) {
      const expected = items.map((_, index) => `${PREFIX[group]}-${String(index + 1).padStart(3, '0')}`);
      expect(items.map((item) => item.id), group).toEqual(expected);
    }
    const seen = new Map<string, string>();
    const repeated: string[] = [];
    for (const item of all) {
      const key = normalizeSentence(item.sentence);
      if (seen.has(key)) repeated.push(`${seen.get(key)} = ${item.id}`);
      else seen.set(key, item.id);
    }
    expect(repeated).toEqual([]);
  });

  it('labels every sentence in the contract vocabulary', () => {
    const bad = all.map((item) => ({ id: item.id, issues: labelIssues(item) })).filter((row) => row.issues.length > 0);
    expect(bad).toEqual([]);
  });

  it('says what each negation removes, in canonical ids the sentence no longer asks for', () => {
    const negation = [...SET.groups.negation, ...heldOut.filter((item) => item.kind === 'negation')];
    expect(negation.filter((item) => !Array.isArray(item.negated)).map((item) => item.id)).toEqual([]);
    expect(SET.groups.negation.filter((item) => (item.negated ?? []).length > 0).length).toBeGreaterThanOrEqual(20);
    const bad = all
      .filter((item) => item.negated !== undefined)
      .filter((item) => item.negated!.some((verb) => !CANON.has(verb) || item.essential.some((t) => t.verb === verb)))
      .map((item) => item.id);
    expect(bad).toEqual([]);
  });

  it('keeps every paraphrase family to one hero and one set of triples', () => {
    const paraphrases = [...SET.groups.paraphrase, ...heldOut.filter((item) => item.kind === 'paraphrase')];
    expect(paraphrases.filter((item) => !item.family).map((item) => item.id)).toEqual([]);
    expect(all.filter((item) => item.family && !paraphrases.includes(item)).map((item) => item.id)).toEqual([]);
    const families = new Map<string, Item[]>();
    for (const item of paraphrases) families.set(item.family!, [...(families.get(item.family!) ?? []), item]);
    for (const [family, members] of families) {
      expect(members.length, family).toBeGreaterThanOrEqual(3);
      expect(new Set(members.map(meaning)).size, family).toBe(1);
    }
    const tuningFamilies = new Set(SET.groups.paraphrase.map((item) => item.family));
    expect(heldOut.filter((item) => item.family && tuningFamilies.has(item.family)).map((item) => item.id)).toEqual([]);
  });

  it('holds the owner sentence and its race, shoot and race + shoot variants', () => {
    const owner = tuning.find((item) => item.sentence === OWNER);
    expect(owner).toBeDefined();
    expect(owner!.hero).toBe('car');
    for (const verb of ['drive', 'shoot', 'race']) expect(has(owner!, 'car', verb), verb).toBe(true);
    const cars = tuning.filter((item) => item.hero === 'car' && !item.unsupported && item !== owner);
    const race = cars.filter((item) => has(item, 'car', 'race') && !has(item, 'car', 'shoot'));
    const shoot = cars.filter((item) => has(item, 'car', 'shoot') && !has(item, 'car', 'race'));
    const both = cars.filter((item) => has(item, 'car', 'race') && has(item, 'car', 'shoot'));
    expect(race.length).toBeGreaterThanOrEqual(2);
    expect(shoot.length).toBeGreaterThanOrEqual(2);
    expect(both.length).toBeGreaterThanOrEqual(3);
  });

  it('tells a dog chasing a cat from a cat chasing a dog', () => {
    const dog = all.find((item) => item.sentence === 'a dog chases a cat');
    const cat = all.find((item) => item.sentence === 'a cat chases a dog');
    expect(dog?.hero).toBe('dog');
    expect(cat?.hero).toBe('cat');
    expect(has(dog!, 'dog', 'catch', 'cat')).toBe(true);
    expect(has(cat!, 'cat', 'catch', 'dog')).toBe(true);
    expect(meaning(dog!)).not.toBe(meaning(cat!));
  });

  it('shares no sentence with the sealed test set', () => {
    // Jen strojové porovnání po normalizaci; vypisují se počty a id NAŠICH vět, nikdy obsah zapečetěné sady.
    const sealed: { text: string }[] = JSON.parse(readLf(join(PLAY, 'p30', 'test-200.json'))).sentences;
    const known = new Set(sealed.map((sentence) => normalizeSentence(sentence.text)));
    expect(known.size).toBeGreaterThan(0);
    expect(all.filter((item) => known.has(normalizeSentence(item.sentence))).map((item) => item.id)).toEqual([]);
  });
});
