/**
 * Průběh hry ve skládání světa (P45C T10): za `progressionParts` obalí
 * ovládání a robota křivkou napětí (`pacing_control`, `pacing_bot`), přidá
 * předlohy chování a bosse, pravidlo `pacing` a pravidlo `boss_beat` podle
 * tabulky žánrů `GENRE_PACING`.
 *
 * Jen nové hry: spec bez `genre` (hry uložené před žánry, fixtury přehrání),
 * spec žánru uložený před průběhem (`genre.v1`) i generátor bez záznamu
 * v tabulce staví tentýž svět jako dřív.
 */

import type { GameSpecV1 } from '../../spec';
import type { ArcadeParts } from '../addons';
import { ARCADE_LIMITS, type ArcadeWorld, type PieceRef } from '../contract';
import type { BehaviourId, BehaviourRef } from './behaviours';
import { type PacingSetup, withPacing } from './pacing';

/** Co žánr dá průběhu: nastavení `withPacing` bez semínka; boss navíc s věcmi, které nese, a body za pád. */
export interface GenrePacingSetup extends Omit<PacingSetup, 'seed' | 'boss'> {
  readonly boss?: NonNullable<PacingSetup['boss']> & {
    /** Věci úrovně (indexy těl), které boss nese: do jeho pádu jsou jen předlohy, padlý boss vydá jejich kopie. */
    readonly carries?: readonly number[];
    readonly score?: number;
  };
}

/** Záznam žánru: z hotových částí a specu nastavení průběhu; `null` = tahle hra průběh nedostane. */
export type GenrePacing = (parts: ArcadeParts, spec: GameSpecV1) => GenrePacingSetup | null;

/** Průběh podle generátoru světa (`generatorOf`); žánry plní T11–T14. Generátor bez záznamu hraje beze změny. */
export const GENRE_PACING: Partial<Record<string, GenrePacing>> = {};

/** Verze překladu žánru před průběhem (`GENRE_COMPILER_VERSION` v `genre/contract.ts`): uložené hry s ní průběh nedostanou. */
export const UNPACED_GENRE_VERSION = 'genre.v1';

/** Nejvýš tolik pravidel ze stropu jádra si průběh vezme: `pacing` a `boss_beat`. */
export const PACING_RULES = 2;

/**
 * Pravidla, která hra dostane i bez průběhu, v pořadí `arcadeWorldOf`: části,
 * doplňky, díly skládání, pravidla specu, časovač s prohrou, skóre.
 * simplified: každý doplněk se počítá za jedno pravidlo, i když žádné nepřidá; přesně to ví až `applyAddons`.
 */
function rulesBesides(parts: ArcadeParts, spec: GameSpecV1): number {
  const timer = spec.mechanics.some((mechanic) => mechanic.id === 'timer' && (mechanic.params as { readonly onEnd?: string }).onEnd === 'lose') ? 1 : 0;
  const assembly = spec.assemblyParts === undefined ? 0 : spec.assemblyParts.length + 1;
  return parts.rules.length + (spec.addons?.length ?? 0) + assembly + (spec.rules?.length ?? 0) + timer + (spec.scoring === undefined ? 0 : 1);
}

/**
 * Části hry s průběhem. Rozpočet pravidel: když by `pacing` a `boss_beat`
 * se vším ostatním přetekly strop jádra, ustoupí nejdřív boss, pak chování;
 * křivka (`pacing_control`) zůstane vždy – hra kvůli průběhu nikdy neselže.
 */
export function pacingParts(parts: ArcadeParts, spec: GameSpecV1, seed: number, generator: string): ArcadeParts {
  const unpaced = spec.genre === undefined || spec.genre.compilerVersion === UNPACED_GENRE_VERSION;
  const entry = unpaced || (parts.issues?.length ?? 0) > 0 ? undefined : GENRE_PACING[generator];
  const setup = entry?.(parts, spec) ?? null;
  if (setup === null) return parts;
  const room = ARCADE_LIMITS.maxRules - rulesBesides(parts, spec);
  const boss = room >= PACING_RULES ? setup.boss : undefined;
  const moving = room >= 1;
  const finale = !moving || (setup.finale === 'boss' && boss === undefined) ? undefined : setup.finale;
  const carried = boss?.carries ?? [];
  const level = carried.length === 0 ? parts.level : { ...parts.level, bodies: parts.level.bodies.map((body, index) => (carried.includes(index) ? { ...body, template: true } : body)) };
  const paced = withPacing({ ...parts, level }, {
    seed, goal: setup.goal, space: setup.space, spots: setup.spots,
    behaviours: moving ? setup.behaviours : [], budget: moving ? setup.budget : 0,
    ...(finale === undefined ? {} : { finale }),
    ...(boss === undefined ? {} : { boss: { body: boss.body, at: boss.at } }),
  });
  if (boss === undefined || (paced.issues?.length ?? 0) > 0) return paced;
  const drop = carried.length === 0 ? {} : { drop: { template: carried[0] as number, count: carried.length } };
  const beat: PieceRef = { id: 'boss_beat', params: { boss: parts.level.bodies.length + setup.behaviours.length, ...drop, ...(boss.score === undefined ? {} : { score: boss.score }) } };
  return { ...paced, level: { ...paced.level, spawnSlots: (paced.level.spawnSlots ?? 0) + carried.length }, rules: [...paced.rules, beat] };
}

/** `pacing_control` pod obaly doplňků a skládání, nebo `null`. */
function pacedControl(control: PieceRef): PieceRef | null {
  if (control.id === 'pacing_control') return control;
  const base = control.params.base as PieceRef | undefined;
  return typeof base === 'object' && base !== null && typeof base.id === 'string' ? pacedControl(base) : null;
}

/** Co sondovat (`verifyArcade`): první tělo (předloha) každého chování a bosse ve světě. */
export function pacingProbeBodies(world: ArcadeWorld): { readonly body: number; readonly behaviour: BehaviourId }[] {
  const refs = (pacedControl(world.control)?.params.behaviours ?? []) as readonly BehaviourRef[];
  const seen = new Set<BehaviourId>();
  return refs.flatMap((ref) => (seen.has(ref.id) ? [] : (seen.add(ref.id), [{ body: ref.template, behaviour: ref.id }])));
}
