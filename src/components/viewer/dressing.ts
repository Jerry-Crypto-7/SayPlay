/**
 * Výzdoba světa — které kusy kitu se do vygenerovaného světa postaví a kam.
 *
 * Do 20. 8. 2026 kit ve vygenerovaném světě nefiguroval vůbec: plátno umělo
 * postavit ručně skládaný layout (`buildLayoutScene`), ale svět z promptu se
 * kreslil z holých primitiv. Tenhle soubor to zavírá a drží se čtyř pravidel:
 *
 * 1. **Je to zobrazovací vrstva, ne pravidla.** Odsud se do `src/ir/` a
 *    `src/sim/interpreter.ts` jen čte. Výzdoba nemění, co svět dělá — mění to,
 *    jak vypadá. Kdyby se sem dostalo rozhodování, existují dva systémy
 *    pravidel a jeden z nich nikdo neověřuje.
 * 2. **Hrací entity si tvar nemění.** `avatar`, `agent`, `collectible`, `goal`,
 *    `gate` a `trigger` kreslí dál `geometryFor` ve `WorldScene.tsx`. Kit se
 *    obléká jen na podlahu, zdi, zóny a entity s rolí `prop` — tedy na kulisu.
 *    Podoby hracích entit prošly bránou fáze 1 nepotvrzené a přehazovat je
 *    mimochodem by tu nejistotu jen prohloubilo.
 * 3. **Náhoda jde výhradně přes `pure-rand`, a přes vlastní stream.** Semínko
 *    se odvodí z deklarace světa, takže tatáž věta dá tentýž svět i tutéž
 *    výzdobu. Stream si vyrábí tenhle soubor sám; ze streamů běhového runtimu
 *    se neodebere ani jedna hodnota, jinak by výzdoba spotřebovávala hashovaný
 *    stav a replay by přestal sedět.
 * 4. **Žádný import z `three` a žádná React komponenta.** Výzdoba je aritmetika
 *    nad buňkami mřížky — vrací id kusů a souřadnice, ne geometrii. Proto se na
 *    ni dá zeptat ve vitestu bez GPU, což je jediný způsob, jak se determinismus
 *    dá vůbec změřit.
 *
 * **Kde tenhle soubor NESMÍ bydlet:** v `src/kit/**`. Důkaz izolace fallbacku
 * (`npm run prove:fallback`) skenuje kit na cesty do jádra a `src/sim/rng.ts`
 * jádro je. Kit musí jít postavit ve stromu, kde `src/sim/` není.
 */

import type { WorldDocRuntime } from '@/sim/interpreter';
import { hashWords } from '@/sim/hash';
import { createStreams, nextInt } from '@/sim/rng';

import { visualRoleOf } from './projection';

/** Čím kus ve scéně je. Rozhoduje o tom, jak vysoko sedí a jestli se hýbe. */
export type DressingKind = 'floor' | 'wall' | 'zone' | 'scatter';

export interface DressingPlacement {
  readonly kind: DressingKind;
  /** Id kusu z `KIT`. */
  readonly piece: string;
  readonly cell: readonly [number, number];
  /** Otočení kolem osy Y ve čtvrtinách otáčky, 0–3. */
  readonly yaw: number;
}

export interface DressingPlan {
  /** Odvozené z deklarace světa — tentýž svět dá totéž číslo. */
  readonly seed: number;
  /** Nehybná část výzdoby. Zapisuje se jednou při stavbě scény. */
  readonly statics: readonly DressingPlacement[];
  /** `stableId` entity s rolí `prop` → id kusu, který nosí. Hýbe se s entitou. */
  readonly props: Readonly<Record<string, string>>;
  /** Všechna použitá id kusů, každé právě jednou, seřazená. Jedno id = jedna dávka. */
  readonly pieces: readonly string[];
}

/**
 * Podlaha. Kit má právě jednu plochou dlaždici, takže se tu nelosuje — losovat
 * z jednoprvkové sady by spotřebovalo hodnotu ze streamu a nic nerozhodlo.
 */
const FLOOR_PIECE = 'panel.floor';

/** Zeď je celá buňka, takže sem patří jen kusy, které buňku vyplní. */
const WALL_PIECES = ['mass.block', 'mass.bevel', 'mass.stack', 'mass.plinth'] as const;

/** Rohové značky zóny. Svislé a útlé, aby zónu ohraničily a nezakryly. */
const ZONE_PIECES = ['fixture.lamp', 'column.post', 'fixture.sign', 'column.capital'] as const;

/** Kulisa na entitách s rolí `prop`. */
const PROP_PIECES = [
  'fixture.crate',
  'fixture.barrel',
  'fixture.hatch',
  'fixture.bench',
  'fixture.pipe',
  'fixture.terminal',
  'organic.boulder',
  'organic.cluster',
] as const;

/** Drobnosti rozházené po volných buňkách. Nízké, aby se přes ně dalo dívat. */
const SCATTER_PIECES = ['organic.pebble', 'organic.reed', 'organic.shrub'] as const;

/** Na kolika volných buňkách z devíti se objeví drobnost. */
const SCATTER_ODDS = 9;

function pick<T>(pool: readonly T[], stream: Parameters<typeof nextInt>[0]): T {
  return pool[nextInt(stream, 0, pool.length - 1)];
}

function cellKey(cell: readonly [number, number]): string {
  return `${cell[0]},${cell[1]}`;
}

/**
 * Semínko výzdoby z deklarace světa.
 *
 * Bere jen to, co svět **popisuje** — mřížku, zdi, sockety, zóny a role entit.
 * Ne běhový stav: výzdoba se staví jednou při výměně světa a nesmí se hnout,
 * když se hráč pohne. FNV-1a je tentýž, jakým se hashuje stav (`src/sim/hash.ts`);
 * druhá implementace hashe by byla druhé místo, kde se to rozejde.
 */
export function dressingSeed(world: WorldDocRuntime): number {
  const parts = [
    `${world.ir.limits.gridWidth}x${world.ir.limits.gridHeight}`,
    world.space.blocked.map(cellKey).join(';'),
    Object.keys(world.space.sockets)
      .sort()
      .map((name) => `${name}=${cellKey(world.space.sockets[name])}`)
      .join(';'),
    Object.keys(world.space.zones)
      .sort()
      .map((name) => `${name}=${world.space.zones[name].join(',')}`)
      .join(';'),
    world.ir.entities.map((decl) => `${decl.stableId}:${decl.role}`).join(';'),
  ];

  const text = parts.join('|');
  return hashWords(Uint32Array.from(text, (char) => char.charCodeAt(0)));
}

/**
 * Rozhodne, co kde stojí.
 *
 * **Pořadí odběrů ze streamu je součást kontraktu**, ne detail: zdi → rohy zón
 * → propy → drobnosti. Prohození dvou bloků je jiná výzdoba téhož světa, takže
 * by se rozešly dva běhy, které si mají odpovídat. Uvnitř bloků rozhoduje pevné
 * pořadí zdrojových dat — pole `blocked`, jména zón seřazená, entity v pořadí
 * deklarace a buňky po řádcích.
 */
export function planDressing(world: WorldDocRuntime): DressingPlan {
  const seed = dressingSeed(world);
  const stream = createStreams(seed).layout;

  const width = world.ir.limits.gridWidth;
  const height = world.ir.limits.gridHeight;

  const blocked = new Set(world.space.blocked.map(cellKey));
  const taken = new Set(blocked);
  for (const socket of Object.values(world.space.sockets)) taken.add(cellKey(socket));

  const statics: DressingPlacement[] = [];

  for (const cell of world.space.blocked) {
    statics.push({ kind: 'wall', piece: pick(WALL_PIECES, stream), cell, yaw: nextInt(stream, 0, 3) });
  }

  for (const name of Object.keys(world.space.zones).sort()) {
    const [x, y, zoneWidth, zoneHeight] = world.space.zones[name];
    const corners: (readonly [number, number])[] = [
      [x, y],
      [x + zoneWidth - 1, y],
      [x, y + zoneHeight - 1],
      [x + zoneWidth - 1, y + zoneHeight - 1],
    ];

    for (const cell of corners) {
      // Roh mimo mřížku nebo obsazený zdí či socketem se přeskakuje — značka
      // zóny nesmí zakrýt to, co ve světě něco znamená. Los se přesto odebere,
      // aby vynechaný roh neposunul výzdobu zbytku světa.
      //
      // **Tohle je zároveň jediný důvod, proč se nemusí zvlášť řešit zóny o
      // jedné buňce.** `buildZones` (`src/ir/surface.ts:122`) vyrobí obdélník
      // 1×1 z každého socketu, takže všechny čtyři jeho rohy padnou na tentýž
      // socket — a ten je v `taken` od začátku. Značka na místě, kde startuje
      // hráč, tedy nevznikne, a nepotřebuje k tomu vlastní podmínku.
      const piece = pick(ZONE_PIECES, stream);
      const yaw = nextInt(stream, 0, 3);
      const outside = cell[0] < 0 || cell[1] < 0 || cell[0] >= width || cell[1] >= height;
      if (outside || taken.has(cellKey(cell))) continue;
      taken.add(cellKey(cell));
      statics.push({ kind: 'zone', piece, cell, yaw });
    }
  }

  const props: Record<string, string> = {};
  for (const decl of world.ir.entities) {
    if (visualRoleOf(decl.role) !== 'prop') continue;
    props[decl.stableId] = pick(PROP_PIECES, stream);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell: readonly [number, number] = [x, y];
      if (blocked.has(cellKey(cell))) continue;
      statics.push({ kind: 'floor', piece: FLOOR_PIECE, cell, yaw: 0 });
      if (taken.has(cellKey(cell))) continue;
      if (nextInt(stream, 0, SCATTER_ODDS - 1) !== 0) continue;
      statics.push({
        kind: 'scatter',
        piece: pick(SCATTER_PIECES, stream),
        cell,
        yaw: nextInt(stream, 0, 3),
      });
    }
  }

  const used = new Set(statics.map((placement) => placement.piece));
  for (const piece of Object.values(props)) used.add(piece);

  return { seed, statics, props, pieces: [...used].sort() };
}
