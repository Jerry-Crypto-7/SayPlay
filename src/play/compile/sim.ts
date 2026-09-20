/**
 * Základ povrchového `sim` z rozvržení (P23-A, T3).
 *
 * Každá instance role je entita **a** soket téhož jména – `sys.moveTo.<entita>`
 * (`src/ir/build.ts:273`) tak umí hráče poslat ke každé z nich a soket je zároveň
 * zóna 1×1 (`buildZones`), takže `onEnterZone(player, <instance>)` platí bez
 * další deklarace. Role, které žijí jako širší zóna (2×2), přidají obdélník do
 * `state.zones` pod týmž jménem; `inZone` je pak `anyOf` soketu a obdélníku.
 *
 * Entita nese `role` = ID role ze specu, ne druh: `onPickup {role}` tím zasáhne
 * všechny instance jedné role a `countInZone {tag}` počítá touž skupinu.
 */

import type { RoleBinding } from '../contracts';
import type { GameRole, GameSpecV1 } from '../spec';
import { type Layout, ZONE_KINDS, roleInstanceId } from './layout';
import type { SurfaceEntity, SurfaceSim } from './types';

export const PLAYER_SOCKET = 'spawn';
/** Krátký tier a jeho strop – hry na 30–180 s hrané svědkem se vejdou. */
export const WITNESS_HORIZON = 600;

/** Výchozí stav entity podle druhu role; adaptéry stavy přepínají `setState`. */
const INITIAL_STATE: Readonly<Record<GameRole['kind'], string>> = {
  player: 'idle',
  exit: 'open',
  collectible: 'present',
  key: 'present',
  door: 'closed',
  switch: 'off',
  hazard: 'on',
  chaser: 'hunting',
  patrol: 'walking',
  item: 'present',
  destination: 'waiting',
  checkpoint: 'pending',
  target: 'alive',
  prop: 'idle',
  zone: 'idle',
};

export function baseSim(spec: GameSpecV1, layout: Layout): { sim: SurfaceSim; roles: RoleBinding[]; player: string } {
  const sockets: Record<string, readonly [number, number]> = {};
  const collisionAabb: Record<string, readonly [number, number, number, number]> = {};
  const entities: Record<string, SurfaceEntity> = {};
  const zones: Record<string, readonly (readonly [number, number, number, number])[]> = {};
  const roles: RoleBinding[] = [];
  let player = '';

  for (const role of spec.roles) {
    const entityIds: string[] = [];
    const roleZones: string[] = [];
    for (let i = 0; i < role.count; i += 1) {
      const id = roleInstanceId(role, i);
      const cell = layout.cells.get(id) as readonly [number, number];
      const isPlayer = role.kind === 'player';
      const socket = isPlayer ? PLAYER_SOCKET : id;
      sockets[socket] = cell;
      entities[id] = { role: isPlayer ? 'actor' : role.id, socket, state: INITIAL_STATE[role.kind] };
      if (isPlayer) player = id;
      const rect = layout.zones[id];
      collisionAabb[id] = rect ?? [cell[0], cell[1], 1, 1];
      if (rect !== undefined && ZONE_KINDS.includes(role.kind)) {
        roleZones.push(id);
        // Soket 1×1 už zónu téhož jména tvoří; obdélník se přidá jen, když je širší.
        if (rect[2] > 1 || rect[3] > 1) zones[id] = [rect];
      }
      entityIds.push(id);
    }
    roles.push({ roleId: role.id, entityIds, zones: roleZones, sockets: entityIds.map((id) => (id === player ? PLAYER_SOCKET : id)) });
  }

  const sim: SurfaceSim = {
    layout: { width: layout.width, height: layout.height },
    grid: { cell: 1 },
    sockets,
    collisionAabb,
    entities,
    state: { counters: {}, flags: {}, timers: {}, zones, slots: 0, pool: {} },
    rules: {},
    witness: { tier: 'short', H_cert: WITNESS_HORIZON, ops: [] },
  };
  return { sim, roles, player };
}
