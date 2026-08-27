/**
 * Verifikátor svědka — kroková kontrola, tier politika, `K_input`.
 *
 * `DESIGN-BOOK.md` §6 staví celou garanci na tom, že přijatý kandidát nese
 * svědka ověřeného replayem. „Stopa došla do `win()`" ale certifikuje i náhodnou
 * procházku, takže se tu netestuje jen že vyhratelný svět projde — testuje se,
 * **co všechno neprojde a proč**.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IrEffect, IrRule } from '../../ir/types';
import { createStreams, nextInt } from '../../sim/rng';
import { RUNTIME_VERSION, type TraceInput } from '../../sim/interpreter';
import { TIER_POLICY } from '../tiers';
import { hashWitness, verifyWitness, type Certificate, type VerifiableWorld } from '../witness';

import badWitness from '../__fixtures__/bad-witness.json';
import horizonGreedyWorld from '../__fixtures__/horizon-greedy.world.json';
import unwinnableWorld from '../__fixtures__/unwinnable.world.json';
import vaultWorld from '../../sim/__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as VerifiableWorld;
const unwinnable = unwinnableWorld as unknown as VerifiableWorld;
const horizonGreedy = horizonGreedyWorld as unknown as VerifiableWorld;

/** Vítězná stopa vaultu je jediný vstup — a je to jediné, co do výhry vede. */
const WINNING: readonly TraceInput[] = vault.trace;

describe('certifikace vyhratelného světa', () => {
  it('vydá certifikát se skutečnými čísly, ne s přanými', () => {
    const result = verifyWitness(vault, WINNING);
    expect(result.verdict).toBe('CERTIFIED');
    const cert = result as Certificate;
    expect(cert.tier).toBe('short');
    expect(cert.horizonTicks).toBe(TIER_POLICY.short.maxHorizonTicks);
    // `L_witness` je skutečná délka běhu, ne horizont.
    expect(cert.witnessLength).toBe(vault.winsAtTick);
    expect(cert.witnessLength).toBeLessThan(cert.horizonTicks);
    expect(cert.inputCount).toBe(WINNING.length);
    expect(cert.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(cert.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('a nevyhratelný svět odmítne — týž řetěz, chybí poslední článek', () => {
    const result = verifyWitness(unwinnable, unwinnable.trace);
    expect(result.verdict).toBe('REJECTED');
    expect(result).toMatchObject({ reason: 'NO_WIN' });
  });

  it('bez příčinného vstupu se stejný svět necertifikuje', () => {
    // Kdyby prošel, certifikát by neříkal nic o tom, že ho vyhrál SVĚDEK.
    expect(verifyWitness(vault, []).verdict).toBe('REJECTED');
  });
});

describe('horizont deklaruje systém, ne dokument', () => {
  it('vyhratelný svět s horizontem nad stropem svého tieru je `NO_FIT`', () => {
    const result = verifyWitness(horizonGreedy, horizonGreedy.trace);
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'NO_FIT' });
  });

  it('a je to politika, ne obsah — týž svět v mezích tieru se certifikuje', () => {
    // Bez téhle aserce by `NO_FIT` mohlo být jen jinak pojmenované `NO_WIN`.
    const modest: VerifiableWorld = { ...horizonGreedy, certification: { tier: 'short', horizonTicks: 60 } };
    expect(verifyWitness(modest, horizonGreedy.trace).verdict).toBe('CERTIFIED');
  });

  it('horizont v certifikátu je `H_cert` tieru, ne číslo z dokumentu', () => {
    // Zmrazený `protocol.v1.json` má `horizonDeclaredBy: "system"` a
    // `modelMayDeclareHorizon: false`. Dokument smí říct jen to, o který tier
    // jde; kdyby jeho číslo řídilo replay, byl by `resolvePolicy` jen strop a
    // ne branka, a certifikát by vykazoval modelem zvolený horizont jako
    // systémový.
    const result = verifyWitness(
      { ...vault, certification: { tier: 'short', horizonTicks: 30 } },
      WINNING,
    ) as Certificate;
    expect(result.horizonTicks).toBe(TIER_POLICY.short.maxHorizonTicks);
    expect(result.horizonTicks).not.toBe(30);
  });

  it('a delší tier dá delší horizont, i když dokument žádal o kratší', () => {
    const result = verifyWitness(
      { ...vault, certification: { tier: 'long', horizonTicks: 5 } },
      WINNING,
    ) as Certificate;
    expect(result.tier).toBe('long');
    expect(result.horizonTicks).toBe(TIER_POLICY.long.maxHorizonTicks);
  });
});

describe('`K_input` je strop, ne doporučení', () => {
  /**
   * Neškodná výplň PŘED vítězným vstupem, jeden vstup na tik kvůli frontě.
   *
   * Pořadí je podstatné: výplň za výhrou by běh nikdy nedočerpal, takže by ji
   * odmítla kontrola kroků za koncem běhu a test by měřil ji místo stropu.
   */
  const padded = (fillerCount: number): TraceInput[] => {
    const inputs: TraceInput[] = [];
    for (let i = 0; i < fillerCount; i += 1) inputs.push({ tick: i, actor: 'hero', actionId: 'wave' });
    inputs.push({ tick: fillerCount, actor: 'hero', actionId: 'pull', target: 'lever' });
    return inputs;
  };

  it('svědek nad stropem je odmítnut, I KDYŽ do `win()` dojde', () => {
    const witness = padded(TIER_POLICY.short.maxInputs);
    expect(witness.length).toBeGreaterThan(TIER_POLICY.short.maxInputs);
    const result = verifyWitness(vault, witness);
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'INPUT_CAP' });
  });

  it('a odmítl ho strop, ne obsah — v delším tieru týž svědek projde', () => {
    const witness = padded(TIER_POLICY.short.maxInputs);
    const longer: VerifiableWorld = { ...vault, certification: { tier: 'standard', horizonTicks: 600 } };
    const result = verifyWitness(longer, witness);
    expect(result.verdict).toBe('CERTIFIED');
    expect((result as Certificate).inputCount).toBe(witness.length);
  });

  it('přesně na stropu ještě projde', () => {
    const witness = padded(TIER_POLICY.short.maxInputs - 1);
    expect(witness.length).toBe(TIER_POLICY.short.maxInputs);
    expect(verifyWitness(vault, witness).verdict).toBe('CERTIFIED');
  });
});

describe('k-tý krok musí být proveditelný', () => {
  const cases = badWitness.cases;

  it('zmrazené vadné případy dostanou očekávaný verdikt i index kroku', () => {
    expect(cases.length).toBeGreaterThan(3);
    for (const entry of cases) {
      const result = verifyWitness(vault, entry.witness as TraceInput[]);
      expect(result, entry.name).toMatchObject({
        verdict: 'REJECTED',
        reason: entry.expect,
        atStep: entry.atStep,
      });
    }
  });

  it('krok ZA výhrou taky ne — běh už skončil, takže se nikdy nezahrál', () => {
    // Bez téhle kontroly se nedeklarovaný aktér za vítězným tikem nikdy
    // nezkontroluje, a přesto se započítá do `K_input` — certifikát by pak
    // vykazoval délku stopy, kterou nikdo neověřil.
    const witness: TraceInput[] = [
      { tick: 2, actor: 'hero', actionId: 'pull', target: 'lever' },
      { tick: 10, actor: 'ghost', actionId: 'pull', target: 'phantom' },
    ];
    expect(verifyWitness(vault, witness)).toMatchObject({
      verdict: 'REJECTED',
      reason: 'STEP_UNREACHABLE',
      atStep: 1,
    });

    // A bez toho druhého kroku je to týž svědek a certifikuje se — takže
    // odmítnutí přišlo od něj, ne od vítězné části.
    expect(verifyWitness(vault, [witness[0]]).verdict).toBe('CERTIFIED');
  });

  it('cíl smí být i deklarovaný soket, ne jen entita', () => {
    // `references.ts` typuje `onAction.target` jako `entityOrSocket` a zmrazený
    // korpus tak vypadá (`{ actionId: "moveTo", target: "s1" }`). Kdyby
    // verifikátor uznával jen entity, odmítl by většinu svědků, které dostane.
    const toSocket: TraceInput[] = [
      { tick: 1, actor: 'hero', actionId: 'moveTo', target: 's_vault' },
      { tick: 2, actor: 'hero', actionId: 'pull', target: 'lever' },
    ];
    expect(Object.keys(vault.space.sockets)).toContain('s_vault');
    expect(verifyWitness(vault, toSocket).verdict).toBe('CERTIFIED');

    // Nedeklarovaný soket je pořád neproveditelný — jinak by kontrola cíle
    // zmizela úplně.
    expect(
      verifyWitness(vault, [{ tick: 1, actor: 'hero', actionId: 'moveTo', target: 's_nowhere' }]),
    ).toMatchObject({ verdict: 'REJECTED', reason: 'STEP_UNREACHABLE' });
  });

  it('zóna je taky legitimní cíl — soketový prostor je `sockets` ∪ `zones`', () => {
    // `references.ts:148` definuje soketový prostor jako sjednocení a je to
    // tentýž prostor, proti kterému se rozpouštějí cíle svědkových operací.
    // Ptát se jen na `space.sockets` znamená nevydat certifikát světu, který se
    // doopravdy vyhrát dá.
    const withZone: VerifiableWorld = {
      ...vault,
      space: { ...vault.space, zones: { ...vault.space.zones, plaza: [0, 0, 4, 4] } },
    };
    const witness: TraceInput[] = [
      { tick: 0, actor: 'hero', actionId: 'moveTo', target: 'plaza' },
      ...(vault.trace as TraceInput[]),
    ];
    expect(verifyWitness(withZone, witness).verdict).toBe('CERTIFIED');
  });

  it('a soket pojmenovaný jako entita tu entitu nepřebije', () => {
    // Ve zmrazeném korpusu má 9 ze 13 světů soket pojmenovaný přesně jako
    // entita, takže sjednocení „entita NEBO soket" by u nich vypnulo jedinou
    // kontrolu, kterou verifikátor umí změřit až za běhu.
    //
    // Základem je VYHRATELNÝ vault, aby se rozdíl měřil na certifikaci: se
    // sjednocením tenhle svědek projde jako CERTIFIED, s uspořádáním padne.
    // Nad nevyhratelným světem by se rozdíl schoval do dvou různých odmítnutí.
    const smashed = vault.ir.nodes.length;
    const nodes = [
      ...vault.ir.nodes,
      { kind: 'ref' as const, ref: { space: 'pulse' as const, fact: 'acted' as const, args: ['hero', 'smash', 'lever'] } },
    ];
    const effects: IrEffect[] = [...vault.ir.effects, { op: 'despawn', entity: 'lever' }];
    const rules: IrRule[] = [
      ...vault.ir.rules,
      {
        ruleId: 'r.smash',
        phase: 0,
        priority: 3,
        trigger: { kind: 'onEdge', predicate: 'p.onAction.hero.smash.lever', became: true },
        guard: null,
        effects: [effects.length - 1],
      },
    ];
    const shadowed: VerifiableWorld = {
      ...vault,
      space: { ...vault.space, sockets: { ...vault.space.sockets, lever: [3, 1] } },
      ir: {
        ...vault.ir,
        nodes,
        predicates: [
          ...vault.ir.predicates,
          { predicateId: 'p.onAction.hero.smash.lever', source: 'onAction' as const, expr: smashed },
        ],
        effects,
        rules,
      },
    };

    const witness: TraceInput[] = [
      { tick: 0, actor: 'hero', actionId: 'smash', target: 'lever' },
      { tick: 2, actor: 'hero', actionId: 'pull', target: 'lever' },
    ];
    expect(verifyWitness(shadowed, witness)).toMatchObject({
      verdict: 'REJECTED',
      reason: 'STEP_UNREACHABLE',
      atStep: 1,
    });

    // Bez despawnu je týž svědek platný — odmítla ho aktivita entity, ne tvar.
    const intact: VerifiableWorld = { ...shadowed, ir: { ...shadowed.ir, rules: vault.ir.rules } };
    expect(verifyWitness(intact, witness).verdict).toBe('CERTIFIED');
  });

  /**
   * Stav-závislý případ. Předchozí případy jdou rozhodnout ze samotného svědka;
   * tenhle ne — aktér je na začátku aktivní a **přestane být** krokem před tím.
   * Proto se svět odvozuje tady a ne ve zmrazeném souboru: statický záznam by
   * neprokázal, že se proveditelnost měří proti stavu.
   */
  it('cíl despawnutý dřívějším krokem už není proveditelný', () => {
    // Základem je NEVYHRATELNÝ svět schválně: nad vaultem by první krok spustil
    // celý řetěz do výhry a verifikátor by se k druhému kroku nikdy nedostal,
    // takže by test měřil pořadí návratů, ne proveditelnost.
    const effects: IrEffect[] = [...unwinnable.ir.effects, { op: 'despawn', entity: 'lever' }];
    const rules: IrRule[] = [
      ...unwinnable.ir.rules,
      {
        ruleId: 'r.vanish',
        phase: 0,
        priority: 3,
        trigger: { kind: 'onEdge', predicate: 'p.onAction.hero.pull.lever', became: true },
        guard: null,
        effects: [effects.length - 1],
      },
    ];
    const vanishing: VerifiableWorld = { ...unwinnable, ir: { ...unwinnable.ir, effects, rules } };

    const witness: TraceInput[] = [
      { tick: 1, actor: 'hero', actionId: 'pull', target: 'lever' },
      { tick: 4, actor: 'hero', actionId: 'pull', target: 'lever' },
    ];

    const result = verifyWitness(vanishing, witness);
    expect(result).toMatchObject({ verdict: 'REJECTED', reason: 'STEP_UNREACHABLE', atStep: 1 });
    expect((result as { detail: string }).detail).toContain('lever');

    // Týž svět s JEDINÝM krokem dojde až na konec horizontu — tedy `NO_WIN`, ne
    // `STEP_UNREACHABLE`. Tím je prokázané, že první krok proveditelný byl a
    // odmítnutí přišlo od druhého, ne od obojího.
    expect(verifyWitness(vanishing, [witness[0]])).toMatchObject({
      verdict: 'REJECTED',
      reason: 'NO_WIN',
    });
  });
});

describe('náhodná procházka se necertifikuje', () => {
  /** Sto seedovaných svědků nad daným světem; vrací počet certifikací. */
  const walk = (world: VerifiableWorld, actions: readonly string[]): number => {
    // `pure-rand`, ne globální náhoda — replay cesta musí zůstat
    // reprodukovatelná a `CLAUDE.md` to má mezi nepřekročitelnými pravidly.
    const stream = createStreams(20260812).ai;
    const actors = ['hero', 'lever', 'door'];
    let certified = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const witness: TraceInput[] = [];
      const steps = nextInt(stream, 1, TIER_POLICY.short.maxInputs);
      let tick = 0;
      for (let i = 0; i < steps; i += 1) {
        tick += nextInt(stream, 0, 3);
        witness.push({
          tick,
          actor: actors[nextInt(stream, 0, actors.length - 1)],
          actionId: actions[nextInt(stream, 0, actions.length - 1)],
          target: actors[nextInt(stream, 0, actors.length - 1)],
        });
      }
      if (verifyWitness(world, witness).verdict === 'CERTIFIED') certified += 1;
    }
    return certified;
  };

  it('kandidát BEZ platného svědka neprojde ani jednou, ani s vítěznou akcí v abecedě', () => {
    // Tohle je doslovné znění AC: kandidát bez platného svědka. `unwinnable`
    // žádného nemá, takže abeceda smí obsahovat i `pull` — neexistuje stopa,
    // která by ho vyhrála, a certifikace by znamenala vadu verifikátoru.
    expect(walk(unwinnable, ['pull', 'wave', 'push', 'look'])).toBe(0);
  });

  it('sto seedovaných svědků bez příčinného vstupu neprojde ani jednou', () => {
    // `pure-rand`, ne globální náhoda — replay cesta musí zůstat reprodukovatelná
    // a `CLAUDE.md` to má mezi nepřekročitelnými pravidly.
    const stream = createStreams(20260812).ai;
    const actors = ['hero', 'lever', 'door'];
    // Vítězná trojice `hero/pull/lever` v abecedě SCHVÁLNĚ není: kdyby ji
    // generátor mohl trefit, nula certifikací by měřila štěstí, ne politiku.
    const actions = ['wave', 'push', 'look', 'wait'];

    let certified = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const witness: TraceInput[] = [];
      const steps = nextInt(stream, 1, TIER_POLICY.short.maxInputs);
      let tick = 0;
      for (let i = 0; i < steps; i += 1) {
        tick += nextInt(stream, 0, 3);
        witness.push({
          tick,
          actor: actors[nextInt(stream, 0, actors.length - 1)],
          actionId: actions[nextInt(stream, 0, actions.length - 1)],
          target: actors[nextInt(stream, 0, actors.length - 1)],
        });
      }
      if (verifyWitness(vault, witness).verdict === 'CERTIFIED') certified += 1;
    }

    expect(certified).toBe(0);
  });

  it('a přitom pravý svědek projde — jinak by nula nic neznamenala', () => {
    expect(verifyWitness(vault, WINNING).verdict).toBe('CERTIFIED');
  });
});

describe('replay cesta nesahá na nástěnné hodiny', () => {
  /** Moduly, kterými prochází `verifyWitness`. Ruční seznam, protože je krátký. */
  const REPLAY_PATH = [
    'verify/witness.ts',
    'verify/tiers.ts',
    'sim/interpreter.ts',
    'sim/phases.ts',
    'sim/state.ts',
    'sim/hash.ts',
    'ir/eval.ts',
    'ir/schema.ts',
    'ir/types.ts',
  ];

  it.each(REPLAY_PATH)('%s nečte wall-clock ani reálný rAF', (moduleName) => {
    const source = readFileSync(join(process.cwd(), 'src', ...moduleName.split('/')), 'utf8');
    // Doslovný sken, takže by ho shodila i zmínka v komentáři — proto o zákazu
    // mluví `rng.ts` opisem a proto ho tyhle moduly nezmiňují vůbec.
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/performance\.now/);
    expect(source).not.toMatch(/requestAnimationFrame/);
  });

  it('a ten seznam skutečně pokrývá to, co verifikátor importuje', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'verify', 'witness.ts'), 'utf8');
    for (const specifier of ['../sim/hash', '../sim/interpreter', './tiers'])
      expect(source, specifier).toContain(specifier);
  });
});

/**
 * Hash stopy (P11 T15) — jediná věc, kterou se dá zvenčí ověřit, že náhled
 * vítězné cesty přehrává tutéž stopu, jakou certifikát potvrdil.
 *
 * Aserce na shodu hashů má cenu jen tehdy, když se dvě různé stopy doopravdy
 * rozejdou. Testuje se proto hlavně to, **co všechno hash rozliší** — kdyby
 * kolidoval, „náhled sedí s certifikátem" by platilo i o náhledu, který lže.
 */
describe('hashWitness — dvě různé stopy se musí rozejít', () => {
  const step = (over: Partial<TraceInput> = {}): TraceInput => ({
    tick: 10,
    actor: 'player',
    actionId: 'moveTo',
    target: 'exit',
    ...over,
  });

  it('má tvar hashe a je deterministický', () => {
    expect(hashWitness([step()])).toMatch(/^[0-9a-f]{8}$/);
    expect(hashWitness([step()])).toBe(hashWitness([step()]));
  });

  it('rozliší tik, herce, akci i cíl — každý zvlášť', () => {
    const base = hashWitness([step()]);
    expect(hashWitness([step({ tick: 11 })])).not.toBe(base);
    expect(hashWitness([step({ actor: 'guard' })])).not.toBe(base);
    expect(hashWitness([step({ actionId: 'pickup' })])).not.toBe(base);
    expect(hashWitness([step({ target: 'k1' })])).not.toBe(base);
  });

  it('rozliší pořadí a délku, ne jen množinu tahů', () => {
    const a = step({ tick: 1, actionId: 'pickup' });
    const b = step({ tick: 2, actionId: 'moveTo' });
    expect(hashWitness([a, b])).not.toBe(hashWitness([b, a]));
    expect(hashWitness([a, b])).not.toBe(hashWitness([a]));
    expect(hashWitness([])).not.toBe(hashWitness([a]));
  });

  it('délka řetězce jde do hashe, takže posunutá hranice slov nekoliduje', () => {
    // Bez prefixu délky by z obojího vyšla táž slova a dvě různé stopy by měly
    // týž hash — přesně ta tichá kolize, kvůli které by aserce nic netvrdila.
    const left = hashWitness([step({ actor: 'ab', actionId: 'c', target: 'd' })]);
    const right = hashWitness([step({ actor: 'a', actionId: 'bc', target: 'd' })]);
    expect(left).not.toBe(right);
  });

  it('nepřítomný cíl je týž zástupce jako `none` — vědomě, ne omylem', () => {
    const absent = step();
    delete (absent as { target?: string }).target;
    expect(hashWitness([absent])).toBe(hashWitness([step({ target: 'none' })]));
  });

  it('certifikát nese hash TÉ stopy, kterou dostal', () => {
    const cert = verifyWitness(vault, WINNING) as Certificate;
    expect(cert.witnessHash).toBe(hashWitness(WINNING));
    expect(cert.witnessHash).not.toBe(cert.snapshotHash);
  });
});
