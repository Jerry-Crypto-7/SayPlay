/**
 * **Korpus porotcovských vět – pin na tvar orákul (P22 T1).**
 *
 * Orákulum, jehož citát ve větě doslova není, vypadá jako orákulum a nikdy se
 * netrefí: plánovač ho nemůže splnit ani porušit, takže věta projde měřením
 * bez skóre a nikdo si toho nevšimne. Sada proto soudí artefakty, ne kód:
 * každý `required.quote` je doslovný podřetězec své věty, každý vztah stojí
 * mezi dvěma citáty téhož orákula, a kategorie, které mají odmítnutí nebo
 * degradaci jako správnou odpověď, žádný `required` nenesou. Druhý pin je
 * pokrytí: dvacet kategorií z uzavřeného seznamu, aspoň pět vět v každé,
 * čtrnáct vět ze strategického balíčku doslovně.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROMPTS_FILE = fileURLToPath(new URL('../prompts.json', import.meta.url));
const ORACLES_FILE = fileURLToPath(new URL('../oracles.json', import.meta.url));
const README_FILE = fileURLToPath(new URL('../README.md', import.meta.url));
const PACK_CSV = fileURLToPath(new URL('../../../../plans/P22/strategy-pack/07_JUDGE_GAUNTLET.csv', import.meta.url));

export const GAUNTLET_CATEGORIES = [
  'ordinary', 'architecture', 'nature', 'scifi', 'fantasy', 'abstract', 'physics', 'agent',
  'educational', 'narrative', 'minimal', 'large', 'ambiguous', 'contradictory', 'count-relation',
  'adversarial', 'unsupported', 'safety', 'long', 'ultrashort',
] as const;

const REFUSAL_CATEGORIES = new Set(['contradictory', 'unsupported', 'safety']);
const RELATIONS = new Set(['on', 'under', 'inside', 'behind', 'over', 'beside']);

interface Prompt {
  readonly id: string;
  readonly category: string;
  readonly sentence: string;
  readonly packCategory?: string;
}

interface Requirement { readonly quote: string; readonly count: number }
interface Relation { readonly subject: string; readonly relation: string; readonly object: string }

interface Oracle {
  readonly id: string;
  readonly required?: readonly Requirement[];
  readonly forbidden?: readonly string[];
  readonly relations?: readonly Relation[];
  readonly expectedRefusalOrDegrade?: true;
}

const prompts = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8')) as { readonly prompts: readonly Prompt[] };
const oracles = JSON.parse(readFileSync(ORACLES_FILE, 'utf8')) as { readonly oracles: readonly Oracle[] };

// Balíček má v CSV citované věty s čárkami uvnitř – druhý sloupec je celý v uvozovkách.
function packSentences(): string[] {
  return readFileSync(PACK_CSV, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const match = /^[^,]+,"(.*)"$/.exec(line);
    if (!match) throw new Error(`CSV line without a quoted sentence: ${line}`);
    return match[1];
  });
}

describe('gauntlet corpus', () => {
  const byId = new Map(prompts.prompts.map((p) => [p.id, p]));

  it('has at least 100 unique sentences with unique ids', () => {
    expect(prompts.prompts.length).toBeGreaterThanOrEqual(100);
    expect(byId.size).toBe(prompts.prompts.length);
    expect(new Set(prompts.prompts.map((p) => p.sentence.trim().toLowerCase())).size).toBe(prompts.prompts.length);
  });

  it('covers all twenty categories with at least five sentences each', () => {
    const counts = new Map<string, number>();
    for (const p of prompts.prompts) {
      expect(GAUNTLET_CATEGORIES, `unknown category on ${p.id}`).toContain(p.category);
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    for (const category of GAUNTLET_CATEGORIES) {
      expect(counts.get(category) ?? 0, `category ${category}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('carries the fourteen strategy-pack sentences verbatim', () => {
    const sentences = new Set(prompts.prompts.map((p) => p.sentence));
    const pack = packSentences();
    expect(pack).toHaveLength(14);
    for (const sentence of pack) expect(sentences.has(sentence), sentence).toBe(true);
  });

  it('has exactly one oracle per sentence and no orphan oracle', () => {
    const oracleIds = oracles.oracles.map((o) => o.id);
    expect(new Set(oracleIds).size).toBe(oracleIds.length);
    // Orákula archivu (`p20-*`, T2) věty v `prompts.json` nemají – ta se soudí zvlášť.
    const corpusOracles = oracleIds.filter((id) => !id.startsWith('p20-'));
    expect(new Set(corpusOracles)).toEqual(new Set(byId.keys()));
  });

  it('quotes every required item verbatim from its sentence', () => {
    for (const oracle of oracles.oracles) {
      const prompt = byId.get(oracle.id);
      if (!prompt) continue;
      if (REFUSAL_CATEGORIES.has(prompt.category)) {
        expect(oracle.expectedRefusalOrDegrade, oracle.id).toBe(true);
        expect(oracle.required, oracle.id).toBeUndefined();
        continue;
      }
      expect(oracle.expectedRefusalOrDegrade, oracle.id).toBeUndefined();
      expect(oracle.required?.length ?? 0, oracle.id).toBeGreaterThanOrEqual(1);
      for (const item of oracle.required ?? []) {
        expect(item.quote.length, `${oracle.id}: empty quote`).toBeGreaterThan(0);
        expect(prompt.sentence.includes(item.quote), `${oracle.id}: "${item.quote}" is not in "${prompt.sentence}"`).toBe(true);
        expect(Number.isInteger(item.count) && item.count >= 1, `${oracle.id}: count of "${item.quote}"`).toBe(true);
      }
    }
  });

  it('binds every relation to two required quotes of the same oracle', () => {
    for (const oracle of oracles.oracles) {
      if (!byId.has(oracle.id)) continue;
      const quotes = new Set((oracle.required ?? []).map((r) => r.quote));
      for (const relation of oracle.relations ?? []) {
        expect(RELATIONS, `${oracle.id}: relation ${relation.relation}`).toContain(relation.relation);
        expect(quotes.has(relation.subject), `${oracle.id}: subject "${relation.subject}" is not a required quote`).toBe(true);
        expect(quotes.has(relation.object), `${oracle.id}: object "${relation.object}" is not a required quote`).toBe(true);
        expect(relation.subject).not.toBe(relation.object);
      }
      for (const quote of oracle.forbidden ?? []) expect(quote.length, `${oracle.id}: empty forbidden`).toBeGreaterThan(0);
    }
  });

  it('says in the README that a human wrote the oracles and the corpus is not frozen', () => {
    const readme = readFileSync(README_FILE, 'utf8');
    expect(readme).toMatch(/člověk|human/i);
    expect(readme).toMatch(/není zmrazen|not frozen/i);
  });
});
