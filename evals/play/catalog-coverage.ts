/**
 * Kolik podstatných jmen rolí z vět dostane **přesný** model katalogu (P26A T7).
 *
 * Jména čte `readRoles` návrhu ze slov – tytéž role, které arkáda kreslí –
 * a model vybírá `modelOf` z `src/play/arcade/models.ts`, tedy funkce, kterou
 * arkáda opravdu volá. Přesný = vybraný model nese hlavu jména jako id nebo
 * tag; alias (zombie → goblin) ani kategorie přesné nejsou. „Před“ je týž
 * výběr bez CC0 modelů: CC0 model smí nést jen tag, který žádný vlastní model
 * nemá (`promote.mjs`), takže přesná shoda před CC0 by vedla na vlastní model.
 *
 * Artefakt `catalog-coverage.json` píše `node scripts/assets/cc0/coverage.mjs`.
 */

import catalogIndex from '@/assets/catalog-index.json';
import { readRoles, singular } from '@/play/draft/lexicon';
import { modelOf } from '@/play/arcade/models';

import demand from './demand/corpus.json';
import fidelity from './fidelity/corpus.json';

export const ROLES = ['hero', 'enemy', 'collectible', 'obstacle', 'target', 'checklist'] as const;
export type CoverageRole = (typeof ROLES)[number];

/** Sady vět zvlášť (P26A T12): korpus poptávky, sada věrnosti a z ní 10 nepřátelských vět porotce. */
export const SETS = ['demand', 'fidelity', 'hostile'] as const;
export type CoverageSet = (typeof SETS)[number];

interface Mention {
  readonly sentence: string;
  readonly role: CoverageRole;
  readonly noun: string;
  readonly sets: readonly CoverageSet[];
}

const TAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  catalogIndex.assets.map((asset) => [asset.assetId, new Set([asset.assetId, ...asset.tags])]),
);

const isCc0 = (model: string) => model.startsWith('cc0-');

/** Jména rolí jedné věty; `checklist` jsou věci ze seznamu sady věrnosti, které role nepřečtou. */
function mentionsOf(sentence: string, text: string, sets: readonly CoverageSet[], checklist: readonly string[] = []): Mention[] {
  const roles = readRoles(text);
  const phrases: Array<[CoverageRole, string | null | undefined]> = [
    ['hero', roles.player],
    ['enemy', roles.chaser ?? roles.threat?.label],
    ['collectible', roles.collectible ?? roles.item],
    ['obstacle', roles.hazard],
    ['target', roles.target],
    ...checklist.map((item): [CoverageRole, string] => ['checklist', item]),
  ];
  const out: Mention[] = [];
  for (const [role, phrase] of phrases) {
    if (!phrase) continue;
    const noun = singular(phrase.toLowerCase().trim());
    if (out.some((mention) => mention.noun === noun)) continue;
    out.push({ sentence, role, noun, sets });
  }
  return out;
}

/** Model pro jméno a jestli je přesný: vybraný model nese hlavu jména jako id nebo tag. */
export function exactModel(noun: string): { model: string | undefined; exact: boolean } {
  const model = modelOf(noun, false);
  const head = noun.split(' ').at(-1) ?? noun;
  const tags = model === undefined ? undefined : TAGS.get(model);
  return { model, exact: tags !== undefined && (tags.has(noun) || tags.has(head) || tags.has(noun.replaceAll(' ', '-'))) };
}

interface Tally {
  mentions: number;
  before: number;
  now: number;
}

export function measureCoverage() {
  const mentions = [
    ...demand.map((entry) => mentionsOf(entry.id, entry.text, ['demand'])),
    ...fidelity.sentences.map((entry) =>
      mentionsOf(
        `fidelity:${entry.id}`,
        entry.text,
        entry.source === 'hostile' ? ['fidelity', 'hostile'] : ['fidelity'],
        entry.checklist.filter((item) => !['verb', 'setting'].includes(item.slot)).map((item) => item.item),
      ),
    ),
  ].flat();

  const byRole = Object.fromEntries(ROLES.map((role) => [role, { mentions: 0, before: 0, now: 0 }])) as Record<CoverageRole, Tally>;
  const nouns = new Map<string, { model: string | undefined; exact: boolean; mentions: number }>();
  const sets = Object.fromEntries(SETS.map((set) => [set, { mentions: 0, now: 0, nouns: new Set<string>(), exact: new Set<string>() }]));
  for (const mention of mentions) {
    const found = exactModel(mention.noun);
    for (const tally of [byRole[mention.role], ...mention.sets.map((set) => sets[set])]) {
      tally.mentions += 1;
      if (found.exact) tally.now += 1;
    }
    for (const set of mention.sets) {
      sets[set].nouns.add(mention.noun);
      if (found.exact) sets[set].exact.add(mention.noun);
    }
    const tally = byRole[mention.role];
    if (found.exact && !isCc0(found.model!)) tally.before += 1;
    const entry = nouns.get(mention.noun) ?? { ...found, mentions: 0 };
    entry.mentions += 1;
    nouns.set(mention.noun, entry);
  }

  const sorted = [...nouns].sort((a, b) => b[1].mentions - a[1].mentions || a[0].localeCompare(b[0]));
  const total = Object.values(byRole).reduce((sum, tally) => ({ mentions: sum.mentions + tally.mentions, before: sum.before + tally.before, now: sum.now + tally.now }), { mentions: 0, before: 0, now: 0 });
  // CC0 model, jehož jméno věta řekne, ale `modelOf` vybere jiný model (alias v `WORD_MODEL`).
  const cc0Tags = new Map(catalogIndex.assets.filter((asset) => isCc0(asset.assetId)).flatMap((asset) => asset.tags.map((tag) => [tag, asset.assetId] as const)));
  return {
    about: 'P26A T7: role nouns (readRoles of the play draft) from evals/play/demand (200) and evals/play/fidelity (30, plus checklist items) that src/play/arcade/models.ts modelOf maps to a catalog model carrying that noun as id or tag. before = the same choice without CC0 models. bySet (P26A T12): demand, fidelity and its 10 hostile sentences apart.',
    sentences: { demand: demand.length, fidelity: fidelity.sentences.length },
    mentions: total,
    nouns: {
      distinct: nouns.size,
      before: sorted.filter(([, entry]) => entry.exact && !isCc0(entry.model!)).length,
      now: sorted.filter(([, entry]) => entry.exact).length,
    },
    byRole,
    bySet: Object.fromEntries(SETS.map((set) => [set, { mentions: sets[set].mentions, now: sets[set].now, nouns: sets[set].nouns.size, nounsNow: sets[set].exact.size }])) as Record<CoverageSet, SetTally>,
    gained: sorted.filter(([, entry]) => entry.exact && isCc0(entry.model!)).map(([noun, entry]) => ({ noun, model: entry.model!, mentions: entry.mentions })),
    aliasedAway: sorted
      .filter(([noun, entry]) => cc0Tags.has(noun) && entry.model !== cc0Tags.get(noun))
      .map(([noun, entry]) => ({ noun, cc0: cc0Tags.get(noun)!, drawn: entry.model ?? null, mentions: entry.mentions })),
  };
}

export type CatalogCoverage = ReturnType<typeof measureCoverage>;

interface SetTally {
  mentions: number;
  now: number;
  nouns: number;
  nounsNow: number;
}

/** Souhrn jednoho stavu katalogu (P26A T12): přesné modely celkem a po sadách vět. */
export const stateOf = (coverage: CatalogCoverage) => ({
  models: catalogIndex.assets.length,
  nouns: { distinct: coverage.nouns.distinct, now: coverage.nouns.now },
  mentions: { mentions: coverage.mentions.mentions, now: coverage.mentions.now },
  bySet: coverage.bySet,
});
