/**
 * **Kolik textu se do modelu nalije na jeden svět — před zkrácením a po něm.**
 *
 * Čekání na svět je z drtivé většiny model, jak píše odpověď (medián
 * kompilátoru 103 s, naměřeno 13. 9.), ale vstup se platí taky: běh
 * `gpt-6-astra@medium#cli` z 13. 9. vykázal **38 849 vstupních tokenů na
 * větu** (`latency-report.json`). Tenhle soubor měří, z čeho se to skládá, a
 * hlídá, že zkrácení zadání doopravdy nastalo.
 *
 * **Neplatí se za něj nic a nikam se nevolá.** Plány se berou z archivu běhu
 * ze 6. 9. (`create-raw.json`), takže se měří dnešní prompt nad týmiž pěti
 * větami, nad kterými se měřila latence: `c01, c07, c13, c19, c25`.
 *
 * **Znaky, ne tokeny poskytovatele.** Tokenizér modelu tady není a odhad by
 * jen předstíral přesnost; `tokensPerChar` v artefaktu je jediný přepočet
 * a je pojmenovaný. Poměr před/po je na jednotce nezávislý — a je to on, co
 * tahle úloha slibuje.
 *
 * Dvě cesty, protože od T4 existují dvě:
 *   `whole`   jedno volání na svět, dnešní výchozí, s počtem opravných kol
 *             z archivu
 *   `chunked` tři volání na svět, každé zúžené na svůj kus (T4, zatím opt-in)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { type Grammar } from '@/model/prompt';
import { EMISSION_CHUNKS } from '@/model/emission-merge';
import { buildCompilerRequest } from '@/model/worldstream-prompt';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';

/** Tytéž věty, nad kterými se 13. 9. měřila latence (`latency-report.json`). */
const CASES = ['c01', 'c07', 'c13', 'c19', 'c25'] as const;

/**
 * **Stav před zkrácením, naměřený týmhle souborem nad `1b83d07`** (18. 9. 2026,
 * commit T4). Je to pinovaná konstanta, a ne druhý živý výpočet, protože starý
 * prompt po zkrácení nikde neexistuje — jediná poctivá alternativa by bylo
 * držet ho v kódu jako mrtvou kopii.
 */
const BEFORE = {
  wholeCharsPerWorld: 92719,
  chunkedCharsPerWorld: 107160,
} as const;

/** Naměřený poměr z běhu 13. 9.: 38 849 vstupních tokenů na 92 719 znaků zadání. */
const TOKENS_PER_CHAR = 38849 / 92719;

const grammarRead = frozenGrammar();
if (!grammarRead.ok) throw new Error(`frozen grammar unreadable: ${grammarRead.detail}`);
const GRAMMAR: Grammar = grammarRead.value;

interface ArchivedCall {
  readonly caseId: string;
  readonly request: { readonly system: string; readonly user: string };
  readonly answer: unknown;
}

// Archiv je gitignorovaný (3,8 MB), takže se čte za běhu – statický import by
// shodil typecheck buildu z čistého exportu, kde soubor není.
const calls = JSON.parse(readFileSync(fileURLToPath(new URL('./create-raw.json', import.meta.url)), 'utf8')) as ArchivedCall[];

const chars = (request: { system: string; user: string }): number => request.system.length + request.user.length;

describe('velikost vstupního zadání na svět', () => {
  it('zapíše rozpad před a po a ukáže pokles', () => {
    const rows = CASES.map((caseId) => {
      const mine = calls.filter((entry) => entry.caseId === caseId);
      const planner = mine[0];
      if (planner === undefined) throw new Error(`archiv nemá volání pro ${caseId}`);
      const parsed = readPlannerEmission(planner.answer, { requireSceneSpec: false });
      if (!parsed.ok) throw new Error(`plán ${caseId} se nepřečetl: ${JSON.stringify(parsed).slice(0, 200)}`);

      // Opravná kola se platí celým zadáním znovu, takže do světa patří.
      const compilerCalls = mine.length - 1;
      const plannerChars = chars(buildIntentRequest(planner.request.user));
      const wholeCall = chars(buildCompilerRequest(parsed.value, GRAMMAR));
      const chunkCalls = EMISSION_CHUNKS.map((chunk) => ({ chunk, chars: chars(buildCompilerRequest(parsed.value, GRAMMAR, chunk)) }));

      return {
        caseId,
        compilerCalls,
        plannerChars,
        wholeCallChars: wholeCall,
        chunkCallChars: Object.fromEntries(chunkCalls.map((entry) => [entry.chunk, entry.chars])),
        wholeCharsPerWorld: plannerChars + compilerCalls * wholeCall,
        chunkedCharsPerWorld: plannerChars + chunkCalls.reduce((sum, entry) => sum + entry.chars, 0),
      };
    });

    const mean = (pick: (row: (typeof rows)[number]) => number) => Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length);
    const after = { wholeCharsPerWorld: mean((row) => row.wholeCharsPerWorld), chunkedCharsPerWorld: mean((row) => row.chunkedCharsPerWorld) };
    const drop = (before: number, now: number) => Number((1 - now / before).toFixed(4));

    const report = {
      measuredAt: new Date().toISOString(),
      cases: CASES,
      note: 'Znaky zadání, které produkt pošle. Tokeny jsou přepočet měřeným poměrem z 13. 9., ne výstup tokenizéru.',
      tokensPerChar: Number(TOKENS_PER_CHAR.toFixed(4)),
      before: BEFORE,
      after,
      beforeTokensPerWorld: { whole: Math.round(BEFORE.wholeCharsPerWorld * TOKENS_PER_CHAR), chunked: Math.round(BEFORE.chunkedCharsPerWorld * TOKENS_PER_CHAR) },
      afterTokensPerWorld: { whole: Math.round(after.wholeCharsPerWorld * TOKENS_PER_CHAR), chunked: Math.round(after.chunkedCharsPerWorld * TOKENS_PER_CHAR) },
      drop: { whole: drop(BEFORE.wholeCharsPerWorld, after.wholeCharsPerWorld), chunked: drop(BEFORE.chunkedCharsPerWorld, after.chunkedCharsPerWorld) },
      rows,
    };

    writeFileSync(fileURLToPath(new URL('./prompt-size.json', import.meta.url)), `${JSON.stringify(report, null, 2)}\n`);

    // Cesta, kterou svět od T4 vzniká, musí spadnout nejméně o pětinu.
    expect(report.drop.chunked).toBeGreaterThanOrEqual(0.2);
    // A jedno volání se nesmí prodloužit ani na staré cestě.
    expect(after.wholeCharsPerWorld).toBeLessThan(BEFORE.wholeCharsPerWorld);
  });
});
