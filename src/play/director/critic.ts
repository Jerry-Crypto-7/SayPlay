/**
 * Deterministický kritik nad `GameSpecV1` (P23-B T5) s kódy z balíčku GPT
 * (`docs/play/pack/critic.md`). Žádný model, žádné skóre zábavy – jen
 * kontroly, které jdou přečíst ze specu, každá s cestou, důkazem a nápovědou
 * pro opravu (`repair.ts` z ní čte deterministicky).
 *
 * `severity: 'block'` zastaví přijetí specu a spustí opravné kolo; `'warn'`
 * se přenese ven jako `warnings`. Blokuje jen to, co hru rozbije (nic na
 * hraní, žádná výhra, čísla proti sobě, nefér honička, přeplněný spec).
 *
 * `ASSET_BLOCKING` a `NO_RECOVERY` z balíčku se **nevydávají**: kritik nezná
 * assety ani checkpointy runtimu, a kód, který by vydával naslepo, by byl
 * horší než žádný. Test to pinuje.
 */

import { controlOf, unreadItems } from '../capabilities';
import { NUMBER_WORDS } from '../draft/lexicon';
import { ARCHETYPES, type MechanicId, estimateCost } from '../registry';
import type { GameSpecV1 } from '../spec';

export const CRITIC_CODES = [
  'NO_AGENCY',
  'GOAL_UNCLEAR',
  'NO_TERMINATION',
  'CONTRADICTION',
  'UNSUPPORTED',
  'DEAD_TIME',
  'TOO_COMPLEX',
  'UNFAIR_SPAWN',
  'UNVERIFIABLE',
  'BUDGET',
] as const;
export type CriticCode = (typeof CRITIC_CODES)[number];

/** Kódy balíčku, které tenhle kritik nikdy nevydá – viz hlavičku. */
export const UNISSUED_PACK_CODES = ['ASSET_BLOCKING', 'NO_RECOVERY'] as const;

export interface CriticIssue {
  readonly code: CriticCode;
  readonly severity: 'block' | 'warn';
  /** JSON pointer do specu (`/mechanics/1/params/speed`). */
  readonly path: string;
  readonly evidence: string;
  readonly repairHint: string;
}

/** Mechaniky, na které hráč sáhne, nebo před kterými uhýbá – bez nich není co hrát. */
const AGENCY_MECHANICS: readonly MechanicId[] = ['collectible', 'switch', 'carry', 'stun', 'defeat', 'checkpoint', 'zone_trigger', 'hazard_zone', 'chaser', 'patrol'];
/** Mechaniky, které samy dovedou hru k výhře. */
const WIN_MECHANICS: readonly MechanicId[] = ['checkpoint', 'defeat', 'carry'];
/** Mechaniky, které hráče tlačí – bez nich je dlouhá hra prázdný čas. */
const PRESSURE_MECHANICS: readonly MechanicId[] = ['chaser', 'hazard_zone', 'spawn_wave', 'timer'];
const UNSUPPORTED_WORDS = /\b(jump|jumps|jumping|projectile|projectiles|shoot|shoots|shooting|fly|flies|flying|swim|swims|swimming|climb|climbs|climbing|physics)\b/i;
const MAX_MECHANICS = 4;
const MAX_ROLES = 12;
const DEAD_TIME_SECONDS = 120;
const BUDGET_HEADROOM = 0.8;

const NUMBER_IN_TEXT = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'i');

function params<P>(spec: GameSpecV1, id: MechanicId): P | null {
  const found = spec.mechanics.find((mechanic) => mechanic.id === id);
  return found === undefined ? null : (found.params as P);
}

function indexOf(spec: GameSpecV1, id: MechanicId): number {
  return spec.mechanics.findIndex((mechanic) => mechanic.id === id);
}

/**
 * Co ovládání z tabulky schopností nepoužije (P26 T5). Mechanika, kterou
 * kompilátor nečte, blokuje a deterministická oprava ji ze specu vyjme – spec
 * pak netvrdí nic, co hra nehraje. Popisek, který vykreslení nečte, je
 * varování: zůstává v obálce a sada věrnosti ho počítá jako „not built“.
 */
function unread(spec: GameSpecV1): CriticIssue[] {
  const control = controlOf(spec);
  return unreadItems(spec).map((item) =>
    item.kind === 'mechanic'
      ? { code: 'UNSUPPORTED', severity: 'block', path: item.path, evidence: `control ${control} does not play mechanic ${item.what}`, repairHint: `remove it, or pick a control that plays it` }
      : { code: 'UNSUPPORTED', severity: 'warn', path: item.path, evidence: `control ${control} never shows "${item.what}"`, repairHint: 'keep only roles the control shows' },
  );
}

export function critique(spec: GameSpecV1): CriticIssue[] {
  const issues: CriticIssue[] = unread(spec);
  const ids = spec.mechanics.map((mechanic) => mechanic.id);
  const has = (id: MechanicId): boolean => ids.includes(id);
  // Kontroly hratelnosti mřížky; arkádu místo nich ověřuje robot nad tratí z generátoru.
  const grid = controlOf(spec) === 'tap_go';

  if (grid && !ids.some((id) => AGENCY_MECHANICS.includes(id))) {
    issues.push({
      code: 'NO_AGENCY',
      severity: 'block',
      path: '/mechanics',
      evidence: `mechanics ${ids.join(', ')} give the player nothing to touch or dodge`,
      repairHint: `add one of ${AGENCY_MECHANICS.join(', ')} with a matching role`,
    });
  }

  const zoneWin = spec.mechanics.some((m) => m.id === 'zone_trigger' && (m.params as { effect?: string }).effect === 'win');
  const timerWin = spec.mechanics.some((m) => m.id === 'timer' && (m.params as { onEnd?: string }).onEnd === 'win');
  // Aréna (P25F) vyhrává v jádře růstem nebo přežitím (`arenaWinOf`, pravidla `grow_to` /
  // `survive_time`) – časovač končící prohrou je tam limit na růst, ne chybějící výhra.
  const arenaWin = spec.control === 'move_free';
  if (grid && !zoneWin && !timerWin && !arenaWin && !ids.some((id) => WIN_MECHANICS.includes(id))) {
    issues.push({
      code: 'NO_TERMINATION',
      severity: 'block',
      path: '/mechanics',
      evidence: 'no zone_trigger with effect win, no timer with onEnd win, no checkpoint, defeat or carry',
      repairHint: 'add zone_trigger {role: exit, when: enter, effect: win} and an exit role',
    });
  }

  const objective = spec.objective;
  if ((objective.count !== undefined || objective.seconds !== undefined) && !NUMBER_IN_TEXT.test(objective.description)) {
    issues.push({
      code: 'GOAL_UNCLEAR',
      severity: 'warn',
      path: '/objective/description',
      evidence: `objective needs ${objective.count !== undefined ? `count ${String(objective.count)}` : `seconds ${String(objective.seconds)}`} but the description names no number`,
      repairHint: 'put the number into objective.description',
    });
  }
  if (spec.tutorial.goalLine.trim().toLowerCase() === spec.title.trim().toLowerCase()) {
    issues.push({
      code: 'GOAL_UNCLEAR',
      severity: 'warn',
      path: '/tutorial/goalLine',
      evidence: 'goalLine repeats the title instead of saying what to do',
      repairHint: 'write goalLine as one imperative sentence',
    });
  }

  const countMechanics: readonly MechanicId[] = ['collectible', 'defeat', 'checkpoint'];
  for (const id of countMechanics) {
    const mechanic = params<{ count: number }>(spec, id);
    if (mechanic !== null && objective.count !== undefined && objective.count !== mechanic.count) {
      issues.push({
        code: 'CONTRADICTION',
        severity: 'block',
        path: `/mechanics/${String(indexOf(spec, id))}/params/count`,
        evidence: `objective.count ${String(objective.count)} but ${id}.count ${String(mechanic.count)}`,
        repairHint: `set objective.count to ${String(mechanic.count)}`,
      });
    }
  }
  const timer = params<{ seconds: number }>(spec, 'timer');
  if (timer !== null && objective.seconds !== undefined && objective.seconds !== timer.seconds) {
    issues.push({
      code: 'CONTRADICTION',
      severity: 'block',
      path: `/mechanics/${String(indexOf(spec, 'timer'))}/params/seconds`,
      evidence: `objective.seconds ${String(objective.seconds)} but timer.seconds ${String(timer.seconds)}`,
      repairHint: `set objective.seconds to ${String(timer.seconds)}`,
    });
  }
  const sw = params<{ switchRoles: string[]; required: string[] }>(spec, 'switch');
  if (sw !== null) {
    const outside = sw.required.filter((role) => !sw.switchRoles.includes(role));
    if (outside.length > 0) {
      issues.push({
        code: 'CONTRADICTION',
        severity: 'block',
        path: `/mechanics/${String(indexOf(spec, 'switch'))}/params/required`,
        evidence: `required switches ${outside.join(', ')} are not in switchRoles`,
        repairHint: 'keep required a subset of switchRoles',
      });
    }
  }

  const texts: readonly (readonly [string, string])[] = [
    ['/theme/setting', spec.theme.setting],
    ['/objective/description', objective.description],
    ...spec.roles.map((role, index) => [`/roles/${String(index)}/label`, role.label] as const),
  ];
  for (const [path, text] of grid ? texts : []) {
    const word = UNSUPPORTED_WORDS.exec(text);
    if (word !== null) {
      issues.push({
        code: 'UNSUPPORTED',
        severity: 'warn',
        path,
        evidence: `"${word[1]}" describes something the tap-to-move runtime cannot do`,
        repairHint: 'keep the fantasy in words; the mechanics stay registered ones',
      });
    }
  }

  if (grid && spec.targetDurationSec > DEAD_TIME_SECONDS && !ids.some((id) => PRESSURE_MECHANICS.includes(id))) {
    issues.push({
      code: 'DEAD_TIME',
      severity: 'warn',
      path: '/targetDurationSec',
      evidence: `${String(spec.targetDurationSec)} s with nothing pushing the player (no ${PRESSURE_MECHANICS.join(', ')})`,
      repairHint: 'shorten targetDurationSec or add a timer or hazard',
    });
  }

  if (spec.mechanics.length > MAX_MECHANICS || spec.roles.length > MAX_ROLES) {
    issues.push({
      code: 'TOO_COMPLEX',
      severity: 'block',
      path: spec.mechanics.length > MAX_MECHANICS ? '/mechanics' : '/roles',
      evidence: `${String(spec.mechanics.length)} mechanics, ${String(spec.roles.length)} roles (max ${String(MAX_MECHANICS)} and ${String(MAX_ROLES)})`,
      repairHint: `drop mechanics outside ${ARCHETYPES[spec.archetype].requiredMechanics.join(', ')} from the end, merge prop roles`,
    });
  }

  const chaser = params<{ speed: string }>(spec, 'chaser');
  if (chaser !== null && chaser.speed === 'fast' && !has('stun') && !has('checkpoint')) {
    issues.push({
      code: 'UNFAIR_SPAWN',
      severity: 'block',
      path: `/mechanics/${String(indexOf(spec, 'chaser'))}/params/speed`,
      evidence: 'a fast chaser with no stun and no checkpoint leaves the player no answer',
      repairHint: 'set speed to normal, or add stun',
    });
  }

  const verified = new Set(spec.verification.map((assertion) => assertion.mechanic).filter((id): id is string => id !== undefined));
  spec.mechanics.forEach((mechanic, index) => {
    if (grid && !verified.has(mechanic.id)) {
      issues.push({
        code: 'UNVERIFIABLE',
        severity: 'warn',
        path: `/mechanics/${String(index)}`,
        evidence: `no verification assertion names mechanic ${mechanic.id}`,
        repairHint: `add a keypoint with mechanic ${mechanic.id}`,
      });
    }
  });

  const cost = estimateCost(spec.mechanics, spec.roles);
  const overEntities = cost.entities > spec.budgets.maxEntities * BUDGET_HEADROOM;
  const overRules = cost.rules > spec.budgets.maxRules * BUDGET_HEADROOM;
  if (overEntities || overRules) {
    issues.push({
      code: 'BUDGET',
      severity: 'warn',
      path: overEntities ? '/budgets/maxEntities' : '/budgets/maxRules',
      evidence: `estimate ${String(cost.entities)} entities / ${String(cost.rules)} rules against ${String(spec.budgets.maxEntities)} / ${String(spec.budgets.maxRules)} (over 80 %)`,
      repairHint: 'lower role counts or mechanic counts proportionally',
    });
  }

  return issues;
}

/** Jen blokující nálezy – to, co opravné kolo musí odstranit. */
export function blockingIssues(issues: readonly CriticIssue[]): CriticIssue[] {
  return issues.filter((issue) => issue.severity === 'block');
}
