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

import { createHash } from 'node:crypto';

import { canonical } from '@/ir/worlddoc';
import { RUNTIME_VERSION } from '@/sim/interpreter';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import type { ArcadeWorld } from './arcade/contract';

import type { GameSpecV1 } from './spec';

/** Verze kompilátoru: zvednout, když stejný spec+seed dá jiný `WorldDoc`. */
export const GAME_COMPILER_VERSION = 'play-compiler-v3';

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
  readonly compilerVersion: string;
  /** Mřížkový svět (`src/sim`); `null` u arkádové hry, ta běží z `arcade`. */
  readonly blueprint: WorldstreamBlueprint | null;
  /** Arkádový svět (P25A), jen u her s `control` jiným než `tap_go`. */
  readonly arcade?: ArcadeWorld;
  /** `simHashOf(blueprint.world)`, u arkády `canonicalHash(arcade)` – identita hratelné instance. */
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
  /** Slovesa pravidel arkády (P29A) a zda je robot během běhu viděl vystřelit; jen hra s pravidly. */
  readonly verbs?: readonly VerbProof[];
  /**
   * Vítězný běh robota arkádové hry se skóre (P36B T1) – měřítko hvězd
   * (`src/play/score/stars.ts`). Chybí u mřížkové hry a u her publikovaných dřív.
   */
  readonly par?: { readonly score: number; readonly ticks: number };
}

/**
 * Jedno sloveso z pravidel: vystřelilo během robotova běhu, v kterém tiku
 * poprvé, a zda se po výstřelu opravdu něco změnilo (P30B T2) – čítač, tělo,
 * slot držení, poloha, výsledek. Dokázané je jen sloveso s `changed`.
 */
export interface VerbProof {
  readonly verb: string;
  readonly fired: boolean;
  readonly firstTick: number | null;
  readonly changed: boolean;
  /** Co se změnilo („score 0→1 at tick 57“); `null`, když nic. */
  readonly evidence: string | null;
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

/**
 * Veřejné id verze: prvních 128 bitů SHA-256 nad poli verze **a celým specem**.
 * 32-bitový `canonicalHash` sem nepatří – id, které jde trefit hrubou silou za
 * minuty (volný `seed`), by nechalo útočníka „zabrat“ adresu cizí hry ještě
 * před jejím autorem (nález bezpečnostní revize 20. 9. 2026). Spec jde do
 * hashe přímo, protože `specHash`/`worldHash` jsou samy 32-bitové.
 */
export function gameVersionId(fields: Omit<GameVersion, 'versionId' | 'createdAt' | 'title'>, spec: GameSpecV1): string {
  return createHash('sha256').update(canonical({ ...fields, spec })).digest('hex').slice(0, 32);
}

/** Jak režisér skončil. `draft` je okamžitá šablona ze slov, `authored` odpověď modelu. */
export type DirectorSource = 'draft' | 'authored' | 'cached';

/**
 * Proč režisér vrátil návrh ze slov místo odpovědi modelu. `VERB_UNPROVED`
 * (P29A T8) je jediný důvod i u `source: 'authored'`: pravidlo, které se ani po
 * opravě nedalo složit nebo které robot nevystřelil, ze hry vypadlo a hraje se
 * bez něj; `source: 'draft'` jen když ani hra bez pravidel neprošla.
 */
export type FallbackReason = 'MODEL_UNAVAILABLE' | 'MALFORMED' | 'UNREPAIRED' | 'VERB_UNPROVED';

/**
 * Režisér neselže: výpadek modelu, nečitelná odpověď i neopravitelný spec
 * skončí návrhem ze slov (`source: 'draft'`) s důvodem ve `fallbackReason`.
 */
export interface DirectorResult {
  readonly ok: true;
  readonly spec: GameSpecV1;
  readonly source: DirectorSource;
  readonly repairRounds: number;
  readonly fallbackReason: FallbackReason | null;
}

/** Věta po dohrání: čím se liší dítě od rodiče. Určuje, co se musí přepočítat. */
export type RemixClass = 'parameter' | 'mechanic' | 'presentation' | 'topology' | 'objective';
