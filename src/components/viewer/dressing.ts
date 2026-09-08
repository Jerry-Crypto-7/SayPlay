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

import { familyForSeed as familyFromSeed } from '@/geom/family-choice';
import type { WorldDocRuntime } from '@/sim/interpreter';
import { hashWords } from '@/sim/hash';
import { createStreams, nextInt } from '@/sim/rng';

import { visualRoleOf } from './projection';

/** Čím kus ve scéně je. Rozhoduje o tom, jak vysoko sedí a jestli se hýbe. */
export type DressingKind = 'floor' | 'wall' | 'zone' | 'scatter' | 'fill';

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
  /** Id výtvarné rodiny, ze které se postaví kulisa za hrací plochou. */
  readonly family: string;
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

/**
 * Výplň — pás kusů **za** hranou mřížky, jeden pool na prstenec.
 *
 * Do 27. 8. 2026 končil svět hranou hrací plochy a za ní byla prázdnota:
 * vygenerovaný svět kreslil 8 700 až 11 400 trojúhelníků ze stropu 120 000,
 * tedy pod desetinu rozpočtu, a valnou většinu z toho nesly dlaždice podlahy.
 * Tohle je ta hustota, kterou hrací plocha dodat nemůže — kusů uvnitř mřížky je
 * pevný počet a mají svoji roli.
 *
 * **Pořadí polí je pořadí prstenců od mřížky ven a je to jediné, co určuje
 * výšku.** Nejbližší prstenec nese jen přízemní kusy (nic přes 0,95 pole), aby
 * hrací plochu nezakryl, a teprve venku se staví vysoké. `FILL_RINGS` se z pole
 * odvozuje, ne píše zvlášť — dvě čísla by se rozešla a poslední prstenec by
 * zůstal bez kusů, nebo by pool přebyl.
 */
const FILL_PIECES = [
  ['organic.pebble', 'organic.boulder', 'organic.shrub', 'fixture.crate'],
  ['organic.cluster', 'mass.stack', 'fixture.barrel', 'fixture.hatch'],
  ['organic.tree', 'column.broken', 'column.fluted', 'arch.round'],
] as const;

/**
 * Kolik prstenců buněk kolem mřížky výplň zabírá.
 *
 * Čte to i kulisa (`scenery.ts`), aby začínala až za posledním prstencem —
 * jinak by krajina ležela na výplni. Proto je to export, ne lokální konstanta.
 */
export const FILL_RINGS = FILL_PIECES.length;

/**
 * Výtvarná rodina kulisy **pro svět bez věty**.
 *
 * Počítá se ze **semínka**, ne ze streamu. Odběr navíc by posunul všechny
 * následující losy, takže by tatáž věta dala jinou výzdobu než včera — a pořadí
 * odběrů je podle `planDressing` součást kontraktu, ne detail.
 *
 * Od vlny 3 T3 je to **záloha, ne hlavní cesta**: rodinu vybírá `look` emise
 * (`chooseFamily` v `@/geom/family-choice`) a na semínko se padá teprve tehdy,
 * když v něm není jediné známé slovo. Tělo je proto přeposlání — druhá definice
 * téhož výpočtu by se rozešla přesně tam, kam se nikdo nedívá.
 */
export function familyForSeed(seed: number): string {
  return familyFromSeed(seed);
}

function pick<T>(pool: readonly T[], stream: Parameters<typeof nextInt>[0]): T {
  return pool[nextInt(stream, 0, pool.length - 1)];
}

function cellKey(cell: readonly [number, number]): string {
  return `${cell[0]},${cell[1]}`;
}

/**
 * Buňky `ring`-tého prstence kolem mřížky, po řádcích.
 *
 * Prstenec 1 přiléhá k mřížce, takže žádná vrácená buňka do mřížky nespadá a
 * dva prstence se nepřekrývají — je to obvod obdélníku zvětšeného o `ring`.
 * Pořadí je pevné (řádky, v nich sloupce), aby se výplň dvou běhů nerozešla.
 */
function ringCells(width: number, height: number, ring: number): (readonly [number, number])[] {
  const cells: (readonly [number, number])[] = [];
  const last = { x: width + ring - 1, y: height + ring - 1 };

  for (let y = -ring; y <= last.y; y += 1) {
    for (let x = -ring; x <= last.x; x += 1) {
      if (x === -ring || y === -ring || x === last.x || y === last.y) cells.push([x, y]);
    }
  }

  return cells;
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

  // Výplň je až za dlaždicemi schválně. Pořadí odběrů ze streamu je součást
  // kontraktu, takže nový blok patří na konec — jinak by se posunula výzdoba
  // hrací plochy, kterou tahle úloha měnit nemá.
  FILL_PIECES.forEach((pool, index) => {
    for (const cell of ringCells(width, height, index + 1)) {
      statics.push({ kind: 'fill', piece: pick(pool, stream), cell, yaw: nextInt(stream, 0, 3) });
    }
  });

  const used = new Set(statics.map((placement) => placement.piece));
  for (const piece of Object.values(props)) used.add(piece);

  return { seed, statics, props, pieces: [...used].sort(), family: familyForSeed(seed) };
}
