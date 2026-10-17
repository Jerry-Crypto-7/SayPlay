/** Typy k `time-to-playable.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export interface ProbeConfig {
  url: string;
  promptSelector?: string;
  submitSelector?: string;
  sentence?: string;
  waitForUrl?: string;
  surfaceSelector?: string;
  timeoutMs?: number;
  harPath?: string;
  harContent?: 'omit' | 'embed' | 'attach';
  screenshotDir?: string;
  gpu?: boolean;
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export interface ProbeResult {
  url: string;
  sentence: string | null;
  t0: number;
  tPlayable: number | null;
  ms: number | null;
  playable: boolean;
  note: string | null;
  attempts: number;
  inputChangePct: number | null;
  confirmChangePct: number | null;
  idleAfterPct: number | null;
  renderer: 'gpu' | 'software';
  gameUrl: string | null;
}

export declare const CHANGE_PCT: number;
export declare const REACT_MS: number;
export declare function changedPct(before: Buffer, after: Buffer): Promise<number | null>;
export declare function measure(config: ProbeConfig): Promise<ProbeResult>;
