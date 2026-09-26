/**
 * Fyzikální fáze arkádového tiku (P29A, T12): tělesa s `FLAG.physics` hýbe
 * Rapier, všechno ostatní dál jádro.
 *
 * Svět Rapieru patří jedné instanci stavu (`WeakMap` nad `Int32Array`) a
 * vzniká líně při prvním tiku, ve kterém stav nějaké fyzikální těleso má. Mezi
 * tiky nese floaty, které hash nevidí, ale jsou funkcí historie stavu: replay
 * od tiku 0 je projde znovu stejně (Rapier je deterministický, T11). Po kroku
 * se do stavu zapíše kvantovaná poloha, rychlost a natočení; když je mezitím
 * přepíše jádro nebo efekt (strčení, zvednutí, hod, návrat), Rapier je před
 * dalším krokem převezme.
 *
 * Ostatní pevná tělesa (zdi, bedny, plošiny) jsou v Rapieru kinematické
 * překážky, od kterých se fyzikální tělesa odráží. Hráč v něm není: jeho
 * kolize řeší jádro a pevné fyzikální těleso je pro něj obyčejná překážka.
 */

import type * as RapierModule from '@dimforge/rapier3d-compat';

import {
  ARCADE_HZ,
  type ArcadeState,
  BODY,
  FLAG,
  HEADER,
  PHYSICS_SUBSTEPS,
  RESTITUTION_MASK,
  RESTITUTION_SHIFT,
  ROLE,
  UNIT,
  bodyBase,
  packRotation,
  unpackRotation,
} from '../contract';
import { type Rapier, rapierIfLoaded } from './world';

/** Tření fyzikálních těles a země (Rapier je průměruje). */
const FRICTION = { body: 0.6, ground: 0.8 } as const;

const m = (units: number): number => units / UNIT;
const perSecond = (unitsPerTick: number): number => (unitsPerTick * ARCADE_HZ) / UNIT;

/** Sloty, které fáze zapisuje a po kterých pozná zásah zvenku: x y z vx vy vz aux0 aux1. */
const SYNCED = [BODY.x, BODY.y, BODY.z, BODY.vx, BODY.vy, BODY.vz, BODY.aux0, BODY.aux1] as const;

interface Entry {
  readonly rigid: RapierModule.RigidBody;
  readonly dynamic: boolean;
  /** Co fáze do stavu naposledy zapsala (u překážky poloha, kterou Rapieru předala). */
  readonly last: Int32Array;
}

class PhysicsSession {
  private readonly world: RapierModule.World;
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly rapier: Rapier,
    gravity: number,
  ) {
    this.world = new rapier.World({ x: 0, y: -(gravity * ARCADE_HZ * ARCADE_HZ) / UNIT, z: 0 });
    // Tik = `PHYSICS_SUBSTEPS` celých kroků Rapieru, každý s vlastním hledáním
    // kontaktů: míč letící 0,26 m za tik by při jednom kroku zapadl 13 cm pod
    // zem (měkké CCD zapadnutí zastaví, ale spolkne odraz).
    this.world.timestep = 1 / (ARCADE_HZ * PHYSICS_SUBSTEPS);
    this.world.numSolverIterations = 1;
    const ground = this.world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(rapier.ColliderDesc.cuboid(500, 0.5, 500).setFriction(FRICTION.ground), ground);
  }

  private create(state: ArcadeState, base: number, dynamic: boolean): Entry {
    const { rapier } = this;
    const flags = state[base + BODY.flags] as number;
    const desc = dynamic ? rapier.RigidBodyDesc.dynamic().setCcdEnabled(true) : rapier.RigidBodyDesc.kinematicPositionBased();
    const rigid = this.world.createRigidBody(desc);
    const w = state[base + BODY.w] as number;
    const h = state[base + BODY.h] as number;
    const d = state[base + BODY.d] as number;
    const collider = (flags & FLAG.ball) !== 0 ? rapier.ColliderDesc.ball(m(Math.min(w, h, d)) / 2) : rapier.ColliderDesc.cuboid(m(w) / 2, m(h) / 2, m(d) / 2);
    collider
      .setFriction(FRICTION.body)
      .setRestitution(((flags >> RESTITUTION_SHIFT) & RESTITUTION_MASK) / 1000)
      .setRestitutionCombineRule(rapier.CoefficientCombineRule.Max);
    this.world.createCollider(collider, rigid);
    const entry: Entry = { rigid, dynamic, last: new Int32Array(SYNCED.length) };
    this.teleport(state, base, entry, true);
    return entry;
  }

  /**
   * Rapier převezme polohu, rychlost a natočení ze stavu. Překážka se posune
   * plynule (Rapier z toho zná její rychlost); `snap` = vznik nebo návrat po
   * vypnutí, kdy se musí objevit na místě, ne přejet z posledního.
   */
  private teleport(state: ArcadeState, base: number, entry: Entry, snap = false): void {
    const center = { x: m(state[base + BODY.x] as number), y: m((state[base + BODY.y] as number) + (state[base + BODY.h] as number) / 2), z: m(state[base + BODY.z] as number) };
    SYNCED.forEach((slot, k) => {
      entry.last[k] = state[base + slot] as number;
    });
    if (!entry.dynamic) {
      if (snap) entry.rigid.setTranslation(center, true);
      entry.rigid.setNextKinematicTranslation(center);
      return;
    }
    const [x, y, z, w] = unpackRotation(state[base + BODY.aux0] as number, state[base + BODY.aux1] as number);
    const norm = Math.sqrt(x * x + y * y + z * z + w * w);
    entry.rigid.setTranslation(center, true);
    entry.rigid.setRotation({ x: x / norm, y: y / norm, z: z / norm, w: w / norm }, true);
    entry.rigid.setLinvel({ x: perSecond(state[base + BODY.vx] as number), y: perSecond(state[base + BODY.vy] as number), z: perSecond(state[base + BODY.vz] as number) }, true);
  }

  private changed(state: ArcadeState, base: number, entry: Entry): boolean {
    for (let k = 0; k < SYNCED.length; k += 1) if (state[base + (SYNCED[k] as number)] !== entry.last[k]) return true;
    return false;
  }

  /** Jeden krok: předat Rapieru, co změnilo jádro, krok, zapsat kvantovaný výsledek. */
  step(state: ArcadeState): void {
    const count = state[HEADER.bodyCount] as number;
    const player = state[HEADER.player] as number;
    const held = (state[HEADER.held] as number) - 1;
    for (let i = 0; i < count; i += 1) {
      if (i === player) continue;
      const base = bodyBase(i);
      const flags = state[base + BODY.flags] as number;
      const dynamic = (flags & FLAG.physics) !== 0;
      // Nesené těleso veze hráč, ne Rapier; živé pevné tělo je překážka.
      const active = (flags & FLAG.alive) !== 0 && i !== held && (dynamic || ((flags & FLAG.solid) !== 0 && state[base + BODY.role] !== ROLE.projectile));
      let entry = this.entries.get(i);
      if (!active) {
        if (entry?.rigid.isEnabled() === true) entry.rigid.setEnabled(false);
        continue;
      }
      if (entry === undefined) {
        entry = this.create(state, base, dynamic);
        this.entries.set(i, entry);
      } else if (!entry.rigid.isEnabled()) {
        entry.rigid.setEnabled(true);
        this.teleport(state, base, entry, true);
      } else if (this.changed(state, base, entry)) this.teleport(state, base, entry);
    }
    for (let k = 0; k < PHYSICS_SUBSTEPS; k += 1) this.world.step();
    for (const [i, entry] of this.entries) {
      if (!entry.dynamic || !entry.rigid.isEnabled()) continue;
      const base = bodyBase(i);
      const t = entry.rigid.translation();
      const v = entry.rigid.linvel();
      const q = entry.rigid.rotation();
      const [aux0, aux1] = packRotation(q.x, q.y, q.z, q.w);
      state[base + BODY.x] = Math.round(t.x * UNIT);
      state[base + BODY.y] = Math.round(t.y * UNIT - (state[base + BODY.h] as number) / 2);
      state[base + BODY.z] = Math.round(t.z * UNIT);
      state[base + BODY.vx] = Math.round((v.x * UNIT) / ARCADE_HZ);
      state[base + BODY.vy] = Math.round((v.y * UNIT) / ARCADE_HZ);
      state[base + BODY.vz] = Math.round((v.z * UNIT) / ARCADE_HZ);
      state[base + BODY.aux0] = aux0;
      state[base + BODY.aux1] = aux1;
      SYNCED.forEach((slot, k) => {
        entry.last[k] = state[base + slot] as number;
      });
    }
  }

  free(): void {
    this.world.free();
  }
}

const sessions = new WeakMap<ArcadeState, PhysicsSession>();
// Stav, který nikdo nedohrál, uvolní WASM paměť svého světa aspoň při úklidu.
const orphans = new FinalizationRegistry<PhysicsSession>((session) => session.free());

/** Má stav živé fyzikální těleso? Hra bez něj fyzikální fázi vůbec nespustí. */
export function hasPhysics(state: ArcadeState): boolean {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) if (((state[bodyBase(i) + BODY.flags] as number) & FLAG.physics) !== 0) return true;
  return false;
}

/**
 * Fyzikální fáze tiku. Rapier musí být načtený předem (`loadRapier`) – jádro
 * je synchronní a hra s fyzikou bez něj běžet nesmí, jinak by se tiše
 * rozešla s replayem.
 */
export function stepPhysics(state: ArcadeState, gravity: number): void {
  let session = sessions.get(state);
  if (session === undefined) {
    const rapier = rapierIfLoaded();
    if (rapier === null) throw new Error('arcade: a world with physics bodies needs loadRapier() before its first step');
    session = new PhysicsSession(rapier, gravity);
    sessions.set(state, session);
    orphans.register(state, session, state);
  }
  session.step(state);
}

/** Uvolní svět Rapieru dohrané instance (volá jádro po konci běhu). */
export function releasePhysics(state: ArcadeState): void {
  const session = sessions.get(state);
  if (session === undefined) return;
  sessions.delete(state);
  orphans.unregister(state);
  session.free();
}
