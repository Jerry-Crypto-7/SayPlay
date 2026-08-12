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
import { verifyWitness, type Certificate, type VerifiableWorld } from '../witness';

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

  it('horizont v certifikátu je ten systémový, nikdy vyšší než strop tieru', () => {
    const result = verifyWitness(
      { ...vault, certification: { tier: 'short', horizonTicks: 30 } },
      WINNING,
    ) as Certificate;
    expect(result.horizonTicks).toBe(30);
    expect(result.horizonTicks).toBeLessThanOrEqual(TIER_POLICY.short.maxHorizonTicks);
  });
});

describe('`K_input` je strop, ne doporučení', () => {
  /** Vítězný vstup plus neškodná výplň, roztažená přes tiky kvůli frontě. */
  const padded = (count: number): TraceInput[] => {
    const inputs: TraceInput[] = [{ tick: 2, actor: 'hero', actionId: 'pull', target: 'lever' }];
    for (let i = 0; i < count; i += 1) inputs.push({ tick: 3 + i, actor: 'hero', actionId: 'wave' });
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
