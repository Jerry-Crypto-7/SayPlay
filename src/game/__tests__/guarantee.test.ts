import { describe, expect, it } from 'vitest';

import { guaranteeWorld } from '@/game/guarantee';
import { recognize, seedEmission } from '@/model/local/shapes';
import { verifyWitness } from '@/verify/witness';

/**
 * Záruka světa (P11 T20).
 *
 * **Co se tu dokazuje.** Že `guaranteeWorld` splní svůj slib i tehdy, když je
 * něco rozbité — a hlavně že ho neplní naprázdno. Náhradní místnost, která by
 * spolykala i větu, ze které svět vzniknout měl, by prošla každou asercí o
 * neprázdné scéně a produkt by přestal odpovídat na vstup; místnost, ve které
 * se nedá dojít do konce, by prošla taky. Obojí je tady zavřené.
 *
 * **Co se tu nedokazuje.** Kolik ze sedmdesáti nepřátelských vět skončí
 * náhradou. To je naměřené číslo a patří do `evals/hostile-report.json`; zapsat
 * ho vedle testu by z něj udělalo požadavek na dnešní chování.
 */

/** Věta, kterou rozpoznávač zná. Kdyby ji nepoznal, celý test níž nic netvrdí. */
const KNOWN = 'a puzzle room where I have to find three keys to open the exit door';

/** Vstupy, ze kterých žádný svět neplyne. Tvary jsou doslovné ze zmrazené sady. */
const HOSTILE = [
  '',
  '   ',
  'asdfghjkl',
  'the the the the the the',
  '1234567890',
  '\u{1F419}\u{1F30B}\u{1F3AA}',
  'a completely empty room full of furniture',
  '桜の木の下でお茶を飲む静かな場所',
  '[31m',
  'x'.repeat(20_000),
];

describe('guaranteeWorld — věta dovnitř, svět ven, vždycky', () => {
  it('rozpoznaná věta jde přes tvar, ne přes náhradu', () => {
    // Kdyby náhrada spolkla i tuhle větu, všechny ostatní aserce v souboru by
    // platily o systému, který na vstup vůbec nereaguje.
    expect(recognize(KNOWN), 'předpoklad testu padl: rozpoznávač tuhle větu nezná').not.toBeNull();

    const guaranteed = guaranteeWorld(KNOWN);
    expect(guaranteed.kind).toBe('shape');
    expect(guaranteed.shapeId).toBe('keys-to-door');
    expect(guaranteed.fault).toBeNull();
  });

  it.each(HOSTILE.map((text, at) => [at, text] as const))(
    'nepřátelský vstup #%i skončí světem, ne prázdnem',
    (_at, text) => {
      const guaranteed = guaranteeWorld(text);
      expect(guaranteed.world.ir.entities.length).toBeGreaterThan(0);
    },
  );

  it('náhrada vždycky nese vadu, tvar nikdy', () => {
    for (const text of [KNOWN, ...HOSTILE]) {
      const guaranteed = guaranteeWorld(text);
      // Tichá náhrada je horší než prázdná scéna: prázdná scéna je aspoň vidět.
      if (guaranteed.kind === 'seed') expect(guaranteed.fault, text.slice(0, 40)).not.toBeNull();
      else expect(guaranteed.fault, text.slice(0, 40)).toBeNull();
    }
  });

  it('náhradní místnost se dá dohrát vlastní stopou', () => {
    // Bez tohohle by „scéna není prázdná" šlo splnit dekorací — místností, ve
    // které stojí entity a nedá se v ní dojít do konce.
    const guaranteed = guaranteeWorld('asdfghjkl');
    expect(guaranteed.kind).toBe('seed');
    const certified = verifyWitness(guaranteed.world, guaranteed.world.trace);
    expect(certified.verdict, JSON.stringify(certified)).toBe('CERTIFIED');
  });

  it('v náhradní místnosti je co dělat, ne jen kam dojít', () => {
    // Dohratelnost sama tohle netvrdí: místnost bez sbíratelného předmětu má cíl
    // odemčený už z `onStart`, takže se „dohraje" jedním krokem ke dveřím a
    // certifikace ji přijme. Aserce výš by ji tedy pustila dál, a to je přesně
    // ten rozdíl mezi místností a chodbou.
    const world = guaranteeWorld('asdfghjkl').world;
    expect(world.ir.entities.filter((entity) => entity.role === 'collectible').length).toBeGreaterThan(0);
    expect(world.trace.some((input) => input.actionId === 'pickup')).toBe(true);
  });

  it('náhradní místnost je pro každou větu táž', () => {
    // Náhrada odvozená ze vstupu by byla odpověď na větu, které systém nerozuměl.
    const first = guaranteeWorld('asdfghjkl');
    const second = guaranteeWorld('1234567890');
    expect(first.emission).toEqual(second.emission);
    expect(first.emission).toEqual(seedEmission());
  });

  it('pád uvnitř rozpoznávače je vada s důvodem, ne prázdná scéna', () => {
    const guaranteed = guaranteeWorld('cokoli', () => {
      throw new TypeError('regulární výraz spadl');
    });
    expect(guaranteed.kind).toBe('seed');
    expect(guaranteed.fault).toBe('RECOGNIZER_THREW: TypeError: regulární výraz spadl');
    expect(guaranteed.world.ir.entities.length).toBeGreaterThan(0);
  });

  it('emise bez `sim` i nesnížitelná emise skončí náhradou, každá s vlastní vadou', () => {
    const noSim = guaranteeWorld('cokoli', () => ({ look: {} }));
    expect(noSim.kind).toBe('seed');
    expect(noSim.fault).toBe('NO_SIM');

    const broken = guaranteeWorld('cokoli', () => ({ sim: { layout: { width: 0, height: 0 } } }));
    expect(broken.kind).toBe('seed');
    expect(broken.fault).toMatch(/^MALFORMED_SIM: /);
  });

  it('emise, ze které stojí prázdná místnost, se vymění za náhradu', () => {
    // Nejtišší z vad: `buildRuntimeWorld` takový svět **přijme** a vrátí ho s
    // nulou entit. Bez téhle výměny by se do produktu dostala scéna, která je
    // technicky v pořádku a na plátně po ní nezůstane nic.
    const empty = guaranteeWorld('cokoli', () => ({
      sim: {
        layout: { kind: 'grid', width: 12, height: 8, levels: 1, portals: [] },
        grid: { cell: 1 },
        sockets: { spawn: [1, 4] },
        collisionAabb: {},
        entities: {},
        rules: {},
        state: { counters: {}, flags: {}, timers: {}, zones: {}, slots: 1 },
        witness: { tier: 'short', H_cert: 600, ops: [] },
      },
    }));
    expect(empty.kind).toBe('seed');
    expect(empty.fault).toBe('EMPTY_SCENE');
    expect(empty.world.ir.entities.length).toBeGreaterThan(0);
  });

  it('věta, kterou rozpoznávač nezná, nese právě `NO_SHAPE`', () => {
    // Odlišuje „tvar neznám" od „tvar znám, ale svět z něj nestojí". Kdyby obojí
    // dalo tutéž vadu, histogram vad v reportu by o systému netvrdil nic.
    const guaranteed = guaranteeWorld('cokoli', () => null);
    expect(guaranteed.fault).toBe('NO_SHAPE');
  });
});
