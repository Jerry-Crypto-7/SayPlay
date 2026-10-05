/**
 * Knihovna terénu pro ostatní stopy (P32A T9): ostrůvky plošinovky, podlaha arény
 * a voda. Ostrůvek o 20 cm níž vypadá dobře, ale hrdina na něm visí ve vzduchu –
 * proto se měří síť, kterou scéna kreslí (paprsek shora), proti deskám jádra
 * ze skutečně přeložené úrovně, ne proti funkci, ze které ostrůvek vznikl.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { type BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, ShaderLib, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/platform.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { COVERS, LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';
import { readGameSpec } from '@/play/spec';

import { playableGround } from '../look/rig/terrain';
import { arenaPalette, buildArenaFloor } from '../look/rig/terrain/arenaFloor';
import { buildIslands, islandPalette, platformIslands, platformSlabKeys } from '../look/rig/terrain/islands';
import { OPEN_SEA, WAVE_HEIGHT, buildWater, waterPalette } from '../look/rig/terrain/water';

const rng = xoroshiro128plus(3209);
const between = (from: number, to: number): number => from + uniformFloat64(rng) * (to - from);

const ray = new Raycaster();
const down = new Vector3(0, -1, 0);

/** Výška nakreslené sítě pod bodem scény (m), `null` = paprsek nic netrefil. */
function drawnAt(geometry: BufferGeometry, x: number, z: number): number | null {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  mesh.updateMatrixWorld(true);
  ray.set(new Vector3(x, 500, z), down);
  return ray.intersectObject(mesh, false)[0]?.point.y ?? null;
}

/** Flat shading: všechny tři vrcholy trojúhelníku mají tutéž normálu. */
function expectFlat(geometry: BufferGeometry): void {
  expect(geometry.index).toBeNull();
  const normal = geometry.getAttribute('normal');
  for (let face = 0; face < normal.count; face += 97 * 3) {
    for (const k of [1, 2]) {
      expect(normal.getX(face)).toBeCloseTo(normal.getX(face + k), 6);
      expect(normal.getY(face)).toBeCloseTo(normal.getY(face + k), 6);
    }
  }
  expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
}

function expectNoPurple(id: string, colors: Readonly<Record<string, string>>): void {
  for (const hex of Object.values(colors)) {
    const { h, s } = new Color(hex).getHSL({ h: 0, s: 0, l: 0 });
    if (s > 0.05) expect(h * 360 < 250 || h * 360 > 320, `${id} ${hex}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Ostrůvky

/** Tři vzorové úrovně plošinovky: každá obtížnost, jedna s pohyblivými plošinami. */
const LEVELS = [
  { seed: 11, params: { difficulty: 'easy', lengthM: 90 } },
  { seed: 12, params: { difficulty: 'normal', lengthM: 160, movingPlatforms: true } },
  { seed: 13, params: { difficulty: 'hard', lengthM: 220 } },
] as const;

function levelOf(seed: number, params: Record<string, unknown>): ArcadeWorld {
  const spec = readGameSpec({ ...fixture, controlParams: { ...fixture.controlParams, ...params } });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, seed);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

interface Slab {
  /** Deska jádra ve scéně (m): x zrcadlí jádro, z po trati. */
  readonly x0: number;
  readonly x1: number;
  readonly near: number;
  readonly far: number;
  readonly top: number;
}

/** Pevné desky přímo ze stavu jádra – nezávisle na `platformIslands`. Pohyblivá plošina ostrůvek nedostane. */
function slabsOf(world: ArcadeWorld): { readonly slabs: Slab[]; readonly moving: number } {
  const state = world.initial;
  const slabs: Slab[] = [];
  let moving = 0;
  for (let index = 0; index < (state[HEADER.bodyCount] as number); index += 1) {
    const base = bodyBase(index);
    if (state[base + BODY.role] !== ROLE.platform) continue;
    if (world.kinds[state[base + BODY.kind] as number] !== 'platform') {
      moving += 1;
      continue;
    }
    const [x, y, z, w, h, d] = [BODY.x, BODY.y, BODY.z, BODY.w, BODY.h, BODY.d].map((slot) => (state[base + slot] as number) / UNIT) as [number, number, number, number, number, number];
    slabs.push({ x0: -x - w / 2, x1: -x + w / 2, near: z - d / 2, far: z + d / 2, top: y + h });
  }
  return { slabs: slabs.sort((a, b) => a.near - b.near), moving };
}

/** Hladina pod plošinami, jak ji kreslí dnešní scéna (`World.tsx`). */
const WATER_LEVEL = 0.6;

describe.each(LEVELS)('islands on platform level seed $seed ($params.difficulty)', ({ seed, params }) => {
  const world = levelOf(seed, params);
  const { slabs, moving } = slabsOf(world);
  const spots = platformIslands(world);
  const islands = buildIslands({ look: LOOKS.meadow, islands: spots, base: WATER_LEVEL });

  it('makes one islet per fixed platform and none for a moving one', () => {
    expect(slabs.length).toBeGreaterThan(4);
    expect(spots).toHaveLength(slabs.length);
    if (params.difficulty === 'normal') expect(moving).toBeGreaterThan(0);
  });

  // Revize P32 (stopa F): kvádry pevných desek se schovají podle klíče polohy, jakou jim zapíše `World`.
  it('keys every fixed slab where World places its box, and never the moving platform', () => {
    const keys = platformSlabKeys(world);
    const state = world.initial;
    const key = (index: number): string => {
      const base = bodyBase(index);
      return `${-(state[base + BODY.x] as number) + 0},${state[base + BODY.y] as number},${state[base + BODY.z] as number}`;
    };
    let fixed = 0;
    for (let index = 0; index < (state[HEADER.bodyCount] as number); index += 1) {
      const base = bodyBase(index);
      if (state[base + BODY.role] !== ROLE.platform) continue;
      if (world.kinds[state[base + BODY.kind] as number] === 'platform') {
        fixed += 1;
        expect(keys.has(key(index)), key(index)).toBe(true);
      } else expect(keys.has(key(index)), key(index)).toBe(false);
    }
    expect(keys.size).toBe(fixed);
    expect(fixed).toBe(slabs.length);
  });

  it('draws every islet top at the kernel platform height within 1 cm, over the whole slab', () => {
    for (const slab of slabs) {
      const inset = 0.002;
      const corners = [
        [slab.x0 + inset, slab.near + inset],
        [slab.x1 - inset, slab.near + inset],
        [slab.x0 + inset, slab.far - inset],
        [slab.x1 - inset, slab.far - inset],
      ] as const;
      const inside = Array.from({ length: 30 }, () => [between(slab.x0, slab.x1), between(slab.near, slab.far)] as const);
      for (const [x, z] of [...corners, ...inside]) {
        const y = drawnAt(islands.geometry, x, z);
        expect(y, `x ${x.toFixed(2)} z ${z.toFixed(2)}`).not.toBeNull();
        expect(Math.abs(y! - slab.top), `x ${x.toFixed(2)} z ${z.toFixed(2)} top ${slab.top}`).toBeLessThan(0.01);
      }
    }
  });

  it('leaves the gaps between platforms open, so a jump edge looks where it is', () => {
    for (let i = 0; i + 1 < slabs.length; i += 1) {
      const [a, b] = [slabs[i]!, slabs[i + 1]!];
      if (b.near - a.far < 1) continue;
      expect(islands.heightAt(0, (a.far + b.near) / 2), `gap ${a.far.toFixed(1)}–${b.near.toFixed(1)}`).toBeNull();
      expect(drawnAt(islands.geometry, 0, (a.far + b.near) / 2)).toBeNull();
    }
  });

  it('gives the height the mesh draws around the edges, and never rises above the top', () => {
    for (let i = 0; i < 150; i += 1) {
      const slab = slabs[Math.floor(uniformFloat64(rng) * slabs.length)]!;
      const x = between(slab.x0 - 0.6, slab.x1 + 0.6);
      const z = between(slab.near - 0.6, slab.far + 0.6);
      const drawn = drawnAt(islands.geometry, x, z);
      const said = islands.heightAt(x, z);
      if (drawn === null) expect(said, `x ${x.toFixed(2)} z ${z.toFixed(2)}`).toBeNull();
      else expect(Math.abs(said! - drawn), `x ${x.toFixed(2)} z ${z.toFixed(2)}`).toBeLessThan(0.01);
      if (said !== null) expect(said).toBeLessThanOrEqual(slab.top + 1e-4);
    }
  });
});

describe('island kit', () => {
  const round = buildIslands({ look: LOOKS.ocean, islands: [{ x: 4, z: 20, w: 9, d: 7, top: 1.4, round: true }], base: 0 });

  it('draws with flat-shaded faces and palette vertex colours', () => {
    expectFlat(round.geometry);
    expect(drawnAt(round.geometry, 4, 20)).toBeCloseTo(1.4, 4);
  });

  it('measures the shore from the waterline: negative on land, growing out to sea', () => {
    expect(round.shoreDistance(4, 20)).toBeLessThan(0);
    const near = round.shoreDistance(4 + 9, 20);
    const far = round.shoreDistance(4 + 17, 20);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near + 5);
  });

  it('takes a grassy rim, a snowy one in snow and a sandy one on sand', () => {
    expect(islandPalette(LOOKS.meadow).top).toBe(LOOKS.meadow.ground);
    expect(islandPalette(LOOKS.snow).top).toBe(LOOKS.snow.terrain?.cap);
    expect(islandPalette(LOOKS.desert).top).toBe(LOOKS.desert.ground);
    // Oceán má zem v barvě hladiny – ostrov je z písku sady, ne z vody.
    expect(islandPalette(LOOKS.ocean).top).toBe(LOOKS.ocean.land);
    expect(new Set([islandPalette(LOOKS.meadow).rim, islandPalette(LOOKS.snow).rim, islandPalette(LOOKS.desert).rim]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Podlaha arény

describe('arena floor', () => {
  const half = ARENA.half / UNIT;
  const arena = buildArenaFloor({ look: LOOKS.castle, half });

  it('sits on the kernel ground within 1 cm at 200 random points of the arena', () => {
    for (let i = 0; i < 200; i += 1) {
      const x = between(-half, half);
      const z = between(-half, half);
      const y = drawnAt(arena.floor, x, z);
      expect(y, `x ${x.toFixed(2)} z ${z.toFixed(2)}`).not.toBeNull();
      // Scéna zrcadlí x jádra (`ArenaScene`): bod scény x je v jádře −x.
      expect(Math.abs(y! - playableGround('move_free', -x, z)), `x ${x.toFixed(2)} z ${z.toFixed(2)}`).toBeLessThan(0.01);
      expect(arena.heightAt(x, z)).toBeCloseTo(y!, 6);
    }
  });

  it('rings the arena with walls beyond the edge, and the scenery beyond the walls', () => {
    const position = arena.walls.getAttribute('position');
    let outer = 0;
    const sides = new Set<string>();
    let tallest = 0;
    for (let i = 0; i < position.count; i += 1) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
      const reach = Math.max(Math.abs(x), Math.abs(z));
      expect(reach, `wall vertex ${x.toFixed(2)} ${z.toFixed(2)} inside the arena`).toBeGreaterThan(half + 0.3);
      outer = Math.max(outer, reach);
      tallest = Math.max(tallest, y);
      if (x > half) sides.add('+x');
      if (x < -half) sides.add('-x');
      if (z > half) sides.add('+z');
      if (z < -half) sides.add('-z');
    }
    expect([...sides].sort()).toEqual(['+x', '+z', '-x', '-z']);
    expect(tallest).toBeGreaterThan(1);
    expect(arena.sceneryInner).toBeGreaterThan(outer);
    // Za stěnami a kulisami je pořád zem, ne díra do oblohy.
    expect(drawnAt(arena.floor, arena.sceneryInner + 6, 0)).not.toBeNull();
    expectFlat(arena.floor);
    expectFlat(arena.walls);
  });

  it('paves a castle, freezes a snow arena to ice and covers grass and sand with their ground', () => {
    expect(arenaPalette(LOOKS.castle).floor).toBe(LOOKS.castle.block?.[1]);
    expect(arenaPalette(LOOKS.snow).floor).toBe(LOOKS.snow.terrain?.lane);
    expect(arenaPalette(LOOKS.meadow).floor).toBe(LOOKS.meadow.ground);
    expect(arenaPalette(LOOKS.desert).floor).toBe(LOOKS.desert.ground);
  });
});

// ---------------------------------------------------------------------------
// Voda

describe('water', () => {
  const shore = (x: number, z: number): number => Math.hypot(x, z - 10) - 4;
  const water = buildWater({ look: LOOKS.ocean, half: 30, from: -10, to: 60, level: 0.25, shore });

  it('lies flat at its level in the mesh – the waves are the vertex shader’s, the kernel never sees them', () => {
    const position = water.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) expect(position.getY(i)).toBeCloseTo(0.25, 6);
  });

  it('waves within their height, moving in place and time', () => {
    const heights: number[] = [];
    for (let i = 0; i < 200; i += 1) heights.push(water.heightAt(between(-30, 30), between(-10, 60), between(0, 30)));
    expect(Math.max(...heights.map((h) => Math.abs(h - 0.25)))).toBeLessThanOrEqual(WAVE_HEIGHT + 1e-9);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(WAVE_HEIGHT);
    expect(water.heightAt(3, 7, 0)).not.toBeCloseTo(water.heightAt(3, 7, 1.3), 3);
  });

  it('carries the shore distance to every vertex, so foam gathers at the shore', () => {
    const position = water.geometry.getAttribute('position');
    const distance = water.geometry.getAttribute('shore');
    let foamy = 0;
    for (let i = 0; i < position.count; i += 1) {
      expect(distance.getX(i)).toBeCloseTo(Math.min(shore(position.getX(i), position.getZ(i)), OPEN_SEA), 3);
      if (distance.getX(i) < 1) foamy += 1;
    }
    expect(foamy).toBeGreaterThan(5);
  });

  it('measures the outline only of islands near a vertex, not of every island down the course (P35 T4)', () => {
    const course = buildIslands({ look: LOOKS.ocean, islands: Array.from({ length: 16 }, (_, i) => ({ x: i % 2 === 0 ? -16 : 16, z: 20 + 30 * i, w: 8, d: 7, top: 1.4, round: true })), base: 0 });
    const hypot = vi.spyOn(Math, 'hypot');
    const sea = buildWater({ look: LOOKS.ocean, half: 40, from: -20, to: 520, level: 0.25, shore: course.shoreDistance });
    const perVertex = hypot.mock.calls.length / sea.geometry.getAttribute('position').count;
    hypot.mockRestore();
    // Obálka každého ostrova a obrys jen těch do stropu: ~24 výpočtů vzdálenosti na vrchol.
    // Bez stropu mřížka měřila obrysy od začátku trati až k vrcholu (~196), se stropem 100 m ~85.
    expect(perVertex).toBeLessThan(40);
    // Strop nemění, co se kreslí: blíž ke břehu přesná vzdálenost, dál strop.
    const position = sea.geometry.getAttribute('position');
    const distance = sea.geometry.getAttribute('shore');
    for (let i = 0; i < position.count; i += 7) expect(distance.getX(i)).toBeCloseTo(Math.min(course.shoreDistance(position.getX(i), position.getZ(i)), OPEN_SEA), 4);
  });

  it('wires the waves into the vertex shader and the foam into the fragment shader', () => {
    const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, defines: {} };
    (water.material.onBeforeCompile as (shader: unknown) => void)(shader);
    expect(shader.vertexShader).toMatch(/transformed\.y \+= wave/);
    expect(shader.fragmentShader).toMatch(/uFoamColor/);
    expect(shader.uniforms).toHaveProperty('uTime');
    expect(water.material.flatShading).toBe(true);
    water.setTime(4.5);
    expect((shader.uniforms as { uTime: { value: number } }).uTime.value).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// Palety

describe('terrain kit palettes', () => {
  it.each(LOOK_IDS)('%s names a cover and derives no purple island, floor or water colour', (id) => {
    expect(COVERS).toContain(LOOKS[id].cover);
    expectNoPurple(id, { ...islandPalette(LOOKS[id]) });
    expectNoPurple(id, { ...arenaPalette(LOOKS[id]) });
    expectNoPurple(id, { ...waterPalette(LOOKS[id]) });
  });
});
