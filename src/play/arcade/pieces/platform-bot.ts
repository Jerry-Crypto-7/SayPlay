/**
 * Robot plošinovky (P25C, T3) – věrohodný hráč pro ověření hratelnosti.
 *
 * Svět vidí 8 tiků starý (`reactionTicks`), vlastní pohyb si ale dopočítá
 * z toho, co od té doby zmáčkl (ví, že běží). Na zemi běží vpravo, před
 * hrotem zpomalí a skočí, u hrany propasti skočí, u pohyblivé plošiny počká,
 * až přijede. Ve vzduchu řídí tak, aby odhadnuté místo dopadu leželo na
 * úseku cílové plošiny bez hrotu. Plošiny a hroty čte z geometrie (role,
 * obrys, rychlost), ne z generátoru.
 */

import { z } from 'zod';

import { AXIS_MAX, type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, ROLE, bodyBase } from '../contract';
import { GRAVITY } from '../kernel';
import { PLATFORM, riseTicks } from './platform';

const REACTION = 8;
/** Odraz, když je střed hráče (odhad) tolik před hranou. */
const EDGE_LEAD = 350;
/** Skok přes hrot, když je přední hrana hráče tolik před hrotem – plus dráha výstupu nad hrot. */
const SPIKE_LEAD = 150;
/** Tiků, než skok vystoupá nad hrot s rezervou. */
const CLEAR_SPIKE_TICKS = riseTicks(PLATFORM.spikeH + 150);
/** Rychlost (osa) při přibližování k hrotu. */
const SPIKE_APPROACH = 600;
/** Odstup místa dopadu od hrotu a od hrany plošiny. */
const SPIKE_PAD = 600;
const EDGE_PAD = 350;
/** Pohyblivá plošina je „u nás“, když je její bližší hrana tolik za hranou. */
const SHUTTLE_READY = 700;

const S = BODY;
const F = FLAG;
const PL = PLATFORM;
const baseOf = bodyBase;

interface Slab {
  readonly near: number;
  readonly far: number;
  readonly center: number;
  readonly top: number;
  readonly vz: number;
  readonly moving: boolean;
}

interface Spike {
  readonly near: number;
  readonly far: number;
}

function scan(state: Int32Array, player: number): { slabs: Slab[]; spikes: Spike[] } {
  const slabs: Slab[] = [];
  const spikes: Spike[] = [];
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = baseOf(i);
    const flags = state[base + S.flags] as number;
    if ((flags & F.alive) === 0) continue;
    const role = state[base + S.role] as number;
    const z0 = state[base + S.z] as number;
    const half = (state[base + S.d] as number) / 2;
    if (role === ROLE.platform) {
      slabs.push({ near: z0 - half, far: z0 + half, center: z0, top: (state[base + S.y] as number) + (state[base + S.h] as number), vz: state[base + S.vz] as number, moving: (flags & F.kinematic) !== 0 });
    } else if (role === ROLE.hazard) spikes.push({ near: z0 - half, far: z0 + half });
  }
  return { slabs, spikes };
}

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Vlastní rychlost a poloha „teď“: viděný stav + stisky, které v něm ještě nejsou. */
function ownMotion(z0: number, vz0: number, grounded: boolean, recent: readonly ArcadeInput[]): { z: number; vz: number } {
  let z = z0;
  let vz = vz0;
  for (const input of recent) {
    let target = Math.trunc((input.axis * PL.maxRun) / AXIS_MAX);
    if ((input.buttons & BUTTON.LEFT) !== 0) target = -PL.maxRun;
    if ((input.buttons & BUTTON.RIGHT) !== 0) target = PL.maxRun;
    const rate = target !== 0 ? (grounded ? PL.groundAccel : PL.airAccel) : grounded ? PL.groundFriction : PL.airDrag;
    vz = toward(vz, target, rate);
    z += vz;
  }
  return { z, vz };
}

/** Tiků do dopadu na výšku `top` z viděného `y`, `vy` (jen sestup); `null`, když ji skok nedosáhne. */
function ticksToLand(y: number, vy: number, top: number): number | null {
  let cy = y;
  let cvy = vy;
  for (let t = 1; t < 240; t += 1) {
    cvy -= GRAVITY;
    cy += cvy;
    if (cvy < 0 && cy <= top) return t;
  }
  return null;
}

const move = (axis: number, tap = false): ArcadeInput => ({ buttons: tap ? BUTTON.TAP : 0, axis });

const botParams = z.object({}).strict();

export const platformBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'platform_bot',
  params: botParams,
  roles: ['player', 'platform', 'hazard'],
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }): ArcadeInput => {
    const p = baseOf(player);
    const py = state[p + S.y] as number;
    const vy = state[p + S.vy] as number;
    const grounded = ((state[p + S.flags] as number) & F.grounded) !== 0;
    const tapped = recent.some((input) => (input.buttons & BUTTON.TAP) !== 0);
    const own = ownMotion(state[p + S.z] as number, state[p + S.vz] as number, grounded && !tapped, recent);
    const { slabs, spikes } = scan(state, player);
    const halfD = PL.playerD / 2;
    const onSlab = (slab: Slab, z0: number): boolean => z0 + halfD > slab.near && z0 - halfD < slab.far;

    if (grounded && !tapped) {
      const support = slabs.find((slab) => slab.top === py && onSlab(slab, state[p + S.z] as number));
      if (support === undefined) return move(AXIS_MAX);
      const spike = spikes.filter((s) => s.near > support.near && s.far < support.far && s.far + halfD > own.z).sort((a, b) => a.near - b.near)[0];
      if (spike !== undefined) {
        // Odraz tak brzy, aby hráč nad hrot vystoupal dřív, než k němu doběhne.
        const gapToSpike = spike.near - (own.z + halfD);
        if (gapToSpike <= SPIKE_LEAD + CLEAR_SPIKE_TICKS * Math.max(0, own.vz)) return move(AXIS_MAX, true);
        return move(gapToSpike < 2500 ? SPIKE_APPROACH : AXIS_MAX);
      }
      const next = slabs.filter((slab) => slab !== support && slab.center > support.far).sort((a, b) => a.center - b.center)[0];
      if (next === undefined) return move(AXIS_MAX);

      if (support.moving) {
        // Na pohyblivé plošině: postav se k přední hraně a skoč, až bude u další.
        const off = own.z - (support.far - EDGE_LEAD);
        const ready = support.far + support.vz * REACTION >= next.near - SHUTTLE_READY;
        if (ready && support.vz >= 0 && Math.abs(off) <= 250) return move(AXIS_MAX, true);
        return move(off > 150 ? -AXIS_MAX / 2 : off < -150 ? AXIS_MAX / 2 : 0);
      }
      if (next.moving) {
        // Počkej u hrany, až pohyblivá plošina přijede.
        const waitZ = support.far - EDGE_LEAD - 100;
        const ready = next.near + next.vz * REACTION <= support.far + SHUTTLE_READY;
        if (ready && own.z >= waitZ - 400) return move(AXIS_MAX, true);
        const stopAt = own.z + Math.floor((own.vz * own.vz) / (2 * PL.groundFriction));
        return move(stopAt < waitZ ? AXIS_MAX : 0);
      }
      if (own.z >= support.far - EDGE_LEAD) return move(AXIS_MAX, true);
      return move(AXIS_MAX);
    }

    // Odraz, který robot ještě nevidí: poběž dál, řídit začne, až skok uvidí.
    if (grounded) return move(AXIS_MAX);

    // Ve vzduchu: cíl = nejbližší plošina, na kterou skok dosáhne a která má
    // před námi úsek bez hrotu (střed hráče, s odstupem od hran a hrotů).
    for (const slab of [...slabs].sort((a, b) => a.near - b.near)) {
      const land = ticksToLand(py, vy, slab.top);
      if (land === null) continue;
      const shift = slab.moving ? slab.vz * land : 0;
      const cuts = spikes.filter((s) => s.near >= slab.near && s.far <= slab.far).sort((a, b) => a.near - b.near);
      // Úseky: od hrany k hrotu, mezi hroty, od hrotu k hraně.
      const bounds = [slab.near + halfD + EDGE_PAD, ...cuts.flatMap((s) => [s.near - halfD - SPIKE_PAD, s.far + halfD + SPIKE_PAD]), slab.far - halfD - EDGE_PAD];
      let seg: { lo: number; hi: number } | undefined;
      for (let i = 0; i + 1 < bounds.length && seg === undefined; i += 2) {
        const lo = bounds[i] as number;
        const hi = bounds[i + 1] as number;
        if (hi > lo && hi + shift > own.z) seg = { lo: lo + shift, hi: hi + shift };
      }
      if (seg === undefined) continue;
      const landZ = own.z + own.vz * Math.max(0, land - recent.length);
      if (landZ > seg.hi) return move(-AXIS_MAX);
      if (landZ < seg.lo) return move(AXIS_MAX);
      // Dopad sedí: pustit osu. Odpor vzduchu rychlost ubírá, takže robot
      // dopadne pomalu a stihne zareagovat na hrot, i když ho 8 tiků nevidí.
      return move(0);
    }
    return move(AXIS_MAX);
  },
};
