/**
 * Typy k `codex-shim.mjs`. Skript běží holým Nodem bez build kroku; test je
 * TypeScript a potřebuje jeho kontrakt zapsaný.
 */
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';

export declare interface ShimOptions {
  readonly key: string;
  readonly model: string;
  readonly effort: string;
  /** Soubor denního počítadla spuštění. */
  readonly runsFile: string;
  readonly dailyRuns?: number;
  /** Co spustit místo codexu – testy sem dávají falešný příkaz. */
  readonly command?: { readonly file: string; readonly prefix: readonly string[] };
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export declare function createShim(options: ShimOptions): Server;

/** Zabije strom procesů codexu; na Windows jen dokud obal žije (`ship-pidreuse`). */
export declare function killTree(child: ChildProcess): void;
