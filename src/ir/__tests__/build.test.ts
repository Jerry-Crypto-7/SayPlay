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
