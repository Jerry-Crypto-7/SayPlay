/**
 * Příklad ve zprávě musí projít touž cestou jako emise modelu.
 *
 * Tvar světa nevlastní tenhle soubor ani `prompt.ts` — vlastní ho
 * `src/ir/surface.ts` a `src/ir/build.ts`. Prompt ten tvar jen popisuje, a popis
 * se od kódu rozejde tiše: nic v překladači ani v jiném testu nespojuje větu
 * „rules je objekt klíčovaný ruleId" s tím, co `buildRuntimeWorld` doopravdy
 * čte. Tady se to spojuje — příklad se bere **z hotové systémové zprávy** a jede
 * validací, snížením i verifikací svědka.
 *
 * Proč z textu, a ne z exportované konstanty: konstanta může být bezvadná a do
 * zprávy se přesto nedostat (překlep v markeru, špatné pořadí řádků, `join`
 * nad jiným polem). Ověřuje se to, co uvidí model.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRuntimeWorld } from '../../ir/build';
import { peelEnvelope, validateLook, worldEmissionSchema } from '../../ir/worlddoc';
import { verifyWitness } from '../../verify/witness';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';

/**
 * Slovník je tu doslova ten zmrazený, ale **čtený ze souboru**, ne opsaný —
 * opsaná gramatika by tenhle test nechala zelený i po změně protokolu.
 */
const grammar = (): Grammar => {
  const protocol = JSON.parse(
    readFileSync(new URL('../../../evals/frozen/protocol.v1.json', import.meta.url), 'utf8'),
  ) as {
    grammar: { surfaceEvents: string[]; conditions: string[]; actions: string[] };
    worldDoc: { sim: { fields: string[] }; look: { fields: string[] } };
  };
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
};

/** Příklad stojí ve zprávě poslední, za markerem. Nic za ním být nesmí. */
function exampleFromMessage(): unknown {
  const system = buildEmissionRequest('anything', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  expect(at, 'zpráva neobsahuje marker příkladu').toBeGreaterThan(-1);
  const tail = system.slice(at + EXAMPLE_MARKER.length).trim();
  expect(tail.startsWith('{'), 'za markerem nestojí JSON').toBe(true);
  return JSON.parse(tail);
}

describe('příklad ve zprávě je platná emise', () => {
  it('projde schématem emise', () => {
    const parsed = worldEmissionSchema.safeParse(peelEnvelope(exampleFromMessage())?.document);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `/${i.path.join('/')}: ${i.message}`)).toEqual([]);
  });

  it('sníží se do běhového světa', () => {
    const sim = (exampleFromMessage() as { sim: unknown }).sim;
    const built = buildRuntimeWorld(sim);
    expect(built.ok ? [] : built.issues).toEqual([]);
  });

  it('jeho svědek dojde do výhry', () => {
    const built = buildRuntimeWorld((exampleFromMessage() as { sim: unknown }).sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');
  });

  it('má postavitelnou scénu', () => {
    expect(validateLook((exampleFromMessage() as { look: unknown }).look).issues).toEqual([]);
  });
});

/**
 * Druhý živý běh: patnáct emisí prošlo schématem a pět z devíti měřitelných
 * přesto skončilo `NO_WIN`, protože svědek jmenoval soket místo entity. Příklad
 * to tehdy naučit nemohl — `lever` byl současně entita i soket, takže z
 * `target: "lever"` nešlo poznat, co tam patří. Tyhle tři testy drží obojí: že
 * příklad tu dvojznačnost nemá, a že vlastnost, kterou zpráva tvrdí, opravdu
 * platí o interpretu.
 */
describe('příklad učí, kam smí mířit svědek', () => {
  const example = () => exampleFromMessage() as { sim: Record<string, Record<string, unknown>>; look: Record<string, unknown> };

  it('jméno soketu se nekryje se jménem entity', () => {
    const sim = example().sim;
    const collide = Object.keys(sim.sockets).filter((socket) => socket in sim.entities);
    expect(collide, 'příklad je dvojznačný: soket se jmenuje stejně jako entita').toEqual([]);
  });

  it('každý cíl svědka je deklarovaná entita', () => {
    const sim = example().sim;
    const ops = (sim.witness as { ops: readonly { target: string }[] }).ops;
    expect(ops.length, 'příklad nemá jediný op — test by neměřil nic').toBeGreaterThan(0);
    for (const op of ops) expect(sim.entities, `cíl ${op.target} není entita`).toHaveProperty(op.target);
  });

  it('cíl na soketu opravdu nedojde do výhry', () => {
    // Tvrzení zprávy proti skutečnému chování. Kdyby se povrch změnil a soket
    // v cíli začal fungovat, zčervená tenhle test — a věta ve zprávě je pak
    // zbytečně strašící, ne popis systému.
    const doc = example();
    const socketOf = doc.sim.entities as Record<string, { socket: string }>;
    const ops = (doc.sim.witness as { ops: readonly { target: string }[] }).ops;
    const sim = {
      ...doc.sim,
      witness: { ...doc.sim.witness, ops: ops.map((op) => ({ ...op, target: socketOf[op.target].socket })) },
    };
    const built = buildRuntimeWorld(sim);
    expect(built.ok, 'svět se soketem v cíli se nepostavil — test měří něco jiného, než měl').toBe(true);
    if (!built.ok) return;
    expect(verifyWitness(built.world, built.world.trace).verdict).not.toBe('CERTIFIED');
  });

  it('příklad projde inventářem, ne jen kolem něj', () => {
    // `state.slots` je jediné místo, kde se počet slotů deklaruje, a zpráva o
    // něm mlčela, přestože `giveItem` i `hasItem` jmenovala. Aby ta oprava
    // nebyla jen věta v textu, musí ji příklad doopravdy projít.
    const sim = example().sim;
    expect(typeof (sim.state as { slots?: unknown }).slots, 'příklad nedeklaruje state.slots').toBe('number');
    const rules = JSON.stringify(sim.rules);
    expect(rules, 'příklad nikdy nic nedá do inventáře').toContain('"giveItem"');
    expect(rules, 'příklad se inventáře nikdy nezeptá').toContain('"hasItem"');
  });

  it('každý klíč look.modules je deklarovaná entita', () => {
    const doc = example();
    for (const key of Object.keys(doc.look.modules as Record<string, unknown>))
      expect(doc.sim.entities, `look.modules.${key} nepojmenovává entitu`).toHaveProperty(key);
  });
});

describe('zpráva nese slovník i tvar', () => {
  it('jmenuje kontejnery, na kterých snížení stojí', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    // Přesně ta pole, na kterých padly všechny tři emise z prvního živého běhu.
    for (const named of ['sim.layout', 'width, height', 'keyed by stableId', 'keyed by ruleId', 'durationTicks'])
      expect(system, `zpráva mlčí o ${named}`).toContain(named);
  });

  it('pojmenuje obě vady druhého živého běhu', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    // Ne libovolná formulace: obojí je vlastnost, kterou model nemá odkud vzít.
    for (const named of ['names an ENTITY stableId', 'Never a socket name', 'key of look.modules'])
      expect(system, `zpráva mlčí o ${named}`).toContain(named);
  });

  it('neříká o rolích a inventáři nepravdu', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    // Role je volný řetězec: `build.ts` čte `actor` a `agent`, nic dalšího.
    expect(system, 'zpráva pořád vydává role za pevný výčet').toContain('role is a FREE label');
    expect(system, 'zpráva neříká, které role systém opravdu čte').toContain('reads exactly two');
    // Inventář nemá kde vzniknout, dokud se nejmenuje jeho deklarace.
    expect(system, 'zpráva mlčí o state.slots').toContain('slots:');
    expect(system, 'zpráva nespojí sloty s giveItem/hasItem').toContain('giveItem or hasItem declares state.slots');
  });

  it('nese uživatelský prompt doslova', () => {
    const request = buildEmissionRequest('a tower that falls over', grammar());
    expect(request.user).toContain('a tower that falls over');
  });

  it('označí kopii ukázkového scénáře za neplatnou odpověď', () => {
    const request = buildEmissionRequest('jumping arcade game with obstacles', grammar());

    expect(request.user).toContain('REQUEST-SPECIFIC CONTENT');
    expect(request.user).toContain('structurally valid');
    expect(request.user).toContain('invalid answer');
    for (const identifier of ['cardPad', 'leverPad', 'gatePad', 'card', 'lever', 'gate', 'powered', 'grab', 'pull', 'escape']) {
      expect(request.system).toContain(identifier);
      expect(request.user, 'uživatelská zpráva nevaruje před kopií ' + identifier).toContain(identifier);
    }
  });

  /**
   * Odsazení příkladu vypadá jako plýtvání a **není**. Je to jediná aserce
   * v tomhle souboru, která nehlídá obsah zprávy, ale její formát — protože
   * formát je tu naměřeně nosný.
   *
   * Zkompaktnit příklad je lákavé: ušetří 1937 znaků zadání, zkrátí odpověď
   * a naměřeně srazí medián latence z 36,7 s na 24,3 s. Zaplatí se to ale tím,
   * co model napíše. Naměřeno 25. 8. 2026 dvěma běhy nad týmž strojem
   * i korpusem (`../../../evals/local-model/decision.md` §8):
   *
   *   odsazený příklad   emise padají na JEDINÉM poli, doplnění opraví 16 z nich
   *   kompaktní příklad  padají navíc na `sim.grid` a `look.materialRoles`,
   *                      opravit nejde ani jedna
   *
   * Řádky příkladu slouží modelu jako seznam polí, který si projde. Na jednom
   * dlouhém řádku tu oporu ztratí. Tenhle test je tu proto, aby se ta zkratka
   * nezkusila potřetí — vada po ní totiž **není vidět na zprávě ani na světě**,
   * ukáže se až po třinácti minutách na GPU.
   */
  it('příklad zůstává odsazený, protože model podle řádků kontroluje pole', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    const tail = system.slice(system.indexOf(EXAMPLE_MARKER) + EXAMPLE_MARKER.length).trim();
    expect(tail, 'příklad se zkompaktnil — emise pak vynechávají pole a nejdou opravit').toContain('\n');
  });
});
