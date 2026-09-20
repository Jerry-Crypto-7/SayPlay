/**
 * Kontrakty mezi třemi vrstvami PLAY (P23), aby se daly stavět odděleně:
 *
 * - **Režisér** (`src/play/director`, P23-B): věta → `GameSpecV1`.
 * - **Kompilátor a verifikátor** (`src/play/compile`, `src/play/verify`, P23-A):
 *   `GameSpecV1` + seed → `CompiledGame` s `WorldstreamBlueprint`; keypointy.
 * - **Obálka, publikace, remix** (`src/app/play`, `src/play/version`, P23-C):
 *   hraje `CompiledGame`, zapečeťuje `GameVersion`, remixuje `GameSpecV1`.
 *
 * Tenhle soubor nese jen **typy a hashe** – žádnou implementaci. Kdo potřebuje
 * dvojníka jiné vrstvy, píše ho u sebe (`__fixtures__`), ne sem.
 */

import { RUNTIME_VERSION } from '@/sim/interpreter';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { canonicalHash } from '@/ir/worlddoc';

import type { GameSpecV1 } from './spec';

/** Verze kompilátoru: zvednout, když stejný spec+seed dá jiný `WorldDoc`. */
export const GAME_COMPILER_VERSION = 'play-compiler-v1';

/** Které pravidlo a entita ve `WorldDoc` patří které mechanice a roli. Verifikátor a panel „Why“ to čtou. */
export interface MechanicBinding {
  readonly mechanicId: string;
  readonly ruleIds: readonly string[];
  readonly entityIds: readonly string[];
  readonly slotIds: readonly string[];
}

export interface RoleBinding {
  readonly roleId: string;
  readonly entityIds: readonly string[];
  /** Zóna nebo soket, pokud role stojí na místě. */
  readonly zones: readonly string[];
  readonly sockets: readonly string[];
}

export interface CompiledGame {
  readonly spec: GameSpecV1;
  readonly specHash: string;
  readonly seed: number;
  readonly compilerVersion: typeof GAME_COMPILER_VERSION;
  readonly blueprint: WorldstreamBlueprint;
  /** `simHashOf(blueprint.world)` – identita hratelné instance. */
  readonly worldHash: string;
  readonly mechanics: readonly MechanicBinding[];
  readonly roles: readonly RoleBinding[];
  /** Kolik tiků svědek potřebuje k výhře (z certifikace); `null`, když se hledání vyčerpalo. */
  readonly winsAtTick: number | null;
}

export type CompileGameReason =
  /** Spec neprošel `readGameSpec`. */
  | 'SPEC_REJECTED'
  /** Mechanika bez kompilačního adaptéru – registr ji zná, kompilátor ještě ne. */
  | 'MECHANIC_UNSUPPORTED'
  /** Rozvržení se nepodařilo bez kolizí umístit na mřížku. */
  | 'LAYOUT_FAILED'
  /** `buildRuntimeWorld` nebo `validateBlueprint` odmítly výsledek. */
  | 'WORLD_REJECTED'
  /** Svědek se nenašel nebo nedošel do výhry. */
  | 'UNWINNABLE';

export type CompileGameResult =
  | { readonly ok: true; readonly value: CompiledGame }
  | { readonly ok: false; readonly reason: CompileGameReason; readonly issues: readonly string[] };

export type GameCompiler = (spec: GameSpecV1, seed: number) => CompileGameResult;

/** Jeden důkaz keypointu – co se vstříklo, co se hrálo, co platí. */
export interface KeypointEvidence {
  readonly assertionId: string;
  readonly mechanicId: string | null;
  readonly passed: boolean;
  readonly hashBefore: string;
  readonly hashAfter: string;
  readonly ticks: number;
  readonly failures: readonly string[];
}

export interface QualityReport {
  readonly specHash: string;
  readonly worldHash: string;
  readonly keypoints: readonly KeypointEvidence[];
  readonly witness: { readonly certified: boolean; readonly winsAtTick: number | null };
  readonly replayEqual: boolean;
  readonly budgets: { readonly entities: number; readonly rules: number; readonly triangles: number | null };
  readonly publishEligible: boolean;
}

/** Neměnná publikovaná verze. `versionId` je hash všeho, na čem hra stojí. */
export interface GameVersion {
  readonly versionId: string;
  readonly title: string;
  readonly specHash: string;
  readonly worldHash: string;
  readonly seed: number;
  readonly schemaVersion: 'gamespec.v1';
  readonly compilerVersion: string;
  readonly runtimeVersion: typeof RUNTIME_VERSION;
  readonly parentId: string | null;
  readonly createdAt: string;
}

export function gameVersionId(fields: Omit<GameVersion, 'versionId' | 'createdAt' | 'title'>): string {
  return canonicalHash(fields);
}

/** Jak režisér skončil. `draft` je okamžitá šablona ze slov, `authored` odpověď modelu. */
export type DirectorSource = 'draft' | 'authored' | 'cached';

export type DirectorResult =
  | { readonly ok: true; readonly spec: GameSpecV1; readonly source: DirectorSource; readonly repairRounds: number }
  | { readonly ok: false; readonly reason: 'MODEL_UNAVAILABLE' | 'SPEC_REJECTED' | 'REPAIR_EXHAUSTED'; readonly issues: readonly string[] };

/** Věta po dohrání: čím se liší dítě od rodiče. Určuje, co se musí přepočítat. */
export type RemixClass = 'parameter' | 'mechanic' | 'presentation' | 'topology' | 'objective';
