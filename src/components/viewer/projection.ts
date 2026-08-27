/**
 * Projekce běžícího světa do souřadnic scény.
 *
 * Vykreslení je čistě **zobrazovací**: jediný systém pravidel zůstává
 * `src/ir/` a `src/sim/interpreter.ts`, tenhle soubor z nich jen čte. Proto tu
 * není ani jeden import z `three` a ani jedna React komponenta — projekce je
 * aritmetika nad buňkami mřížky a dá se na ni ptát v Node bez GPU.
 *
 * **Souřadnice se berou z běžícího stavu, ne ze socketu v deklaraci.** Socket
 * je jen výchozí buňka; entita, kterou `moveTo` posune, má buňku jinou a scéna
 * ji musí kreslit tam, kde doopravdy je. Socket zůstává jako záloha pro entitu,
 * kterou běh ještě nezná (první snímek dřív, než doběhne první tik).
 *
 * Mřížka je vycentrovaná na počátek. Kamera pak nemusí znát rozměr světa a
 * rámování vychází stejně pro mřížku 5×5 i 20×12.
 */

import type { EntityPlacement } from '@/sim/interpreter';
import type { WorldDocRuntime } from '@/sim/interpreter';

export type { EntityPlacement };

/** Hrana jedné buňky ve světových jednotkách. */
export const CELL_SIZE = 1;

export interface GridSize {
  readonly width: number;
  readonly height: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Podoba, kterou entita ve scéně dostane.
 *
 * Odvozená z rolí, které zmrazený korpus **skutečně** nese (`actor` 40×,
 * `prop` 13×, `goal` 11×, `collectible` 11×, `agent` 9×, `door` 2×, `plate`
 * 1×, `any` 1×), ne z výčtu vymyšleného dopředu. `wall` mezi nimi není, protože
 * zeď není entita — je to blokovaná buňka layoutu.
 */
export type VisualRole = 'avatar' | 'agent' | 'collectible' | 'goal' | 'gate' | 'trigger' | 'prop';

const VISUAL_BY_ROLE: Readonly<Record<string, VisualRole>> = {
  actor: 'avatar',
  agent: 'agent',
  collectible: 'collectible',
  goal: 'goal',
  door: 'gate',
  plate: 'trigger',
  prop: 'prop',
  any: 'prop',
};

/**
 * Role → podoba. Neznámá role je `prop`, **nikdy výjimka**: model smí vymyslet
 * roli, kterou korpus nemá, a scéna se kvůli tomu nesmí přestat kreslit.
 * Prázdné plátno je horší vada než krychle navíc.
 */
export function visualRoleOf(role: string): VisualRole {
  return VISUAL_BY_ROLE[role] ?? 'prop';
}

/** Buňka mřížky → světové souřadnice. Osa `y` je výška, mřížka leží v rovině `xz`. */
export function cellToWorld(cell: readonly [number, number], grid: GridSize, y = 0): Vec3 {
  return {
    x: (cell[0] - (grid.width - 1) / 2) * CELL_SIZE,
    y,
    z: (cell[1] - (grid.height - 1) / 2) * CELL_SIZE,
  };
}

export interface ProjectedWall {
  readonly cell: readonly [number, number];
  readonly position: Vec3;
}

export interface ProjectedZone {
  readonly name: string;
  readonly center: Vec3;
  readonly width: number;
  readonly depth: number;
}

export interface ProjectedFloor {
  readonly center: Vec3;
  readonly width: number;
  readonly depth: number;
}

export interface ProjectedStatic {
  readonly grid: GridSize;
  readonly floor: ProjectedFloor;
  readonly walls: readonly ProjectedWall[];
  readonly zones: readonly ProjectedZone[];
}

/** Výška zdi. Stojí NA podlaze, takže její střed leží v polovině té výšky. */
export const WALL_HEIGHT = 0.9;

/** Nehybná část scény — podlaha, zdi, zóny. Mění se jen při výměně světa. */
export function projectStatic(world: WorldDocRuntime): ProjectedStatic {
  const grid: GridSize = { width: world.ir.limits.gridWidth, height: world.ir.limits.gridHeight };

  const walls = world.space.blocked.map((cell) => ({
    cell,
    position: cellToWorld(cell, grid, WALL_HEIGHT / 2),
  }));

  const zones = Object.entries(world.space.zones).map(([name, rect]) => {
    // Obdélník `[x, y, šířka, výška]` kryje buňky `x .. x+šířka-1`. Plocha má
    // krýt buňky, ne jejich středy, takže střed sudě široké zóny leží mezi nimi.
    const first = cellToWorld([rect[0], rect[1]], grid);
    const last = cellToWorld([rect[0] + rect[2] - 1, rect[1] + rect[3] - 1], grid);
    return {
      name,
      center: { x: (first.x + last.x) / 2, y: 0, z: (first.z + last.z) / 2 },
      width: rect[2] * CELL_SIZE,
      depth: rect[3] * CELL_SIZE,
    };
  });

  return {
    grid,
    floor: {
      center: { x: 0, y: 0, z: 0 },
      width: grid.width * CELL_SIZE,
      depth: grid.height * CELL_SIZE,
    },
    walls,
    zones,
  };
}

export interface ProjectedEntity {
  readonly stableId: string;
  readonly role: string;
  readonly visual: VisualRole;
  readonly cell: readonly [number, number];
  readonly position: Vec3;
  readonly active: boolean;
  readonly state: string;
  readonly locked: boolean;
}

/** Jak vysoko nad podlahou sedí střed entity dané podoby. */
const ELEVATION: Readonly<Record<VisualRole, number>> = {
  avatar: 0.45,
  agent: 0.45,
  collectible: 0.45,
  goal: 0.06,
  gate: 0.55,
  trigger: 0.03,
  prop: 0.35,
};

export function elevationOf(visual: VisualRole): number {
  return ELEVATION[visual];
}

/**
 * Entity ve světových souřadnicích — **v pořadí deklarace a v plné délce**.
 *
 * Despawnutá entita z pole nevypadne, jen nese `active: false`. Kdyby vypadla,
 * `entities()` by po despawnu vrátilo kratší pole a vypadalo by to jako vada
 * projekce tam, kde je korektní chování světa.
 */
export function projectEntities(
  world: WorldDocRuntime,
  placements: readonly EntityPlacement[],
): ProjectedEntity[] {
  const grid: GridSize = { width: world.ir.limits.gridWidth, height: world.ir.limits.gridHeight };
  const live = new Map(placements.map((placement) => [placement.stableId, placement]));

  return world.ir.entities.map((decl) => {
    const placement = live.get(decl.stableId);
    const socket = world.space.sockets[decl.socket] ?? [0, 0];
    const cell: readonly [number, number] =
      placement === undefined ? socket : [placement.x, placement.y];
    const visual = visualRoleOf(decl.role);

    return {
      stableId: decl.stableId,
      role: decl.role,
      visual,
      cell,
      position: cellToWorld(cell, grid, elevationOf(visual)),
      active: placement?.active ?? true,
      state: placement?.state ?? decl.initialState,
      locked: placement?.locked ?? decl.initialLocked,
    };
  });
}
