/** Typy k `quest-dev.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare const PORT: number;
export declare const GAME_URL: string;

export declare function findAdb(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): { adb: string } | { error: string };

export declare function parseDevices(stdout: string): { serial: string } | { error: string };

export declare function openGameArgs(serial: string): string[];

export declare function parseVrApiFps(line: string): number | null;

export declare function summarizeFps(
  samples: readonly number[],
): { median: number; p5: number; samples: number } | null;
