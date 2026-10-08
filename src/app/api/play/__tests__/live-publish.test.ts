/**
 * Sdílení po živých změnách (P29D T10): `liveRemixSpec` přepíše změny běhu do
 * specu a klient ho publikuje dnešní remix route (`POST …/remix { spec }`).
 * Dítě nese víc hrozeb od startu a počasí v `theme`, rodič zůstává v
 * rodokmenu a sám se nemění. Nikam se nevolá – route běží v procesu.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import runner from '@/play/arcade/__fixtures__/runner.json';
import { type ArcadeRole, type ArcadeWorld, BODY, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type LivePatch, liveRemixSpec } from '@/play/arcade/live';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { resetConcurrency } from '@/server/paid-slots';
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

function worldOf(spec: GameSpecV1): ArcadeWorld {
  const built = arcadeWorldOf(spec, SEED);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Těla role na startu hry a počet jejich různých řad (`z`). */
function start(spec: GameSpecV1, role: ArcadeRole): { readonly bodies: number; readonly rows: number } {
  const state = worldOf(spec).initial;
  const zs = new Set<number>();
  let bodies = 0;
  for (let i = 0; i < state[HEADER.bodyCount]; i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] !== ROLE[role]) continue;
    bodies += 1;
    zs.add(state[base + BODY.z]);
  }
  return { bodies, rows: zs.size };
}

const countOf = (spec: GameSpecV1, id: string): number | undefined => spec.roles.find((role) => role.id === id)?.count;

const LIVE: readonly LivePatch[] = [
  { kind: 'spawn', role: 'obstacle', count: 3 },
  { kind: 'visual', weather: 'rain' },
  { kind: 'spawn', role: 'obstacle', count: 2 },
  { kind: 'visual', timeOfDay: 'night' },
];

describe('liveRemixSpec', () => {
  const world = worldOf(parentSpec);

  it('adds runner obstacles to the rows the game really starts with and writes weather into theme', () => {
    const { rows, bodies } = start(parentSpec, 'obstacle');
    // Řady, ne těla: řada nese víc překážek, a počet těl by řady nafoukl (revize fáze 2, nález 2).
    expect(bodies).toBeGreaterThan(rows);
    const { spec: child, dropped } = liveRemixSpec(parentSpec, world, LIVE);
    expect(countOf(child, 'obstacle')).toBe(rows + 5);
    expect(dropped).toBe(0);
    expect(child.roles.find((role) => role.id === 'coin')).toEqual(parentSpec.roles.find((role) => role.id === 'coin'));
    expect(child.theme).toEqual({ ...parentSpec.theme, weather: 'rain', timeOfDay: 'night' });
    expect(readGameSpec(child).ok).toBe(true);
    // Rodič se nemění – funkce pracuje na kopii.
    expect(parentSpec.theme).toEqual({ setting: 'sunny arcade track', mood: 'energetic' });
  });

  it('maps collectible to coin', () => {
    const few = { ...parentSpec, roles: parentSpec.roles.map((role) => (role.id === 'coin' ? { ...role, count: 5 } : role)) };
    const { spec: child, dropped } = liveRemixSpec(few, worldOf(few), [{ kind: 'spawn', role: 'collectible', count: 3 }]);
    expect(start(few, 'collectible').bodies).toBe(5);
    expect(countOf(child, 'coin')).toBe(8);
    expect(dropped).toBe(0);
  });

  it('never lowers a count (60 coins vs cap 50)', () => {
    expect(start(parentSpec, 'collectible').bodies).toBeGreaterThan(50);
    const { spec: child, dropped } = liveRemixSpec(parentSpec, world, [{ kind: 'spawn', role: 'collectible', count: 3 }]);
    expect(child).toEqual(parentSpec);
    expect(dropped).toBe(1);
  });

  it('keeps the spec count when it is already higher than the start, and caps at 50', () => {
    const many = { ...parentSpec, roles: parentSpec.roles.map((role) => (role.id === 'obstacle' ? { ...role, count: 45 } : role)) };
    expect(countOf(liveRemixSpec(many, world, [{ kind: 'spawn', role: 'obstacle', count: 3 }]).spec, 'obstacle')).toBe(48);
    expect(countOf(liveRemixSpec(many, world, [{ kind: 'spawn', role: 'obstacle', count: 5 }, { kind: 'spawn', role: 'obstacle', count: 9 }]).spec, 'obstacle')).toBe(50);
  });

  it('counts what stays in the run only: counters and bodies the generator does not count; clear weather by day is no change', () => {
    const { spec: child, dropped } = liveRemixSpec(parentSpec, world, [
      { kind: 'count', counter: 'health', amount: 1 },
      { kind: 'spawn', role: 'chaser', count: 3 },
      { kind: 'visual', weather: 'snow', timeOfDay: 'dusk' },
      { kind: 'visual', weather: 'clear', timeOfDay: 'day' },
    ]);
    expect(child).toEqual(parentSpec);
    expect(dropped).toBe(2);
    expect(liveRemixSpec(parentSpec, world, [])).toEqual({ spec: parentSpec, dropped: 0 });
  });
});

describe('POST /api/play/games/:id/remix { spec } after live changes', () => {
  it('publishes a child that starts with the live changes, and the parent stays in its lineage', async () => {
    const parentId = await publish(parentSpec);
    const parent = (await game(parentId)).spec as GameSpecV1;
    const child = liveRemixSpec(parent, worldOf(parent), LIVE).spec;

    const response = await remix(new Request(`http://play.test/api/play/games/${parentId}/remix`, { method: 'POST', headers: CALLER, body: JSON.stringify({ spec: child }) }), params(parentId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBeLessThan(300);
    const childId = ((await response.json()) as { versionId: string }).versionId;
    expect(childId).not.toBe(parentId);

    const shared = await game(childId);
    expect(shared.spec.theme).toMatchObject({ weather: 'rain', timeOfDay: 'night' });
    expect(shared.lineage.map((version: { versionId: string }) => version.versionId)).toContain(parentId);
    // Víc hrozeb od startu: dítě staví víc překážek než rodič při témž semínku.
    // Víc řad, než trať pojme, generátor nepostaví – proto „víc“, ne přesně +5.
    expect(start(shared.spec as GameSpecV1, 'obstacle').rows).toBeGreaterThan(start(parent, 'obstacle').rows);
    // Rodič je beze změny.
    expect((await game(parentId)).spec).toEqual(parent);
  });
});
