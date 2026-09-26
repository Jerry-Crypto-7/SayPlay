/**
 * Sdílení po živých změnách (P29D T10): `liveRemixSpec` přepíše změny běhu do
 * specu a klient ho publikuje dnešní remix route (`POST …/remix { spec }`).
 * Dítě nese víc hrozeb od startu a počasí v `theme`, rodič zůstává v
 * rodokmenu a sám se nemění. Nikam se nevolá – route běží v procesu.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import runner from '@/play/arcade/__fixtures__/runner.json';
import { type ArcadeRole, BODY, FLAG, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type LivePatch, liveRemixSpec } from '@/play/arcade/live';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { resetConcurrency } from '../../worldstream/sessions/route';
import { GET as readGame } from '../games/[id]/route';
import { POST as remix } from '../games/[id]/remix/route';
import { POST as createGame } from '../games/route';

const CALLER = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' };
const SEED = 7;
// Uložený spec prošel `readGameSpec`, takže `count` role je vyplněný výchozí 1.
const read = readGameSpec(runner);
if (!read.ok) throw new Error(read.issues.join('; '));
const parentSpec: GameSpecV1 = read.value;

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  resetConcurrency();
});

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function publish(spec: unknown): Promise<string> {
  const response = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: CALLER, body: JSON.stringify({ spec }) }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBeLessThan(300);
  return ((await response.json()) as { versionId: string }).versionId;
}

async function game(id: string): Promise<Record<string, any>> {
  return (await readGame(new Request(`http://play.test/api/play/games/${id}`), params(id))).json();
}

function startCount(spec: GameSpecV1): (role: ArcadeRole) => number {
  const built = arcadeWorldOf(spec, SEED);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = built.world.initial;
  return (role) => {
    let alive = 0;
    for (let i = 0; i < state[HEADER.bodyCount]; i += 1) {
      const base = bodyBase(i);
      if (state[base + BODY.role] === ROLE[role] && (state[base + BODY.flags] & FLAG.alive) !== 0) alive += 1;
    }
    return alive;
  };
}

const LIVE: readonly LivePatch[] = [
  { kind: 'spawn', role: 'obstacle', count: 3 },
  { kind: 'visual', weather: 'rain' },
  { kind: 'spawn', role: 'obstacle', count: 2 },
  { kind: 'visual', timeOfDay: 'night' },
];

describe('liveRemixSpec', () => {
  it('raises the role count from what the game really starts with and writes weather into theme', () => {
    const child = liveRemixSpec(parentSpec, LIVE, () => 12);
    expect(child.roles.find((role) => role.id === 'obstacle')?.count).toBe(17);
    expect(child.roles.find((role) => role.id === 'coin')).toEqual(parentSpec.roles.find((role) => role.id === 'coin'));
    expect(child.theme).toEqual({ ...parentSpec.theme, weather: 'rain', timeOfDay: 'night' });
    expect(readGameSpec(child).ok).toBe(true);
    // Rodič se nemění – funkce pracuje na kopii.
    expect(parentSpec.theme).toEqual({ setting: 'sunny arcade track', mood: 'energetic' });
  });

  it('keeps the spec count when it is already higher than the start, and caps at 50', () => {
    const many = { ...parentSpec, roles: parentSpec.roles.map((role) => (role.id === 'obstacle' ? { ...role, count: 40 } : role)) };
    expect(liveRemixSpec(many, [{ kind: 'spawn', role: 'obstacle', count: 3 }], () => 5).roles.find((role) => role.id === 'obstacle')?.count).toBe(43);
    expect(liveRemixSpec(many, [{ kind: 'spawn', role: 'obstacle', count: 5 }, { kind: 'spawn', role: 'obstacle', count: 9 }], () => 5).roles.find((role) => role.id === 'obstacle')?.count).toBe(50);
  });

  it('leaves out what belongs to the run only: counters, roles the spec lacks, clear weather by day', () => {
    const child = liveRemixSpec(
      parentSpec,
      [
        { kind: 'count', counter: 'health', amount: 1 },
        { kind: 'spawn', role: 'enemy', count: 3 },
        { kind: 'visual', weather: 'snow', timeOfDay: 'dusk' },
        { kind: 'visual', weather: 'clear', timeOfDay: 'day' },
      ],
      () => 4,
    );
    expect(child).toEqual(parentSpec);
    expect(liveRemixSpec(parentSpec, [], () => 4)).toEqual(parentSpec);
  });
});

describe('POST /api/play/games/:id/remix { spec } after live changes', () => {
  it('publishes a child that starts with the live changes, and the parent stays in its lineage', async () => {
    const parentId = await publish(parentSpec);
    const parent = (await game(parentId)).spec as GameSpecV1;
    const child = liveRemixSpec(parent, LIVE, startCount(parent));

    const response = await remix(new Request(`http://play.test/api/play/games/${parentId}/remix`, { method: 'POST', headers: CALLER, body: JSON.stringify({ spec: child }) }), params(parentId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBeLessThan(300);
    const childId = ((await response.json()) as { versionId: string }).versionId;
    expect(childId).not.toBe(parentId);

    const shared = await game(childId);
    expect(shared.spec.theme).toMatchObject({ weather: 'rain', timeOfDay: 'night' });
    expect(shared.lineage.map((version: { versionId: string }) => version.versionId)).toContain(parentId);
    // Víc hrozeb od startu: dítě staví víc překážek než rodič při témž semínku.
    expect(startCount(shared.spec as GameSpecV1)('obstacle')).toBeGreaterThan(startCount(parent)('obstacle'));
    // Rodič je beze změny.
    expect((await game(parentId)).spec).toEqual(parent);
  });
});
