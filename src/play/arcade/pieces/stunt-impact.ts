/**
 * Náraz do hromady a trosky závodu s triky (P68V T2).
 *
 * **Hromada** jsou 3–6 krabic Rapieru (`FLAG.physics`, nepevné), živé od tiku 0 – svět má fyzikální těleso od začátku,
 * takže se Rapier přednačte (`worldHasPhysics`). Auto Rapier nezná (hráč zůstává kinematický), a tak náraz rozhoduje
 * jádro: pravidlo `stunt_impact` (tik, po fázi Rapieru a kolizích) změří celočíselným AABB, zda se auto v tomto tiku
 * protíná s živou krabicí hromady. Když ano, celá hromada se v **témže tiku** rozletí: každá krabice zhasne a na jejím
 * místě vznikne troska z předlohy (`spawn`) s rychlostí z rychlosti auta a řádku pevné tabulky rozptylu (stream
 * `stunt`). Rapier trosku převezme v příštím kroku i s rychlostí (`create` → `teleport`); solver, tření ani podkroky
 * se nemění. Pravidlo stav samo nemění – jen vydá efekty `despawn` a `spawn`, jako každé pravidlo jádra.
 *
 * **Rozpočet:** živých trosek je nejvýš `debrisMax` (8); krabice nad rozpočet jen zhasne (rozbije se na prach, který
 * kreslí scéna z efektu `despawn`). Troska je každé živé tělo od `spawnBase` – spawn bere první mrtvý slot odtud, takže
 * slot zhaslé trosky dostane troska další hromady.
 *
 * **Zhasnutí:** `stunt_debris` (tik, za `stunt_impact`) vydá `despawn` trosce, které došly hodiny (HP trosky = zbylé tiky,
 * odpočítává je ovládání `stunt`), propadla pod zem nebo vyletěla za mantinel. `despawn` shodí `FLAG.alive`, Rapier
 * tělo v příštím kroku odebere a slot je volný. Pořadí pravidel (náraz před zhasínáním) zaručí, že slot zhaslý v tiku
 * nevezme troska téhož tiku – Rapier by jí nechal točení staré.
 */

import { z } from 'zod';

import { STUNT_DEBRIS_MAX } from '../../genre/p68-contract';
import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeState, BODY, FLAG, type RulePiece, bodyBase, bodyHp } from '../contract';
import { STEER, centerAt, courseSchema, halfWidthAt } from './steer';
import { STUNT, stuntDebrisOf } from './stunt-track';

const index = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Průnik AABB auta a těla jako v jádře: `x/z` střed, `y` spodek, dotyk hranou není průnik. */
export function touches(state: ArcadeState, a: number, b: number): boolean {
  const p = bodyBase(a);
  const q = bodyBase(b);
  const at = (base: number, slot: number): number => state[base + slot] as number;
  return (
    Math.abs(at(p, BODY.x) - at(q, BODY.x)) * 2 < at(p, BODY.w) + at(q, BODY.w) &&
    Math.abs(at(p, BODY.z) - at(q, BODY.z)) * 2 < at(p, BODY.d) + at(q, BODY.d) &&
    at(p, BODY.y) < at(q, BODY.y) + at(q, BODY.h) &&
    at(q, BODY.y) < at(p, BODY.y) + at(p, BODY.h)
  );
}

const impactParams = z
  .object({
    /** Hromady: první krabice, počet krabic (po sobě) a předloha trosky. */
    piles: z.array(z.object({ first: index, count: z.int().min(1).max(STUNT_DEBRIS_MAX), template: index }).strict()).max(8),
    /** Pevná tabulka rozptylu `[dx, dy, dz]` ze streamu `stunt`; krabice bere řádek podle pořadí mezi krabicemi hromad. */
    scatter: z.array(z.tuple([z.int(), z.int(), z.int()])).min(1).max(32),
    debrisMax: z.int().min(1).max(STUNT_DEBRIS_MAX),
  })
  .strict();
export type StuntImpactParams = z.infer<typeof impactParams>;

/** Rychlost trosky z krabice `box` (pořadí `ordinal`) po nárazu auta `player`. */
function kick(state: ArcadeState, player: number, box: number, ordinal: number, scatter: StuntImpactParams['scatter']): { vx: number; vy: number; vz: number } {
  const p = bodyBase(player);
  const vx = state[p + BODY.vx] as number;
  const vz = Math.max(0, state[p + BODY.vz] as number);
  const [dx, dy, dz] = scatter[ordinal % scatter.length] as [number, number, number];
  const offset = (state[bodyBase(box) + BODY.x] as number) - (state[p + BODY.x] as number);
  const side = offset === 0 ? (ordinal % 2 === 0 ? -1 : 1) : Math.sign(offset);
  const { forwardPct, liftPct } = STUNT.kick;
  return { vx: Math.trunc(vx / 2) + side * STUNT.kick.side + dx, vy: Math.trunc((vz * liftPct) / 100) + dy, vz: Math.trunc((vz * forwardPct) / 100) + dz };
}

/** Náraz do hromady (tik): hromada, jejíž živá krabice se protíná s autem, se v tomto tiku celá rozletí – v rozpočtu. */
export const stuntImpact: RulePiece<StuntImpactParams> = {
  id: 'stunt_impact',
  params: impactParams,
  roles: ['player', 'target'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const hit = params.piles.filter((pile) => {
      for (let k = 0; k < pile.count; k += 1) if (alive(state, pile.first + k) && touches(state, player, pile.first + k)) return true;
      return false;
    });
    if (hit.length === 0) return [];
    let room = params.debrisMax - stuntDebrisOf(state).length;
    const first = params.piles[0]?.first ?? 0;
    const effects: ArcadeEffect[] = [];
    for (const pile of hit) {
      for (let k = 0; k < pile.count; k += 1) {
        const box = pile.first + k;
        if (!alive(state, box)) continue;
        effects.push({ kind: 'despawn', body: box });
        if (room <= 0) continue;
        room -= 1;
        const base = bodyBase(box);
        effects.push({ kind: 'spawn', template: pile.template, x: state[base + BODY.x] as number, y: state[base + BODY.y] as number, z: state[base + BODY.z] as number, ...kick(state, player, box, box - first, params.scatter) });
      }
    }
    return effects;
  },
};

const debrisParams = z.object({ track: courseSchema }).strict();

/** Troska mimo hru: hodiny na nule, pod zemí, za koncem trati nebo za vnější hranou mantinelu. */
export function debrisGone(state: ArcadeState, body: number, track: z.infer<typeof courseSchema>): boolean {
  if (bodyHp(state, body) === 0) return true;
  const base = bodyBase(body);
  const x = state[base + BODY.x] as number;
  const y = state[base + BODY.y] as number;
  const zz = state[base + BODY.z] as number;
  if (y < STUNT.fallY || zz > (track.ends[track.ends.length - 1] ?? 0)) return true;
  return Math.abs(x - centerAt(track, zz)) > halfWidthAt(track, zz) + STEER.wallW;
}

/** Zhasínání trosek (tik): `despawn` = `FLAG.alive` 0, Rapier tělo odebere a slot se vrátí spawnu. */
export const stuntDebris: RulePiece<z.infer<typeof debrisParams>> = {
  id: 'stunt_debris',
  params: debrisParams,
  roles: ['target'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => stuntDebrisOf(state).flatMap((debris): ArcadeEffect[] => (debrisGone(state, debris, params.track) ? [{ kind: 'despawn', body: debris }] : [])),
};
