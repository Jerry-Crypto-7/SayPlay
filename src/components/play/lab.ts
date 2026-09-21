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
