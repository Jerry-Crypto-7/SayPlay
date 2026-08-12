import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
