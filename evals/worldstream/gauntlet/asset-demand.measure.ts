/**
 * **Poptávka po druzích objektů proti tomu, co repo umí postavit (P22 T3).**
 *
 * Dva zdroje poptávky: citáty `required` v `oracles.json` (co porotce
 * napíše, váha 1 na větu) a `objects[].label` osmnácti archivních emisí
 * plánovače (co model doopravdy založí, váha 2 – je to naměřené, ne
 * odhadnuté). Druh je hlavní podstatné jméno citátu – poslední slovo,
 * v jednotném čísle a malými písmeny – a srovnává se se třemi zdroji krytí:
 * `assetId` a `tags` v `src/assets/catalog.json`, jména uzlů `ShapeProgram`
 * – jen primitiva (`src/shape/schema.ts`, `SHAPE_NODE_GROUPS.primitive`; operace jako
 * `mirror` nejsou tvar), a parametrická
 * architektura (`room`, `corridor` v `src/scene/architecture.ts`).
 *
 * Artefakt `asset-demand.json` čte T11 očima: `top24` jsou chybějící druhy
 * seřazené podle váhy, a `coverageByWeight` je podíl váhy, kterou repo dnes
 * kryje. Po T11 přibude blok `afterT11` z druhého běhu.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/gauntlet/asset-demand.measure.ts
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog.json';
import { architectureSchema } from '@/scene/architecture';
import { SHAPE_NODE_GROUPS } from '@/shape/schema';

const ARCHIVE = fileURLToPath(new URL('../../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const ORACLES_FILE = fileURLToPath(new URL('./oracles.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('./asset-demand.json', import.meta.url));

/** Slova, která v citátu nesou náladu nebo místo, ne objekt (kategorie `ambiguous`, denní doba, pohled). */
const NOT_AN_OBJECT = new Set(['cozy', 'home', 'place', 'thing', 'surprise', 'night', 'sunset', 'view', 'player', 'left', 'it', 'them', 'ground']);
const ARTICLES = new Set(['a', 'an', 'the', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth']);

/** Jednotné číslo: `shelves` → `shelf`, `boxes` → `box`, `pods` → `pod`; slova na `-ss`/`-us` zůstávají. */
export function singular(word: string): string {
  if (/(ss|us|is)$/.test(word) || word.length < 4) return word;
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/ves$/.test(word)) return word.replace(/ves$/, 'f');
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.replace(/es$/, '');
  if (/s$/.test(word)) return word.replace(/s$/, '');
  return word;
}

/** Hlavní podstatné jméno: poslední slovo citátu bez členů a pořadových číslovek. */
export function kindOf(quote: string): string | null {
  const words = quote.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w && !ARTICLES.has(w));
  const last = words.at(-1);
  if (!last) return null;
  const kind = singular(last);
  return NOT_AN_OBJECT.has(kind) ? null : kind;
}

interface OracleFile { readonly oracles: readonly { readonly id: string; readonly required?: readonly { readonly quote: string }[] }[] }

function coverage() {
  const assets = new Map<string, string>();
  for (const asset of catalog.assets) {
    assets.set(singular(asset.assetId), `catalog:${asset.assetId}`);
    for (const tag of asset.tags) assets.set(singular(tag), `catalog:${asset.assetId}`);
  }
  const shapes = new Set<string>(SHAPE_NODE_GROUPS.primitive.map((kind) => kind.toLowerCase()));
  // Synonyma, která porotce napíše místo jména uzlu – tvar je totéž.
  const shapeSynonyms: Record<string, string> = { cube: 'box', ball: 'sphere', column: 'cylinder', pillar: 'cylinder', ring: 'torus' };
  const architecture = new Set(architectureSchema.element.shape.kind.options);
  return (kind: string): string | null => {
    if (assets.has(kind)) return assets.get(kind)!;
    if (shapes.has(kind)) return `shape:${kind}`;
    if (shapeSynonyms[kind] && shapes.has(shapeSynonyms[kind])) return `shape:${shapeSynonyms[kind]}`;
    if (architecture.has(kind as 'room')) return `architecture:${kind}`;
    return null;
  };
}

describe('the object kinds the corpus and the archive ask for', () => {
  it('counts the demand per kind, compares it with the catalog and writes the report', () => {
    expect(existsSync(ARCHIVE), `${ARCHIVE} is missing — it is gitignored`).toBe(true);
    const demand = new Map<string, { sentences: number; archive: number }>();
    const bump = (kind: string | null, field: 'sentences' | 'archive') => {
      if (!kind) return;
      const entry = demand.get(kind) ?? { sentences: 0, archive: 0 };
      entry[field] += 1;
      demand.set(kind, entry);
    };

    const { oracles } = JSON.parse(readFileSync(ORACLES_FILE, 'utf8')) as OracleFile;
    for (const oracle of oracles) {
      const kinds = new Set((oracle.required ?? []).map((r) => kindOf(r.quote)));
      for (const kind of kinds) bump(kind, 'sentences');
    }

    const files = readdirSync(ARCHIVE).filter((name) => name.endsWith('-planner.json')).sort();
    for (const file of files) {
      const answer = JSON.parse(readFileSync(`${ARCHIVE}/${file}`, 'utf8')) as { value?: { objects?: readonly { label: string }[] } };
      for (const object of answer.value?.objects ?? []) bump(kindOf(object.label), 'archive');
    }

    const coveredBy = coverage();
    const kinds = [...demand.entries()]
      .map(([kind, { sentences, archive }]) => ({ kind, sentences, archive, weight: sentences + 2 * archive, coveredBy: coveredBy(kind) }))
      .sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
    const covered = kinds.filter((k) => k.coveredBy !== null);
    const missing = kinds.filter((k) => k.coveredBy === null);
    const totalWeight = kinds.reduce((sum, k) => sum + k.weight, 0);
    const coveredWeight = covered.reduce((sum, k) => sum + k.weight, 0);

    const report = {
      sources: {
        sentences: 'evals/worldstream/gauntlet/oracles.json required quotes (weight 1 per sentence)',
        archive: 'plans/P20/t18-hybrid-v2-20260917-1803/raw/*-planner.json objects[].label (weight 2 per object)',
        coverage: ['src/assets/catalog.json assetId + tags', 'src/shape/schema.ts SHAPE_NODE_GROUPS.primitive', 'src/scene/architecture.ts kinds'],
      },
      catalogAssets: catalog.assets.length,
      kindsTotal: kinds.length,
      coverageByWeight: Math.round((coveredWeight / totalWeight) * 1000) / 1000,
      coveredKinds: covered.length,
      missingKinds: missing.length,
      top24: missing.slice(0, 24).map((k) => k.kind),
      covered,
      missing,
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`asset-demand: ${kinds.length} kinds, coverage by weight ${report.coverageByWeight}, top24 ${report.top24.join(', ')}`);
    expect(kinds.length).toBeGreaterThanOrEqual(40);
    expect(report.top24).toHaveLength(24);
  });
});
