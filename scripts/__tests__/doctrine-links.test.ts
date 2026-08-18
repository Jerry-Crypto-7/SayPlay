/**
 * Odkaz na rozhodovací záznam nesmí viset do prázdna.
 *
 * `docs/reuse-doctrine.md` je clean-room výtah z patnácti ADR jiného repozitáře.
 * Kdyby na některý z nich odkazoval komentář v `src/server/` a v dokumentu pro
 * něj nebyla položka, čtenář veřejného repozitáře by dostal odkaz, který nikam
 * nevede — a u clean-room stopy je to horší než mlčení, protože to vypadá jako
 * doložená provenience.
 *
 * ## Tenhle test měří i sám sebe, a je to ta podstatná část
 *
 * **Odkazů v `src/server/` je dnes nula.** Samotný průchod nad prázdnou množinou
 * je proto splněný čímkoliv — i rozbitým hledáním, které nenajde nic, protože
 * čte špatný adresář. Tvrzení, které projde vždycky, není kontrola, je ozdoba.
 *
 * Proti tomu tady stojí tři věci:
 *
 * 1. hledání se pouští na **umělém případu s viset­ícím odkazem** a musí ho
 *    najít — to je důkaz, že mechanismus funguje, nezávislý na tom, co zrovna
 *    v repozitáři je;
 * 2. průchod nad `src/server/` **ověří, že vůbec četl soubory** — nula
 *    přečtených souborů je selhání, ne čistý výsledek;
 * 3. **úplnost dokumentu** se tvrdí zvlášť a nad neprázdnou množinou: patnáct
 *    záznamů, patnáct nadpisů.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Odvozeno od tohohle souboru, ne od `process.cwd()`. Pracovní adresář je
// vlastnost spuštění, ne repozitáře.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCTRINE = join(ROOT, 'docs', 'reuse-doctrine.md');
const SCANNED = join(ROOT, 'src', 'server');

/** Kolik záznamů výtah popisuje. Prameny jich mají patnáct. */
const EXPECTED_ENTRIES = 15;

/**
 * Odkazy na rozhodovací záznam v textu.
 *
 * Hledá se **kdekoliv v souboru**, ne jen v komentářích. Odkaz v řetězci nebo
 * v názvu je pořád odkaz, a rozlišovat by znamenalo psát parser — tedy vyrobit
 * místo, kde se dá odkaz schovat.
 */
export function adrReferences(text: string): string[] {
  return [...new Set(text.match(/ADR-\d{4}/g) ?? [])].sort();
}

/** Záznamy, pro které výtah nese nadpis. */
export function doctrineEntries(markdown: string): string[] {
  const headings = markdown.match(/^### (ADR-\d{4})\b/gm) ?? [];
  return [...new Set(headings.map((heading) => heading.replace('### ', '')))].sort();
}

/** Soubory ke kontrole. Vrací i cestu, aby hláška uměla ukázat kam. */
function sourceFiles(directory: string): Array<{ readonly path: string; readonly text: string }> {
  const found: Array<{ path: string; text: string }> = [];

  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry)) found.push({ path: full, text: readFileSync(full, 'utf-8') });
  }

  return found;
}

describe('docs/reuse-doctrine.md', () => {
  const doctrine = readFileSync(DOCTRINE, 'utf-8');

  it('nese položku pro každý z patnácti záznamů', () => {
    const entries = doctrineEntries(doctrine);

    expect(entries).toHaveLength(EXPECTED_ENTRIES);
    // Očekává se souvislá řada, ne jen správný počet: patnáct nadpisů na tentýž
    // záznam by prošlo počtem a bylo by to prázdné.
    expect(entries).toEqual(
      Array.from({ length: EXPECTED_ENTRIES }, (_, index) => `ADR-${String(index + 1).padStart(4, '0')}`),
    );
  });

  it('přiznává, že odkazů z kódu je dnes nula, místo aby to vydával za kontrolu', () => {
    // Kdyby tenhle text z dokumentu zmizel, zůstal by průchod nad prázdnou
    // množinou tvářící se jako splněná kontrola. Přesně to má být vidět.
    expect(doctrine).toMatch(/není ani jeden/);
  });
});

describe('odkazy z `src/server/` proti výtahu', () => {
  const doctrine = readFileSync(DOCTRINE, 'utf-8');
  const entries = doctrineEntries(doctrine);
  const files = sourceFiles(SCANNED);

  it('vůbec něco přečetl — nula souborů je selhání, ne čistý výsledek', () => {
    // Bez tohohle projde i hledání, které míří do neexistujícího adresáře.
    expect(files.length).toBeGreaterThan(0);
  });

  it('žádný odkaz v kódu nevisí do prázdna', () => {
    const dangling = files.flatMap((file) =>
      adrReferences(file.text)
        .filter((reference) => !entries.includes(reference))
        .map((reference) => `${relative(ROOT, file.path)} → ${reference}`),
    );

    expect(dangling).toEqual([]);
  });
});

describe('mechanismus kontroly — měřený na umělém případu, ne na repozitáři', () => {
  // Tahle sada je ta, která dává předchozí smysl. Odkazů v `src/server/` je
  // nula, takže průchod nad nimi neprokazuje, že by se něco našlo. Tyhle
  // případy to prokazují nezávisle na tom, co v repozitáři zrovna je.
  const entries = ['ADR-0001', 'ADR-0002'];

  it('visetící odkaz se najde', () => {
    const source = '// Rozhodnuto podle ADR-0099, viz výtah.\nexport const x = 1;\n';
    const dangling = adrReferences(source).filter((reference) => !entries.includes(reference));

    expect(dangling).toEqual(['ADR-0099']);
  });

  it('odkaz, který v dokumentu položku má, se nehlásí', () => {
    const source = '/** Provenience: ADR-0002. */\nexport const x = 1;\n';

    expect(adrReferences(source).filter((reference) => !entries.includes(reference))).toEqual([]);
  });

  it('odkaz mimo komentář se taky počítá — schovat se nedá', () => {
    const source = "export const NOTE = 'vychází z ADR-0099';\n";

    expect(adrReferences(source)).toEqual(['ADR-0099']);
  });

  it('víc odkazů v jednom souboru se najde všechny a bez duplicit', () => {
    const source = '// ADR-0099 a ADR-0098, a ještě jednou ADR-0099.\n';

    expect(adrReferences(source)).toEqual(['ADR-0098', 'ADR-0099']);
  });

  it('text bez odkazu nevyrobí falešný nález', () => {
    expect(adrReferences('export const ADR = 1; // ADR-99 není odkaz, ADRxx taky ne\n')).toEqual([]);
  });

  it('nadpisy se čtou jen z úrovně tří křížků, ne z běžného textu', () => {
    const markdown = '# ADR-0001 v nadpisu dokumentu\n\nText o ADR-0002.\n\n### ADR-0003 — skutečná položka\n';

    expect(doctrineEntries(markdown)).toEqual(['ADR-0003']);
  });
});
