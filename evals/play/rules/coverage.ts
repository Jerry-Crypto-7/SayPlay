/**
 * Pokrytí sloves pravidly na 200 větách poptávky (P29A T10), offline, bez modelu.
 *
 * Každá věta dostane jednu třídu:
 * - `piece` – dílek: ovládání pro třídu slovesa věty (ruční štítek korpusu)
 *   existuje a návrh ze slov (`draftGameSpec`, semínko 1) ho opravdu zvolí;
 * - `template` – dílek ne, ale věta obsahuje sloveso hotové šablony pravidla
 *   (`src/play/arcade/rules/templates.ts`);
 * - `none` – nic z toho.
 * „Před“ = jen dílky, „po“ = dílky + šablony. Nepokrytá slovesa se čtou ze
 * slov věty proti malému slovníku herních sloves; věta bez něj nese štítek
 * třídy v závorce.
 *
 * Artefakt: `npx tsx evals/play/rules/coverage.ts --write` → `coverage.json`.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { templateFor, type TemplateName } from '@/play/arcade/rules/templates';
import { draftGameSpec } from '@/play/draft';
import type { ControlId } from '@/play/spec';

import corpus from '../demand/corpus.json';

/** Třída slovesa korpusu (`demand/labels.json`) → ovládání, které ji hraje; třída bez ovládání chybí. */
const CLASS_CONTROL: Readonly<Record<string, ControlId>> = {
  tap_go: 'tap_go',
  runner: 'runner',
  platform: 'platform',
  flap: 'flap',
  steer: 'steer',
  move_free: 'move_free',
  aim_shoot: 'shooter',
  throw: 'throw',
  timing: 'timing',
  rhythm: 'rhythm',
  melee: 'duel',
};

/** Herní slovesa, podle kterých se jmenuje, co v nepokryté větě chybí. */
const GAME_VERBS = [
  'build', 'stack', 'grow', 'cook', 'craft', 'merge', 'match', 'sort', 'drive', 'park', 'fly', 'swim', 'dodge', 'jump', 'shoot', 'catch',
  'paint', 'draw', 'dig', 'mine', 'plant', 'water', 'feed', 'fish', 'fight', 'punch', 'kick', 'race', 'collect', 'balance', 'slice', 'cut',
  'pop', 'drop', 'launch', 'bounce', 'roll', 'climb', 'sneak', 'hide', 'escape', 'defend', 'place', 'solve', 'connect', 'rotate', 'slide',
  'swap', 'tap', 'click', 'upgrade', 'manage', 'run', 'survive', 'explore', 'decorate', 'dress', 'design', 'mix', 'bake', 'serve', 'clean',
  'wash', 'fix', 'repair', 'train', 'breed', 'tame', 'ride', 'skate', 'surf', 'ski', 'throw', 'carry', 'push', 'open', 'pull', 'give',
  'deliver', 'rescue', 'save', 'protect', 'guard', 'steal', 'chase', 'hunt', 'eat', 'avoid', 'aim', 'guess', 'type', 'spell', 'count',
];

const forms = (verb: string): string[] => [verb, `${verb}s`, `${verb}es`, `${verb}ed`, `${verb}d`, `${verb}ing`, `${verb.replace(/e$/, '')}ing`, `${verb}${verb.at(-1) ?? ''}ing`];

function verbsIn(text: string): string[] {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  return GAME_VERBS.filter((verb) => forms(verb).some((form) => words.has(form)));
}

export type Cover = 'piece' | 'template' | 'none';

export interface SentenceCoverage {
  readonly id: string;
  readonly verbClass: string;
  readonly drafted: ControlId;
  readonly cover: Cover;
  readonly template: TemplateName | null;
  readonly verbs: readonly string[];
}

export interface VerbCoverage {
  readonly total: number;
  readonly before: { readonly piece: number; readonly none: number };
  readonly after: Readonly<Record<Cover, number>>;
  readonly byTemplate: Readonly<Record<string, number>>;
  readonly topUncovered: readonly { readonly verb: string; readonly count: number }[];
  readonly sentences: readonly SentenceCoverage[];
}

export function measureVerbCoverage(): VerbCoverage {
  const sentences: SentenceCoverage[] = corpus.map((entry) => {
    const drafted = draftGameSpec(entry.text, 1).control ?? 'tap_go';
    const control = CLASS_CONTROL[entry.verb];
    const template = templateFor(entry.text);
    const cover: Cover = control !== undefined && control === drafted ? 'piece' : template !== null ? 'template' : 'none';
    return { id: entry.id, verbClass: entry.verb, drafted, cover, template, verbs: verbsIn(entry.text) };
  });
  const count = (cover: Cover): number => sentences.filter((sentence) => sentence.cover === cover).length;
  const byTemplate: Record<string, number> = {};
  for (const sentence of sentences) if (sentence.cover === 'template' && sentence.template !== null) byTemplate[sentence.template] = (byTemplate[sentence.template] ?? 0) + 1;
  const missing = new Map<string, number>();
  for (const sentence of sentences.filter((item) => item.cover === 'none')) {
    for (const verb of sentence.verbs.length > 0 ? sentence.verbs : [`(${sentence.verbClass})`]) missing.set(verb, (missing.get(verb) ?? 0) + 1);
  }
  const topUncovered = [...missing].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([verb, n]) => ({ verb, count: n }));
  return {
    total: sentences.length,
    before: { piece: count('piece'), none: sentences.length - count('piece') },
    after: { piece: count('piece'), template: count('template'), none: count('none') },
    byTemplate,
    topUncovered,
    sentences,
  };
}

if (process.argv.includes('--write') || process.argv.includes('--write-p41')) {
  const out = fileURLToPath(new URL(process.argv.includes('--write-p41') ? './coverage-p41.json' : './coverage.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(measureVerbCoverage(), null, 1)}\n`);
  console.log(`wrote ${out}`);
}
