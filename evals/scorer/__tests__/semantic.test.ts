/**
 * T16 — strojový sémantický scorer verdiktu `FULFILLED`.
 *
 * Sada dokazuje čtyři věci a každá z nich odpovídá jedné větě AC:
 *
 * 1. **Kontrakty mají jediný zdroj** — zmrazený `evals/frozen/contracts.v1.jsonl`.
 *    Kontroluje se čtením samotného adresáře `evals/scorer/`, ne důvěrou.
 * 2. **Stropy drží.** Prázdné chování, fallback, insta-win a prázdný vektor
 *    požadavků končí `ROBUST` i tehdy, když je kontrakt `FULFILLABLE`.
 * 3. **Scorer měří jednotlivé požadavky.** Pro každý požadavek každého
 *    pozitivního případu existuje mutace, po které selže právě on (plus jeho
 *    deklarovaná vedlejší škoda) a verdikt se překlopí.
 * 4. **Nikdo tu nevolá model.** Scorer je čistá funkce nad kontraktem a důkazem.
 *
 * Body 2 a 3 jsou dohromady ta zajímavá půlka. Bod 2 sám by prošel scoreru, který
 * vrací `FULFILLED` podle ID promptu; bod 3 sám by prošel scoreru, který nezná
 * strop a insta-win pustí dál.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONTRACTS_PATH, loadContracts, scoreCase, type Contract, type Evidence, type ScoreResult } from '../semantic';
import { buildRuntimeWorld, isInstaWin, verifyWitness } from '../world';
import { clone, frozenCases, type FrozenCase } from './corpus';
import { mutationsFor, MUTATED_CASES, UNFALSIFIABLE } from './mutations';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const scorerDir = join(repoRoot, 'evals', 'scorer');

const cases = new Map(frozenCases().map((each) => [each.id, each]));
const contracts = new Map(loadContracts().map((contract) => [contract.id, contract]));

function caseOf(id: string): FrozenCase {
  const found = cases.get(id);
  if (found === undefined) throw new Error(`případ ${id} v korpusu není`);
  return found;
}

function contractOf(id: string): Contract {
  const found = contracts.get(id);
  if (found === undefined) throw new Error(`kontrakt ${id} v korpusu není`);
  return found;
}

function unmetRids(result: ScoreResult): string[] {
  return result.requirements
    .filter((each) => !each.met)
    .map((each) => each.rid)
    .sort();
}

function negativeFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scorerDir, '__fixtures__', 'negatives', `${name}.json`), 'utf8'));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// 1. Jediný zdroj kontraktů
// ---------------------------------------------------------------------------

describe('kontrakty mají jediný zdroj', () => {
  it('žádný soubor scoreru nepojmenovává druhý soubor s kontrakty', () => {
    // Strojová verze grepu z AC. Hledá se **odkaz na soubor**, ne výskyt slova:
    // druhý zdroj kontraktů se bez literálu, který ho pojmenuje a končí na
    // `.json`/`.jsonl`, otevřít nedá.
    const reference = /'[^'\n]*contracts[^'\n]*\.jsonl?'/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(scorerDir)) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        for (const literal of line.match(reference) ?? []) {
          if (literal === "'contracts.v1.jsonl'") continue;
          offenders.push(`${file.slice(repoRoot.length)}:${index + 1}: ${literal}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('implementace scoreru otevírá jediný soubor, a je to ten zmrazený', () => {
    // Druhá půlka téže otázky: kdyby druhý zdroj vznikl bez rozpoznatelného
    // jména, poznal by se podle toho, že implementace sahá na disk podruhé.
    const reads: string[] = [];
    for (const file of sourceFiles(scorerDir)) {
      if (file.includes('__tests__')) continue;
      for (const call of readFileSync(file, 'utf8').match(/readFileSync\([^)]*\)/g) ?? []) {
        reads.push(`${file.slice(repoRoot.length)}: ${call}`);
      }
    }
    expect(reads).toEqual([`${join('evals', 'scorer', 'semantic.ts')}: readFileSync(CONTRACTS_PATH, 'utf8')`]);
  });

  it('zmrazený soubor je ten, ze kterého se doopravdy čte', () => {
    expect(CONTRACTS_PATH).toBe(join(repoRoot, 'evals', 'frozen', 'contracts.v1.jsonl'));
    expect(loadContracts().length).toBe(readFileSync(CONTRACTS_PATH, 'utf8').trim().split('\n').length);
  });

  it('scorer nemá jak zavolat model — v jeho zdrojích není síť ani klient', () => {
    const forbidden = /\bfetch\s*\(|node:https?|from '\.\.\/\.\.\/src\/model/;
    for (const file of sourceFiles(scorerDir)) {
      if (file.includes('__tests__')) continue;
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Stropy
// ---------------------------------------------------------------------------

describe('stropy drží i nad FULFILLABLE kontraktem', () => {
  it('prázdné chování: schema-validní svět bez jediného pravidla je ROBUST', () => {
    const doc = negativeFixture('empty-behaviour');
    // Nejdřív se ukáže, že na světě není nic rozbitého — postaví se.
    expect(buildRuntimeWorld((doc as { sim: unknown }).sim).ok).toBe(true);

    const result = scoreCase(contractOf('C01'), { kind: 'create', outcome: 'emitted', doc, sceneBuilt: true });
    expect(result.verdict).toBe('ROBUST');
    expect(result.gates).toContain('graf nemá jediné pravidlo — prázdné chování');
  });

  it('insta-win: svět, který verifikátor CERTIFIKUJE, scorer přesto nepustí', () => {
    const doc = negativeFixture('insta-win');
    const built = buildRuntimeWorld((doc as { sim: unknown }).sim);
    if (!built.ok) throw new Error('fixture se nepostavila');

    // Tohle je celý důvod, proč je insta-win brána a ne požadavek: verifikátor
    // ho pustí. Kdyby se scorer spolehl na `verifyWitness`, prošel by taky.
    expect(isInstaWin(built.world)).toBe(true);
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');

    const result = scoreCase(contractOf('C01'), { kind: 'create', outcome: 'emitted', doc, sceneBuilt: true });
    expect(result.verdict).toBe('ROBUST');
    expect(result.gates).toContain('insta-win: svět vyhrává v tiku 0 bez jediného vstupu');
  });

  it('fallback: TENTÝŽ dokument je FULFILLED jako emise a ROBUST jako fallback', () => {
    const positive = caseOf('C01');
    if (positive.evidence.kind !== 'create' || positive.evidence.outcome !== 'emitted')
      throw new Error('C01 není emitovaný create');

    expect(scoreCase(positive.contract, positive.evidence).verdict).toBe('FULFILLED');

    const fallback: Evidence = { kind: 'create', outcome: 'fallback', sceneBuilt: true };
    const result = scoreCase(positive.contract, fallback);
    expect(result.verdict).toBe('ROBUST');
    expect(result.gates).toContain('fallback: použitelný výsledek, ale ne splněný kontrakt');
  });

  it('prázdný vektor požadavků: i svět, který plní bohatý kontrakt, zůstane ROBUST', () => {
    const rich = caseOf('C01');
    for (const id of ['C10', 'C11', 'C12']) {
      const empty = contractOf(id);
      expect(empty.requirements.filter((req) => req.layer !== 'outcome' && req.kind !== 'sceneMustBuild')).toEqual([]);

      const result = scoreCase(empty, rich.evidence);
      expect(result.verdict).toBe('ROBUST');
      expect(result.gates).toContain('prázdný vektor požadavků — není co splnit');
    }
  });

  it('strop ROBUST_ONLY se uplatní jmenovitě, ne jen ve výsledku', () => {
    const ceilinged = loadContracts().filter((contract) => contract.scoreAs === 'ROBUST_ONLY');
    expect(ceilinged.length).toBeGreaterThan(0);

    for (const contract of ceilinged) {
      const result = scoreCase(contract, caseOf('C01').evidence);
      expect(result.verdict).not.toBe('FULFILLED');
      // Verdikt sám by tu nic nedokázal: každý `ROBUST_ONLY` záznam ve zmrazené
      // sadě nese i `verdictCeiling: "ROBUST"`, takže by ho zastavil i ten.
      // Vlastnost, kterou drží JEN `scoreAs`, je vykázaný důvod — a report
      // z T21 čte právě ten.
      expect(result.gates.some((gate) => gate.startsWith('strop ROBUST:'))).toBe(true);
    }
  });

  it('v korpusu je `scoreAs: ROBUST_ONLY` zdvojené stropem, a je to měřený fakt', () => {
    // Zapsané proto, aby test výš nikdo nečetl jako důkaz, že `scoreAs` je
    // jediná pojistka. Až přibude záznam, který má strop `FULFILLED` a přesto
    // `ROBUST_ONLY`, dostane ta dvojice zuby sama od sebe.
    for (const contract of loadContracts()) {
      if (contract.scoreAs !== 'ROBUST_ONLY') continue;
      expect(contract.verdictCeiling).toBe('ROBUST');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Kontrafaktuální mutace
// ---------------------------------------------------------------------------

describe('pozitivní případy jsou pozitivní', () => {
  it.each(MUTATED_CASES)('%s je bez mutace FULFILLED a všechny jeho požadavky sedí', (id) => {
    const result = scoreCase(caseOf(id).contract, caseOf(id).evidence);
    expect(unmetRids(result)).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(result.verdict).toBe('FULFILLED');
  });

  it('mutovaná sada je právě ta, kterou scorer hodnotí jako FULFILLED', () => {
    // Kdyby přibyl pozitivní případ a mutace se k němu nedopsaly, tenhle test
    // spadne — jinak by nová větev kontraktu zůstala nezměřená.
    const scored = [...cases.values()]
      .filter((each) => scoreCase(each.contract, each.evidence).verdict === 'FULFILLED')
      .map((each) => each.id)
      .sort();
    expect(scored).toEqual([...MUTATED_CASES].sort());
  });
});

describe('kontrafaktuální mutace: každý požadavek se měří jednotlivě', () => {
  it('každý požadavek pozitivního kontraktu má mutaci, nebo doložený důvod, proč nejde', () => {
    for (const id of MUTATED_CASES) {
      const substantive = caseOf(id)
        .contract.requirements.filter((req) => req.layer !== 'outcome' && req.kind !== 'sceneMustBuild')
        .map((req) => req.rid);
      const covered = new Set([...mutationsFor(id).map((each) => each.rid), ...Object.keys(UNFALSIFIABLE)]);
      expect(substantive.filter((rid) => !covered.has(rid))).toEqual([]);
    }
  });

  const all = MUTATED_CASES.flatMap((id) => mutationsFor(id).map((mutation) => [id, mutation] as const));

  it.each(all.map(([id, mutation]) => [`${mutation.rid} — ${mutation.label}`, id, mutation] as const))(
    '%s',
    (_name, id, mutation) => {
      const base = caseOf(id);
      const mutated = scoreCase(base.contract, mutation.build(base));

      // Terč MUSÍ selhat. Kdyby scorer ten požadavek neměřil, projde tady.
      const unmet = unmetRids(mutated);
      expect(unmet).toContain(mutation.rid);

      // A nic víc, než co mutace přiznává. Zamčené rovností, ne podmnožinou.
      expect(unmet).toEqual([mutation.rid, ...mutation.collateral].sort());

      expect(mutated.verdict).not.toBe('FULFILLED');
    },
  );
});

describe('vakuózní požadavky se dokazují, ne obcházejí', () => {
  it('C06.r4 je pravdivé pro každý svět, protože tik 0 je snímek před prvním tikem', () => {
    expect(Object.keys(UNFALSIFIABLE)).toEqual(['C06.r4']);

    const requirement = contractOf('C06').requirements.find((req) => req.rid === 'C06.r4');
    expect(requirement?.value).toMatchObject({ tick: 0, expr: "fireCount('day5Branch')", op: '==', rhs: 0 });

    // Důkaz místo mutace: i svět, ve kterém sledované pravidlo VŮBEC NENÍ,
    // a i svět, ve kterém vystřelí hned, čtou v tiku 0 nulu. Nula tam tedy
    // nemluví o tomhle světě, ale o okamžiku před prvním tikem.
    for (const build of [
      (sim: Record<string, any>) => void delete sim.rules.day5Branch,
      (sim: Record<string, any>) => void (sim.rules.day5Branch.event = { kind: 'onStart' }),
    ]) {
      const base = caseOf('C06');
      if (base.evidence.kind !== 'create' || base.evidence.outcome !== 'emitted') throw new Error('C06 není create');
      const doc = clone(base.evidence.doc) as Record<string, any>;
      build(doc.sim);
      const result = scoreCase(base.contract, { kind: 'create', outcome: 'emitted', doc, sceneBuilt: true });
      expect(result.requirements.find((each) => each.rid === 'C06.r4')?.met).toBe(true);
    }
  });
});
