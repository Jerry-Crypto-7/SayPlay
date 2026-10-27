/**
 * Typy k `audit.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

import type { GameSpecV1 } from '../../../src/play/spec';

export type Match = 'own' | 'modifier' | 'substitute' | 'none';
export type Via = 'kin' | 'category' | 'nearest' | 'near-word' | 'default';

/** Role z věty (nebo ze zápisu sady) a model, který ji kreslí. */
export interface Thing {
  readonly label: string;
  readonly noun: string;
  readonly fromSentence: boolean;
  readonly model: string | null;
  readonly level?: 'identity' | 'near' | 'class' | 'fallback';
  readonly match: Match;
  readonly via?: Via;
  readonly role?: string;
}

export interface Scenery {
  readonly rows: number;
  readonly inside: number;
  readonly edge: number;
  readonly landmark: number;
  readonly framing: number;
  readonly ring: number;
  readonly edgeTotal: number;
  readonly decorBits?: number;
}

export interface AuditRow {
  readonly genre: string | null;
  readonly control: string | null;
  readonly scene: string;
  readonly variant?: 'agar' | 'styled';
  readonly themeLook: string | null;
  readonly look: string;
  readonly interior: boolean;
  readonly floor: { readonly kind: string; readonly indoor: boolean };
  readonly walls: boolean;
  readonly ceiling: boolean;
  readonly foe: Thing | null;
  readonly item: Thing | null;
  readonly obstacle: Thing | null;
  readonly scenery: Scenery | null;
  readonly compileIssues?: readonly string[];
  readonly id?: string;
  readonly chain?: boolean;
  readonly annotated?: { readonly foe: readonly Thing[]; readonly item: readonly Thing[]; readonly scenery: readonly Thing[] };
}

export interface RoleCounts {
  readonly named: number;
  readonly own: number;
  readonly modifier: number;
  readonly substitute: number;
  readonly none: number;
  readonly via: Readonly<Record<string, number>>;
  readonly genreDefault: number;
}

export interface Summary {
  readonly games: number;
  readonly chains: number;
  readonly foe: RoleCounts;
  readonly item: RoleCounts;
  readonly obstacle: RoleCounts;
  readonly interiors: number;
  readonly interiorsWithoutFloor: number;
  readonly interiorsWithoutWalls: number;
  readonly sceneryModelled: number;
  readonly emptyPlayArea: number;
  readonly sceneryInside: number;
  readonly sceneryEdge: number;
  readonly [key: string]: unknown;
}

export interface MissingNoun {
  readonly noun: string;
  readonly tier: 'foe' | 'item' | 'scenery';
  readonly sentences: number;
  readonly from: readonly string[];
  readonly drawnAs: Readonly<Record<string, number>>;
  readonly examples: readonly string[];
}

export const INTERIOR_LOOKS: ReadonlySet<string>;
export function namesOfModel(model: string): Set<string>;
export function classify(label: string | null, model: string | null | undefined, level?: string, sentence?: string): Thing | null;
export function annotatedNouns(source: Record<string, unknown>): { foe: string[]; item: string[]; scenery: string[] };
export function annotate(nouns: { foe: readonly string[]; item: readonly string[]; scenery: readonly string[] }): { foe: Thing[]; item: Thing[]; scenery: Thing[] };
export function auditSpec(spec: GameSpecV1, options: { readonly seed: number; readonly sentence?: string }): AuditRow;
export function summarize(rows: readonly AuditRow[]): Summary;
export function missingNouns(rows: readonly AuditRow[], notNouns: ReadonlySet<string>): MissingNoun[];
export function auditSets(): string[];
export function quickGame(sentence: string): { spec: GameSpecV1; seed: number; chain: boolean; rounds?: number };
