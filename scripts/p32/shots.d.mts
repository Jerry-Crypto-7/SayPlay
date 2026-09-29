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
  desktopCpuThrottle?: number;
}

export type LoadCategory = 'html' | 'js' | 'api' | 'glb' | 'panorama' | 'rapier' | 'audio' | 'other';

export interface NetworkEntry {
  path: string;
  category: LoadCategory;
  resourceType: string;
  /** Od kliknutí na „Play it“; v `open.network` od začátku navigace. */
  startMs: number;
  endMs: number | null;
  bytes: number | null;
  failed: boolean;
}

export interface SentenceResult {
  id: string;
  /** `null` u položky se specem. */
  text: string | null;
  /** `spec`: hra publikovaná ze specu – bez kliknutí, jen studené otevření a telefon. */
  source: 'sentence' | 'spec';
  gamePath: string | null;
  timeToPlayableMs: number | null;
  timeToFirstFrameMs: number | null;
  inputTick: number | null;
  /** Která sonda dala `timeToPlayableMs`. */
  probe: 'arcade-stage' | 'grid-input-log' | null;
  /** Studené otevření odkazu hry, od začátku navigace; telefon jen první snímek. */
  open: { timeToPlayableMs: number | null; timeToFirstFrameMs: number | null; phoneFirstFrameMs: number | null; network: NetworkEntry[]; phoneNetwork: NetworkEntry[] };
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
export declare function loadSentences(file: string): ({ id: string; text: string } | { id: string; text: null; spec: object })[];
export declare function categoryOf(url: string, resourceType: string): LoadCategory;
export declare function shoot(options: ShotsOptions, io?: { log?: (line: string) => void }): Promise<ShotsResult>;
