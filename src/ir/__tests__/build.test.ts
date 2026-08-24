/**
 * Snížení povrchu do běhové podoby — oracle je **zmrazený korpus**, ne fixtura
 * autorovaná vedle implementace.
 *
 * Tohle je ta vada, kterou si repo naměřilo dvakrát: `worlddoc.ts:79` popisuje,
 * jak první znění `simSchema` žádalo `layout.type` proti korpusovému
 * `layout.kind` a **0 z 15** zmrazených emisí prošlo, aniž si toho kterýkoli test
 * všiml, protože se validovaly jen fixtury z téhož commitu. Snížení má tentýž
 * tvar rizika: čte povrchová jména, kterých se schéma vůbec nedotýká.
 *
 * Aserce jsou proto **pinované počty nad zmrazenými těly**. Kdyby se pokrytí
 * zhoršilo, čísla se rozejdou; kdyby se zlepšilo, taky — a obojí patří před oči,
 * ne pod koberec.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../build';
import { findDanglingReferences } from '../references';
import { verifyWitness } from '../../verify/witness';

interface FrozenRecord {
  readonly forPrompt: string;
  readonly branch: string;
  readonly expectedVerdict: string;
  readonly body: { readonly sim?: unknown; readonly look?: unknown };
}

const records: FrozenRecord[] = readFileSync('evals/frozen/responses/index.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FrozenRecord);

const creates = records.filter((record) => record.branch === 'create');
/** `C14` a `C15` jsou `NO_FIT` a `sim` vůbec nenesou — snižovat není co. */
const withSim = creates.filter((record) => record.body.sim !== null && record.body.sim !== undefined);

function outcomeOf(record: FrozenRecord): string {
  const built = buildRuntimeWorld(record.body.sim);
  if (!built.ok) return built.reason;
  return verifyWitness(built.world, built.world.trace).verdict;
}

describe('snížení zmrazených emisí', () => {
  it('sníží každé zmrazené tělo, které nějaké `sim` nese', () => {
    // Jedna výjimka a je pojmenovaná, ne tolerovaná: `countInZone` nad zónou
    // o třech obdélnících. `world-ir-v1` nemá sčítání, takže se to vyjádřit nedá
    // a odmítnutí je poctivější než ohraničující obdélník, který by počítal
    // i entity mimo zónu.
    const failures = withSim
      .map((record) => ({ id: record.forPrompt, built: buildRuntimeWorld(record.body.sim) }))
      .filter((entry) => !entry.built.ok);

    expect(failures.map((entry) => entry.id)).toEqual(['C05']);
    expect(failures[0].built.ok).toBe(false);
    if (!failures[0].built.ok) {
      expect(failures[0].built.reason).toBe('UNSUPPORTED_SURFACE');
      expect(failures[0].built.issues[0]).toContain('world-ir-v1 has no summation');
    }
  });

  it('vydá certifikát právě těm světům, jejichž svědek doopravdy vyhraje', () => {
    // Naměřeno, ne zvoleno. Sedm zbylých nese vlastní důvod a ten důvod je
    // vlastnost emise, ne snížení — proto se pinují i ony, se svým verdiktem.
    const measured = Object.fromEntries(withSim.map((record) => [record.forPrompt, outcomeOf(record)]));

    expect(measured).toEqual({
      C01: 'CERTIFIED',
      C02: 'CERTIFIED',
      C03: 'CERTIFIED',
      C04: 'CERTIFIED',
      C05: 'UNSUPPORTED_SURFACE',
      C06: 'CERTIFIED',
      C07: 'CERTIFIED',
      // Svědek posílá hráče na `centre`, kde stojí minotaurus, a `catch` z toho
      // dělá prohru. Maze navíc nedeklaruje jedinou neprůchodnou buňku, takže
      // `onSeen` platí přes celou mřížku — validátor layoutu je až P5 T505.
      C08: 'REJECTED',
      // `hit` despawnuje `target0` po prvním výstřelu, druhý míří na neaktivní
      // entitu. Vstupní hranice to odmítne, a je to vada emise.
      C09: 'REJECTED',
      C10: 'REJECTED',
      C11: 'REJECTED',
      C12: 'REJECTED',
      C13: 'REJECTED',
    });
  });

  it('nepřisuzuje výhru světu, který ji nemá — verdikt nesmí být konstanta', () => {
    // Kdyby `verifyWitness` na téhle cestě certifikoval cokoli, předchozí test by
    // prošel s jediným `CERTIFIED` napříč sadou. Tenhle se ptá na obě polarity
    // najednou, takže konstantní verdikt shodí právě on.
    const outcomes = new Set(withSim.map(outcomeOf));
    expect(outcomes.has('CERTIFIED')).toBe(true);
    expect(outcomes.has('REJECTED')).toBe(true);
  });
});

describe('vstupní hranice a rozpouštění jmen', () => {
  /**
   * Dluh z kola 5 nad T8b: `onAction.target` je druhá cesta do prostoru
   * `entityOrSocket` a jako jediná neměla pozitivní test. Tady dostává resolver
   * skutečné vstupy — a pozitivní tvrzení („nic osiřelého") se ověřuje spolu
   * s negativním, jinak by prošel i resolver, který mlčí vždycky.
   */
  it('rozpustí `onAction.target` proti entitám i soketům', () => {
    for (const record of withSim) {
      expect(findDanglingReferences(record.body), `${record.forPrompt} má osiřelý odkaz`).toEqual([]);
    }

    const c01 = withSim.find((record) => record.forPrompt === 'C01');
    expect(c01).toBeDefined();
    const sim = structuredClone(c01!.body.sim) as {
      rules: Record<string, { event: Record<string, unknown> }>;
    };
    // `hit`/`pick` v C01 nemá `onAction`; přepíše se událost `win`, aby cíl
    // ukazoval mimo obě deklarace naráz.
    sim.rules.win.event = { kind: 'onAction', actionId: 'use', target: 'nowhere' };
    const found = findDanglingReferences({ sim });
    expect(found).toEqual([
      { where: 'sim.rules[win].event.target', namespace: 'entityOrSocket', name: 'nowhere' },
    ]);

    // A obě strany prostoru zvlášť: entita i soket se rozpouštějí, ne jen jedna.
    sim.rules.win.event = { kind: 'onAction', actionId: 'use', target: 'exit' };
    expect(findDanglingReferences({ sim })).toEqual([]);
    sim.rules.win.event = { kind: 'onAction', actionId: 'moveTo', target: 'k1' };
    expect(findDanglingReferences({ sim })).toEqual([]);
  });

  it('cíl kanonické akce mimo prostor entit se do IR nedostane', () => {
    // `PULSE_FACTS.acted` má třetí argument jako `entityOrNone`, takže pravidlo
    // mířící na soket by vyrobilo osiřelý argument. Snížení to musí odmítnout
    // verdiktem, ne vydat IR, které `validateIrDoc` shodí až u volajícího.
    const c01 = withSim.find((record) => record.forPrompt === 'C01');
    const sim = structuredClone(c01!.body.sim) as {
      sockets: Record<string, unknown>;
      rules: Record<string, { event: Record<string, unknown> }>;
    };
    sim.rules.win.event = { kind: 'onAction', actionId: 'moveTo', target: 'k1' };

    const built = buildRuntimeWorld(sim);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toBe('INVALID_IR');
      expect(built.issues.join('\n')).toContain('unknown entity k1');
    }
  });
});

describe('systémové vazby, které model neautoruje', () => {
  const c01 = withSim.find((record) => record.forPrompt === 'C01')!;

  it('soket je zóna, jinak `onEnterZone(player, exit)` nikdy nenastane', () => {
    const built = buildRuntimeWorld(c01.body.sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.world.space.zones.exit).toEqual([11, 6, 1, 1]);
    expect(built.world.space.sockets.exit).toEqual([11, 6]);
  });

  it('bez vazby pohybu se svět nevyhraje — je to systém, ne pravidlo modelu', () => {
    const built = buildRuntimeWorld(c01.body.sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const bindings = built.world.ir.rules.filter((rule) => rule.ruleId.startsWith('sys.moveTo.'));
    expect(bindings.length).toBeGreaterThan(0);

    // Mutace: odeber vazbu pohybu a týž svědek přestane vyhrávat. Bez téhle
    // aserce by „vazba existuje" bylo tvrzení o poli, ne o chování.
    const without = {
      ...built.world,
      ir: {
        ...built.world.ir,
        rules: built.world.ir.rules.filter((rule) => !rule.ruleId.startsWith('sys.moveTo.')),
      },
    };
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');
    expect(verifyWitness(without, without.trace).verdict).toBe('REJECTED');
  });

  /**
   * Zón bývá víc než entit, a to je normální svět, ne patologie.
   *
   * **Oracle je tady ručně psaný, proti zvyku tohohle souboru — schválně.**
   * Zmrazený korpus tuhle vlastnost nepokrývá: všechny jeho create světy mají zón
   * nejvýš tolik co entit, protože zóny v nich vznikají skoro jen ze socketů.
   * Právě proto vada přežila do prvního živého běhu (T18), kde ji `C02` trefil
   * hned — pět entit, šest zón, a výherní zóna byla ta šestá. Sensing běžel proti
   * `maxEntities`, takže se na ni nikdy nedostalo: `onEnterZone` nad ní zůstalo
   * navždy nepravdivé, nic nespadlo a svět se prostě nedal dohrát.
   */
  it('svět s víc zónami než entitami vnímá i tu poslední zónu', () => {
    const sim = {
      layout: { width: 12, height: 6 },
      sockets: { spawn: [1, 3], a: [3, 3], b: [5, 3], c: [7, 3], finish: [10, 3] },
      entities: {
        player: { role: 'actor', socket: 'spawn', state: 'idle' },
        marker: { role: 'prop', socket: 'a', state: 'idle' },
        // Kanonické `moveTo` míří na ENTITU, ne na soket — hráče posune až
        // systémová vazba `sys.moveTo.<entita>`. Bez cíle na `finish` by svědek
        // neselhal na zónách, ale na tom, že se hráč vůbec nehne.
        goalPost: { role: 'goal', socket: 'finish', state: 'idle' },
      },
      state: { counters: {}, flags: {}, timers: {}, zones: { winZone: [[9, 2, 3, 3]] } },
      rules: {
        arrive: {
          phase: 0,
          priority: 0,
          event: { kind: 'onEnterZone', entity: 'player', zone: 'winZone' },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      },
      witness: { tier: 'short', H_cert: 600, ops: [{ tick: 0, actionId: 'moveTo', target: 'marker' }] },
    };

    // Svědek míří na `marker` na socketu `a` — mimo `winZone`. Výhru přinese až
    // druhý krok, takže samotné postavení světa nic nevyhrává.
    const built = buildRuntimeWorld({
      ...sim,
      witness: { ...sim.witness, ops: [{ tick: 0, actionId: 'moveTo', target: 'marker' }] },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Bez tohohle by test zezelenal i nad světem, kde zón NENÍ víc než entit —
    // tedy nad světem, který vadu vůbec nespouští. Aserce drží předpoklad, ne kosmetiku.
    const zoneCount = Object.keys(built.world.space.zones).length;
    expect(zoneCount).toBeGreaterThan(built.world.ir.limits.maxEntities);
    expect(built.world.ir.limits.maxZones).toBe(zoneCount);

    const winning = buildRuntimeWorld(sim);
    expect(winning.ok).toBe(true);
    if (!winning.ok) return;
    const toFinish = [{ tick: 0, actor: 'player', actionId: 'moveTo', target: 'goalPost' }];
    expect(verifyWitness(winning.world, toFinish).verdict).toBe('CERTIFIED');
  });

  it('horizont zůstává přáním dokumentu — tier ho smí jen odmítnout', () => {
    const sim = structuredClone(c01.body.sim) as { witness: { tier: string; H_cert: number } };
    sim.witness.H_cert = 5_000;
    const built = buildRuntimeWorld(sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // 5 000 nad stropem `short` (600) je podle protokolu `NO_FIT`, ne povýšení
    // do delšího tieru. Kdyby si snížení horizont oříznulo samo, dokument by si
    // tiše koupil certifikaci, na kterou nemá.
    expect(built.world.certification).toEqual({ tier: 'short', horizonTicks: 5_000 });
    expect(verifyWitness(built.world, built.world.trace)).toMatchObject({
      verdict: 'REJECTED',
      reason: 'NO_FIT',
    });
  });
});

describe('soket mimo mřížku', () => {
  /**
   * Soket mimo rozvržení je **tichý průchod vadné emise**, ne kosmetika.
   *
   * `stepToward` odmítne krok mimo mřížku, takže `moveTo` na takový soket nikdy
   * nedojde, hrana příchodu nikdy nenastane a entita stojí do konce běhu. Nic
   * nespadne a nic se nenahlásí — svět se přijme a nedá se dohrát.
   *
   * **Oracle je ručně psaný, protože zmrazený korpus tuhle vadu nemá.**
   * Naměřeno nad všemi 40 zmrazenými záznamy: 13 create těl nese rozvržení
   * i sokety a **0 z nich má soket mimo mřížku**. Kontrola tedy nemění, co
   * korpus vydá — a právě proto ji korpus sám neuhlídá.
   */
  function simWithSocket(cell: readonly [number, number]) {
    return {
      layout: { width: 12, height: 8 },
      sockets: { spawn: [1, 3], far: cell },
      entities: {
        player: { role: 'actor', socket: 'spawn', state: 'idle' },
        goalPost: { role: 'goal', socket: 'far', state: 'idle' },
      },
      state: { counters: {}, flags: {}, timers: {}, zones: {} },
      rules: {
        arrive: {
          phase: 0,
          priority: 0,
          event: { kind: 'onAction', actionId: 'moveTo', target: 'goalPost' },
          condition: null,
          actions: [{ kind: 'win' }],
        },
      },
      witness: { tier: 'short', H_cert: 600, ops: [{ tick: 0, actionId: 'moveTo', target: 'goalPost' }] },
    };
  }

  /**
   * Každá ze čtyř hran má vlastní případ, a to schválně.
   *
   * Kdyby se testovalo jen `[50, 50]`, přežila by mutace, která kontroluje
   * pouhou osu X — porušené jsou tam obě zároveň. Tahle tabulka drží každou
   * mez samostatně, takže vypadlá polovina podmínky se ozve.
   */
  const mimoMrizku: readonly (readonly [string, readonly [number, number]])[] = [
    ['za pravým okrajem', [13, 3]],
    ['pod spodním okrajem', [3, 9]],
    ['záporné x', [-1, 3]],
    ['záporné y', [3, -1]],
  ];

  for (const [kde, cell] of mimoMrizku) {
    it(`soket ${kde} se odmítne a hláška ho pojmenuje`, () => {
      const built = buildRuntimeWorld(simWithSocket(cell));
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.reason).toBe('UNSUPPORTED_SURFACE');
      // Jméno soketu v hlášce je součást AC: bez něj se ve světě o dvaceti
      // socketech nedá dohledat, který z nich je ten vadný.
      expect(built.issues.join(' | ')).toContain('far');
      expect(built.issues.join(' | ')).toContain(`[${cell[0]}, ${cell[1]}]`);
    });
  }

  /**
   * Hranice se měří, ne odhaduje.
   *
   * `stepToward` pouští krok při `nx <= gridWidth` a `createRuntime` dosazuje
   * slotům entit `max: gridWidth`, takže poslední průchozí buňka je `gridWidth`
   * SAMA, ne `gridWidth - 1`. Přísnější kontrola (`>= gridWidth`) by prošla
   * všemi případy výš a přitom odmítala světy, které dnes fungují — proto
   * tenhle test drží obě strany hrany, ne jen tu vadnou.
   */
  it('poslední průchozí buňka projde na obou osách', () => {
    expect(buildRuntimeWorld(simWithSocket([12, 8])).ok).toBe(true);
    expect(buildRuntimeWorld(simWithSocket([12, 3])).ok).toBe(true);
    expect(buildRuntimeWorld(simWithSocket([3, 8])).ok).toBe(true);
  });

  it('bez vady se týž svět postaví a dohraje — kontrola nic neubrala', () => {
    const built = buildRuntimeWorld(simWithSocket([10, 3]));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');
  });
});
