/**
 * Hrdina z věty má na prvním snímku model (P30B T3).
 *
 * Mapa ztrát T1 (`evals/play/p30b/losses.json`) je baseline: slovní draft i
 * zmrazené AI specy (`live.json`) přes řetěz věrnosti na HEAD. Hrdina, kterého
 * baseline kreslil, kreslený zůstává, a kreslených hrdinů (draft + ai dohromady)
 * je aspoň o čtyři víc. Postava se do těla vepíše výškou, ne nejužší osou –
 * široký slon jinak stojí v třetinové výšce a na snímku není poznat.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fitScale } from '../arcade/models';
import { draftGameSpec } from '../draft';
import { fidelityChain, type ChecklistEntry } from '../fidelity/chain';
import type { GameSpecV1 } from '../spec';

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}
interface Row {
  readonly source: 'draft' | 'ai';
  readonly id: string;
  readonly item: string;
  readonly role: string;
  readonly drawn: boolean;
}

const read = <T,>(...path: string[]): T => JSON.parse(readFileSync(join(process.cwd(), ...path), 'utf8')) as T;

const sentences = [
  ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'corpus.json').sentences,
  ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'judge-10.json').sentences,
];
const live = new Map(read<{ sentences: { id: string; spec: GameSpecV1 }[] }>('evals', 'play', 'p30b', 'live.json').sentences.map((entry) => [entry.id, entry.spec]));
const baseline = read<{ rows: Row[] }>('evals', 'play', 'p30b', 'losses.json').rows.filter((row) => row.role === 'hero');

const key = (row: Pick<Row, 'source' | 'id' | 'item'>): string => `${row.source}|${row.id}|${row.item}`;

/** Hrdinové obou zdrojů na HEAD, klíčovaní jako řádky baseline. */
function heroesNow(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const sentence of sentences) {
    const sources: [Row['source'], GameSpecV1 | undefined][] = [
      ['draft', draftGameSpec(sentence.text)],
      ['ai', live.get(sentence.id)],
    ];
    for (const [source, spec] of sources) {
      if (spec === undefined) continue;
      for (const item of fidelityChain(spec, sentence.checklist)) {
        if (item.slot === 'hero') out.set(key({ source, id: sentence.id, item: item.item }), item.drawn);
      }
    }
  }
  return out;
}

describe('the hero from the sentence is drawn on the first frame', () => {
  const now = heroesNow();

  it('no hero the baseline drew is lost', () => {
    const lost = baseline.filter((row) => row.drawn && now.get(key(row)) !== true).map(key);
    expect(lost).toEqual([]);
  });

  it('the grid and the race draw the heroes the loss map found without a model', () => {
    for (const row of ['ai|h07|elephant', 'ai|j07|squirrel', 'ai|s056|scooter', 'draft|s056|scooter']) {
      expect(now.get(row), row).toBe(true);
    }
  });

  it('draws at least four more heroes than the baseline, draft and ai together', () => {
    const before = baseline.filter((row) => row.drawn).length;
    const after = baseline.filter((row) => now.get(key(row)) === true).length;
    expect(after).toBeGreaterThanOrEqual(before + 4);
  });
});

describe('a character stands at the height of its body', () => {
  const body = { x: 0.8, y: 1.6, z: 0.8 };

  it('a wide animal fills the body height instead of its narrowest axis', () => {
    const elephant = { x: 2, y: 1.5, z: 1 };
    expect(fitScale(elephant, body, true) * elephant.y).toBeCloseTo(body.y);
    // Věc zůstává vepsaná do kvádru – rekvizita nesmí přerůst své těleso.
    expect(fitScale(elephant, body, false) * elephant.x).toBeCloseTo(body.x);
  });

  it('a long, low character is capped so it does not stretch across the scene', () => {
    const snake = { x: 4, y: 0.3, z: 0.3 };
    expect(fitScale(snake, body, true) * snake.x).toBeLessThanOrEqual(1.5 * body.y + 1e-9);
  });
});
