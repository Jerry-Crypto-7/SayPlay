/** Typy k `quest-dev.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare const PORT: number;
export declare const CDP_PORT: number;
export declare const GAME_URL: string;
export declare function gameUrl(port?: number, path?: string): string;

export declare const SHOTS_DIR: string;
export declare const FPS_GATE: { readonly median: number; readonly p5: number };
export declare const NOT_MEASURED: string;

export declare function parseCli(
  argv: string[],
): { port: number; fps: number | null; cdp: boolean; probe: boolean; tour: number | null; shots: string } | { error: string };

export declare function parseResumedActivity(stdout: string): string | null;

export declare function parseWakefulness(stdout: string): string | null;

export declare function publishArgs(port: number): string[];

export declare function parseGames(stdout: string): { id: string; kind: string; url: string }[];

export declare function screencapArgs(serial: string): string[];

export interface TourRow {
  id: string;
  kind: string | null;
  url: string;
  enterVr: string;
  fps: number[];
  median: number | null;
  p5: number | null;
  samples: number;
  runState: string | null;
  screenshot: string | null;
}

export declare function tourRow(row: {
  id: string;
  kind: string | null;
  url: string;
  enterVr: string;
  fps: readonly number[];
  runState: string | null;
  screenshot: string | null;
}): TourRow;

export declare function fpsReport(measured: {
  measuredAt: string;
  port: number;
  seconds: number;
  tour: boolean;
  genres: TourRow[];
}): { connected: true; measuredAt: string; base: string; seconds: number; tour: boolean; gate: { median: number; p5: number }; genres: TourRow[] };

export declare function notMeasured(why: {
  checkedAt: string;
  reason: string;
  serial?: string | null;
  wakefulness?: string | null;
  foreground?: string | null;
}): { connected: false; note: string; checkedAt: string; reason: string; serial: string | null; wakefulness: string | null; foreground: string | null };

export declare function belowGate(
  genres: ReadonlyArray<{ id: string; median: number | null; p5: number | null; samples: number }>,
  gate?: { median: number; p5: number },
): string[];

export declare const TOUR_PLAY: string;
export declare const TOUR_STOP: string;

export declare function cdpForwardArgs(serial: string, cdpPort?: number): string[];

export declare function pickPage(
  targets: ReadonlyArray<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>,
  port: number,
): { url: string; webSocketDebuggerUrl: string } | null;

export interface CdpConnection {
  send(method: string, params?: object): Promise<unknown>;
  close(): void;
}

export declare function cdpConnect(wsUrl: string, options?: { WebSocketImpl?: unknown; timeoutMs?: number }): Promise<CdpConnection>;

export declare function cdpEvaluate(cdp: Pick<CdpConnection, 'send'>, expression: string, options?: { userGesture?: boolean }): Promise<unknown>;

export declare const PROBE_PAGE: string;
export declare const PROBE_HOOK: string;
export declare const ENTER_VR_RECT: string;
export declare const PROBE_SESSION: string;

export declare function findAdb(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): { adb: string } | { error: string };

export declare function parseDevices(stdout: string): { serial: string } | { error: string };

export declare function openGameArgs(serial: string, url?: string): string[];

export declare function parseVrApiFps(line: string): number | null;

export declare function summarizeFps(
  samples: readonly number[],
): { median: number; p5: number; samples: number } | null;
