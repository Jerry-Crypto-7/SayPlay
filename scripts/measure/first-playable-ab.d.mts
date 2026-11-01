/** Typy k `first-playable-ab.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export type Side = 'A' | 'B';
export type TargetKind = 'sentence' | 'shared';

export interface AbTarget {
  kind: TargetKind;
  key: string;
  sentence: string;
}

export interface AbJob {
  run: number;
  profile: string;
  target: AbTarget;
  side: Side;
  pair: number;
}

export interface AbResult {
  profile: string;
  kind: TargetKind;
  target: string;
  side: Side;
  run: number;
  pair: number;
  playable: boolean;
  ms: number | null;
  firstFrameMs?: number | null;
  note: string | null;
  har: string | null;
}

export interface Stats {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface SideStats extends Stats {
  failed: number;
}

export interface ProfileComparison {
  profile: string;
  A: SideStats;
  B: SideStats;
  diffMedian: number | null;
  pairedDiffMedian: number | null;
}

export interface Comparison extends ProfileComparison {
  kind: TargetKind;
}

export interface GateCheck {
  name: 'failedTotal' | 'medianB' | 'pairedDiffMedian';
  /** `null` u `failedTotal` – počítá se přes všechny profily. */
  profile: string | null;
  value: number | null;
  limit: number;
  pass: boolean;
}

export interface AbGate {
  failedTotal: number;
  failed: Record<Side, number>;
  checks: GateCheck[];
  pass: boolean;
}

export declare const GATE: { medianBMaxMs: number; medianBProfiles: string[]; pairedDiffMaxMs: number; pairedDiffProfiles: string[] };
export declare function gate(results: AbResult[]): AbGate;
export declare const MIN_PAUSE_MS: number;
export declare const PROFILES: Record<string, { viewport?: { width: number; height: number }; device?: string; cpuThrottle?: number }>;
export declare function schedule(input: { targets: AbTarget[]; runs: number; profiles: string[] }): AbJob[];
export declare function stats(values: number[]): Stats;
export declare function summarize(
  results: AbResult[],
  metric?: 'ms' | 'firstFrameMs',
): { byTarget: (Comparison & { target: string })[]; byKind: Comparison[]; byProfile: ProfileComparison[] };
