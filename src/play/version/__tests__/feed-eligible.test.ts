/**
 * Kdo smí do feedu od P54A T10 (`docs/play/feed.md`): remix, který prošel
 * publikací a není skrytý, ano; hráčova hra bez rodiče ne; autorská (AI) verze
 * a kurátorská hra ano. Remix se stejným titulem svůj originál z feedu nevytlačí.
 */

import { describe, expect, it } from 'vitest';

import { feedEligible, feedPage, type RecentGame } from '@/play/version';
import { RUNTIME_VERSION } from '@/sim/interpreter';

const NONE: ReadonlySet<string> = new Set();
const id = (n: number): string => n.toString(16).padStart(32, '0');

let clock = 0;

/** Řádek seznamu; pozdější volání = novější hra. */
function row(n: number, fields: Partial<RecentGame>): RecentGame {
  clock += 1000;
  return {
    versionId: id(n),
    title: `Game ${String(n)}`,
    specHash: 'x',
    worldHash: 'x',
    seed: 1,
    schemaVersion: 'gamespec.v1',
    compilerVersion: 'c',
    runtimeVersion: RUNTIME_VERSION,
    parentId: null,
    createdAt: new Date(Date.UTC(2026, 9, 19) + clock).toISOString(),
    archetype: 'collect_exit',
    ...fields,
  };
}

const shownIds = (rows: readonly RecentGame[], hidden = NONE): string[] => feedPage(rows, 24, null, hidden).games.map((game) => game.versionId);

describe('feedEligible – remixes (P54A T10)', () => {
  const remix = { versionId: id(2), parentId: id(1) };

  it('a published remix gets in', () => {
    expect(feedEligible({ ...remix, publishEligible: true }, NONE)).toBe(true);
  });

  it('a hidden remix stays out', () => {
    expect(feedEligible({ ...remix, publishEligible: true }, new Set([remix.versionId]))).toBe(false);
  });

  it('a remix that failed the publish gate stays out', () => {
    expect(feedEligible({ ...remix, publishEligible: false }, NONE)).toBe(false);
  });

  it("a player's own game without a parent stays out", () => {
    expect(feedEligible({ versionId: id(3), parentId: null, publishEligible: true }, NONE)).toBe(false);
  });

  it('the AI version and a curated game get in', () => {
    expect(feedEligible({ versionId: id(4), parentId: id(5), relation: 'upgrade', publishEligible: true }, NONE)).toBe(true);
    expect(feedEligible({ versionId: id(6), parentId: null, curated: true, publishEligible: true }, NONE)).toBe(true);
  });
});

describe('remixes on a feed page (P54A T10)', () => {
  it('two remixes of one game are two cards next to the original', () => {
    const original = row(1, { curated: true, title: 'Hamster escape' });
    const harder = row(2, { parentId: original.versionId, title: 'Hamster escape – Lava' });
    const reskin = row(3, { parentId: original.versionId, title: 'Hamster escape – Space' });
    expect(new Set(shownIds([reskin, harder, original]))).toEqual(new Set([original.versionId, harder.versionId, reskin.versionId]));
  });

  it("a newer remix with its original's title does not push the original out", () => {
    const original = row(10, { curated: true, title: 'Hamster escape' });
    const harder = row(11, { parentId: original.versionId, title: 'Hamster  Escape!' });
    expect(shownIds([harder, original])).toEqual([original.versionId]);
  });

  it('a hidden original leaves its title to the remix', () => {
    const original = row(20, { curated: true, title: 'Cake carry' });
    const harder = row(21, { parentId: original.versionId, title: 'Cake carry' });
    expect(shownIds([harder, original], new Set([original.versionId]))).toEqual([harder.versionId]);
  });

  it("a player's game without a parent is not on the page, its remix is", () => {
    const own = row(30, { title: 'My own maze' });
    const remix = row(31, { parentId: own.versionId, title: 'My own maze – Ice' });
    expect(shownIds([remix, own])).toEqual([remix.versionId]);
  });
});
