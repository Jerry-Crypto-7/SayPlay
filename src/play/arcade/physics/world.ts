/**
 * Rapier za arkádovým jádrem (P29A, T11): svět fyzikálních těles, jehož stav
 * se po každém tiku **kvantuje na celá čísla** jádra (`UNIT`, rychlost za tik).
 *
 * Rapier počítá ve floatech, ale hash a replay jádra vidí jen kvantované
 * hodnoty. Determinismus stojí na tom, že tentýž WASM dá v každém V8 (Node pro
 * publikaci a robota, Chromium pro hráče) bit po bitu stejný výsledek – měří to
 * `__tests__/determinism.test.ts` a `e2e/play-physics-determinism.spec.ts`,
 * čísla jsou v `evals/play/rules/rapier.md`.
 *
 * Modul Rapieru se načítá dynamicky (`loadRapier`): ~0,6 MB brotli, hra bez
 * fyziky ho stahovat nesmí.
 */

import type * as RapierModule from '@dimforge/rapier3d-compat';

import { ARCADE_HZ, QUAT, UNIT } from '../contract';

export type Rapier = typeof RapierModule.default;

let loading: Promise<Rapier> | null = null;
let loaded: Rapier | null = null;

/** Načte a inicializuje Rapier jednou za proces; další volání vrátí týž slib. */
export function loadRapier(): Promise<Rapier> {
  loading ??= import('@dimforge/rapier3d-compat').then(async (mod) => {
    const rapier = mod.default;
    await rapier.init();
    loaded = rapier;
    return rapier;
  });
  return loading;
}

/** Rapier, pokud už je načtený; jinak `null` (jádro je synchronní, načíst se musí předem). */
export const rapierIfLoaded = (): Rapier | null => loaded;

export { QUAT };
/** Celých čísel na jedno těleso v kvantovaném výstupu: x y z vx vy vz qx qy qz qw. */
export const PHYSICS_STRIDE = 10;

export interface PhysicsBodyInit {
  /** Střed spodní stěny a celé rozměry v jednotkách jádra (jako `BodyInit`). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** Rychlost v jednotkách za tik. */
  readonly vx?: number;
  readonly vy?: number;
  readonly vz?: number;
  readonly shape?: 'box' | 'ball';
  /** Nehybné (zeď, podložka). */
  readonly fixed?: boolean;
  /** Tření a odraz v promile. */
  readonly friction?: number;
  readonly restitution?: number;
}

const m = (units: number): number => units / UNIT;
const perSecond = (unitsPerTick: number): number => (unitsPerTick * ARCADE_HZ) / UNIT;

/**
 * Svět Rapieru s pevným krokem 1/60 s, gravitací jádra (`gravity` jednotek za
 * tik², kladně dolů) a zemí v `y = 0`. Tělesa se přidávají jen v konstruktoru,
 * pořadí je jejich index ve výstupu.
 */
export class PhysicsWorld {
  private readonly world: RapierModule.World;
  private readonly bodies: RapierModule.RigidBody[] = [];
  private readonly heights: number[] = [];

  constructor(rapier: Rapier, bodies: readonly PhysicsBodyInit[], gravity: number) {
    this.world = new rapier.World({ x: 0, y: -(gravity * ARCADE_HZ * ARCADE_HZ) / UNIT, z: 0 });
    this.world.timestep = 1 / ARCADE_HZ;
    const ground = this.world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(rapier.ColliderDesc.cuboid(500, 0.5, 500).setFriction(0.8), ground);
    for (const body of bodies) {
      const desc = (body.fixed === true ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic())
        .setTranslation(m(body.x), m(body.y + body.h / 2), m(body.z))
        .setLinvel(perSecond(body.vx ?? 0), perSecond(body.vy ?? 0), perSecond(body.vz ?? 0))
        .setCcdEnabled(true);
      const rigid = this.world.createRigidBody(desc);
      const collider =
        body.shape === 'ball' ? rapier.ColliderDesc.ball(m(Math.min(body.w, body.h, body.d)) / 2) : rapier.ColliderDesc.cuboid(m(body.w) / 2, m(body.h) / 2, m(body.d) / 2);
      collider.setFriction((body.friction ?? 600) / 1000).setRestitution((body.restitution ?? 0) / 1000);
      this.world.createCollider(collider, rigid);
      this.bodies.push(rigid);
      this.heights.push(body.h);
    }
  }

  step(): void {
    this.world.step();
  }

  /** Zapíše kvantovaný stav těles do `out` od `offset` (`PHYSICS_STRIDE` čísel na těleso). */
  quantize(out: Int32Array, offset = 0): void {
    this.bodies.forEach((body, i) => {
      const at = offset + i * PHYSICS_STRIDE;
      const t = body.translation();
      const v = body.linvel();
      const q = body.rotation();
      out[at] = Math.round(t.x * UNIT);
      out[at + 1] = Math.round(t.y * UNIT - (this.heights[i] as number) / 2);
      out[at + 2] = Math.round(t.z * UNIT);
      out[at + 3] = Math.round((v.x * UNIT) / ARCADE_HZ);
      out[at + 4] = Math.round((v.y * UNIT) / ARCADE_HZ);
      out[at + 5] = Math.round((v.z * UNIT) / ARCADE_HZ);
      out[at + 6] = Math.round(q.x * QUAT);
      out[at + 7] = Math.round(q.y * QUAT);
      out[at + 8] = Math.round(q.z * QUAT);
      out[at + 9] = Math.round(q.w * QUAT);
    });
  }

  get size(): number {
    return this.bodies.length;
  }

  free(): void {
    this.world.free();
  }
}
