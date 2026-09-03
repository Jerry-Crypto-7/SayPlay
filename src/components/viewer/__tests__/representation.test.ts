/**
 * **`RepresentationRegistry`: jediný vlastník slotů** (P15 T18).
 *
 * ## Oracle je scéna, ne návratová hodnota
 *
 * „Sockety se výměnou nehnou" se dá napsat tak, že se porovnají dvě čísla,
 * která si test sám spočítal — a pak testuje aritmetiku, ne scénu. Sockety se
 * tu proto čtou přes `getWorldPosition()`, tedy tak, jak je uvidí kamera:
 * kdyby je někdo přesadil na mesh, výměna podoby s nimi hne a tenhle test to
 * pozná, i kdyby se všechna čísla kolem shodovala.
 *
 * ## Slot je vyrobený `slotFromForm()`, ne napsaný ručně
 *
 * Transformace slotu je podíl deklarovaného a naměřeného kvádru — ručně
 * napsaná dvojice by dala kulaté číslo, jaké provoz nikdy nevyrobí, a
 * s kulatým měřítkem projde i výpočet, který násobí ve špatném pořadí.
 */

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import type { Bounds3 } from '../../../shape/types';
import { slotFromForm, type SemanticSlot } from '../../../worldstream/slots';
import type { SemanticObject } from '../../../worldstream/schema';
import {
  createRepresentationRegistry,
  SLOT_FIT_TOLERANCE,
  socketName,
  slotGroupName,
  type RepresentationCandidate,
} from '../representation';

/* ------------------------------------------------------------------ *
 * Fixtura.
 * ------------------------------------------------------------------ */

const LOCAL: Bounds3 = { min: [-1, 0, -0.5], max: [1, 3, 0.5] };

function object(stableId: string): SemanticObject {
  return {
    stableId,
    label: 'leviathan ribs',
    synonyms: ['ribs'],
    role: 'hero',
    source: { kind: 'shape', shapeId: 'ribs' },
    // Nekulaté schválně: měřítko pak vyjde 3,5 / 7,25 / 1,3, ne 1.
    targetBounds: { min: [4, 0, 2], max: [11, 21.75, 3.3] },
    importance: 3,
  };
}

function slotOf(stableId = 'hero'): SemanticSlot {
  return slotFromForm(object(stableId), {
    localBounds: LOCAL,
    anchors: [
      { name: 'base', at: [0, 0, 0], normal: [0, -1, 0] },
      { name: 'top', at: [0, 3, 0], normal: [0, 1, 0] },
    ],
  });
}

/** Mesh s vlastní geometrií i materiálem, aby šlo počítat, co se odložilo. */
function shape(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

function candidate(overrides: Partial<RepresentationCandidate> = {}): RepresentationCandidate {
  return {
    stableId: 'hero',
    revision: 0,
    contentHash: 'hash-a',
    bounds: LOCAL,
    object: shape('candidate'),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Identita a obal.
 * ------------------------------------------------------------------ */

describe('createRepresentationRegistry', () => {
  it('mapuje `stableId` na obal, hrubou podobu a připojenou podobu', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    const view = registry.open(slotOf(), rough);

    expect(view.stableId).toBe('hero');
    expect(view.group.name).toBe(slotGroupName('hero'));
    expect(view.attached).toBe(rough);
    expect(view.contentHash).toBeNull();
    expect(registry.view('hero')?.group).toBe(view.group);
    expect(registry.view('nobody')).toBeNull();
  });

  it('sockety visí na obalu, ne na podobě', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);

    const group = registry.view('hero')!.group;
    const names = group.children.map((child) => child.name);
    expect(names).toContain(socketName('base'));
    expect(names).toContain(socketName('top'));
    // A na meshi žádný není: kdyby byl, hnul by se s ním.
    expect(rough.children).toHaveLength(0);
  });

  it('druhé `open` slot nezaloží znovu — obal má výměnu přežít', () => {
    const registry = createRepresentationRegistry();
    const first = registry.open(slotOf(), shape('clay'));
    const second = registry.open(slotOf(), shape('clay-again'));

    expect(second.group).toBe(first.group);
    expect(second.attached).toBe(first.attached);
    expect(registry.slots).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Brána: revize a kvádr.
 * ------------------------------------------------------------------ */

describe('offer', () => {
  it('připojí kandidáta, který sedí, a odloží podobu, která odešla', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);

    const outcome = registry.offer(candidate({ contentHash: 'hash-b' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.view.contentHash).toBe('hash-b');
    expect(outcome.view.attached?.name).toBe('candidate');
    expect(outcome.view.group.children.map((child) => child.name)).toContain('candidate');
    // Hlína odešla právě jednou: jedna geometrie, jeden materiál.
    expect(outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(rough.parent).toBeNull();
  });

  it('zastaralá revize se nepřipojí a kandidát se odloží', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));
    // Druhá věta zvedla revizi, dokud worker počítal.
    expect(registry.revise('hero')).toBe(1);

    const late = candidate({ revision: 0 });
    const outcome = registry.offer(late);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('STALE_REVISION');
    expect(outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(late.object.parent).toBeNull();
    // Na scéně zůstala hlína, ne odvolaná podoba.
    expect(registry.view('hero')?.attached?.name).toBe('clay');
  });

  it('kvádr, který slotu přeroste, se odmítne', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const tooBig: Bounds3 = { min: [-1, 0, -0.5], max: [1, 3 * SLOT_FIT_TOLERANCE + 0.01, 0.5] };
    const outcome = registry.offer(candidate({ bounds: tooBig }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('BOUNDS_MISMATCH');
    expect(registry.view('hero')?.attached?.name).toBe('clay');
  });

  it('kvádr uvnitř tolerance projde — přerůst o kus buňky mřížky je normální', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const slightly: Bounds3 = { min: [-1, 0, -0.5], max: [1, 3 * (SLOT_FIT_TOLERANCE - 0.05), 0.5] };
    expect(registry.offer(candidate({ bounds: slightly })).ok).toBe(true);
  });

  it('zdegenerovaný kvádr se odmítne vlastním kódem, ne jako „moc velký"', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const flat: Bounds3 = { min: [-1, 0, -0.5], max: [1, 0, 0.5] };
    const outcome = registry.offer(candidate({ bounds: flat }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('BOUNDS_DEGENERATE');
  });

  it('kandidát pro slot, který neexistuje, se odloží a nic nezaloží', () => {
    const registry = createRepresentationRegistry();
    const orphan = candidate({ stableId: 'nobody' });

    const outcome = registry.offer(orphan);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('UNKNOWN_SLOT');
    expect(registry.slots).toHaveLength(0);
    expect(outcome.deferred.geometries).toBe(1);
  });

  it('dva kandidáti v opačném pořadí: vyhraje novější revize', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    // Druhá věta zvedla revizi; worker novější revize doběhl první.
    expect(registry.revise('hero')).toBe(1);
    const fresh = registry.offer(candidate({ revision: 1, contentHash: 'hash-new' }));
    expect(fresh.ok).toBe(true);

    // A teprve teď doběhl ten starý.
    const stale = registry.offer(candidate({ revision: 0, contentHash: 'hash-old' }));
    expect(stale.ok).toBe(false);

    expect(registry.view('hero')?.contentHash).toBe('hash-new');
  });
});

/* ------------------------------------------------------------------ *
 * Invarianty §13.2 přes celou výměnu.
 * ------------------------------------------------------------------ */

describe('invarianty hot-swapu', () => {
  it('world transform a světové polohy socketů výměnu přežijí beze změny', () => {
    const registry = createRepresentationRegistry();
    const view = registry.open(slotOf(), shape('clay'));

    const before = {
      position: view.group.position.toArray(),
      scale: view.group.scale.toArray(),
      base: registry.socketWorld('hero', 'base'),
      top: registry.socketWorld('hero', 'top'),
    };

    expect(registry.offer(candidate({ contentHash: 'hash-detail' })).ok).toBe(true);

    expect(view.group.position.toArray()).toEqual(before.position);
    expect(view.group.scale.toArray()).toEqual(before.scale);
    expect(registry.socketWorld('hero', 'base')).toEqual(before.base);
    expect(registry.socketWorld('hero', 'top')).toEqual(before.top);
  });

  it('světová poloha socketu je ta, kterou spočítá scéna z transformace slotu', () => {
    const registry = createRepresentationRegistry();
    const slot = slotOf();
    registry.open(slot, shape('clay'));

    // `base` je v prostoru slotu v [0, 0, 0], takže ve světě sedí na
    // translation. Nekulaté měřítko z fixtury to nesmí posunout.
    expect(registry.socketWorld('hero', 'base')).toEqual(slot.transform.translation);
    expect(registry.socketWorld('hero', 'missing')).toBeNull();
  });

  it('`stableId` přežije i zvednutí revize', () => {
    const registry = createRepresentationRegistry();
    const view = registry.open(slotOf(), shape('clay'));
    registry.revise('hero');

    expect(registry.view('hero')?.group).toBe(view.group);
    expect(registry.view('hero')?.revision).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Odkládání: právě jednou, ani víc, ani míň.
 * ------------------------------------------------------------------ */

describe('odkládání', () => {
  it('každý prohraný kandidát se odloží právě jednou', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const losers: Mesh[] = [];
    const disposals: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const mesh = shape(`loser-${round}`);
      mesh.geometry.dispose = () => disposals.push(mesh.name);
      losers.push(mesh);
      // Sudá kola prohrají na revizi, lichá projdou a prohrají o kolo později.
      registry.offer(candidate({ revision: round % 2 === 0 ? 99 : 0, object: mesh }));
    }

    // Dva odmítnutí + jeden vytlačený z pozice = tři odložení, každé jednou.
    expect(disposals).toEqual(['loser-0', 'loser-2', 'loser-1']);
    expect(new Set(disposals).size).toBe(disposals.length);
    expect(losers[3].parent).not.toBeNull();
  });

  it('výměna nad slotem bez podoby nic neodkládá', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), null);

    const outcome = registry.offer(candidate());
    expect(outcome.ok).toBe(true);
    expect(outcome.deferred).toEqual({ geometries: 0, materials: 0, textures: 0 });
  });

  it('`dispose()` sečte celou scénu a registr vyprázdní', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf('hero'), shape('clay-a'));
    registry.open(slotOf('pillar'), shape('clay-b'));

    expect(registry.dispose()).toEqual({ geometries: 2, materials: 2, textures: 0 });
    expect(registry.slots).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Ta druhá cesta na scénu nesmí existovat.
 * ------------------------------------------------------------------ */

describe('jediné dveře', () => {
  it('nikdo mimo registry mesh z workeru nepřipojuje', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/components/viewer/RepresentationSlot.tsx', 'utf8');

    // Komponenta smí obal vykreslit, ne do něj přidávat. `add(` v ní by
    // znamenalo druhou cestu, jak se podoba dostane na scénu — a ta by
    // neuměla nic z toho, co §13.2 při výměně vyžaduje.
    expect(source).not.toMatch(/\.add\(/);
    expect(source).toContain('primitive');
  });

  it('obal je `Group`, aby do něj `primitive` šel připnout beze změny scény', () => {
    const registry = createRepresentationRegistry();
    const view = registry.open(slotOf(), shape('clay'));
    expect(view.group).toBeInstanceOf(Group);
    expect(view.group).toBeInstanceOf(Object3D);
  });
});

/* ------------------------------------------------------------------ *
 * Dvoufázové připojení — §13.3.
 * ------------------------------------------------------------------ */

/**
 * **Odhalení má okno, ve kterém stojí na scéně obě podoby.** To je jediné, čím
 * se `stage()` liší od `offer()`, a taky jediný důvod, proč obě existují:
 * atomická výměna nemá kam vložit crossfade, a crossfade nemá jak splnit
 * „stará podoba odešla právě jednou", dokud běží.
 *
 * Sada proto soudí **konce**, ne průběh. Průběh (krytí v čase) je práce
 * `Materialize` a ta se měří jinde.
 */
describe('stage / commit / abandon', () => {
  it('kandidát se připojí neviditelný a hrubá podoba pod ním zůstane', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);

    const detail = shape('detail');
    const outcome = registry.stage(candidate({ object: detail, contentHash: 'hash-b' }));

    expect(outcome.ok).toBe(true);
    expect(detail.visible).toBe(false);
    expect(detail.parent).toBe(registry.view('hero')!.group);
    // Připojená podoba je pořád ta hrubá — commit ještě nebyl.
    expect(registry.view('hero')!.attached).toBe(rough);
    expect(registry.view('hero')!.staged).toBe(detail);
    expect(registry.view('hero')!.contentHash).toBeNull();
  });

  it('commit vymění podobu, zviditelní kandidáta a starou odloží právě jednou', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);
    const detail = shape('detail');
    registry.stage(candidate({ object: detail, contentHash: 'hash-b' }));

    const outcome = registry.commit('hero');

    expect(outcome.ok).toBe(true);
    expect(detail.visible).toBe(true);
    expect(registry.view('hero')!.attached).toBe(detail);
    expect(registry.view('hero')!.staged).toBeNull();
    expect(registry.view('hero')!.contentHash).toBe('hash-b');
    expect(outcome.ok && outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(rough.parent).toBeNull();
  });

  it('abandon nechá hrubou podobu stát a odloží jen kandidáta (§13.3 bod 7)', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);
    const detail = shape('detail');
    registry.stage(candidate({ object: detail }));

    const tally = registry.abandon('hero');

    expect(tally).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(registry.view('hero')!.attached).toBe(rough);
    expect(registry.view('hero')!.staged).toBeNull();
    expect(rough.parent).toBe(registry.view('hero')!.group);
    expect(detail.parent).toBeNull();
  });

  it('abandon nad slotem bez rozdělaného odhalení neodloží nic', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));
    expect(registry.abandon('hero')).toEqual({ geometries: 0, materials: 0, textures: 0 });
    expect(registry.abandon('nobody')).toEqual({ geometries: 0, materials: 0, textures: 0 });
  });

  it('commit bez kandidáta se pozná od commitu na cizí slot', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const empty = registry.commit('hero');
    const alien = registry.commit('nobody');

    expect(empty.ok === false && empty.refusal).toBe('NOTHING_STAGED');
    expect(alien.ok === false && alien.refusal).toBe('UNKNOWN_SLOT');
  });

  it('revize zvednutá během odhalení kandidáta nepřipojí, hlína zůstane', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);
    const detail = shape('detail');
    registry.stage(candidate({ object: detail, contentHash: 'hash-b' }));

    // Druhá věta ten objekt mezitím odvolala.
    registry.revise('hero');
    const outcome = registry.commit('hero');

    expect(outcome.ok === false && outcome.refusal).toBe('STALE_REVISION');
    expect(outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(registry.view('hero')!.attached).toBe(rough);
    expect(registry.view('hero')!.contentHash).toBeNull();
    expect(detail.parent).toBeNull();
  });

  it('stage prochází týmiž branami jako offer — zastaralá revize i špatný kvádr', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));

    const stale = registry.stage(candidate({ revision: 7 }));
    expect(stale.ok === false && stale.refusal).toBe('STALE_REVISION');

    const huge: Bounds3 = {
      min: LOCAL.min,
      max: [LOCAL.max[0] * SLOT_FIT_TOLERANCE * 4, LOCAL.max[1], LOCAL.max[2]],
    };
    const misfit = registry.stage(candidate({ bounds: huge }));
    expect(misfit.ok === false && misfit.refusal).toBe('BOUNDS_MISMATCH');

    const alien = registry.stage(candidate({ stableId: 'nobody' }));
    expect(alien.ok === false && alien.refusal).toBe('UNKNOWN_SLOT');

    // Ani jeden odmítnutý kandidát na scéně nezůstal a odhalení nezačalo.
    expect(registry.view('hero')!.staged).toBeNull();
    expect(registry.view('hero')!.group.children.filter((c) => c.name === 'candidate')).toHaveLength(0);
  });

  it('druhý kandidát vytlačí prvního a ten se odloží právě jednou', () => {
    const registry = createRepresentationRegistry();
    registry.open(slotOf(), shape('clay'));
    const first = shape('detail-a');
    const second = shape('detail-b');

    registry.stage(candidate({ object: first }));
    const outcome = registry.stage(candidate({ object: second }));

    expect(outcome.ok && outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(registry.view('hero')!.staged).toBe(second);
    expect(first.parent).toBeNull();
  });

  it('atomická výměna rozdělané odhalení přebije a odloží obojí', () => {
    const registry = createRepresentationRegistry();
    const rough = shape('clay');
    registry.open(slotOf(), rough);
    const staged = shape('detail');
    registry.stage(candidate({ object: staged }));

    const outcome = registry.offer(candidate({ object: shape('winner'), contentHash: 'hash-c' }));

    // Dva odložené uzly, každý s vlastní geometrií a materiálem — účty se
    // sčítají, protože odešly oba.
    expect(outcome.ok && outcome.deferred).toEqual({ geometries: 2, materials: 2, textures: 0 });
    expect(registry.view('hero')!.staged).toBeNull();
    expect(registry.view('hero')!.contentHash).toBe('hash-c');
    expect(rough.parent).toBeNull();
    expect(staged.parent).toBeNull();
  });
});
