/**
 * Fakta panelu „How this game works“ (P23-C T8), počítaná **na serveru**.
 *
 * Vysvětlení mechanik bydlí v registru (`MECHANICS[id].explanation`) a registr
 * táhne zod; do klientského bundlu proto nejde registr, ale hotové věty
 * odsud. Tenhle modul importuje jen serverová stránka `/play/[id]`.
 */

import type { QualityReport } from '@/play/contracts';
import { MECHANICS, type MechanicId } from '@/play/registry';
import type { GameSpecV1 } from '@/play/spec';
import type { PublishedGame } from '@/play/version';

/**
 * Kdo hru navrhl. `draft` = okamžitý návrh ze slov (bez modelu), `ai` = model
 * (vylepšení návrhu, nebo rovnou režisér), `remix` = změna čipem nad cizí hrou.
 * Návrh se nikdy nesmí vydávat za `ai` – panel by lhal porotci přesně tam,
 * kde se ptá, co udělala AI.
 */
export type Authorship = 'ai' | 'draft' | 'remix';

export function authorshipOf(game: Pick<PublishedGame, 'origin' | 'sentence' | 'relation'>): Authorship {
  if (game.origin !== undefined) return 'draft';
  if (game.relation === 'upgrade' || game.sentence !== undefined) return 'ai';
  return 'remix';
}

/** Co se z věty stalo – panel „From your sentence“. */
export interface ReadFacts {
  readonly authorship: Authorship;
  /** Kdo větu návrhu přečetl (P29B T6): lokální model, nebo klíčová slova. */
  readonly readBy: 'model' | 'keywords';
  readonly sentence: string | null;
  readonly game: string;
  readonly world: string;
  readonly you: string | null;
  readonly against: readonly string[];
  readonly goal: string;
  readonly rules: readonly string[];
}

const CONTROL_NAME: Readonly<Record<string, string>> = {
  runner: 'Runner',
  platform: 'Platformer',
  flap: 'Flying',
  steer: 'Racing',
  move_free: 'Arena',
  shooter: 'Shooter',
  throw: 'Throwing',
  timing: 'Timing',
  rhythm: 'Rhythm',
  duel: 'Duel',
};

const OPPONENT_KINDS: ReadonlySet<string> = new Set(['hazard', 'chaser', 'patrol']);

const words = (id: string): string => id.replaceAll('_', ' ');

export function readFacts(spec: GameSpecV1, authorship: Authorship, sentence: string | null, readBy: ReadFacts['readBy'] = 'keywords'): ReadFacts {
  const control = spec.control === undefined || spec.control === 'tap_go' ? null : spec.control;
  const game = control === null ? words(spec.archetype) : (CONTROL_NAME[control] ?? words(control));
  return {
    authorship,
    readBy,
    sentence,
    game: game.charAt(0).toUpperCase() + game.slice(1),
    world: `${spec.theme.setting} · ${spec.theme.mood}`,
    you: spec.roles.find((role) => role.kind === 'player')?.label ?? null,
    against: [...new Set(spec.roles.filter((role) => OPPONENT_KINDS.has(role.kind)).map((role) => role.label))],
    goal: spec.objective.description,
    rules: spec.mechanics.map((mechanic) => words(mechanic.id)),
  };
}

export interface LabMechanic {
  readonly id: string;
  readonly name: string;
  readonly explanation: string;
  readonly params: readonly (readonly [string, string])[];
}

export interface LabFacts {
  readonly mechanics: readonly LabMechanic[];
  readonly rulesChecked: string;
  readonly winnable: string;
  readonly replay: string;
}

function paramText(value: unknown): string {
  if (Array.isArray(value)) return value.map(paramText).join(', ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([key, inner]) => `${key} ${paramText(inner)}`).join(', ');
  }
  return String(value);
}

export function labFacts(spec: GameSpecV1, report: QualityReport & { readonly stub?: boolean }): LabFacts {
  const passed = report.keypoints.filter((keypoint) => keypoint.passed).length;
  return {
    mechanics: spec.mechanics.map((mechanic) => ({
      id: mechanic.id,
      name: mechanic.id.replaceAll('_', ' '),
      explanation: MECHANICS[mechanic.id as MechanicId].explanation,
      params: Object.entries(mechanic.params).map(([key, value]) => [key.replaceAll('_', ' '), paramText(value)] as const),
    })),
    rulesChecked: `Rules checked: ${passed}/${report.keypoints.length}`,
    winnable: report.witness.certified && report.witness.winsAtTick !== null ? `Winnable at tick ${report.witness.winsAtTick}` : 'Not proven',
    replay: report.stub === true ? 'Replay: stub' : report.replayEqual ? 'Replay: identical' : 'Replay: differs',
  };
}
