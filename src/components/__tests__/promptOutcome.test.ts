import { describe, expect, it } from 'vitest';

import { outcomeFor, outcomeForUnreachable } from '../promptOutcome';

/**
 * Oracle nálezu z brány nad T9: **věta, kterou záložní větev umí, nesmí skončit
 * slepou uličkou.**
 *
 * Naměřeno na běžícím demu 20. 8. 2026 — „i want arcade jumping game" dostalo
 * hlášku, přestože `routePrompt()` tu větu směruje na hratelný archetyp. Test
 * hlídá tři vlastnosti a každá chrání něco jiného:
 *
 * 1. `NO_SOURCE` nabídne cestu dál (jinak je nález zpátky);
 * 2. **žádný jiný kód ji nenabídne** (jinak odkaz svádí na slepou cestu při
 *    poruše, kterou fallback nespraví);
 * 3. věta se do adresy dostane celá a zakódovaná (jinak fallback odpoví na jiný
 *    prompt, než jaký uživatel napsal, a nikdo si toho nevšimne).
 */

/** Doslovná věta, na které nález vznikl. Kdyby se přestala nabízet, je to regrese. */
const REPORTED = 'i want arcade jumping game';

describe('věta bez zdroje dostane cestu dál', () => {
  it('NO_SOURCE nabídne záložní větev s tou samou větou', () => {
    const outcome = outcomeFor(404, 'NO_SOURCE', '', REPORTED);

    expect(outcome.fallbackHref, 'věta z nálezu zůstala bez nabídky').toBe(
      '/fallback/play?prompt=i%20want%20arcade%20jumping%20game',
    );
    expect(outcome.message).toContain('fallback branch');
  });

  it('věta se zakóduje celá, i s diakritikou a ampersandem', () => {
    // Bez `encodeURIComponent` useknou `&` a `#` prompt uprostřed a fallback
    // odpoví na půlku věty. Znaky jsou vybrané tak, aby to bylo vidět.
    const outcome = outcomeFor(404, 'NO_SOURCE', '', 'skákačka & poklady #1');

    expect(outcome.fallbackHref).toBe(
      '/fallback/play?prompt=sk%C3%A1ka%C4%8Dka%20%26%20poklady%20%231',
    );
  });

  it('okolní mezery se do adresy nepřenesou', () => {
    expect(outcomeFor(404, 'NO_SOURCE', '', '   jump   ').fallbackHref).toBe(
      '/fallback/play?prompt=jump',
    );
  });

  it('prázdná věta nedostane odkaz, aby fallback neodpověděl na svůj výchozí prompt', () => {
    expect(outcomeFor(404, 'NO_SOURCE', '', '   ').fallbackHref).toBeNull();
  });
});

describe('poruchy záložní větev nenabízejí', () => {
  it.each([
    [400, 'PROMPT_REFUSED', 'obsah'],
    [429, 'BUDGET_EXHAUSTED', ''],
    [502, 'UPSTREAM_BROKEN', 'poskytovatel mlčí'],
    [503, 'BRANCH_UNCONFIGURED', 'chybí klíč'],
  ])('%i / %s nenabídne nic', (status, code, detail) => {
    const outcome = outcomeFor(status, code, detail, REPORTED);

    expect(outcome.fallbackHref, `${code} nabídl fallback, který poruchu nespraví`).toBeNull();
    expect(outcome.message, `${code} nemá co říct uživateli`).not.toBe('');
  });

  it('moderace i strop mluví o své vlastní příčině', () => {
    expect(outcomeFor(400, 'PROMPT_REFUSED', 'násilí', REPORTED).message).toContain('násilí');
    expect(outcomeFor(429, 'BUDGET_EXHAUSTED', '', REPORTED).message).toContain('budget');
  });

  it('neznámý kód bez detailu se pozná podle kódu, ne podle prázdné hlášky', () => {
    expect(outcomeFor(500, 'WAT', '', REPORTED).message).toContain('WAT');
  });
});

/**
 * Oracle T27q — **spadlá síť postaví svět, odchod ze stránky ne.**
 *
 * Do 24. 8. 2026 byly obě situace jeden `catch` s jednou hláškou a lokální
 * stavba visela výhradně na tom, že server odpoví 404. Doslovné „odpojím síť a
 * svět se přesto postaví" tedy před kamerou selhalo, přestože je to jediná
 * vlastnost projektu, která zní jako záruka.
 *
 * Rozlišit obojí jde, protože `fetch` je hlásí různě: navigace pryč dá
 * `AbortError`, nedoručený požadavek `TypeError`. Test drží tři vlastnosti a
 * každá chrání něco jiného:
 *
 * 1. `TypeError` postaví svět (jinak je nález zpátky a záruka je nepravdivá);
 * 2. `AbortError` nepostaví nic a nic nevypíše (jinak by se do zahazovaného
 *    plátna stavěla místnost a nad ní by blikla hláška o poruše, která žádná
 *    nebyla);
 * 3. cokoli jiného zůstane hláškou **bez** světa — kdyby se svět stavěl na
 *    každou výjimku, spolkl by pád ve stavbě světa a náhradní místnost by
 *    tvrdila, že spadla síť.
 */
describe('nedoručený požadavek se rozliší podle toho, co ho zabilo', () => {
  it('spadlá síť postaví svět a řekne, kdo ho postavil', () => {
    const fallen = outcomeForUnreachable(new TypeError('Failed to fetch'));

    expect(fallen.buildLocally, 'spadlá síť nechala plátno bez světa').toBe(true);
    expect(fallen.outcome?.message).toContain('built by the browser');
    // Záložní větev je jiná adresa na tom samém serveru — když je nedosažitelný
    // server, je nedosažitelná i ona, takže odkaz by vedl do prázdna.
    expect(fallen.outcome?.fallbackHref, 'offline se nabízí cesta na mrtvý server').toBeNull();
  });

  it('odchod ze stránky nepostaví nic a mlčí', () => {
    // `DOMException` je to, čím `fetch` přerušení hlásí v prohlížeči; jméno je
    // ta rozhodující část, takže test dodá obojí — typ i jméno.
    const aborted = new DOMException('The user aborted a request.', 'AbortError');
    const fallen = outcomeForUnreachable(aborted);

    expect(fallen.buildLocally, 'do zahazovaného plátna se postavil svět').toBe(false);
    expect(fallen.outcome, 'odchod ze stránky se vypsal jako porucha').toBeNull();
  });

  it('jiná výjimka zůstane hláškou bez světa', () => {
    const fallen = outcomeForUnreachable(new SyntaxError('Unexpected token < in JSON'));

    expect(fallen.buildLocally, 'náhradní místnost by lhala o příčině').toBe(false);
    expect(fallen.outcome?.message, 'porucha zmizela beze stopy').not.toBe('');
  });
});
