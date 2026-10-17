/** Typy k `director-burst.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare function envFilesIn(root: string): string[];

export declare function startServer(options: {
  port: number;
  upstream: string;
  slots: number;
  queue?: number;
  root?: string;
}): Promise<{ base: string; log: string[]; stop: () => Promise<void> }>;
