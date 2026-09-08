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
import { EMISSION_MODEL, EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../prompt';
import { repairEmission } from '../repair';

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
  // Příklad se od 26. 8. 2026 posuzuje **po opravné vrstvě**, protože přesně tak
  // putuje i v produkci: model svědka nepíše, systém ho dohledá. Kdyby se tenhle
  // soubor ptal na holý příklad, ptal by se na dokument, který nikdy nikam nejde.
  const asSent = () => repairEmission(exampleFromMessage()).document;

  it('model ho posílá bez svědka', () => {
    const sim = (exampleFromMessage() as { sim: Record<string, unknown> }).sim;
    expect(sim.witness, 'příklad pořád učí model psát svědka, kterého psát nemá').toBeUndefined();
  });

  it('projde schématem emise, jakmile systém doplní důkaz', () => {
    const parsed = worldEmissionSchema.safeParse(peelEnvelope(asSent())?.document);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `/${i.path.join('/')}: ${i.message}`)).toEqual([]);
  });

  it('sníží se do běhového světa', () => {
    const sim = (asSent() as { sim: unknown }).sim;
    const built = buildRuntimeWorld(sim);
    expect(built.ok ? [] : built.issues).toEqual([]);
  });

  it('systém pro něj najde vítěznou cestu', () => {
    const built = buildRuntimeWorld((asSent() as { sim: unknown }).sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.world.trace.length, 'hledač nenašel ani jeden tah').toBeGreaterThan(0);
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

  it('nese povinné pravidlo výhry, a to jediné', () => {
    // Naměřený důvod: 15 z 24 zaznamenaných emisí nemá jedinou akci `win`.
    // Vynutit to dekodérem nejde (viz `FORCED_SHAPE_SCHEMA`), takže povinnost
    // nese zpráva — a příklad je jediné místo, kde je ten tvar vidět.
    const rules = example().sim.rules as Record<string, { actions: readonly { kind: string }[] }>;
    expect(rules.win, 'příklad nemá pravidlo `win`, které schéma vynucuje').toBeDefined();
    expect(rules.win.actions).toEqual([{ kind: 'win' }]);
    const winning = Object.entries(rules).filter(([, rule]) => rule.actions.some((a) => a.kind === 'win'));
    expect(winning.map(([id]) => id), 'výhra je ve víc pravidlech než v `win`').toEqual(['win']);
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

  /**
   * Povinnost vítězného pravidla nese od 26. 8. 2026 **jen** tahle zpráva.
   * Vynutit ji dekodérem se zkusilo a na živém modelu to shodilo překlad
   * gramatiky (viz `FORCED_SHAPE_SCHEMA`), takže když věta ze zprávy vypadne,
   * nezůstane po ní žádná druhá pojistka — jen 15 z 24 světů bez výhry.
   */
  it('žádá vítězné pravidlo a zakazuje modelu psát svědka', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    expect(system).toContain('THE WORLD MUST BE WINNABLE');
    expect(system).toContain('sim.rules MUST contain a rule named "win"');
    expect(system, 'zpráva pořád nechává model psát důkaz, který dohledává systém').toContain(
      'You do NOT write sim.witness',
    );
  });

  /**
   * Naměřeno 26. 8. 2026 na živém modelu: ze šesti odmítnutí byla **tři**
   * `lowering/UNSUPPORTED_SURFACE: … is missing a required argument`
   * (dvakrát `moveTo`, jednou `stateIs`). Seznam argumentů ve zprávě přitom
   * celou dobu byl — chyběla u něj věta, že vyjmenované argumenty jsou
   * **povinné**. Nadpis říkal jen to, co se zahazuje navíc, což se dá číst jako
   * nabídka.
   */
  it('říká, že vyjmenované argumenty jsou povinné, ne nabízené', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    expect(system).toContain('Every argument listed below is REQUIRED');
    expect(system, 'zpráva neukazuje, jak vypadá neúplné volání').toContain('it is a broken one');
  });

  it('pojmenuje obě vady druhého živého běhu', () => {
    const system = buildEmissionRequest('anything', grammar()).system;
    // Ne libovolná formulace: obojí je vlastnost, kterou model nemá odkud vzít.
    for (const named of ['onCollide is strictly between two declared ENTITIES', 'key of look.modules'])
      expect(system, `zpráva mlčí o ${named}`).toContain(named);
  });

  it('sváže každou událost vstupu s deklarovanou zónou', () => {
    const system = buildEmissionRequest('anything', grammar()).system;

    expect(system).toContain('Every onEnterZone or onExitZone event.zone MUST exactly name');
    expect(system).toContain('sim.sockets or sim.state.zones');
    expect(system).toContain('{ entity: player, zone: goalPad }');
    expect(system).toContain('not the goal entity stableId');
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
    for (const identifier of ['cardPad', 'leverPad', 'gatePad', 'card', 'lever', 'gate', 'powered', 'grab', 'pull']) {
      expect(request.system).toContain(identifier);
      expect(request.user, 'uživatelská zpráva nevaruje před kopií ' + identifier).toContain(identifier);
    }
    // `win` je povinné jméno, ne ukázkové. Kdyby spadlo na seznam zakázaných,
    // zpráva by si v jednom odstavci odporovala s druhým.
    const banned = request.user.slice(request.user.indexOf('Do not copy these example-only identifiers'));
    const firstLine = banned.split(String.fromCharCode(10))[0];
    expect(firstLine, 'zpráva zakazuje jméno, které sama vyžaduje').not.toContain('win');
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

/**
 * **Jméno modelu je tvrzení, které jde do přihlášky — a nikdo si ho nepřečte
 * jako chybu.**
 *
 * Rozhodnutí `G2` (a) ze 6. 9. 2026: světy píše `gpt-5.6-sol` placený
 * předplatným Codexu. Do té chvíle tu stálo `claude-opus-5` a proxy vracela
 * odpovědi označené tím aliasem, takže archiv i `create-report.json`
 * zapisovaly jméno modelu, který se produktu neúčastní. `RULES.md` §2 chce
 * u každého modelu pravdivý zdroj a poskytovatele, takže by to byla nepravda
 * odeslaná v odevzdávaném dokumentu.
 *
 * Brána proto soudí **tvar jména**, ne jednu konkrétní hodnotu: kdyby soudila
 * rovnost s `gpt-5.6-sol`, projde jí každý budoucí alias jiného poskytovatele
 * stejně tiše jako tenhle.
 */
describe('the emission path names the model that actually answers', () => {
  it('refuses any claude-* alias while the model is bought as a subscription', () => {
    expect(EMISSION_MODEL.toLowerCase().startsWith('claude-')).toBe(false);
    expect(EMISSION_MODEL).toBe('gpt-5.6-sol');
  });

  it('sends that same name upstream instead of one written elsewhere', () => {
    // Konstanta, o kterou se nikdo nežádá, je jen komentář. Tohle pinuje, že
    // jméno doopravdy odjede v požadavku.
    const request = buildEmissionRequest('a salt flat with one iron mast', grammar());
    expect(request.model).toBe(EMISSION_MODEL);
  });

  it('says in the disclosure who provides it and how it is paid for', () => {
    // `docs/submission/submission.json` deklaruje tenhle soubor jako tabulku
    // modelů, takže poskytovatel a forma úhrady musí být čitelné odsud, ne jen
    // z plánu, který do veřejného repa nejde.
    const source = readFileSync(new URL('../prompt.ts', import.meta.url), 'utf8');
    expect(source).toContain('OpenAI');
    expect(source).toContain('předplatným Codexu');

    const registry = JSON.parse(
      readFileSync(new URL('../../../disclosure.json', import.meta.url), 'utf8'),
    ) as { entries: { name: string; kind: string; authorOrProvider?: string; reviewNote?: string }[] };
    const entry = registry.entries.find(
      (item) => item.kind === 'model' && item.name === EMISSION_MODEL,
    );
    expect(entry?.authorOrProvider).toBe('OpenAI');
    expect(entry?.reviewNote).toContain('předplatn');
  });
});
