/**
 * Projekce mřížky do scény — jediná část vykreslení, která se dá změřit bez GPU.
 *
 * Test míří na tři vlastnosti, které rozhodují o tom, jestli je scéna vůbec
 * čitelná, a žádná z nich nejde ověřit snímkem obrazovky:
 *
 * 1. **Mřížka je vycentrovaná na počátek.** Kdyby se kreslila od nuly nahoru,
 *    kamera by musela znát rozměr světa a rámování by se lišilo svět od světa.
 * 2. **Role entity určuje podobu.** `DESIGN-BOOK.md` ani korpus nemají výčet
 *    rolí jako data — bere se z toho, co v korpusu skutečně je, a neznámá role
 *    smí skončit jako `prop`, nikdy jako výjimka. Prázdná scéna je horší než
 *    scéna s krychlí navíc.
 * 3. **Zóna kreslená z obdélníku sedí na buňky, které do ní patří.** Střed
 *    obdélníku o sudé šířce leží mezi buňkami a je to správně — plocha zóny má
 *    krýt buňky, ne jejich středy.
 */

import { describe, expect, it } from 'vitest';

import {
  CELL_SIZE,
  cellToWorld,
  projectStatic,
  projectEntities,
  visualRoleOf,
  type EntityPlacement,
} from '../projection';

import type { WorldDocRuntime } from '@/sim/interpreter';
import type { EntityDecl, IrDoc, IrLimits } from '@/ir/types';

const GRID = { width: 7, height: 5 };

function limits(): IrLimits {
  return {
    maxEntities: 8,
    maxZones: 4,
    maxSlots: 8,
    maxRules: 8,
    maxRuleFiringsPerTick: 16,
    maxQueueDepth: 64,
    maxAgents: 2,
    memorySlotsPerAgent: 2,
    gridWidth: GRID.width,
    gridHeight: GRID.height,
  };
}

function entity(stableId: string, role: string, socket: string): EntityDecl {
  return { stableId, role, socket, states: ['idle'], initialState: 'idle', initialLocked: false };
}

function world(): WorldDocRuntime {
  const ir = {
    irVersion: 'world-ir-v1',
    limits: limits(),
    slots: [],
    entities: [entity('hero', 'actor', 'spawn'), entity('coin0', 'collectible', 'ledge')],
    nodes: [],
    predicates: [],
    effects: [],
    rules: [],
  } as unknown as IrDoc;

  return {
    ir,
    space: {
      sockets: { spawn: [0, 0], ledge: [6, 4] },
      zones: { finish: [4, 3, 2, 2] },
      blocked: [
        [1, 1],
        [2, 1],
      ],
      tags: { hero: 'actor', coin0: 'collectible' },
    },
    trace: [],
  };
}

describe('cellToWorld', () => {
  it('kreslí mřížku vycentrovanou na počátek, ne od nuly nahoru', () => {
    // Střed mřížky 7×5 je buňka [3, 2] a ta musí ležet v počátku.
    expect(cellToWorld([3, 2], GRID)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('krajní buňky leží symetricky kolem počátku', () => {
    const left = cellToWorld([0, 0], GRID);
    const right = cellToWorld([GRID.width - 1, GRID.height - 1], GRID);

    expect(left.x).toBeCloseTo(-right.x, 10);
    expect(left.z).toBeCloseTo(-right.z, 10);
  });

  it('sousední buňky dělí právě jedna velikost buňky', () => {
    const a = cellToWorld([2, 2], GRID);
    const b = cellToWorld([3, 2], GRID);

    expect(b.x - a.x).toBeCloseTo(CELL_SIZE, 10);
    expect(b.z).toBe(a.z);
  });

  it('výška je volitelná a nepřepisuje osu mřížky', () => {
    const raised = cellToWorld([3, 2], GRID, 0.5);

    expect(raised).toEqual({ x: 0, y: 0.5, z: 0 });
  });
});

describe('visualRoleOf', () => {
  it('mapuje role, které jsou ve zmrazeném korpusu doopravdy', () => {
    // Osm rolí, které `grep` nad `evals/frozen/` skutečně najde. Není to výčet
    // z hlavy — role, kterou korpus nemá, by se v testu nedala odůvodnit.
    expect(visualRoleOf('actor')).toBe('avatar');
    expect(visualRoleOf('agent')).toBe('agent');
    expect(visualRoleOf('collectible')).toBe('collectible');
    expect(visualRoleOf('goal')).toBe('goal');
    expect(visualRoleOf('door')).toBe('gate');
    expect(visualRoleOf('plate')).toBe('trigger');
    expect(visualRoleOf('prop')).toBe('prop');
    expect(visualRoleOf('any')).toBe('prop');
  });

  it('neznámá role je prop, ne výjimka', () => {
    // Prázdná scéna je horší chyba než krychle navíc: model smí vymyslet roli,
    // kterou korpus nemá, a scéna se kvůli tomu nesmí přestat kreslit.
    expect(visualRoleOf('teleporter')).toBe('prop');
    expect(visualRoleOf('')).toBe('prop');
  });
});

describe('projectStatic', () => {
  it('podlaha kryje celou mřížku a leží v počátku', () => {
    const floor = projectStatic(world()).floor;

    expect(floor.width).toBeCloseTo(GRID.width * CELL_SIZE, 10);
    expect(floor.depth).toBeCloseTo(GRID.height * CELL_SIZE, 10);
    expect(floor.center).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('zeď stojí přesně na blokované buňce a nikde jinde', () => {
    const walls = projectStatic(world()).walls;

    expect(walls).toHaveLength(2);
    expect(walls[0].cell).toEqual([1, 1]);
    expect(walls[0].position.x).toBeCloseTo(cellToWorld([1, 1], GRID).x, 10);
    expect(walls[0].position.z).toBeCloseTo(cellToWorld([1, 1], GRID).z, 10);
    // Zeď stojí NA podlaze, ne v ní — jinak by z ní koukala půlka.
    expect(walls[0].position.y).toBeGreaterThan(0);
  });

  it('zóna kryje své buňky, ne jejich středy', () => {
    const [zone] = projectStatic(world()).zones;

    expect(zone.name).toBe('finish');
    expect(zone.width).toBeCloseTo(2 * CELL_SIZE, 10);
    expect(zone.depth).toBeCloseTo(2 * CELL_SIZE, 10);
    // Obdélník [4,3] o rozměru 2×2 kryje buňky 4 a 5; jeho střed je mezi nimi.
    const a = cellToWorld([4, 3], GRID);
    const b = cellToWorld([5, 4], GRID);
    expect(zone.center.x).toBeCloseTo((a.x + b.x) / 2, 10);
    expect(zone.center.z).toBeCloseTo((a.z + b.z) / 2, 10);
  });
});

describe('projectEntities', () => {
  const placements: readonly EntityPlacement[] = [
    { stableId: 'hero', x: 3, y: 2, active: true, state: 'idle', locked: false },
    { stableId: 'coin0', x: 6, y: 4, active: true, state: 'idle', locked: false },
  ];

  it('vrací tolik prvků, kolik má dokument entit', () => {
    expect(projectEntities(world(), placements)).toHaveLength(world().ir.entities.length);
  });

  it('každý prvek nese stableId, roli a světové souřadnice', () => {
    const [hero] = projectEntities(world(), placements);

    expect(hero.stableId).toBe('hero');
    expect(hero.role).toBe('actor');
    expect(hero.visual).toBe('avatar');
    expect(hero.cell).toEqual([3, 2]);
    expect(hero.position.x).toBeCloseTo(0, 10);
    expect(hero.position.z).toBeCloseTo(0, 10);
  });

  it('souřadnice jdou z běžícího stavu, ne ze socketu v deklaraci', () => {
    // Tohle je ta vlastnost, kterou shodí konstantní pozice: `hero` má socket
    // `spawn` na [0,0], ale běží na [3,2]. Kdyby se kreslil socket, scéna by
    // po dvaceti ticích vypadala stejně jako na začátku.
    const socketCell = world().space.sockets.spawn;
    const [hero] = projectEntities(world(), placements);

    expect(hero.cell).not.toEqual(socketCell);
    expect(hero.position).not.toEqual(cellToWorld(socketCell, GRID));
  });

  it('entita bez záznamu v běhu spadne zpět na svůj socket', () => {
    const [hero] = projectEntities(world(), []);

    expect(hero.cell).toEqual([0, 0]);
    expect(hero.active).toBe(true);
  });

  it('despawnutá entita zůstane v poli a nese active: false', () => {
    // Délka pole je součást AC. Kdyby neaktivní entity vypadly, `entities()`
    // by po despawnu vrátilo kratší pole a test délky by hlásil vadu tam,
    // kde je korektní chování.
    const despawned = projectEntities(world(), [
      { stableId: 'hero', x: 3, y: 2, active: true, state: 'idle', locked: false },
      { stableId: 'coin0', x: 6, y: 4, active: false, state: 'idle', locked: false },
    ]);

    expect(despawned).toHaveLength(2);
    expect(despawned[1].active).toBe(false);
  });
});
