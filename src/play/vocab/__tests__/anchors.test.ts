/**
 * Kotvy a vývojová zlatá sada P44C (T3). Kotva, která v ruční tabulce znamená jiný kus,
 * by vypadala správně a tabulka by se s návrhem hádala – proto se každá ověří přes `extractIntent`.
 * Zapečetěná sada a test-200 se porovnávají jen tvary slov přes hash; text se nevypisuje.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_TEMPLATES, type TemplateName } from '../../arcade/rules/templates';
import { heroActionOf } from '../../genre/families';
import { HERO_ACTIONS } from '../../hero-action';
import { ACTIONS, MOVES, OBJECTIVES } from '../../intent/contract';
import { extractIntent } from '../../intent/extract';
import { ANCHORS, ANCHOR_TARGETS, DEFAULT_FRAME, type Anchor, type AnchorTarget } from '../anchors';

const anchor = (target: AnchorTarget): Anchor => ANCHORS[target];
const isHero = (target: string): boolean => target.startsWith('hero:');
const AXIS_TARGETS = ANCHOR_TARGETS.filter((target) => !isHero(target));
const HERO_TARGETS = ANCHOR_TARGETS.filter(isHero);

/** Cíle, na které ruční tabulka pošle sloveso ve větě kotvy (bez osy `unknown`). */
function handTargets(target: AnchorTarget, verb: string): string[] {
  const sentence = (anchor(target).frame ?? DEFAULT_FRAME).replace('{verb}', verb);
  return extractIntent(sentence)
    .items.filter((item) => item.axis !== 'unknown' && item.axis !== 'threat')
    .map((item) => `${item.axis}:${item.verb}`);
}

/** Šablona pravidel → akce záměru, kterou hraje. */
const TEMPLATE_TARGET: Readonly<Record<TemplateName, AnchorTarget>> = {
  carry: 'action:deliver',
  throw: 'action:throw',
  push: 'action:kick',
  open: 'action:interact',
  give: 'action:deliver',
  stack: 'action:stack',
};

describe('anchor catalogue', () => {
  it('has one anchor per intent target and per visible hero action', () => {
    const expected = [
      ...MOVES.map((id) => `move:${id}`),
      ...ACTIONS.map((id) => `action:${id}`),
      ...OBJECTIVES.map((id) => `objective:${id}`),
      ...HERO_ACTIONS.filter((id) => id !== 'none').map((id) => `hero:${id}`),
    ];
    expect([...ANCHOR_TARGETS].sort()).toEqual(expected.sort());
  });

  it('has well-formed verbs and OEWN 2024 synsets, each synset anchoring one target per dimension', () => {
    for (const group of [AXIS_TARGETS, HERO_TARGETS]) {
      const owner = new Map<string, string>();
      for (const target of group) {
        const { verbs, synsets } = anchor(target);
        expect(verbs.length, target).toBeGreaterThan(0);
        expect(synsets.length, target).toBeGreaterThan(0);
        for (const verb of verbs) expect(verb, target).toMatch(/^[a-z]+$/);
        expect(new Set(verbs).size, target).toBe(verbs.length);
        for (const synset of synsets) {
          expect(synset, target).toMatch(/^oewn-\d{8}-v$/);
          expect(owner.get(synset) ?? target, `${synset} in ${owner.get(synset)} and ${target}`).toBe(target);
          owner.set(synset, target);
        }
      }
    }
  });

  it('never contradicts the hand table: a verb it reads lands on the anchor target', () => {
    const contradictions: string[] = [];
    for (const target of AXIS_TARGETS)
      for (const verb of anchor(target).verbs) {
        const hand = handTargets(target, verb);
        if (hand.length > 0 && !hand.includes(target)) contradictions.push(`${verb}: ${target} vs ${hand.join(',')}`);
      }
    expect(contradictions).toEqual([]);
  });

  it('is confirmed by the hand table for at least one verb of every intent target', () => {
    const unconfirmed = AXIS_TARGETS.filter((target) => !anchor(target).verbs.some((verb) => handTargets(target, verb).includes(target)));
    expect(unconfirmed).toEqual([]);
  });

  it('anchors every rule-template verb on the action its template plays, unless the hand table says otherwise', () => {
    const missing: string[] = [];
    for (const name of Object.keys(RULE_TEMPLATES) as TemplateName[])
      for (const verb of RULE_TEMPLATES[name].verbs) {
        const target = TEMPLATE_TARGET[name];
        if (anchor(target).verbs.includes(verb)) continue;
        const elsewhere = AXIS_TARGETS.find((other) => anchor(other).verbs.includes(verb) && handTargets(other, verb).includes(other));
        if (elsewhere === undefined) missing.push(`${name}:${verb}`);
      }
    expect(missing).toEqual([]);
  });

  it('agrees with the verb families on the hero pose', () => {
    const disagreements: string[] = [];
    for (const target of HERO_TARGETS)
      for (const verb of anchor(target).verbs) {
        const pose = heroActionOf(verb);
        if (pose !== null && `hero:${pose}` !== target) disagreements.push(`${verb}: ${target} vs hero:${pose}`);
      }
    expect(disagreements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

interface GoldPair {
  readonly verb: string;
  readonly target: AnchorTarget | null;
  readonly source: 'dev-150' | 'p30-dev' | 'p42-dev' | 'own';
}

const gold = (JSON.parse(readFileSync('src/play/vocab/__fixtures__/gold-verbs.json', 'utf8')) as { pairs: GoldPair[] }).pairs;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Pravidelné tvary slovesa – stejné, jaké pozná lookup (T6). */
function formsOf(verb: string): string[] {
  const stem = verb.replace(/e$/, '');
  const last = verb.at(-1)!;
  return [verb, `${verb}s`, `${verb}es`, `${verb}d`, `${verb}ed`, `${verb}ing`, `${stem}ing`, `${stem}ed`, `${verb}${last}ing`, `${verb}${last}ed`, verb.replace(/y$/, 'ies'), verb.replace(/y$/, 'ied')];
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

const wordHashesOf = (paths: readonly string[]): Set<string> =>
  new Set(paths.flatMap((path) => stringLeaves(JSON.parse(readFileSync(path, 'utf8'))).flatMap((text) => text.toLowerCase().match(/[a-z]+/g) ?? [])).map(sha256));

const P42_SENTENCES = readdirSync('evals/play/p42', { recursive: true, encoding: 'utf8' })
  .map((path) => path.replace(/\\/g, '/'))
  .filter((path) => path.endsWith('sentences.json'))
  .map((path) => `evals/play/p42/${path}`);
const OPEN_SETS: Readonly<Record<Exclude<GoldPair['source'], 'own'>, readonly string[]>> = {
  'dev-150': ['evals/play/p37a/dev-150.json'],
  'p30-dev': ['evals/play/p30/dev.json'],
  'p42-dev': P42_SENTENCES,
};

describe('dev gold verbs', () => {
  it('has at least 200 unique pairs, 40 of them negatives, on known targets only', () => {
    expect(gold.length).toBeGreaterThanOrEqual(200);
    expect(gold.filter((pair) => pair.target === null).length).toBeGreaterThanOrEqual(40);
    expect(new Set(gold.map((pair) => pair.verb)).size).toBe(gold.length);
    for (const pair of gold) {
      expect(pair.verb).toMatch(/^[a-z]+$/);
      if (pair.target !== null) expect(ANCHOR_TARGETS, pair.verb).toContain(pair.target);
    }
  });

  it('takes a verb from the open set it names', () => {
    const missing: string[] = [];
    for (const [source, paths] of Object.entries(OPEN_SETS)) {
      const words = wordHashesOf(paths);
      for (const pair of gold.filter((p) => p.source === source)) if (!formsOf(pair.verb).some((form) => words.has(sha256(form)))) missing.push(`${source}:${pair.verb}`);
    }
    expect(missing).toEqual([]);
  });

  it('shares no verb with the sealed set said-words', () => {
    const sealed = JSON.parse(readFileSync('evals/play/p44c/sealed-110.json', 'utf8')) as {
      groups: { sealed: { said?: string; essential: { said?: string }[] }[] };
    };
    const said = new Set(
      sealed.groups.sealed.flatMap((row) => [row.said, ...row.essential.map((triple) => triple.said)]).filter((word): word is string => typeof word === 'string').map((word) => sha256(word.toLowerCase())),
    );
    expect(said.size).toBeGreaterThan(50);
    expect(gold.filter((pair) => formsOf(pair.verb).some((form) => said.has(sha256(form)))).map((pair) => pair.verb)).toEqual([]);
  });

  it('takes no verb that only the held-out test-200 contains', () => {
    const test200 = wordHashesOf(['evals/play/p30/test-200.json']);
    const open = wordHashesOf(Object.values(OPEN_SETS).flat());
    const leaked = gold.filter((pair) => {
      const forms = formsOf(pair.verb).map(sha256);
      return forms.some((form) => test200.has(form)) && !forms.some((form) => open.has(form));
    });
    expect(leaked.map((pair) => pair.verb)).toEqual([]);
  });
});
