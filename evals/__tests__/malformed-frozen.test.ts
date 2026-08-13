import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalRuleOrder,
  carriesOrderKeys,
  isCanonicallyOrdered,
  ruleRecordOf,
  type RuleRecord,
} from './rule-order';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const frozenDir = join(repoRoot, 'evals', 'frozen');

interface Malformed {
  id: string;
  defectClass: string;
  defect: string;
  expectedRepair: string;
  repairable: boolean;
  mustPreserve: string[];
  body: Record<string, unknown>;
}

const fixtures = readFileSync(join(frozenDir, 'malformed', 'index.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Malformed);

const protocol = JSON.parse(readFileSync(join(frozenDir, 'protocol.v1.json'), 'utf8')) as {
  malformedFixtures: { count: number; repairFloor: { minRepaired: number } };
};

describe('evals/frozen/malformed — anotace', () => {
  it('obsahuje přesně tolik vadných emisí, kolik protokol deklaruje', () => {
    expect(fixtures).toHaveLength(protocol.malformedFixtures.count);
  });

  it('id jsou jedinečná', () => {
    const ids = fixtures.map((f) => f.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  // Chybějící anotace je selhání testu, ne mezera k doplnění později:
  // opravář z T15 se proti `mustPreserve` soudí a bez ní si smí zvolit vlastní laťku.
  it('každá emise nese defect, expectedRepair i mustPreserve', () => {
    for (const f of fixtures) {
      expect(f.defectClass?.length, `${f.id} nemá defectClass`).toBeGreaterThan(0);
      expect(f.defect?.length, `${f.id} nemá popis defektu`).toBeGreaterThan(0);
      expect(f.expectedRepair?.length, `${f.id} nemá expectedRepair`).toBeGreaterThan(0);
      expect(Array.isArray(f.mustPreserve), `${f.id} nemá mustPreserve`).toBe(true);
    }
  });

  it('opravitelná emise musí říct, co se při opravě NESMÍ změnit', () => {
    for (const f of fixtures.filter((x) => x.repairable)) {
      expect(f.mustPreserve.length, `${f.id} je repairable, ale nechrání nic`).toBeGreaterThan(0);
    }
  });

  it('každá emise nese tělo s dvoudílným tvarem dokumentu', () => {
    for (const f of fixtures) {
      expect(f.body, `${f.id} nemá tělo`).toBeTypeOf('object');
      const hasPart = 'sim' in f.body || 'look' in f.body;
      expect(hasPart, `${f.id}: tělo není WorldDoc ani jeho vadná varianta`).toBe(true);
    }
  });
});

// Vadné emise jsou vadné ve svém DEKLAROVANÉM defektu, ne v tvaru kontejneru.
// Kdyby tady zůstalo pole, opravář z T15 by kromě svého defektu potkal ještě
// spor, který mu nikdo nedeklaroval — a `mustPreserve` by ho nechránilo.
describe('evals/frozen/malformed — sim.rules je záznam klíčovaný stabilním id', () => {
  const withSim = fixtures.filter((f) => (f.body as { sim?: unknown }).sim);

  it('žádné tělo nenese rules jako pole a klíč se rovná id', () => {
    expect(withSim.length).toBeGreaterThan(0);
    for (const f of withSim) {
      const rules = (f.body as { sim: { rules?: unknown } }).sim.rules;
      expect(Array.isArray(rules), `${f.id}: sim.rules je pole`).toBe(false);
      for (const [key, rule] of Object.entries(rules as Record<string, { id?: unknown }>)) {
        expect(rule.id, `${f.id}: pravidlo pod klíčem ${key} nese jiné id`).toBe(key);
      }
    }
  });
});

/**
 * **Pořadí klíčů je od v2 měřitelné jedině tímhle — `simHash` ho nevidí.**
 *
 * `canonical()` klíče objektů řadí, takže M05 je pod v2 bajtově shodná před
 * i po vlastní deklarované opravě („kanonicky seřadit"). Scorer z T15/T16, který
 * by třídu `non_canonical_order` soudil podle hashe, by tedy opravu viděl jako
 * no-op a celá třída by byla neměřitelná. Jednotkou téhle třídy je POŘADÍ KLÍČŮ.
 *
 * Pozor na rozsah třídy: `non_canonical_order` nesou DVĚ emise, ale každá v jiném
 * rozsahu — M05 pořadí PRAVIDEL, M06 pořadí operandů `allOf` uvnitř podmínky
 * (a nese jediné pravidlo, takže pořadí klíčů porušit ani nemůže). Aserce proto
 * jmenuje M05, ne celou třídu.
 */
describe('evals/frozen/malformed — deklarované pořadí vykonání', () => {
  const bodiesWithRules = fixtures
    .map((f) => ({ id: f.id, rules: ruleRecordOf(f.body) }))
    .filter((x): x is { id: string; rules: RuleRecord } => x.rules !== null);

  it('řadicí pole jsou všude konečná čísla, jinak je pořadí nedefinované', () => {
    expect(bodiesWithRules.length).toBeGreaterThan(0);
    for (const b of bodiesWithRules) {
      expect(carriesOrderKeys(b.rules), `${b.id}: pravidlo bez phase/priority`).toBe(true);
    }
  });

  // Pozitivní i negativní pól v jedné aserci: kdyby oracle přestal fungovat,
  // vypadne M05; kdyby začal hlásit i zdravá těla, přibude někdo další.
  it('deklarované pořadí porušuje právě M05 a nikdo jiný', () => {
    const multiRule = bodiesWithRules.filter((b) => Object.keys(b.rules).length >= 2);
    expect(multiRule.length, 'žádná emise nemá dvě pravidla — kontrola by byla vakuózní').toBeGreaterThan(0);

    const violators = multiRule.filter((b) => !isCanonicallyOrdered(b.rules)).map((b) => b.id);
    expect(violators).toEqual(['M05']);
  });

  // Tohle je ta věta, kterou hash říct neumí: oprava M05 je POZOROVATELNÁ změna.
  it('deklarovaná oprava M05 je v jednotce pořadí klíčů vidět', () => {
    const m05 = bodiesWithRules.find((b) => b.id === 'M05');
    expect(m05, 'M05 v sadě chybí').toBeDefined();
    const before = Object.keys((m05 as { rules: RuleRecord }).rules);
    const after = canonicalRuleOrder((m05 as { rules: RuleRecord }).rules);
    expect(after, 'oprava M05 nemění pořadí klíčů — třída non_canonical_order je neměřitelná').not.toEqual(before);
    expect([...after].sort(), 'oprava M05 nesmí měnit MNOŽINU pravidel').toEqual([...before].sort());
  });
});

describe('evals/frozen/malformed — rozložení defektů', () => {
  // "Rozložení defektů přes třídy z protokolu, ne jen chybějící výchozí hodnoty."
  // Osm triviálních chybějících defaultů by splnilo podlahu T15 a nedokázalo nic.
  it('defekty se rozkládají přes nejméně deset tříd', () => {
    const classes = new Set(fixtures.map((f) => f.defectClass));
    expect(classes.size).toBeGreaterThanOrEqual(10);
  });

  it('žádná jediná třída netvoří většinu sady', () => {
    const counts = new Map<string, number>();
    for (const f of fixtures) counts.set(f.defectClass, (counts.get(f.defectClass) ?? 0) + 1);
    const largest = Math.max(...counts.values());
    expect(largest).toBeLessThanOrEqual(fixtures.length / 2);
  });

  it('opravitelných je dost na podlahu T15 a zároveň ne všechny', () => {
    const repairable = fixtures.filter((f) => f.repairable).length;
    expect(repairable).toBeGreaterThanOrEqual(protocol.malformedFixtures.repairFloor.minRepaired);
    expect(repairable, 'sada bez neopravitelných případů netestuje odmítnutí').toBeLessThan(fixtures.length);
  });

  // Mechanická oprava nesmí dohadovat sémantiku. Případ označený jako
  // neopravitelný to musí říct v expectedRepair, ne mlčet.
  it('neopravitelný případ vysvětluje, proč se nedá opravit mechanicky', () => {
    for (const f of fixtures.filter((x) => !x.repairable)) {
      expect(f.expectedRepair.toLowerCase(), `${f.id} neříká, proč je neopravitelný`).toContain('unrepairable');
    }
  });
});
