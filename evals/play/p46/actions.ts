/**
 * Měřidlo „sloveso → akce“ P46A (T2): věta, která hrdinovi říká něco udělat
 * (střílet, bít, krást, uhnout, krýt se), má dát hru, kde to hrdina na tlačítko
 * udělá. Pro každou větu se zjistí čtyři věci: chce akci (`wantsAction`), rychlá
 * verze ji má (`hasAction`), robot `intermediate` stiskl tlačítko akce (`botUsed`)
 * a pravidlo akce se spustilo (`verbFired`). Cesta ke hře je táž jako `p45/fun.ts`.
 *
 * Akce bez nepřátel nepočítáme za splněnou: `verbFired` u střelby chce zásah
 * (`shot_hit`), ne jen výstřel, takže `addons: ['shoot']` do prázdna nevyroste.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { type ArcadeWorld, BUTTON, underlyingRule } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { extractIntent } from '@/play/intent/extract';
import type { GameSpecV1 } from '@/play/spec';

export const P46_DIR = join(process.cwd(), 'evals', 'play', 'p46');
export const P45_PANEL = join(process.cwd(), 'evals', 'play', 'p45', 'panel.json');

/** Akce hrdiny P46A (spec, rozhodnutí 12. 10.). */
export const ACTION_KINDS = ['shoot', 'strike', 'dash', 'shield', 'grab'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Hrdina má nejvýš 2 akce, takže věta chce nejvýš první 2 podle pořadí. */
const MAX_WANTED = 2;

/** Slovesa, která osa akce `extractIntent` nemá (krást, uhnout, krýt se). */
const WORD_CUES: readonly (readonly [ActionKind, RegExp])[] = [
  ['grab', /\b(?:steal|steals|stealing|stole|grab|grabs|grabbing|snatch|snatches|snatching)\b/],
  ['dash', /\b(?:dash|dashes|dashing|dodge|dodges|dodging)\b/],
  ['shield', /\b(?:block|blocks|blocking|shield|shields|shielding|defend|defends|defending|protect|protects|protecting)\b/],
];

/** Osa akce z `extractIntent` → akce hrdiny. */
const INTENT_ACTION: Readonly<Record<string, ActionKind>> = { shoot: 'shoot', fight: 'strike', kick: 'strike' };

/** Pravidla, jejichž výstřel dokazuje akci i bez `params.verb` (dnešní doplňky a žánry). */
const LEGACY_PROOF: Readonly<Record<string, ActionKind>> = { shot_hit: 'shoot', glide_shot_hit: 'shoot', fight_hits: 'strike' };

/** Tlačítka akce: dnešní FIRE/ATTACK/INTERACT a nové ACTION_A/B (1<<9, 1<<10, P46A T3). */
const ACTION_BUTTONS = BUTTON.FIRE | BUTTON.ATTACK | BUTTON.INTERACT | (1 << 9) | (1 << 10);

export interface ActionSentence {
  readonly id: string;
  readonly text: string;
}

export interface ActionRow {
  readonly id: string;
  readonly control: string | null;
  /** Akce, které věta chce, v pořadí věty (max 2). */
  readonly wanted: readonly ActionKind[];
  /** Akce, které rychlá verze hrdinovi dala. */
  readonly present: readonly ActionKind[];
  readonly wantsAction: boolean;
  /** Každá chtěná akce je ve hře. */
  readonly hasAction: boolean;
  /** Robot aspoň jednou stiskl tlačítko akce. */
  readonly botUsed: boolean;
  /** Pravidlo každé chtěné akce, kterou hra má, se spustilo (zásah, úder). */
  readonly verbFired: boolean;
  readonly playable: boolean;
  readonly issues: readonly string[];
}

/** Akce, které věta chce, v pořadí, jak je řekla. */
export function wantedActions(sentence: string): ActionKind[] {
  const text = sentence.toLowerCase();
  const found: { kind: ActionKind; at: number }[] = [];
  for (const item of extractIntent(sentence).items) {
    const kind = item.axis === 'action' ? INTENT_ACTION[item.verb] : undefined;
    if (kind !== undefined) found.push({ kind, at: Math.max(0, text.indexOf(item.said.toLowerCase())) });
  }
  for (const [kind, pattern] of WORD_CUES) {
    const hit = pattern.exec(text);
    if (hit !== null) found.push({ kind, at: hit.index });
  }
  const ordered: ActionKind[] = [];
  for (const { kind } of found.sort((a, b) => a.at - b.at)) if (!ordered.includes(kind)) ordered.push(kind);
  return ordered.slice(0, MAX_WANTED);
}

/** Akce, které spec hrdinovi dává: nové pole `abilities` (P46A T3), dnes doplněk střelby a souboj. */
export function presentActions(spec: GameSpecV1): ActionKind[] {
  const present = new Set<ActionKind>();
  const abilities = (spec as { abilities?: readonly string[] }).abilities ?? [];
  for (const ability of abilities) if ((ACTION_KINDS as readonly string[]).includes(ability)) present.add(ability as ActionKind);
  if (spec.addons?.includes('shoot') || spec.control === 'shooter') present.add('shoot');
  // Souboj = ovládání duel i aréna v režimu souboje (generátor `fight`, úder na Attack, `fight_hits`).
  if (spec.control === 'duel' || (spec.controlParams as { generator?: string } | undefined)?.generator === 'fight') present.add('strike');
  return [...present];
}

/** Akce, jejichž pravidlo robotův běh spustil. */
export function firedActions(world: ArcadeWorld, firstFired: readonly number[]): Set<ActionKind> {
  const fired = new Set<ActionKind>();
  world.rules.forEach((ref, index) => {
    if ((firstFired[index] ?? -1) < 0) return;
    const rule = underlyingRule(ref);
    const verb = (rule.params as { verb?: unknown } | undefined)?.verb;
    const kind = typeof verb === 'string' && (ACTION_KINDS as readonly string[]).includes(verb) ? (verb as ActionKind) : LEGACY_PROOF[rule.id];
    if (kind !== undefined) fired.add(kind);
  });
  return fired;
}

/** Řádek nad hotovým specem – měřidlo i test jím projdou stejně. */
export async function actionRowOf(sentence: ActionSentence, spec: GameSpecV1): Promise<ActionRow> {
  const wanted = wantedActions(sentence.text);
  const present = presentActions(spec);
  const base = { id: sentence.id, control: spec.control ?? null, wanted, present, wantsAction: wanted.length > 0, hasAction: wanted.length > 0 && wanted.every((kind) => present.includes(kind)) };
  const dead = (issues: readonly string[]): ActionRow => ({ ...base, botUsed: false, verbFired: false, playable: false, issues });
  if (spec.control === undefined || spec.control === 'tap_go') return dead(['the draft fell back to the grid game – no arcade world to measure']);
  await preloadPhysics(spec, loadRapier);
  // Táž výhybka semínek jako `p45/fun.ts` a publikace.
  let chosen: ArcadeWorld | null = null;
  let last: ArcadeWorld | null = null;
  for (const seed of derivedSeeds(seedFrom(sentence.text.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) return dead(made.issues);
    last = made.world;
    const verdict = verifyArcade(made.world);
    if (verdict.bot.outcome === 'won' && verdict.idle.outcome !== 'won') {
      chosen = made.world;
      break;
    }
  }
  const world = chosen ?? (last as ArcadeWorld);
  const bot = runBot(world, undefined, { profile: 'intermediate' });
  const fired = firedActions(world, bot.firstFired);
  const owned = wanted.filter((kind) => present.includes(kind));
  return {
    ...base,
    // Jen akce, kterou hra má: robot mačká ATTACK/INTERACT i tam, kde nic nedělají. Žánr střelce
    // střílí na TAP, proto se počítá i spuštěné pravidlo akce.
    botUsed: owned.length > 0 && (bot.inputs.some((input) => (input.buttons & ACTION_BUTTONS) !== 0) || owned.some((kind) => fired.has(kind))),
    verbFired: owned.length > 0 && owned.every((kind) => fired.has(kind)),
    playable: chosen !== null,
    issues: [],
  };
}

export const actionRow = (sentence: ActionSentence): Promise<ActionRow> => actionRowOf(sentence, draftGameSpecWithMeta(sentence.text, 1).spec);

const readSentences = (path: string): ActionSentence[] =>
  (JSON.parse(readFileSync(path, 'utf8')) as { sentences: ActionSentence[] }).sentences.map(({ id, text }) => ({ id, text }));

/** Panel P45 (40 vět) a 20 vět se slovesy akce. */
export const actionSentences = (): ActionSentence[] => [...readSentences(P45_PANEL), ...readSentences(join(P46_DIR, 'action-sentences.json'))];

const share = (flags: readonly boolean[]): number | null => (flags.length === 0 ? null : Math.round((flags.filter(Boolean).length / flags.length) * 100) / 100);

export interface ActionSummary {
  readonly n: number;
  readonly wanting: number;
  /** Podíly nad větami, které akci chtějí. */
  readonly hasAction: number | null;
  readonly botUsed: number | null;
  readonly verbFired: number | null;
}

export function actionSummary(rows: readonly ActionRow[]): ActionSummary {
  const wanting = rows.filter((row) => row.wantsAction);
  return {
    n: rows.length,
    wanting: wanting.length,
    hasAction: share(wanting.map((row) => row.hasAction)),
    botUsed: share(wanting.map((row) => row.botUsed)),
    verbFired: share(wanting.map((row) => row.verbFired)),
  };
}
