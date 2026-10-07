/**
 * Podněty akce (P43 T4) – čistě vykreslovací vrstva.
 *
 * Sloveso, které hra hraje, dostane podnět jen v tiku, kdy jádro vydalo
 * odpovídající událost (`VisualEvent` ze sběrnice efektů, ta je z efektů
 * `session.onEvents`). Bez události žádný podnět: efekt se nesmí tvářit jako
 * akce, kterou hra nehraje. Simulace tenhle modul nikdy nečte.
 */

import type { ActionId, ObjectiveId } from '@/play/intent/contract';
import type { GameSpecV1 } from '@/play/spec';

import type { VisualEvent, VisualEventKind } from '../effects/bus';

export type CueVerb = ActionId | ObjectiveId;

/**
 * Které události sloveso dokazují. Prázdné pole = sloveso nemá vlastní
 * viditelnou událost (trefa do rytmu, skóre míče) a podnět nedostane.
 */
export const CUE_EVENTS: Readonly<Record<CueVerb, readonly VisualEventKind[]>> = {
  shoot: ['hit', 'death'],
  throw: ['hit', 'death'],
  fight: ['hit', 'death'],
  beat: ['hit', 'death'],
  duel: ['hit', 'death'],
  kick: ['hit', 'death'],
  defeat: ['hit', 'death'],
  collect: ['pickup'],
  catch: ['pickup'],
  deliver: ['stateChange'],
  interact: ['stateChange'],
  stack: ['spawn'],
  build: ['spawn'],
  land: ['land'],
  reach: ['win'],
  race: ['win'],
  escape: ['win'],
  survive: ['win'],
  time: [],
  score: [],
};

/** Události, které patří hrdinovi samému, ne tělu, se kterým něco udělal. */
const OWN: readonly VisualEventKind[] = ['win', 'lose', 'land'];

export interface ActionCue {
  readonly verb: CueVerb;
  /** Tik události. */
  readonly at: number;
  /** Tělo, se kterým hrdina akci udělal; u výhry a dopadu chybí. */
  readonly target?: number;
  /** Poloha události v metrech (osy jádra, jako `VisualEvent`). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Podněty z událostí jednoho tiku; `player` = tělo hrdiny. */
export function cuesOf(verbs: readonly CueVerb[], events: readonly VisualEvent[], player: number): ActionCue[] {
  const cues: ActionCue[] = [];
  for (const event of events) {
    const own = OWN.includes(event.kind);
    // Co se stalo hrdinovi (zásah, sebrání hrdiny), není jeho akce.
    if (own !== (event.body === player)) continue;
    for (const verb of verbs) {
      if (!CUE_EVENTS[verb].includes(event.kind)) continue;
      cues.push({ verb, at: event.tick, ...(own ? {} : { target: event.body }), x: event.x, y: event.y, z: event.z });
    }
  }
  return cues;
}

const BY_CONTROL: Partial<Record<string, CueVerb>> = { shooter: 'shoot', throw: 'throw', duel: 'duel', timing: 'time', rhythm: 'time', ball: 'kick' };
const BY_ADDON: Partial<Record<string, CueVerb>> = { shoot: 'shoot', collect: 'collect' };
const BY_OBJECTIVE: Partial<Record<string, CueVerb>> = { reach: 'reach', checkpoints: 'reach', collect: 'collect', survive: 'survive', deliver: 'deliver', puzzle: 'interact', defeat_targets: 'defeat' };
const BY_HERO_ACTION: Partial<Record<string, CueVerb>> = { throw: 'throw', carry: 'deliver', stack: 'stack' };

/** Slovesa, která hra podle specu hraje (renderer `Intent` nezná). Bez duplicit, v pořadí ovládání → doplňky → cíl → akce hrdiny. */
export function verbsOfSpec(spec: Pick<GameSpecV1, 'control' | 'addons' | 'objective' | 'heroAction'>): CueVerb[] {
  const verbs = [
    BY_CONTROL[spec.control ?? 'tap_go'],
    ...(spec.addons ?? []).map((addon) => BY_ADDON[addon]),
    BY_OBJECTIVE[spec.objective.kind],
    spec.heroAction === undefined ? undefined : BY_HERO_ACTION[spec.heroAction],
  ];
  return [...new Set(verbs.filter((verb): verb is CueVerb => verb !== undefined))];
}
