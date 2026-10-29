/**
 * Režimy rigu VR (P67 T6): každý z 19 žánrů se ve VR hraje jedním ze čtyř způsobů.
 *
 * - `native` – hraje se rukou ve skutečné velikosti nebo v dosahu ruky (střílečka, hod, bouchání, krájení; P65 T3);
 * - `room` – svět 1:1 až 1:3 kolem stojícího hráče (aréna, obrana, chytání); hrdina se hýbe, hráč ne;
 * - `surround` – trať jako velká diorama před hráčem (T7; do té doby se kreslí jako `desk`);
 * - `desk` – zmenšený svět na stole (P65 T4, `diorama-scale.ts`). Neznámý žánr jde sem.
 *
 * `pose` říká, kde hráč stojí. Režim i póza jsou jen kresba: do hashovaného stavu nejde nic z nich.
 */

import { baseBotOf } from '@/play/arcade/addons';
import { type ArcadeWorld, BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { LANES } from '@/play/arcade/pieces/lanes';
import type { GenreId } from '@/play/genre/contract';

import { playAreaOf } from './diorama-scale';

export type XrMode = 'native' | 'room' | 'surround' | 'desk';

/**
 * Kde hráč stojí:
 * - `behind` – za hrdinou čelem ke hřišti (střílečka, hod);
 * - `reach` – pruhy v dosahu ruky ve výšce pasu (bouchání, krájení);
 * - `center` – ve středu hřiště (aréna);
 * - `base` – u základny za hrdinou, nepřátelé jdou k němu (obrana);
 * - `front` – před pruhy, do kterých věci padají (chytání);
 * - `track` – před tratí, která jede k němu (T7);
 * - `table` – u stolu.
 */
export type XrPose = 'behind' | 'reach' | 'center' | 'base' | 'front' | 'track' | 'table';

export interface XrModeEntry {
  readonly mode: XrMode;
  readonly pose: XrPose;
}

export const XR_MODES: Readonly<Record<GenreId, XrModeEntry>> = {
  runner: { mode: 'surround', pose: 'track' },
  platformer: { mode: 'surround', pose: 'track' },
  arena: { mode: 'room', pose: 'center' },
  voyage: { mode: 'surround', pose: 'track' },
  quest: { mode: 'desk', pose: 'table' },
  shooter: { mode: 'native', pose: 'behind' },
  throw: { mode: 'native', pose: 'behind' },
  timing: { mode: 'desk', pose: 'table' },
  rhythm: { mode: 'desk', pose: 'table' },
  duel: { mode: 'desk', pose: 'table' },
  flap: { mode: 'surround', pose: 'track' },
  catch: { mode: 'room', pose: 'front' },
  whack: { mode: 'native', pose: 'reach' },
  defense: { mode: 'room', pose: 'base' },
  slice: { mode: 'native', pose: 'reach' },
  hop: { mode: 'surround', pose: 'track' },
  crowd: { mode: 'surround', pose: 'track' },
  merge: { mode: 'desk', pose: 'table' },
  push: { mode: 'desk', pose: 'table' },
};

/** Žánr, který tabulka nezná (starý spec bez žánru, nový žánr před svou úlohou VR), hraje na stole. */
export const DESK_MODE: XrModeEntry = { mode: 'desk', pose: 'table' };

export const modeOf = (genre: string | null): XrModeEntry => (genre !== null && Object.hasOwn(XR_MODES, genre) ? XR_MODES[genre as GenreId] : DESK_MODE);

/**
 * Robot žánru → žánr. Svět žánr nenese (spec ano, ale do XR vrstvy nedojde); robota má každý žánr vlastního
 * a obaly doplňků, fází a skládání ho jen balí (`baseBotOf`). Souboj arény má svého robota (`fight_bot`).
 */
const GENRE_OF_BOT: Readonly<Record<string, GenreId>> = {
  runner_bot: 'runner',
  platform_bot: 'platformer',
  arena_bot: 'arena',
  fight_bot: 'arena',
  steer_bot: 'voyage',
  quest_bot: 'quest',
  shooter_bot: 'shooter',
  throw_bot: 'throw',
  timing_bot: 'timing',
  rhythm_bot: 'rhythm',
  duel_bot: 'duel',
  flap_bot: 'flap',
  catch_bot: 'catch',
  whack_bot: 'whack',
  defense_bot: 'defense',
  slice_bot: 'slice',
  hop_bot: 'hop',
  crowd_bot: 'crowd',
  merge_bot: 'merge',
  push_bot: 'push',
};

/** Žánr hratelného světa; `null` = svět bez žánru (starší ovládání `glide`, `walker`, `ball`). */
export function genreOfWorld(world: ArcadeWorld): GenreId | null {
  const id = baseBotOf(world.bot).id;
  return Object.hasOwn(GENRE_OF_BOT, id) ? (GENRE_OF_BOT[id] as GenreId) : null;
}

/**
 * Režim `room` v číslech (m skutečného prostoru):
 * - `reach` – stěny hřiště nejvýš tolik od hráče (aréna 40 × 40 m → 1:2,5);
 * - `minScale` – menší než 1:3 svět není; menší je diorama;
 * - `baseBack` – obrana: hráč stojí tolik za startem hrdiny, hradba a pruhy jsou před ním;
 * - `catchAhead` – chytání: pruhy tolik před hráčem;
 * - `catchSide` – chytání: krajní pruh začíná tolik od středu (natažená ruka a půlkrok), z toho měřítko 1:3.
 */
export const ROOM = { reach: 8, minScale: 1 / 3, baseBack: 1.5, catchAhead: 1.2, catchSide: 1 } as const;

/** Kde stojí svět `room`: měřítko a bod scény (m, osy scény) pod nohama hráče. Po celou hru stejné. */
export interface RoomPlacement {
  readonly scale: number;
  readonly anchor: { readonly x: number; readonly z: number };
  /** Nejvzdálenější stěna hřiště od hráče podél os (m skutečného prostoru). */
  readonly reach: number;
}

/**
 * Svět `room` kolem hráče. Počítá se jen ze startu úrovně (`world.initial`), takže se za hry nehne: hráč se nikdy
 * nepohne bez vlastního pohybu, hýbe se hrdina.
 *
 * - `center` (aréna): střed hřiště pod hráčem, měřítko tak, aby stěny byly nejvýš `ROOM.reach` od něj;
 * - `base` (obrana): 1:1, hráč `ROOM.baseBack` za startem hrdiny;
 * - `front` (chytání): pruhy `ROOM.catchAhead` před hráčem, krajní pruh začíná `ROOM.catchSide` od středu.
 */
export function roomOf(pose: XrPose, world: ArcadeWorld): RoomPlacement {
  const area = playAreaOf(world);
  const state = world.initial;
  const hero = bodyBase(state[HEADER.player] as number);
  // Osy scény: x zrcadlí jádro.
  const start = { x: -(state[hero + BODY.x] as number) / UNIT, z: (state[hero + BODY.z] as number) / UNIT };
  let scale = 1;
  let anchor = { x: start.x, z: start.z - ROOM.baseBack };
  if (pose === 'center') {
    const half = Math.max(area.maxX - area.minX, area.maxZ - area.minZ) / 2;
    scale = Math.min(1, Math.max(ROOM.minScale, ROOM.reach / half));
    anchor = { x: (area.minX + area.maxX) / 2, z: (area.minZ + area.maxZ) / 2 };
  } else if (pose === 'front') {
    // Hranice krajního pruhu leží půl druhého rozestupu od středu.
    scale = Math.min(1, Math.max(ROOM.minScale, ROOM.catchSide / ((1.5 * LANES.width) / UNIT)));
    anchor = { x: start.x, z: start.z - ROOM.catchAhead / scale };
  }
  const reach = scale * Math.max(anchor.x - area.minX, area.maxX - anchor.x, anchor.z - area.minZ, area.maxZ - anchor.z);
  return { scale, anchor, reach };
}
