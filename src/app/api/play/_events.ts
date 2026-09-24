/**
 * Kam jdou události smyčky (P27D T4). Pod `next start` řádek JSON do
 * `data/play/events/<den>.jsonl` (nebo `PLAY_EVENTS_DIR`), na Vercelu řádek do
 * logu funkce – obojí čte `scripts/play-loop-report.mjs`. Zápis, který selže,
 * hru nezdrží: událost je statistika, ne stav.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { LoopEvent } from '@/play/loop-events';

export const LOOP_LOG_PREFIX = '[play-loop] ';

export function recordLoopEvent(event: LoopEvent, env: Record<string, string | undefined> = process.env, now: () => Date = () => new Date()): void {
  const at = now();
  const line = JSON.stringify({ ...event, at: at.toISOString() });
  if (env.VERCEL !== undefined) {
    console.log(`${LOOP_LOG_PREFIX}${line}`);
    return;
  }
  // Testy zapisují jen do složky, kterou samy určí (jako záznamy selhání v `_upgrade.ts`).
  if (env.VITEST !== undefined && env.PLAY_EVENTS_DIR === undefined) return;
  const dir = env.PLAY_EVENTS_DIR ?? join(process.cwd(), 'data', 'play', 'events');
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
  } catch (thrown) {
    console.warn(`[play] loop event not written: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
}
