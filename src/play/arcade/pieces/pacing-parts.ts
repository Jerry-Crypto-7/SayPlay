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

import { type Phase, phasesFromCurve } from '../../compose/progression';
import type { GameSpecV1 } from '../../spec';
import type { ArcadeParts } from '../addons';
import { ARCADE_LIMITS, type ArcadeWorld, type PieceRef, RAMP_STEP_PCT } from '../contract';
import type { BehaviourId, BehaviourRef } from './behaviours';
import { type PacingSetup, TENSION_CURVE, withPacing } from './pacing';
import { progressionParts } from './progression-parts';

/** Co žánr dá průběhu: nastavení `withPacing` bez semínka; boss navíc s věcmi, které nese, a body za pád. */
export interface GenrePacingSetup extends Omit<PacingSetup, 'seed' | 'boss'> {
  readonly boss?: NonNullable<PacingSetup['boss']> & {
    /** Věci úrovně (indexy těl), které boss nese: do jeho pádu jsou jen předlohy, padlý boss vydá jejich kopie. */
    readonly carries?: readonly number[];
    readonly score?: number;
  };
  /** Výchozí fáze (`progressionParts`), když spec nenese vlastní `phases` ani `dependsOn`. */
  readonly phases?: readonly Phase[];
  /** Fáze běží nad prostřední úrovní rampy žánru (+10 %), ne nad její první třetinou: křivka vezme rampě jen růst. */
  readonly rampLevel?: boolean;
}

/** Záznam žánru: z hotových částí a specu nastavení průběhu; `null` = tahle hra průběh nedostane. */
export type GenrePacing = (parts: ArcadeParts, spec: GameSpecV1) => GenrePacingSetup | null;

/** Fáze z křivky; `rows` = finále přidá tolik překážek vedle bezpečné cesty (hustší řady sprintu). */
const curvePhases = (rows: number): Phase[] => phasesFromCurve(TENSION_CURVE).map((phase, index, all) => (rows > 0 && index === all.length - 1 ? { ...phase, add: [{ role: 'obstacle', count: rows }] } : phase));

/**
 * Dráhový žánr (P45C T11): postup = ujetá trať, fáze z křivky a finále
 * závěrečný sprint. Bez chování: robot běžce s nimi na trati s překážkami
 * prohrává (nález pod plánem), ostatní dráhy pruhy nemají.
 */
const track = (rows: number, rampLevel = false): GenrePacing => (parts) => ({
  goal: { by: 'distance', need: parts.level.length, limit: ARCADE_LIMITS.maxTicks },
  space: 'track',
  spots: [0, 0],
  behaviours: [],
  budget: 0,
  finale: 'sprint',
  phases: curvePhases(rows),
  ...(rampLevel ? { rampLevel: true } : {}),
});

/**
 * Průběh podle generátoru světa (`generatorOf`); žánry plní T11–T14. Generátor bez záznamu hraje beze změny.
 * Plošinovka zatím ne (robot nezná rychlost běhu); `steer_track` a `glide_course` staví jen spec bez `genre`.
 */
export const GENRE_PACING: Partial<Record<string, GenrePacing>> = {
  // Běžec bez řad navíc: obecné umístění (`progressionParts`) nezná volný pruh řady a zavřelo by ho – útěk s jedním životem vyhrál 2/8.
  // Nad úrovní rampy: se stupňováním na 100 % základu měl začátečník víc času sestřelit nepřítele v pruhu (se střelbou 0,61 → 0,81 výher
  // na 80 semínkách); nad prostřední třetinou drží běžec svou dřívější obtížnost (0,59 / 0,58 / útěk 0,35 jako bez průběhu).
  // Složená hra (díly P42) ne: robot dílu `catch` uhne do pruhu padající kořisti jen při základní rychlosti (`assembly-parts` run/1 při 110 % nevyhrál).
  runner_track: (parts, spec) => track(0, spec.assemblyParts === undefined)(parts, spec),
  // Poletování bez úrovně rampy: rychlejší let mu obtížnost nepřidá (sběr 0,7 → 0,9).
  flap_track: track(0),
  // Závod do prvního nárazu (`crashBudget` 1) si nechá rampu – odchylka P45C T11: vrchol křivky 115 % jede pod vrcholem rampy 120 %
  // a rychlejší finále bez natažení zatáček kontrola neunese; začátečník pak vyhrál 0,79 (80 semínek) proti 0,63 bez průběhu.
  voyage_race: (parts, spec) => (parts.health === 1 ? null : track(3)(parts, spec)),
};

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
  let setup = entry?.(parts, spec) ?? null;
  if (setup === null || entry === undefined) return parts;
  // Výchozí fáze jen tam, kde je spec nenese; záznam se pak přečte znovu nad nataženou tratí.
  // Fáze, které úroveň neunese (`issues`), odpadnou – hra kvůli průběhu nikdy neselže.
  if (setup.phases !== undefined && spec.phases === undefined && spec.dependsOn === undefined) {
    // Křivka nahradí rampu žánru (+10 % za třetinu): obojí naráz by finále hnalo na 150 % a útěk před pronásledovatelem prohrával.
    // `rampLevel`: z rampy zůstane jedna značka na startu (druhá leží za cílem a nepřejede se) – 100 % křivky = prostřední třetina.
    const ramp = parts.control.params.ramp;
    const marks = Array.isArray(ramp) ? ramp.length : 0;
    const kept = setup.rampLevel === true && marks > 0 ? 1 : 0;
    const flat = (ref: PieceRef): PieceRef => {
      const { ramp: _ramp, ...params } = ref.params;
      return { ...ref, params: kept === 1 && _ramp !== undefined ? { ...params, ramp: [0, 2 * parts.level.length] } : params };
    };
    // Trať rampy je postavená na její vrchol (+10 % za značku): natáhne se jen o to, co fáze přesáhnou nad něj, jinak hra ztratí třetinu tempa.
    const builtFor = ((100 + RAMP_STEP_PCT * marks) * 100) / (100 + RAMP_STEP_PCT * kept);
    const phased = progressionParts({ ...parts, control: flat(parts.control), bot: flat(parts.bot) }, { ...spec, phases: [...setup.phases] }, builtFor);
    if ((phased.issues?.length ?? 0) === 0) {
      parts = phased;
      setup = entry(parts, spec) ?? setup;
    }
  }
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
