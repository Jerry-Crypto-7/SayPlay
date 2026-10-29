/**
 * Prostorový zvuk ve VR (P67 T8) nad falešným `AudioContext`, který graf opravdu „vyrenderuje“: zdroj rovnou do
 * `destination` dá do obou kanálů tentýž vzorek, panner vzorky ztlumí podle vzdálenosti a rozdělí do stran.
 *
 * - **Bez polohy bajt po bajtu stejně.** Otisky vzorků dvou presetů jsou naměřené na kódu před T8 (`GOLDEN`). Zvuk
 *   telefonu se nesmí změnit ani o bit – ani mimo VR s polohou, ani ve VR bez ní.
 * - **S polohou ve VR přes panner** HRTF / `inverse`, v bodě, kde scéna tělo kreslí; posluchač je hlava.
 * - **Poloha pro každý režim rigu:** obal světa postavený jako v `XrRoom`, `Diorama` a `XrPlace` (`REACH`) dá bod,
 *   který sedí na hrdinu, na pruh pod rukou a na desku dioramy (`deskPointOf`).
 */

import { createHash } from 'node:crypto';

import { Matrix4, Object3D, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runnerPathOf } from '@/components/play/arcade/runner/path';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { laneX } from '@/play/arcade/pieces/lanes';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { DESK, type DeskPose, type DioramaView, createDiorama, deskOfWorld, deskPointOf, onDesk, playAreaOf } from '@/play/xr/diorama-scale';
import { REACH } from '@/play/xr/input-map';
import { ROOM, type XrPose, roomOf } from '@/play/xr/modes';
import { type Bend, PANNER, soundPointOf } from '@/play/xr/spatial-sound';

import type { SfxPreset, SoundAt } from '..';

/**
 * sha256 vyrenderovaných vzorků (L pak R, Float32) – naměřeno 29. 10. 2026 na `index.ts` před T8: po zásahu (`hit`)
 * a po výhře, která zazní přes něj (`hit` + `win` v jednom kontextu).
 */
const GOLDEN = {
  hit: 'ae93ee9b8c3387ce33b7177b3376974b382136a6142f5166477af340783b2246',
  hitThenWin: '97a626ee20767bb3cf27d9aac9694bf74c112f59fe7fcc90a282f8a0c93a3c62',
} as const;

type Param = { value: number };
const param = (value = 0): Param => ({ value });

class FakeNode {
  targets: FakeNode[] = [];
  connect(target: FakeNode): FakeNode {
    this.targets.push(target);
    return target;
  }
  disconnect(): void {
    this.targets = [];
  }
}

class FakePanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'linear';
  refDistance = 1;
  rolloffFactor = 1;
  readonly positionX = param();
  readonly positionY = param();
  readonly positionZ = param();
}

class FakeSource extends FakeNode {
  buffer: { getChannelData: (channel: number) => Float32Array } | null = null;
  started = false;
  stopped = false;
  private ended: (() => void)[] = [];
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  addEventListener(_: string, listener: () => void): void {
    this.ended.push(listener);
  }
  end(): void {
    for (const listener of this.ended) listener();
  }
}

class FakeListener {
  readonly positionX = param();
  readonly positionY = param();
  readonly positionZ = param();
  readonly forwardX = param();
  readonly forwardY = param();
  readonly forwardZ = param(-1);
  readonly upX = param();
  readonly upY = param(1);
  readonly upZ = param();
}

class FakeContext {
  static last: FakeContext | null = null;
  state = 'running';
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly listener = new FakeListener();
  sources: FakeSource[] = [];
  panners: FakePanner[] = [];
  constructor() {
    FakeContext.last = this;
  }
  addEventListener(): void {}
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createPanner(): FakePanner {
    const panner = new FakePanner();
    this.panners.push(panner);
    return panner;
  }
}

/** Panner jako `equalpower` s útlumem `inverse` vůči posluchači: stačí, aby výstup přes něj nebyl týž jako bez něj. */
function pan(panner: FakePanner, listener: FakeListener): readonly [number, number] {
  const to = new Vector3(panner.positionX.value - listener.positionX.value, panner.positionY.value - listener.positionY.value, panner.positionZ.value - listener.positionZ.value);
  const forward = new Vector3(listener.forwardX.value, listener.forwardY.value, listener.forwardZ.value);
  const up = new Vector3(listener.upX.value, listener.upY.value, listener.upZ.value);
  const distance = to.length();
  const gain = panner.refDistance / (panner.refDistance + panner.rolloffFactor * (Math.max(distance, panner.refDistance) - panner.refDistance));
  const side = distance === 0 ? 0 : to.dot(new Vector3().crossVectors(forward, up).normalize()) / distance;
  const angle = ((side + 1) * Math.PI) / 4;
  return [gain * Math.cos(angle), gain * Math.sin(angle)];
}

/** Co uslyší reproduktory: L pak R. Zdroj rovnou do `destination` = tentýž vzorek v obou kanálech. */
function render(context: FakeContext): Float32Array {
  const length = Math.max(0, ...context.sources.map((source) => source.buffer?.getChannelData(0).length ?? 0));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const source of context.sources) {
    if (!source.started || source.stopped) continue;
    const samples = source.buffer!.getChannelData(0);
    const [next] = source.targets;
    let gains: readonly [number, number];
    if (next === context.destination) gains = [1, 1];
    else if (next instanceof FakePanner && next.targets[0] === context.destination) gains = pan(next, context.listener);
    else throw new Error('a source that reaches no speaker');
    samples.forEach((sample, index) => {
      left[index]! += gains[0] === 1 ? sample : sample * gains[0];
      right[index]! += gains[1] === 1 ? sample : sample * gains[1];
    });
  }
  const out = new Float32Array(2 * length);
  out.set(left);
  out.set(right, length);
  return out;
}

const hashOf = (samples: Float32Array): string => createHash('sha256').update(Buffer.from(samples.buffer)).digest('hex');

beforeEach(() => {
  vi.resetModules();
  FakeContext.last = null;
  vi.stubGlobal('AudioContext', FakeContext);
});
afterEach(() => vi.unstubAllGlobals());

/** Čerstvý modul zvuku s běžícím kontextem; `world` = ve VR s obalem světa s touto maticí (`null` = obal ještě není). */
async function fresh(world?: Matrix4 | null, bend: Bend = null) {
  const audio = await import('..');
  const xr = await import('@/play/xr/spatial-sound');
  audio.unlockAudio();
  const sound = world === undefined ? null : xr.createSpatialSound(() => world, bend);
  if (sound !== null) audio.spatial.route = sound.route;
  return { audio, sound, context: FakeContext.last! };
}

const AT: SoundAt = { x: 2, y: 0.5, z: 6 };

/** Zásah, pak výhra přes něj; otisk po každém. */
async function hitThenWin(at: SoundAt | undefined, world?: Matrix4 | null) {
  const { audio, context } = await fresh(world);
  const play = (preset: SfxPreset) => audio.playSfx(preset, at);
  play('hit');
  const hit = hashOf(render(context));
  play('win');
  return { hit, hitThenWin: hashOf(render(context)), panners: context.panners.length };
}

describe('without a position the synth output is byte for byte the same (P67 T8)', () => {
  it('outside VR, without a position', async () => {
    expect(await hitThenWin(undefined)).toEqual({ ...GOLDEN, panners: 0 });
  });

  it('outside VR, with a position (it is ignored)', async () => {
    expect(await hitThenWin(AT)).toEqual({ ...GOLDEN, panners: 0 });
  });

  it('in VR, without a position', async () => {
    expect(await hitThenWin(undefined, new Matrix4())).toEqual({ ...GOLDEN, panners: 0 });
  });
});

describe('in VR a sound with a position goes through an HRTF panner', () => {
  it('the panner stands where the scene draws the body; the output is no longer the plain one', async () => {
    const { audio, context } = await fresh(new Matrix4());
    audio.playSfx('hit', AT);
    expect(context.panners).toHaveLength(1);
    const [panner] = context.panners;
    expect(panner).toMatchObject({ panningModel: 'HRTF', distanceModel: 'inverse', refDistance: PANNER.refDistance, rolloffFactor: PANNER.rolloffFactor });
    // Scéna zrcadlí x jádra.
    expect([panner!.positionX.value, panner!.positionY.value, panner!.positionZ.value]).toEqual([-AT.x, AT.y, AT.z]);
    expect(context.sources[0]!.targets).toEqual([panner]);
    expect(panner!.targets).toEqual([context.destination]);
    expect(hashOf(render(context))).not.toBe(GOLDEN.hit);
    // Po dohrání se panner odpojí – nehromadí se.
    context.sources[0]!.end();
    expect(panner!.targets).toEqual([]);
  });

  it('before the world exists the sound plays plain', async () => {
    expect(await hitThenWin(AT, null)).toEqual({ ...GOLDEN, panners: 0 });
  });

  it('the same sound with a position cuts the plain one of the same tick (core effects are heard first)', async () => {
    const { audio, context } = await fresh(new Matrix4());
    audio.playSfx('pickup');
    audio.playSfx('pickup', AT);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]!.stopped).toBe(true);
    expect(context.sources[1]!.targets).toEqual(context.panners);
    // Opačné pořadí: zvuk bez polohy po témže s polohou spolkne okno opakování jako dřív.
    audio.playSfx('win', AT);
    audio.playSfx('win');
    expect(context.sources).toHaveLength(3);
  });

  it('a plain sound of another preset is not cut', async () => {
    const { audio, context } = await fresh(new Matrix4());
    audio.playSfx('pickup');
    audio.playSfx('hit', AT);
    expect(context.sources[0]!.stopped).toBe(false);
  });

  it('outside VR the repeat window is the same as before', async () => {
    const { audio, context } = await fresh();
    audio.playSfx('pickup');
    audio.playSfx('pickup', AT);
    expect(context.sources).toHaveLength(1);
  });

  it('the listener is the head, from the first sound on', async () => {
    const { audio, sound, context } = await fresh(new Matrix4());
    const head = { position: { x: 0.1, y: 1.6, z: 0.2 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
    sound!.hear(head);
    expect(context.listener.positionY.value).toBe(0);
    audio.playSfx('hit', AT);
    expect([context.listener.positionX.value, context.listener.positionY.value, context.listener.positionZ.value]).toEqual([0.1, 1.6, 0.2]);
    sound!.hear({ ...head, position: { x: 0, y: 1.5, z: 0 }, forward: { x: 1, y: 0, z: 0 } });
    expect([context.listener.positionY.value, context.listener.forwardX.value, context.listener.forwardZ.value]).toEqual([1.5, 1, 0]);
    expect(sound!.report()).toEqual({ placed: 1, last: { x: -AT.x, y: AT.y, z: AT.z }, listener: { x: 0, y: 1.5, z: 0 } });
  });

  it('a browser without listener params (Gecko) gets the older calls', async () => {
    const { sound } = await fresh(new Matrix4());
    const calls: number[][] = [];
    const listener = { setPosition: (...xyz: number[]) => calls.push(xyz), setOrientation: (...v: number[]) => calls.push(v) };
    const context = { listener, destination: {}, currentTime: 0 } as unknown as AudioContext;
    sound!.hear({ position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } });
    sound!.route(context, { buffer: null, connect: () => undefined } as unknown as AudioBufferSourceNode);
    expect(calls).toEqual([
      [1, 2, 3],
      [0, 0, -1, 0, 1, 0],
    ]);
  });
});

/* Poloha zvuku pro každý režim rigu. Obal světa se staví tak, jak ho staví komponenta režimu. */

const cells = new Map(
  liveCells().flatMap((cell) => {
    const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
    return built.ok ? [[cell.id, built.world] as const] : [];
  }),
);
const worldOf = (id: string): ArcadeWorld => cells.get(id)!;

/** Událost u startu hrdiny (m, osy jádra), jak ji vydá sběrnice. */
function heroEvent(world: ArcadeWorld): SoundAt {
  const hero = bodyBase(world.initial[HEADER.player] as number);
  return { x: (world.initial[hero + BODY.x] as number) / UNIT, y: (world.initial[hero + BODY.y] as number) / UNIT, z: (world.initial[hero + BODY.z] as number) / UNIT };
}

const matrixOf = (position: readonly [number, number, number], scale: number): Matrix4 => {
  const group = new Object3D();
  group.position.set(...position);
  group.rotation.set(0, Math.PI, 0);
  group.scale.setScalar(scale);
  group.updateMatrixWorld();
  return group.matrixWorld;
};

/** Jako `XrRoom`: bod `anchor` scény k nohám hráče. */
function roomMatrix(pose: XrPose, world: ArcadeWorld) {
  const room = roomOf(pose, world);
  return { room, matrix: matrixOf([room.scale * room.anchor.x, 0, room.scale * room.anchor.z], room.scale) };
}

/** Jako `Diorama`: střed okna `view` na střed plochy desky. */
function deskMatrix(view: DioramaView, desk: DeskPose = DESK): Matrix4 {
  const { scale, center } = view;
  const cos = Math.cos(desk.yaw);
  const sin = Math.sin(desk.yaw);
  const ox = scale * center.x;
  const oz = scale * center.z;
  const group = new Object3D();
  group.position.set(desk.x + ox * cos + oz * sin, desk.top - scale * center.y, desk.z - ox * sin + oz * cos);
  group.rotation.set(0, desk.yaw + Math.PI, 0);
  group.scale.setScalar(scale);
  group.updateMatrixWorld();
  return group.matrixWorld;
}

const close = (point: Vector3, expected: readonly [number, number, number]) => {
  expect(point.x).toBeCloseTo(expected[0], 6);
  expect(point.y).toBeCloseTo(expected[1], 6);
  expect(point.z).toBeCloseTo(expected[2], 6);
};

describe('the sound lands where the body is drawn, in every rig mode', () => {
  it('room, arena: the middle of the arena is under the player, the kernel’s +x is to his right, shrunk by the scale', () => {
    const world = worldOf('arena.escape');
    const { room, matrix } = roomMatrix('center', world);
    const middle = { x: -room.anchor.x, y: 0, z: room.anchor.z };
    close(soundPointOf(middle, matrix, null), [0, 0, 0]);
    close(soundPointOf({ ...middle, x: middle.x + 4, y: 2 }, matrix, null), [4 * room.scale, 2 * room.scale, 0]);
  });

  it('room, defense: the hero starts 1.5 m in front of the player', () => {
    const world = worldOf('defense.default');
    const at = heroEvent(world);
    close(soundPointOf(at, roomMatrix('base', world).matrix, null), [0, at.y, -ROOM.baseBack]);
  });

  it('room, catch: the basket starts 1.2 m in front of the player', () => {
    const world = worldOf('catch.default');
    const { room, matrix } = roomMatrix('front', world);
    const at = heroEvent(world);
    close(soundPointOf(at, matrix, null), [0, at.y * room.scale, -ROOM.catchAhead]);
  });

  it('native, whack and slice: a lane sounds under the hand that hits it', () => {
    const matrix = matrixOf(REACH.at, REACH.scale);
    for (const lane of [0, 2, 4]) {
      // Ruka nad pruhem jako v `e2e/vr-native.spec.ts` (`laneHandX`).
      close(soundPointOf({ x: laneX(lane) / UNIT, y: 0, z: 0 }, matrix, null), [REACH.at[0] + (laneX(lane) / 1000) * REACH.scale, REACH.at[1], REACH.at[2]]);
    }
  });

  it('desk: the hero sounds on the desk, exactly where the diorama puts him', () => {
    const world = worldOf('quest.spatial');
    const at = heroEvent(world);
    // Okno dioramy jede za kresleným hrdinou (body scény: x zrcadlené).
    const view = createDiorama(playAreaOf(world)).frame({ x: -at.x, y: at.y, z: at.z });
    const point = soundPointOf(at, deskMatrix(view), null);
    const onTable = deskOfWorld(DESK, point);
    const expected = deskPointOf(view, { x: -at.x, y: at.y, z: at.z });
    expect(onTable.x).toBeCloseTo(expected.x, 6);
    expect(onTable.y).toBeCloseTo(expected.y, 6);
    expect(onTable.z).toBeCloseTo(expected.z, 6);
    expect(onDesk(onTable, 0.05)).toBe(true);
  });

  it('desk carried by the left grip: the sound turns with the desk', () => {
    const world = worldOf('quest.spatial');
    const at = heroEvent(world);
    const view = createDiorama(playAreaOf(world)).frame({ x: -at.x, y: at.y, z: at.z });
    const turned: DeskPose = { x: 0.3, top: 0.9, z: -0.7, yaw: 0.6 };
    const onTable = deskOfWorld(turned, soundPointOf(at, deskMatrix(view, turned), null));
    const expected = deskPointOf(view, { x: -at.x, y: at.y, z: at.z });
    expect(onTable.x).toBeCloseTo(expected.x, 6);
    expect(onTable.z).toBeCloseTo(expected.z, 6);
  });

  it('surround, runner: far down a bending track the sound follows the bend the scene draws', () => {
    const world = worldOf('runner.default');
    const path = runnerPathOf(world)!;
    const view = createDiorama(playAreaOf(world)).frame(null);
    const matrix = deskMatrix(view);
    const z = (() => {
      for (let at = 20; at < 400; at += 5) if (Math.abs(path(at).x) > 0.5) return at;
      throw new Error('a runner track without a bend');
    })();
    const at = { x: 1, y: 0, z };
    const bent = deskOfWorld(DESK, soundPointOf(at, matrix, path));
    const expected = deskPointOf(view, { x: path(z).x - at.x, y: at.y + path(z).y, z });
    expect(bent.x).toBeCloseTo(expected.x, 6);
    expect(bent.y).toBeCloseTo(expected.y, 6);
    // Bez ohybu by zvuk zněl jinde, než scéna tělo kreslí.
    expect(Math.abs(deskOfWorld(DESK, soundPointOf(at, matrix, null)).x - bent.x)).toBeGreaterThan(0.5 * view.scale);
  });
});
