/** Typy k `quest-dev.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare const PORT: number;
export declare const CDP_PORT: number;
export declare const GAME_URL: string;
export declare function gameUrl(port?: number, path?: string): string;

export declare function parseCli(
  argv: string[],
): { port: number; fps: number | null; cdp: boolean; probe: boolean } | { error: string };

export declare function parseResumedActivity(stdout: string): string | null;

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
