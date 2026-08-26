/**
 * Výzdoba světa kusy z kitu — jediná část vykreslení, která jde změřit bez GPU.
 *
 * Test míří na čtyři vlastnosti, a žádná z nich nejde ověřit snímkem obrazovky:
 *
 * 1. **Tentýž svět dá tutéž výzdobu.** Kdyby ne, dva běhy téže věty by vypadaly
 *    jinak a replay by tvrdil něco jiného než to, co je vidět. Je to zároveň
 *    jediný pozorovatelný důsledek toho, že se losuje z vlastního streamu a ne
 *    ze streamů běhového runtimu — sdílený stream by se mezi dvěma voláními
 *    posunul a druhé volání by vrátilo jinou výzdobu.
 * 2. **Jiný svět dá jinou výzdobu.** Bez tohohle by „determinismus" splnila i
 *    konstanta a náhoda by byla dekorativní.
 * 3. **Jedno id kusu = jedna dávka.** Seznam `pieces` je to, podle čeho scéna
 *    zakládá instancované meshe; duplicita v něm je duplicitní kreslicí volání.
 * 4. **Výzdoba nezakryje to, co ve světě něco znamená** — značka zóny nesmí
 *    stát na zdi ani na socketu, dlaždice nesmí ležet na zdi.
 */

import { describe, expect, it } from 'vitest';

import { KIT } from '@/kit';
import type { EntityDecl, IrDoc, IrLimits } from '@/ir/types';
import type { WorldDocRuntime } from '@/sim/interpreter';

import { FAMILIES } from '@/geom/families';

import { dressingSeed, familyForSeed, planDressing, type DressingPlacement } from '../dressing';

function limits(width: number, height: number): IrLimits {
  return {
    maxEntities: 8,
    maxZones: 4,
    maxSlots: 8,
    maxRules: 8,
    maxRuleFiringsPerTick: 16,
    maxQueueDepth: 64,
    maxAgents: 2,
    memorySlotsPerAgent: 2,
    gridWidth: width,
    gridHeight: height,
  };
}

function entity(stableId: string, role: string, socket: string): EntityDecl {
  return { stableId, role, socket, states: ['idle'], initialState: 'idle', initialLocked: false };
}

function world(): WorldDocRuntime {
  const ir = {
    irVersion: 'world-ir-v1',
    limits: limits(7, 5),
    slots: [],
    entities: [
      entity('hero', 'actor', 'spawn'),
      entity('coin0', 'collectible', 'ledge'),
      entity('barrel0', 'prop', 'corner'),
      entity('barrel1', 'prop', 'corner'),
      entity('mystery', 'kdovico', 'ledge'),
    ],
    nodes: [],
    predicates: [],
    effects: [],
    rules: [],
  } as unknown as IrDoc;

  return {
    ir,
    space: {
      sockets: { spawn: [0, 0], ledge: [6, 4], corner: [4, 3] },
      zones: { finish: [4, 3, 2, 2] },
      blocked: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      tags: {},
    },
    trace: [],
  };
}

/** Druhý svět se od prvního liší mřížkou, zdmi i entitami. */
function otherWorld(): WorldDocRuntime {
  const base = world();
  return {
    ...base,
    ir: {
      ...base.ir,
      limits: limits(9, 6),
      entities: [entity('hero', 'actor', 'spawn'), entity('crate0', 'prop', 'ledge')],
    } as unknown as IrDoc,
    space: {
      ...base.space,
      blocked: [
        [2, 2],
        [3, 2],
      ],
    },
  };
}

function signature(placements: readonly DressingPlacement[]): string {
  return placements.map((p) => `${p.kind}:${p.piece}@${p.cell[0]},${p.cell[1]}/${p.yaw}`).join('|');
}

const KIT_IDS = new Set(KIT.map((piece) => piece.id));

/** Předpona podpisu výzdoby naměřená 26. 8. 2026, před přidáním rodiny do plánu. */
const PINNED_STATICS_PREFIX = 'wall:mass.bevel@1,1/2|wall:mass.block@2,1/1|wall:mass.block@3,1/';

describe('dressingSeed', () => {
  it('tentýž svět dá totéž semínko', () => {
    expect(dressingSeed(world())).toBe(dressingSeed(world()));
  });

  it('jiný svět dá jiné semínko', () => {
    expect(dressingSeed(world())).not.toBe(dressingSeed(otherWorld()));
  });

  it('semínko se hne, když se hne jediná zeď', () => {
    const moved = world();
    const shifted: WorldDocRuntime = {
      ...moved,
      space: { ...moved.space, blocked: [...moved.space.blocked.slice(1), [5, 2]] },
    };

    expect(dressingSeed(moved)).not.toBe(dressingSeed(shifted));
  });
});

describe('planDressing – determinismus', () => {
  it('dvě sestavení téhož světa dají shodné (kus, buňka, otočení)', () => {
    // Dvě volání za sebou, ne dvě kopie výsledku. Kdyby se losovalo ze
    // sdíleného streamu, druhé volání by pokračovalo tam, kde první skončilo.
    const first = planDressing(world());
    const second = planDressing(world());

    expect(signature(second.statics)).toBe(signature(first.statics));
    expect(second.props).toEqual(first.props);
    expect(second.seed).toBe(first.seed);
  });

  it('jiný svět dá jinou výzdobu', () => {
    const here = planDressing(world());
    const there = planDressing(otherWorld());

    expect(signature(there.statics)).not.toBe(signature(here.statics));
  });

  it('náhoda se opravdu losuje — zdi nenesou všechny tentýž kus', () => {
    // Mutace „vrať pořád první kus z pole" projde determinismem i rozdílem mezi
    // světy; shodí ji až tohle. Sedmnáct zdí je dost na to, aby čtyřprvková
    // sada dala aspoň dva různé kusy.
    const many = world();
    const wide: WorldDocRuntime = {
      ...many,
      space: {
        ...many.space,
        blocked: Array.from({ length: 17 }, (_, i) => [i % 7, Math.floor(i / 7)] as const),
      },
    };

    const walls = planDressing(wide).statics.filter((p) => p.kind === 'wall');
    expect(new Set(walls.map((p) => p.piece)).size).toBeGreaterThan(1);
  });
});

describe('planDressing – výtvarná rodina kulisy', () => {
  it('je z registru rodin a týž svět ji nemění', () => {
    expect(FAMILIES.map((family) => family.id)).toContain(planDressing(world()).family);
    expect(planDressing(world()).family).toBe(planDressing(world()).family);
  });

  it('rodina se opravdu vybírá — semínka nedávají pořád tutéž', () => {
    // Mutace „vracej pořád první rodinu" projde registrem i determinismem a
    // vypadá jako funkční systém s jedním stylem. Shodí ji až tohle: čtyři
    // rodiny přes sto semínek musí dát víc než jednu.
    const chosen = new Set(Array.from({ length: 100 }, (_unused, seed) => familyForSeed(seed)));
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('výběr rodiny nespotřeboval los — výzdoba sedí na hodnotu z doby před rodinou', () => {
    // **Připnuto schválně.** Kdyby rodina brala hodnotu ze streamu, posunuly by
    // se všechny následující losy a tenhle podpis by se změnil. Naměřeno
    // 26. 8. 2026, ještě než `family` do plánu přibyla — když se pohne, zapiš
    // proč, nikdy ho jen nepřepiš.
    expect(signature(planDressing(world()).statics).slice(0, 64)).toBe(PINNED_STATICS_PREFIX);
  });
});

describe('planDressing – co kde stojí', () => {
  it('každé použité id je jednou a je to skutečný kus kitu', () => {
    const plan = planDressing(world());

    expect(new Set(plan.pieces).size).toBe(plan.pieces.length);
    for (const piece of plan.pieces) expect(KIT_IDS.has(piece)).toBe(true);
  });

  it('seznam kusů pokrývá statiku i propy a nic navíc', () => {
    const plan = planDressing(world());
    const seen = new Set([...plan.statics.map((p) => p.piece), ...Object.values(plan.props)]);

    expect([...seen].sort()).toEqual([...plan.pieces]);
  });

  it('dlaždice leží na každé volné buňce právě jednou a na žádné zdi', () => {
    const source = world();
    const plan = planDressing(source);
    const blocked = new Set(source.space.blocked.map((cell) => `${cell[0]},${cell[1]}`));
    const tiles = plan.statics.filter((p) => p.kind === 'floor');
    const cells = tiles.map((p) => `${p.cell[0]},${p.cell[1]}`);

    expect(cells.length).toBe(7 * 5 - blocked.size);
    expect(new Set(cells).size).toBe(cells.length);
    for (const cell of cells) expect(blocked.has(cell)).toBe(false);
  });

  it('zeď dostane právě jeden kus, na každé zablokované buňce', () => {
    const source = world();
    const walls = planDressing(source).statics.filter((p) => p.kind === 'wall');

    expect(walls.map((p) => `${p.cell[0]},${p.cell[1]}`).sort()).toEqual(
      source.space.blocked.map((cell) => `${cell[0]},${cell[1]}`).sort(),
    );
  });

  it('značka zóny nestojí na zdi ani na socketu', () => {
    const source = world();
    const plan = planDressing(source);
    const forbidden = new Set([
      ...source.space.blocked.map((cell) => `${cell[0]},${cell[1]}`),
      ...Object.values(source.space.sockets).map((cell) => `${cell[0]},${cell[1]}`),
    ]);

    const markers = plan.statics.filter((p) => p.kind === 'zone');
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(forbidden.has(`${marker.cell[0]},${marker.cell[1]}`)).toBe(false);
    }
  });

  it('svět, jehož zóny jsou jen sokety, nedostane ani jednu značku', () => {
    // Tenhle tvar má KAŽDÝ skutečný svět: `buildZones` (`src/ir/surface.ts:122`)
    // vyrobí obdélník 1×1 z každého socketu, takže všechny čtyři rohy padnou na
    // tentýž socket. Kdyby se značky na obsazené buňky kladly, stála by lampa
    // přesně tam, kde startuje hráč — a bylo by to vidět na každém světě, ne
    // na výjimce.
    const source = world();
    const onlySockets: WorldDocRuntime = {
      ...source,
      space: { ...source.space, zones: { spawn: [0, 0, 1, 1], ledge: [6, 4, 1, 1] } },
    };

    expect(planDressing(onlySockets).statics.filter((p) => p.kind === 'zone')).toHaveLength(0);
    // A plocha, kterou svět deklaroval jako plochu, značku naopak dostane.
    expect(planDressing(source).statics.filter((p) => p.kind === 'zone').length).toBeGreaterThan(0);
  });

  it('drobnost nestojí tam, kde už něco je — nad čtyřiceti světy, ne nad jedním', () => {
    // Jeden svět tuhle vlastnost neuhlídá a je to naměřené: drobnost padá na
    // devítinu volných buněk, takže se s jedním semínkem na obsazenou buňku
    // prostě nemusí trefit a aserce je pak dekorativní. Čtyřicet světů se liší
    // jen jménem výplňové entity, tedy semínkem — pořád je to deterministické,
    // v testu se nic nelosuje.
    for (let variant = 0; variant < 40; variant += 1) {
      const source = world();
      const seeded: WorldDocRuntime = {
        ...source,
        ir: {
          ...source.ir,
          entities: [...source.ir.entities, entity(`filler${variant}`, 'actor', 'spawn')],
        } as unknown as IrDoc,
      };

      const plan = planDressing(seeded);
      const forbidden = new Set([
        ...seeded.space.blocked.map((cell) => `${cell[0]},${cell[1]}`),
        ...Object.values(seeded.space.sockets).map((cell) => `${cell[0]},${cell[1]}`),
        ...plan.statics.filter((p) => p.kind === 'zone').map((p) => `${p.cell[0]},${p.cell[1]}`),
      ]);

      for (const item of plan.statics.filter((p) => p.kind === 'scatter')) {
        expect(forbidden.has(`${item.cell[0]},${item.cell[1]}`), `varianta ${variant}`).toBe(false);
      }
    }
  });

  it('kus dostane jen entita, která kreslí kulisu — hrací role se neobléká', () => {
    const plan = planDressing(world());

    // `kdovico` není role z korpusu, a `visualRoleOf` z ní dělá `prop`. Kulisou
    // se tedy stane i ona: neznámá role nesmí scénu shodit ani vynechat.
    expect(Object.keys(plan.props).sort()).toEqual(['barrel0', 'barrel1', 'mystery']);
    expect(plan.props.hero).toBeUndefined();
    expect(plan.props.coin0).toBeUndefined();
  });

  it('dva propy vedle sebe nemusí nést tentýž kus', () => {
    const source = world();
    const crowded: WorldDocRuntime = {
      ...source,
      ir: {
        ...source.ir,
        entities: Array.from({ length: 12 }, (_, i) => entity(`prop${i}`, 'prop', 'corner')),
      } as unknown as IrDoc,
    };

    const worn = Object.values(planDressing(crowded).props);
    expect(worn.length).toBe(12);
    expect(new Set(worn).size).toBeGreaterThan(1);
  });
});
