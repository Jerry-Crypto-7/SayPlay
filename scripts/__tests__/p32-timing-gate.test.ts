/**
 * Brána času do ovladatelné hry (P32D T7, oracle bod 4 specu
 * `docs/specs/2026-09-29-play-vzhled-a-zanry.md`): na čistém Chromu je každá
 * věta offline sady ovladatelná ≤ 3 s od kliknutí.
 *
 * Čte uložený běh harnessu `evals/play/p32/runs/after-d/result.json` – číslo,
 * které by se jinak při dalším přeměření tiše rozlezlo. Chybějící čas nebo
 * chyba věty neprojde: bez sondy vstupu se ovladatelnost nedá tvrdit.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ShotsResult } from '../p32/shots.mjs';

const LIMIT_MS = 3000;
const SENTENCES = 9;

const run = JSON.parse(readFileSync(new URL('../../evals/play/p32/runs/after-d/result.json', import.meta.url), 'utf8')) as ShotsResult;

describe('time to playable after P32D', () => {
  it('is an offline run of the 9-sentence set on a clean desktop', () => {
    expect(run).toMatchObject({ schema: 'p32-shots/1', live: false, settings: { desktopCpuThrottling: 1 } });
    expect(run.sentences).toHaveLength(SENTENCES);
  });

  it.each(run.sentences.map((sentence) => [sentence.id, sentence] as const))('%s is playable within 3 s of the click', (_id, sentence) => {
    expect(sentence.error).toBeNull();
    expect(sentence.probe).not.toBeNull();
    expect(sentence.timeToPlayableMs).not.toBeNull();
    expect(sentence.timeToPlayableMs).toBeLessThanOrEqual(LIMIT_MS);
  });
});
