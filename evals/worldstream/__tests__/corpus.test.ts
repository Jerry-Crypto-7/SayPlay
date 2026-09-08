/**
 * Zmrazená worldstream sada (P13 T8) se po zamčení nesmí hnout — a ten zámek
 * musí doopravdy kousat.
 *
 * Dokazují se tu tři různé věci a je snadné splést si je dohromady:
 *
 *   1. **Strom sedí se zámkem.** Kdyby se změnil jediný bajt v `create.jsonl`
 *      nebo `refine.jsonl`, hash se rozejde a tenhle soubor zčervená.
 *   2. **Ten zámek doopravdy kouše.** Bod 1 je zelený i tehdy, kdyby ověřování
 *      nedělalo vůbec nic — proto se v dočasném adresáři korpus vědomě rozbije
 *      a čeká se červená. Bez tohohle je bod 1 dekorace; přesně tu vadu nesl
 *      `evals-frozen-v1` rok, protože testy filtrovaly tak, že vlastní artefakt
 *      nikdy neprověřily.
 *   3. **Validátor kontroluje to, kvůli čemu existuje.** Každé pravidlo, na
 *      kterém T8 stojí, se tu jednou poruší a čeká se pojmenovaný nález.
 *      Pravidlo bez tohohle testu je komentář.
 *
 * Co se tu **nedokazuje a nikde se to tvrdit nesmí:** že je zmrazení
 * vynutitelné. Není. Kdo má přístup do repozitáře, přepíše korpus i manifest
 * a sada zůstane zelená (`CLAUDE.md`, rozpor 1). Zámek dělá tichou změnu
 * hlučnou, ne nemožnou.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CREATE_DISTRIBUTION,
  CREATE_TOTAL,
  FORBIDDEN_VOCABULARY,
  REFINE_DISTRIBUTION,
  REFINE_TOTAL,
  SCOPE_AXES,
  computeFileHashes,
  readCorpus,
  readManifest,
  validateCorpus,
  verifyAgainstManifest,
  type CreateCase,
  type RefineCase,
} from '../lock.mjs';

const corpusDir = fileURLToPath(new URL('..', import.meta.url));

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/** Kopie zmrazeného adresáře, kterou smíme rozbít. Originál se nikdy nedotkne. */
function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldstream-corpus-'));
  scratchDirs.push(dir);
  cpSync(corpusDir, dir, { recursive: true });
  return dir;
}

function loadScratch(dir: string) {
  return readCorpus(dir);
}

function saveScratch(dir: string, create: CreateCase[], refine: RefineCase[]): void {
  writeFileSync(join(dir, 'create.jsonl'), create.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'refine.jsonl'), refine.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** Rozbije korpus v kopii a vrátí nálezy validátoru. */
function problemsAfter(mutate: (create: CreateCase[], refine: RefineCase[]) => void): string[] {
  const dir = scratchCopy();
  const { create, refine } = loadScratch(dir);
  mutate(create, refine);
  saveScratch(dir, create, refine);
  return validateCorpus(readCorpus(dir));
}

describe('worldstream korpus je zmrazený', () => {
  it('strom sedí se zamčeným manifestem', () => {
    expect(verifyAgainstManifest()).toEqual([]);
  });

  it('manifest kryje obě datové sady a nic jiného', () => {
    const manifest = readManifest();
    expect(Object.keys(manifest.files).sort()).toEqual(['create.jsonl', 'refine.jsonl']);
    expect(manifest.files).toEqual(computeFileHashes());
  });

  it('manifest si nesmí myslet, že je zmrazení vynutitelné', () => {
    const manifest = readManifest() as unknown as Record<string, string>;
    expect(manifest.enforceabilityNote).toMatch(/NEVYNUCUJE/);
  });

  it('jediný změněný bajt zámek odmítne', () => {
    const dir = scratchCopy();
    const path = join(dir, 'create.jsonl');
    // Jeden znak uvnitř jedné věty. Nic, čeho by si čtenář všiml.
    writeFileSync(path, readFileSync(path, 'utf8').replace('A cathedral', 'A Cathedral'), 'utf8');
    expect(verifyAgainstManifest(dir)).toEqual(['create.jsonl: hash nesouhlasí se zamčeným']);
  });

  it('data, která manifest nekryje, zámek odmítne', () => {
    const dir = scratchCopy();
    writeFileSync(join(dir, 'extra.jsonl'), '{"id":"c31"}\n', 'utf8');
    expect(verifyAgainstManifest(dir)).toEqual(['extra.jsonl: data ve stromu, která manifest nekryje']);
  });

  it('chybějící soubor zámek odmítne', () => {
    const dir = scratchCopy();
    rmSync(join(dir, 'refine.jsonl'));
    expect(verifyAgainstManifest(dir)).toEqual(['refine.jsonl: v manifestu je, ve stromu chybí']);
  });
});

describe('worldstream korpus má tvar, který T8 objednala', () => {
  const { create, refine, parseProblems } = readCorpus();

  it('nemá jediný nález', () => {
    expect(parseProblems).toEqual([]);
    expect(validateCorpus(readCorpus())).toEqual([]);
  });

  it('má 30 create vět v předepsaném rozdělení', () => {
    expect(create).toHaveLength(CREATE_TOTAL);
    const counts: Record<string, number> = {};
    for (const record of create) counts[record.category] = (counts[record.category] ?? 0) + 1;
    expect(counts).toEqual({ ...CREATE_DISTRIBUTION });
  });

  it('má 20 změn v předepsaném rozdělení', () => {
    expect(refine).toHaveLength(REFINE_TOTAL);
    const counts: Record<string, number> = {};
    for (const record of refine) counts[record.kind] = (counts[record.kind] ?? 0) + 1;
    expect(counts).toEqual({ ...REFINE_DISTRIBUTION });
  });

  it('každá změna cílí na hrdinský objekt svého create případu', () => {
    const heroes = new Map(create.map((record) => [record.id, new Set(record.heroObjects)]));
    for (const record of refine) {
      const set = heroes.get(record.createId);
      expect(set, `${record.id}: createId ${record.createId}`).toBeDefined();
      const named = record.kind === 'ambiguous_target' ? (record.candidates ?? []) : [record.targetObject!];
      for (const name of named) expect(set!.has(name), `${record.id}: "${name}"`).toBe(true);
    }
  });

  it('prompt mimo focus kategorii pojmenuje, co systém odmítl', () => {
    const outside = create.filter((record) => record.category === 'out_of_category');
    expect(outside).toHaveLength(CREATE_DISTRIBUTION.out_of_category);
    for (const record of outside) expect(record.mustName.length, record.id).toBeGreaterThan(0);
  });

  it('nemluví slovníkem implementace', () => {
    const text = JSON.stringify({ create, refine }).toLowerCase();
    for (const term of FORBIDDEN_VOCABULARY) {
      expect(new RegExp(`(^|[^a-z0-9])${term.replace(/ /g, '\\s+')}($|[^a-z0-9])`).test(text), term).toBe(false);
    }
  });
});

describe('validátor kouše — každé pravidlo se jednou poruší', () => {
  it('chybějící create záznam', () => {
    expect(problemsAfter((create) => void create.pop())).toContain('create: 29 záznamů, čekalo se 30');
  });

  it('rozbité rozdělení kategorií', () => {
    const problems = problemsAfter((create) => {
      create[0]!.category = 'abstract';
    });
    expect(problems).toContain('kategorie architecture: 5 záznamů, čekalo se 6');
    expect(problems).toContain('kategorie abstract: 5 záznamů, čekalo se 4');
  });

  it('dvě věty stejně', () => {
    const problems = problemsAfter((create) => {
      create[1]!.prompt = create[0]!.prompt;
    });
    expect(problems).toContain('c02: stejná věta jako c01');
  });

  it('jediná nepřípustná substituce nestačí', () => {
    const problems = problemsAfter((create) => {
      create[0]!.forbiddenSubstitutions = ['a generic hall with a skylight'];
    });
    expect(problems).toContain('c01: potřebuje aspoň dvě nepřípustné substituce');
  });

  it('prompt mimo kategorii bez pojmenovaného odmítnutí', () => {
    const problems = problemsAfter((create) => {
      create.find((record) => record.category === 'out_of_category')!.mustName = [];
    });
    expect(problems).toContain('c26: out_of_category musí pojmenovat, co systém odmítl');
  });

  it('slovník implementace v povinnosti', () => {
    const problems = problemsAfter((create) => {
      create[0]!.spatialThesis = 'The model emits a ShapeProgram for the shaft.';
    });
    expect(problems).toContain('c01: mluví slovníkem implementace ("shapeprogram")');
  });

  it('změna míří na create případ, který neexistuje', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.createId = 'c99';
    });
    expect(problems).toContain('r01: createId "c99" v create sadě neexistuje');
  });

  it('změna míří na objekt, který v tom světě není', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.targetObject = 'the escalator';
    });
    expect(problems).toContain('r01: cíl "the escalator" není hrdinský objekt c12');
  });

  it('jednoosá změna se dvěma osami', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.scope = ['shape', 'appearance'];
    });
    expect(problems).toContain('r01: shape_only musí mít přesně 1 os, má 2');
  });

  it('jednoosá změna na cizí ose', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.scope = ['appearance'];
    });
    expect(problems).toContain('r01: shape_only musí měnit osu shape');
  });

  it('smíšená změna s jedinou osou', () => {
    const problems = problemsAfter((_, refine) => {
      const mixed = refine.find((record) => record.kind === 'mixed')!;
      mixed.scope = ['shape'];
    });
    expect(problems).toContain('r14: mixed musí měnit aspoň dvě osy');
  });

  it('osa mimo slovník', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.scope = ['sound'];
    });
    expect(problems).toContain('r01: scope obsahuje osu mimo slovník');
    expect(SCOPE_AXES).not.toContain('sound');
  });

  it('nejasný cíl, který přesto jmenuje objekt', () => {
    const problems = problemsAfter((_, refine) => {
      const ambiguous = refine.find((record) => record.kind === 'ambiguous_target')!;
      ambiguous.targetObject = 'the ribcage trees';
    });
    expect(problems).toContain('r18: nejasný cíl nesmí jmenovat objekt');
  });

  it('nejasný cíl s jediným kandidátem', () => {
    const problems = problemsAfter((_, refine) => {
      const ambiguous = refine.find((record) => record.kind === 'ambiguous_target')!;
      ambiguous.candidates = ['the ribcage trees'];
    });
    expect(problems).toContain('r18: nejasný cíl potřebuje aspoň dva kandidáty');
  });

  it('kandidát, který v tom světě není', () => {
    const problems = problemsAfter((_, refine) => {
      const ambiguous = refine.find((record) => record.kind === 'ambiguous_target')!;
      ambiguous.candidates = ['the ribcage trees', 'the escalator'];
    });
    expect(problems).toContain('r18: kandidát "the escalator" není hrdinský objekt c07');
  });

  it('chybí, co se změnit nesmí', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.mustNotChange = [];
    });
    expect(problems).toContain('r01: chybí, co se změnit nesmí');
  });

  it('rozbité rozdělení druhů změn', () => {
    const problems = problemsAfter((_, refine) => {
      refine[0]!.kind = 'mixed';
      refine[0]!.scope = ['shape', 'appearance'];
    });
    expect(problems).toContain('druh změny shape_only: 4 záznamů, čekalo se 5');
    expect(problems).toContain('druh změny mixed: 5 záznamů, čekalo se 4');
  });

  it('rozbitý řádek se ohlásí i s číslem řádku', () => {
    const dir = scratchCopy();
    const path = join(dir, 'create.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[2] = '{"id":"c03",';
    writeFileSync(path, lines.join('\n'), 'utf8');
    expect(validateCorpus(readCorpus(dir)).some((problem) => problem.startsWith('create.jsonl:3:'))).toBe(true);
  });
});
