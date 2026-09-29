/** Typy k `shots.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export interface ShotsOptions {
  base: string;
  set: string;
  out: string;
  live: boolean;
  limit: number | null;
  fpsSeconds: number;
  playableTimeoutMs: number;
  /** CDP zpomalení CPU desktopové fáze; 1 = bez zátěže. */
  desktopCpuThrottle: number;
}

export type LoadCategory = 'html' | 'js' | 'api' | 'glb' | 'panorama' | 'rapier' | 'audio' | 'other';

export interface NetworkEntry {
  path: string;
  category: LoadCategory;
  resourceType: string;
  /** Od kliknutí na „Play it“. */
  startMs: number;
  endMs: number | null;
  bytes: number | null;
  failed: boolean;
}

export interface SentenceResult {
  id: string;
  text: string;
  gamePath: string | null;
  timeToPlayableMs: number | null;
  timeToFirstFrameMs: number | null;
  inputTick: number | null;
  /** Která sonda dala `timeToPlayableMs`. */
  probe: 'arcade-stage' | 'grid-input-log' | null;
  fpsMedian: number | null;
  fpsSamples: number[];
  shots: { draftDesktop: string | null; draftPhone: string | null; aiDesktop: string | null; aiPhone: string | null };
  ai: { status: 'ready' | 'final' | 'lost' | 'timeout' | 'absent'; gamePath: string | null } | null;
  network: NetworkEntry[];
  error: string | null;
}

export interface ShotsResult {
  schema: 'p32-shots/1';
  label: string;
  base: string;
  set: string;
  live: boolean;
  startedAt: string;
  finishedAt: string;
  settings: { desktop: string; desktopCpuThrottling: number; phone: string; cpuThrottling: number; fpsSeconds: number; renderer: string };
  sentences: SentenceResult[];
}

export declare const USAGE: string;
export declare function parseArgs(argv: readonly string[]): ShotsOptions;
export declare function loadSentences(file: string): { id: string; text: string }[];
export declare function categoryOf(url: string, resourceType: string): LoadCategory;
export declare function shoot(options: ShotsOptions, io?: { log?: (line: string) => void }): Promise<ShotsResult>;
