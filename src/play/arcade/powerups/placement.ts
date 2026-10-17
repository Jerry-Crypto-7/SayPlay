/**
 * Rozmístění power-upů (P46C T2): 2–4 na hru, jen v nové hře žánru (`POWERUP_GENRE_VERSION`),
 * náhoda z proudu `layout` jen při stavbě. Místa leží tam, kudy hráč i robot jede: volný úsek
 * pruhu běžce, osa trati řízení, horní hrana plošiny skákačky, pole arény. Druh podle žánru:
 * řízení nemá magnet (sbírá jen turba) ani zrychlení (rychlost se v něm sčítá), skákačka nemá
 * zrychlení (skok by přeletěl `jumpReach`), aréna nemá zrychlení ani 2× (sbírá `arena_eat`).
 */

import { createCompileRng } from '@/play/compile/rng';
import type { GameSpecV1 } from '@/play/spec';

import { harmOf } from '../abilities';
import { type ArcadeParts, baseControlOf } from '../addons';
import { ARCADE_LIMITS, type BodyInit, type PowerupId, UNIT } from '../contract';
import { genreAtLeast } from '../pieces/pacing-parts';
import { ARENA } from '../pieces/arena';
import { RUNNER } from '../pieces/runner';
import { centerAt, courseOf, steerRoute } from '../pieces/steer';
import { POWERUP_SIZE, type PlacedPowerup, applyPowerups } from '.';

/** Verze překladu žánru, od které hra power-upy má (`GENRE_COMPILER_VERSION`); uložené starší hrají jako dřív. */
export const POWERUP_GENRE_VERSION = 'genre.v3';

/**
 * Druhy power-upů podle základního ovládání (generátory téhož ovládání sdílí tvar úrovně); ovládání mimo tabulku je nemá.
 * Běžec nemá zrychlení: začátečník s ním narazí dřív a run.escape spadl z 6/20 na 5/20 (pod pásmo 0,3) – power-up hru ztížil.
 */
export const POWERUP_KINDS: Readonly<Record<string, readonly PowerupId[]>> = {
  runner: ['magnet', 'shield', 'double'],
  platform: ['magnet', 'shield', 'double'],
  steer: ['shield', 'double'],
  move_free: ['magnet', 'shield'],
};

/** Zrychlení běžce: o čtvrtinu, jen vpřed. */
const RUNNER_SPEED = { pct: 25 } as const;
/** Podložka řízení je široká jako turbo: auto ji na ose trati nemine. */
const STEER_PAD = 1500;
/** Podložka v čistém útěku: robot jen utíká, širší ji sebere v 19 z 20 her, 0,8 m v 15 (arena.escape/base). */
const ESCAPE_PAD = 2 * UNIT;
/** Skákačka nejvýš 3 power-upy: se čtyřmi vyhrál začátečník 0,72 (žába, 60 semínek), nad pásmem 0,7. */
const PLATFORM_MOST = 3;

const SALT = 0x9e37;

/** Má hra power-upy? Jen nová hra žánru, ne složená (díly P42). */
export const wantsPowerups = (spec: GameSpecV1): boolean => genreAtLeast(spec, POWERUP_GENRE_VERSION) && spec.assemblyParts === undefined;

type Rng = ReturnType<typeof createCompileRng>;
type Spot = Omit<PlacedPowerup, 'id'> & { readonly size?: number };

const live = (bodies: readonly BodyInit[]): BodyInit[] => bodies.slice(1).filter((body) => body.template !== true && body.role !== 'goal');

/** Je místo volné: žádné tělo blíž než `gapX` napříč a `gapZ` podél? */
const clear = (bodies: readonly BodyInit[], x: number, z: number, gapX: number, gapZ: number): boolean =>
  bodies.every((body) => Math.abs(body.x - x) >= body.w / 2 + gapX || Math.abs(body.z - z) >= body.d / 2 + gapZ);

/** Z kandidátů vybere `count` rozložených po trati: jeden náhodný z každé `count`-tiny. */
function spread<T extends { readonly z: number }>(candidates: readonly T[], count: number, rng: Rng): T[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => a.z - b.z);
  const picked: T[] = [];
  for (let k = 0; k < count; k += 1) {
    const window = sorted.slice(Math.floor((k * sorted.length) / count), Math.floor(((k + 1) * sorted.length) / count));
    if (window.length > 0) picked.push(window[rng.int(0, window.length - 1)] as T);
  }
  return picked;
}

function runnerSpots(parts: ArcadeParts, count: number, rng: Rng): Spot[] {
  const { length } = parts.level;
  const others = live(parts.level.bodies);
  const candidates: Spot[] = [];
  for (let z = Math.floor(0.15 * length); z <= 0.8 * length; z += 1500) {
    for (const lane of [-1, 0, 1]) {
      const x = lane * RUNNER.laneWidth;
      if (clear(others, x, z, POWERUP_SIZE / 2 + 200, 2500)) candidates.push({ x, y: 300, z });
    }
  }
  return spread(candidates, count, rng);
}

function platformSpots(parts: ArcadeParts, count: number, rng: Rng): Spot[] {
  const pads = parts.level.bodies.filter((body) => body.role === 'platform' && body.template !== true && body.kinematic !== true).sort((a, b) => a.z - b.z);
  // Bez startu a poslední plošiny: power-up patří do cesty, ne na start nebo k cíli.
  return spread(pads.slice(1, -1).map((pad) => ({ x: pad.x, y: pad.y + pad.h, z: pad.z })), count, rng);
}

function steerSpots(parts: ArcadeParts, count: number, rng: Rng): Spot[] {
  const { length } = parts.level;
  const course = courseOf(parts.level);
  const route = steerRoute(parts.level);
  // Místo berou jen tělesa, která zasahují na trasu; mantinely, břehy a ostrůvky rozcestí ji jen lemují.
  const onRoute = (body: BodyInit): boolean => route.some((segment) => body.z >= segment.near && body.z < segment.far && Math.abs(body.x - segment.center) * 2 < segment.width + body.w);
  const risky = live(parts.level.bodies).filter((body) => (body.role === 'obstacle' || body.role === 'hazard' || body.role === 'enemy' || body.role === 'collectible') && onRoute(body));
  const candidates: Spot[] = [];
  for (let z = Math.floor(0.15 * length); z <= 0.8 * length; z += 2000) {
    if (risky.every((body) => Math.abs(body.z - z) >= body.d / 2 + 4 * UNIT)) candidates.push({ x: centerAt(course, z), y: 0, z, size: STEER_PAD });
  }
  return spread(candidates, count, rng);
}

function arenaSpots(parts: ArcadeParts, count: number, rng: Rng): Spot[] {
  const half = (baseControlOf(parts.control).params as { readonly half?: number }).half ?? ARENA.half;
  const hero = parts.level.bodies[0] as BodyInit;
  const others = live(parts.level.bodies);
  // Čistý útěk (bez mincí): robot k power-upu neodbočí, sebere ho jen v cestě – proto širší podložka.
  const pad = parts.level.bodies.some((body) => body.role === 'collectible' && body.template !== true) ? {} : { size: ESCAPE_PAD };
  const reach = Math.floor(0.6 * half);
  const spots: Spot[] = [];
  for (let tries = 0; tries < 40 && spots.length < count; tries += 1) {
    const x = rng.int(-reach, reach);
    const z = rng.int(-reach, reach);
    const apart = (ax: number, az: number, gap: number): boolean => (ax - x) ** 2 + (az - z) ** 2 >= gap ** 2;
    const far = apart(hero.x, hero.z, 5 * UNIT) && spots.every((spot) => apart(spot.x, spot.z, 6 * UNIT));
    if (far && clear(others, x, z, 2 * UNIT, 2 * UNIT)) spots.push({ x, y: 0, z, ...pad });
  }
  return spots;
}

const SPOTS: Readonly<Record<string, (parts: ArcadeParts, count: number, rng: Rng) => Spot[]>> = {
  runner: runnerSpots,
  platform: platformSpots,
  steer: steerSpots,
  move_free: arenaSpots,
};

/**
 * Power-upy do hotových částí hry (po doplňcích a akcích). Druh má smysl, jen když ho hra
 * využije: magnet a 2× potřebují sbírané věci, štít náraz. Strop pravidel jádra platí:
 * power-upy dostanou jen místo, které po nich zbude pravidlům specu, časovači a skóre –
 * nejdřív ustoupí štít (jedno pravidlo), pak všechny.
 */
export function placePowerups(parts: ArcadeParts, spec: GameSpecV1, seed: number): ArcadeParts {
  const control = baseControlOf(parts.control).id;
  const kinds = POWERUP_KINDS[control];
  const spotsOf = SPOTS[control];
  if (kinds === undefined || spotsOf === undefined || (parts.issues?.length ?? 0) > 0) return parts;
  const items = parts.level.bodies.some((body) => body.role === 'collectible' && body.template !== true);
  const pickup = parts.rules.some((rule) => rule.id === 'pickup') ? 0 : 1;
  const reserved = (spec.rules?.length ?? 0) + 2;
  const room = ARCADE_LIMITS.maxRules - parts.rules.length - reserved - pickup;
  const usable = kinds.filter((id) => (id === 'shield' ? room >= 1 && harmOf(parts).length > 0 : id === 'magnet' || id === 'double' ? items : true));
  if (room < 0 || usable.length === 0) return parts;
  const rng = createCompileRng(seed ^ SALT, 'layout');
  const spots = spotsOf(parts, rng.int(2, control === 'platform' ? PLATFORM_MOST : 4), rng);
  if (spots.length === 0) return parts;
  const placed = spots.map((spot) => ({ ...spot, id: usable[rng.int(0, usable.length - 1)] as PowerupId }));
  return applyPowerups(parts, placed, control === 'runner' ? RUNNER_SPEED : undefined);
}
