/**
 * Průvodce, který odpovídá na otázku „kudy k X".
 *
 * Celé tvrzení téhle funkce zní **odpověď je z pravidel, ne z výmyslu**. Sada
 * proto neměří, jestli odpověď vypadá hezky, ale tři věci, které se dají
 * zfalšovat, aniž by si toho kdokoli všiml:
 *
 * 1. **Vydaná cesta je certifikovaná a doopravdy končí u cíle.** Bez toho by
 *    průvodce uměl poslat hráče kamkoli a tvrdit u toho, že to systém ověřil.
 * 2. **Cíl mimo svět dostane pojmenované „nevím" a žádné jméno ze světa.**
 *    Plynulá odpověď, která si objekt vymyslí, se čte líp než poctivé nevím —
 *    proto se tu prohledává celá odpověď proti jménům, která ve světě jsou.
 * 3. **„Nenašel jsem cestu" je jiná odpověď než „to tu není".** Sloučit je do
 *    jedné nepravdy by šlo jedním řádkem.
 *
 * Svět se sem **nepíše**, bere se z příkladu v produkčním promptu — stejně jako
 * v `src/verify/__tests__/solve.test.ts`, aby test neměřil vlastní opis schématu.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../../model/prompt';
import { createRuntime, entityPlacements, step, type TraceInput } from '../../sim/interpreter';
import { hashWitness, verifyWitness } from '../../verify/witness';
import { certifyRoute, guideRoute } from '../guide';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

const BUDGET = { maxNodes: 20_000, maxTicks: 100_000, maxDepth: 6, settleTicks: 30 } as const;

/** Ukázkový svět z hotové systémové zprávy, tedy ten, který vidí model. */
function exampleSim(): Record<string, unknown> {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  const document = JSON.parse(system.slice(system.indexOf('{', at))) as { sim: Record<string, unknown> };
  return { ...document.sim, witness: { tier: 'short', H_cert: 600, ops: [] } };
}

/**
 * Týž svět plus socha stranou od vítězné cesty.
 *
 * Existuje ve světě, dá se k ní dojít, ale **žádná vítězná cesta kolem ní
 * nevede** — je to jediný případ, který rozhodne mezi „cesta k cíli" a „jakákoli
 * vítězná cesta". Bez ní by průvodce mohl vracet výhru na každou otázku a sada
 * by zůstala zelená.
 */
function simWithDecoy(): Record<string, unknown> {
  const sim = exampleSim();
  return {
    ...sim,
    sockets: { ...(sim.sockets as Record<string, unknown>), statuePad: [1, 1] },
    collisionAabb: { ...(sim.collisionAabb as Record<string, unknown>), statue: [1, 1, 1, 1] },
    entities: {
      ...(sim.entities as Record<string, unknown>),
      statue: { role: 'prop', socket: 'statuePad', state: 'idle' },
    },
  };
}

function build(sim: Record<string, unknown>) {
  const built = buildRuntimeWorld(sim);
  expect(built.ok ? [] : built.issues, 'svět se nepostavil, test by měřil něco jiného').toEqual([]);
  if (!built.ok) throw new Error('unreachable');
  return built.world;
}

/**
 * Kudy hráč doopravdy šel, když se stopa přehraje.
 *
 * Odpověď se soudí proti **odsimulovanému světu**, ne proti tomu, co o sobě
 * tvrdí. Vrací se navštívené buňky v pořadí tiků plus koncový stav běhu.
 */
function walk(world: ReturnType<typeof build>, ops: readonly TraceInput[], stableId: string) {
  const runtime = createRuntime(world);
  const cells: { x: number; y: number }[] = [];
  const look = () => {
    const placement = entityPlacements(runtime).find((entry) => entry.stableId === stableId);
    if (placement !== undefined) cells.push({ x: placement.x, y: placement.y });
  };
  let cursor = 0;
  look();
  for (let tick = 0; tick < 600 && runtime.runState === 'running'; tick += 1) {
    const inputs: TraceInput[] = [];
    while (cursor < ops.length && ops[cursor].tick === tick) {
      inputs.push(ops[cursor]);
      cursor += 1;
    }
    step(runtime, inputs);
    look();
  }
  return { runState: runtime.runState, cells, last: cells[cells.length - 1] };
}

describe('guideRoute nad cílem, který ve světě je', () => {
  it('vrátí cestu, kterou certifikuje verifyWitness, a certifikát patří k ní', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'gate', BUDGET);

    expect(answer.status, 'průvodce nenašel cestu tam, kde vede').toBe('ROUTE');
    if (answer.status !== 'ROUTE') return;

    expect(answer.target).toBe('gate');
    // Nezávisle znovu: certifikát v odpovědi nesmí být jediný důkaz o sobě samém.
    expect(verifyWitness({ ...world, trace: answer.ops }, answer.ops).verdict).toBe('CERTIFIED');
    // A ten certifikát musí patřit TÉTO stopě, ne nějaké jiné, kterou hledač viděl.
    expect(answer.certificate.witnessHash).toBe(hashWitness(answer.ops));
    // Ke bráně se dá dojít až s kartou a pákou, takže jeden tah to být nemůže.
    expect(answer.ops.length).toBeGreaterThanOrEqual(3);
  });

  it('cesta doopravdy končí u cíle, ne jen někde ve vyhraném světě', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'gate', BUDGET);
    if (answer.status !== 'ROUTE') throw new Error('cesta k bráně chybí');

    const player = walk(world, answer.ops, 'player');
    const gate = walk(world, [], 'gate');
    expect(player.runState).toBe('won');
    expect(player.last, 'hráč skončil jinde než u cíle').toEqual(gate.last);
  });

  it('odpoví i na cíl, který leží na vítězné cestě dřív než výhra', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'lever', BUDGET);

    expect(answer.status).toBe('ROUTE');
    if (answer.status !== 'ROUTE') return;
    expect(verifyWitness({ ...world, trace: answer.ops }, answer.ops).verdict).toBe('CERTIFIED');
  });

  /**
   * Cíl, který zmizí dřív, než se dá vyhrát: páka se přehazuje vstupem do zóny
   * a přitom deska mizí. Cesta k desce tak musí jít deska → zóna páky → brána,
   * jenže po kroku k páce je stav **bit po bitu tentýž** jako bez desky – a
   * hledač dedukuje podle hashe stavu. Kdyby klíč nenesl bit „cílem prošel",
   * zahodí právě tu cestu, kterou hledal, a odpoví NO_ROUTE nad cílem, ke
   * kterému cesta vede (nález Codex review, naměřeno 20. 9. 2026).
   */
  it('cesta přes cíl přežije dedukci proti přímé cestě do téhož stavu', () => {
    const sim = exampleSim();
    const rules = sim.rules as Record<string, { actions: unknown[] }>;
    const world = build({
      ...sim,
      sockets: { ...(sim.sockets as Record<string, unknown>), nookPad: [1, 1] },
      collisionAabb: { ...(sim.collisionAabb as Record<string, unknown>), plaque: [1, 1, 1, 1] },
      entities: {
        ...(sim.entities as Record<string, unknown>),
        plaque: { role: 'prop', socket: 'nookPad', state: 'idle' },
      },
      rules: {
        ...rules,
        pull: {
          ...rules.pull,
          event: { kind: 'onEnterZone', entity: 'player', zone: 'leverPad' },
          actions: [...rules.pull.actions, { kind: 'despawn', target: 'plaque' }],
        },
      },
    });
    const answer = guideRoute(world, 'plaque', { ...BUDGET, maxTicks: 400_000 });

    expect(answer.status, 'k desce vede cesta, dedukce ji nesmí zahodit').toBe('ROUTE');
    if (answer.status !== 'ROUTE') return;
    const plaque = walk(world, [], 'plaque').last;
    const player = walk(world, answer.ops, 'player');
    expect(player.runState).toBe('won');
    expect(player.cells, 'certifikovaná cesta kolem desky nešla').toContainEqual(plaque);
  });
});

describe('guideRoute nad cílem, který ve světě není', () => {
  it('řekne pojmenované „to tu není" a nejmenuje jediný objekt ze světa', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'treasure', BUDGET);

    expect(answer.status).toBe('NOT_IN_WORLD');
    // Celá odpověď se prohledá proti jménům, která ve světě opravdu jsou. Kdyby
    // si průvodce cíl „opravil" na nejbližší existující objekt, vyšlo by to tady.
    const serialized = JSON.stringify(answer);
    const names = [
      ...world.ir.entities.map((entity) => entity.stableId),
      ...Object.keys(world.space.sockets),
      ...Object.keys(world.space.zones),
    ];
    for (const name of names)
      expect(serialized, `odpověď si přitáhla objekt ${name}, na který se nikdo neptal`).not.toContain(name);
  });

  it('nevydá cestu ani certifikát, když cíl neexistuje', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'treasure', BUDGET);

    expect(Object.hasOwn(answer, 'ops')).toBe(false);
    expect(Object.hasOwn(answer, 'certificate')).toBe(false);
  });
});

describe('guideRoute nad cílem, ke kterému cestu nenajde', () => {
  it('rozpočet hledání dá „nenašel jsem cestu", ne „to tu není"', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'gate', { ...BUDGET, maxNodes: 1 });

    expect(answer.status).toBe('NO_ROUTE');
    expect(answer.status, 'nedosažitelný cíl se slil s neexistujícím').not.toBe('NOT_IN_WORLD');
    if (answer.status !== 'NO_ROUTE') return;
    expect(answer.reason).toBe('BUDGET_EXHAUSTED');
    expect(answer.target, 'cíl ve světě je, tak se má jmenovat').toBe('gate');
  });

  it('cíl ve světě, na který hledání v rozpočtu nedosáhne, dostane NO_ROUTE', () => {
    const world = build(simWithDecoy());
    // Kontrola, že jde o cíl, který ve světě opravdu je — jinak by tenhle případ
    // měřil totéž co „to tu není".
    expect(world.ir.entities.map((entity) => entity.stableId)).toContain('statue');

    // Vyhrát se dá třemi vstupy, zajít přitom k soše stojí čtvrtý. Strop tři
    // vstupy tedy nechává cíl ve světě a cestu k němu mimo dosah hledání.
    const shallow = { ...BUDGET, maxDepth: 3, maxTicks: 400_000 };
    const answer = guideRoute(world, 'statue', shallow);

    expect(answer.status, 'průvodce vydal vítěznou cestu jako odpověď na jiný cíl').toBe('NO_ROUTE');
    if (answer.status !== 'NO_ROUTE') return;
    expect(answer.reason).toBe('SEARCH_EXHAUSTED');
    // Týž svět, týž rozpočet, jiný cíl — nenašlo se to kvůli cíli, ne kvůli světu.
    expect(guideRoute(world, 'gate', shallow).status).toBe('ROUTE');
  });
});

describe('cesta patří k položenému cíli', () => {
  it('cíl stranou od výhry dostane vlastní cestu, ne tu nejkratší vítěznou', () => {
    const world = build(simWithDecoy());
    const toStatue = guideRoute(world, 'statue', { ...BUDGET, maxTicks: 400_000 });
    const toGate = guideRoute(world, 'gate', { ...BUDGET, maxTicks: 400_000 });

    expect(toStatue.status).toBe('ROUTE');
    expect(toGate.status).toBe('ROUTE');
    if (toStatue.status !== 'ROUTE' || toGate.status !== 'ROUTE') return;
    expect(toStatue.ops, 'k oběma cílům vede tatáž cesta, cíl se neprojevil').not.toEqual(toGate.ops);

    // A hlavně: hráč u sochy doopravdy stál. Certifikát sám o tom neříká nic —
    // certifikuje výhru, ne to, kudy se k ní šlo.
    const statue = walk(world, [], 'statue').last;
    const player = walk(world, toStatue.ops, 'player');
    expect(player.runState).toBe('won');
    expect(player.cells, 'certifikovaná cesta k soše kolem sochy nešla').toContainEqual(statue);
    expect(walk(world, toGate.ops, 'player').cells, 'nejkratší vítězná cesta u sochy být nemá').not.toContainEqual(
      statue,
    );
  });
});

describe('certifyRoute jako brána průvodce', () => {
  it('zamítne podvrženou cestu, ze které se vypadl krok do výhry', () => {
    const world = build(exampleSim());
    const honest = guideRoute(world, 'gate', BUDGET);
    if (honest.status !== 'ROUTE') throw new Error('poctivá cesta chybí');

    // Vypadne jediný krok, kterým se odemyká brána. Zbytek stopy vypadá stejně.
    const forged = honest.ops.filter((input) => input.actionId !== 'use');
    expect(forged.length, 'podvrh nic nevypustil, test by neměřil nic').toBeLessThan(honest.ops.length);

    const verdict = certifyRoute(world, forged);
    expect(verdict.verdict).toBe('REJECTED');
    if (verdict.verdict !== 'REJECTED') return;
    expect(verdict.reason).toBe('NO_WIN');
  });

  it('zamítne cestu, která míří na objekt mimo svět', () => {
    const world = build(exampleSim());
    const forged: readonly TraceInput[] = [{ tick: 0, actor: 'player', actionId: 'moveTo', target: 'treasure' }];

    const verdict = certifyRoute(world, forged);
    expect(verdict.verdict).toBe('REJECTED');
    if (verdict.verdict !== 'REJECTED') return;
    expect(verdict.reason).toBe('STEP_UNREACHABLE');
  });

  it('certifikuje tutéž cestu, kterou průvodce vydal', () => {
    const world = build(exampleSim());
    const answer = guideRoute(world, 'gate', BUDGET);
    if (answer.status !== 'ROUTE') throw new Error('cesta chybí');

    expect(certifyRoute(world, answer.ops).verdict).toBe('CERTIFIED');
  });
});

describe('determinismus odpovědi', () => {
  it('dá dvakrát tutéž cestu, protože se z ní hashuje certifikát', () => {
    const world = build(exampleSim());
    expect(guideRoute(world, 'gate', BUDGET)).toEqual(guideRoute(world, 'gate', BUDGET));
  });
});
