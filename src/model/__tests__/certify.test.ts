/**
 * Tvar verdiktu — **typ, ne přetypování**.
 *
 * `Verdict.body` byl `Record<string, unknown>`, takže každý čtenář odmítnutí si
 * musel `rejection` ručně zúžit zpátky na objekt a vytáhnout z něj tři řetězce.
 * Špatné přečtení tím prošlo překladačem a selhalo až za běhu, u porotce.
 *
 * Testuje se proto dvojí, a ani jedno nejde vidět okem:
 *
 * 1. **Data se nesmějí hnout.** Mění se typy, ne bajty; server i prohlížeč
 *    vracejí tentýž objekt jako předtím. Klíče se pinují jménem.
 * 2. **Rozlišení podle `outcome` musí zúžit `rejection`.** Že to jde napsat bez
 *    přetypování, dokazuje tenhle soubor sám: kdyby to nešlo, `tsc` ho odmítne.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { certifySteps, type Rejection, type Stage, type Verdict } from '../certify';
import { buildEmissionRequest, EXAMPLE_MARKER, type Grammar } from '../prompt';
import { repairEmission } from '../repair';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onCollide', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'stateIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

function example(): Record<string, unknown> {
  const system = buildEmissionRequest('libovolná věta', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(system.indexOf('{', at))) as Record<string, unknown>;
}

const upstream = buildEmissionRequest('libovolná věta', grammar());

function certify(body: unknown): Verdict {
  const steps = certifySteps({ promptId: 'věta', upstream, provenance: { source: 'test' }, body });
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/**
 * Ukázka, jejíž vítězné pravidlo míří do nedeklarované zóny — poctivé
 * `DANGLING_REFERENCE`. Mění se **jedno slovo**, aby vada byla o odkazu a ne
 * o schématu; kdyby se přepsala celá událost, verdikt by padl už na schématu
 * a test by pinoval jinou fázi, než o které mluví.
 */
function withDanglingZone(): Record<string, unknown> {
  // Opravená ukázka, ne syrová: syrová nemá svědka a padla by na schématu,
  // tedy o fázi dřív, než je vada, kterou tenhle test popisuje.
  const doc = repairEmission(example()).document as Record<string, unknown>;
  const sim = { ...(doc.sim as Record<string, unknown>) };
  const rules = { ...(sim.rules as Record<string, unknown>) };
  const win = rules.win as { readonly event: Record<string, unknown> };
  rules.win = { ...win, event: { ...win.event, zone: 'nikdyNedeklarovanaZona' } };
  return { ...doc, sim: { ...sim, rules } };
}

describe('rozlišení podle outcome', () => {
  it('zúží `rejection` na neprázdný tvar bez jediného přetypování', () => {
    const verdict = certify(withDanglingZone());

    expect(verdict.body.outcome).toBe('REJECTED');
    if (verdict.body.outcome !== 'REJECTED') return;

    // Tohle je celý test: tři čtení bez `as`. Než `Verdict` dostal rozlišení,
    // překladač je odmítal a produkce je obcházela ručním zúžením.
    const stage: Stage = verdict.body.rejection.stage;
    const reason: string = verdict.body.rejection.reason;
    const issues: readonly string[] = verdict.body.rejection.issues;

    expect(stage).toBe('references');
    expect(reason).toBe('DANGLING_REFERENCE');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('u certifikovaného verdiktu je `rejection` typově `null`, ne „možná objekt"', () => {
    const verdict = certify(repairEmission(example()).document);

    expect(verdict.body.outcome).toBe('CERTIFIED');
    if (verdict.body.outcome !== 'CERTIFIED') return;

    expectTypeOf(verdict.body.rejection).toEqualTypeOf<null>();
    expect(verdict.body.doc).not.toBeNull();
  });

  it('nedovolí přečíst `rejection.stage` bez rozlišení', () => {
    const verdict = certify(withDanglingZone());

    // @ts-expect-error `rejection` je na nerozlišeném verdiktu `Rejection | null`
    expect(() => verdict.body.rejection.stage).toBeDefined();
  });
});

describe('tvar dat se nehnul', () => {
  it('odmítnutý verdikt nese přesně ty klíče, které nesl předtím', () => {
    const verdict = certify(withDanglingZone());

    expect(Object.keys(verdict.body).sort()).toEqual(
      ['annotations', 'doc', 'emission', 'outcome', 'promptId', 'provenance', 'rejection', 'upstream'].sort(),
    );
    expect(verdict.kind).toBe('verdict');
    if (verdict.body.outcome !== 'REJECTED') return;
    expect(Object.keys(verdict.body.rejection).sort()).toEqual(['detail', 'issues', 'reason', 'stage']);
  });

  it('certifikovaný verdikt nese `certificate` a zapečetěný dokument', () => {
    const verdict = certify(repairEmission(example()).document);

    expect(Object.keys(verdict.body).sort()).toEqual(
      ['annotations', 'certificate', 'doc', 'emission', 'outcome', 'promptId', 'provenance', 'rejection', 'upstream'].sort(),
    );
  });
});

describe('Stage', () => {
  it('jmenuje všech sedm fází, které produkce doopravdy vydává', () => {
    // Sedm, ne šest: prohlížečová větev odmítá doslovnou kopii ukázky pod
    // `stage: 'request'` (`src/model/local/emit.ts`). Kdyby `Stage` tu hodnotu
    // neznala, ten verdikt by se nedal sestavit bez přetypování — tedy přesně
    // ta vada, kterou tenhle typ zavírá.
    const all: readonly Stage[] = ['schema', 'references', 'lowering', 'witness', 'look', 'declined', 'request'];
    expect(new Set(all).size).toBe(7);

    // @ts-expect-error osmá fáze neexistuje a nesmí jít napsat
    const invalid: Stage = 'vymyslena';
    expect(invalid).toBe('vymyslena');
  });

  it('`Rejection` je exportovaný tvar, ne anonymní objekt', () => {
    expectTypeOf<Rejection>().toEqualTypeOf<{
      readonly stage: Stage;
      readonly reason: string;
      readonly detail: string;
      readonly issues: readonly string[];
    }>();
  });
});
