/**
 * Co se stane, když `/api/generate` nevrátí svět.
 *
 * Je to samostatný modul bez JSX schválně: rozhoduje se tu, jestli uživatel
 * skončí u hlášky, nebo dostane cestu dál — a to je logika, která má vlastní
 * test běžící v Node. `PromptBar.tsx` z toho jen kreslí.
 *
 * ## Proč tu vůbec je nabídka záložní větve
 *
 * Naměřeno 20. 8. 2026 nad běžícím demem: věta „i want arcade jumping game"
 * skončila hláškou, přestože ji `routePrompt()` směruje na hratelný archetyp
 * `collect_unlock`. Generátor a záložní větev spolu do té doby nemluvily —
 * fallback vedl výhradně z adresy `/fallback/play`, kterou nikdo nezná. Nebyla
 * to chybějící schopnost, byl to nezapojený drát.
 *
 * ## Dvě věci, které se tu nesmí rozmazat
 *
 * 1. **Nesměruje se potichu.** Vrací se odkaz, ne přesměrování. Kdyby se prompt
 *    přehodil do fallbacku sám, produkt by tvrdil „postavil jsem ti svět z tvé
 *    věty" o třech ručně napsaných archetypech — a přesně tenhle rozdíl je to,
 *    co se v reportu měří.
 * 2. **Odkaz, ne import.** `src/fallback/**` se do hlavního balíku nesmí
 *    dostat; na tom stojí důkaz architektonické nezávislosti z P2, který hlídá
 *    `scripts/prove-fallback-isolation.mjs` analýzou chunků. Adresa je proto
 *    obyčejný řetězec a `promptOutcome.ts` o fallbacku neimportuje nic.
 */

/** Adresa, ze které se záložní větev spouští. Řetězec, ne import — viz hlavička. */
const FALLBACK_ROUTE = '/fallback/play';

export type PromptOutcome = {
  /** Text pro uživatele. Nikdy prázdný. */
  readonly message: string;
  /**
   * Kam nabídnout cestu dál, nebo `null`, když žádná není. Nabízí se **jen**
   * u `NO_SOURCE`: ostatní kódy jsou provozní poruchy a záložní větev je
   * nespraví, takže by odkaz jen sváděl na slepou cestu.
   */
  readonly fallbackHref: string | null;
};

/**
 * Přeloží odpověď serveru na to, co uvidí uživatel.
 *
 * `NO_SOURCE` je 404 a **není to porucha** — offline generátor hledá doslovnou
 * shodu se zmrazeným korpusem, takže na vlastní větu zdroj poctivě nemá. Tady
 * se z toho poprvé stává nabídka místo slepé uličky.
 */
export function outcomeFor(
  status: number,
  code: string,
  detail: string,
  prompt: string,
): PromptOutcome {
  if (code === 'NO_SOURCE') {
    const trimmed = prompt.trim();
    return {
      message:
        'Offline generátor umí jenom doslovné prompty ze zmrazeného korpusu. ' +
        'Záložní větev tuhle větu zahrát umí:',
      // Prázdná věta by na fallbacku spadla do jeho výchozího promptu, což by
      // vypadalo jako by systém odpověděl na něco jiného, než co se ptalo.
      // Sem se ale prázdný text nedostane — `PromptBar` ho neodešle.
      fallbackHref:
        trimmed === ''
          ? null
          : `${FALLBACK_ROUTE}?prompt=${encodeURIComponent(trimmed)}`,
    };
  }

  if (code === 'PROMPT_REFUSED')
    return { message: `Prompt neprošel moderací: ${detail}`, fallbackHref: null };

  if (status === 429)
    return { message: 'Rozpočet na generování je vyčerpaný. Zkus to později.', fallbackHref: null };

  return {
    message: detail === '' ? `Generování selhalo (${code}).` : detail,
    fallbackHref: null,
  };
}

/**
 * Co udělat s výjimkou, se kterou požadavek na `/api/generate` skončil.
 *
 * Rozlišují se tu dvě věci, které `fetch` vrací stejným kanálem a produkt na ně
 * musí reagovat opačně:
 *
 * - **spadlá síť** — `fetch` odmítne `TypeError`em, protože požadavek vůbec
 *   nedoletěl. Tady platí záruka z T20 stejně jako u 404: svět postaví
 *   prohlížeč. Do 24. 8. 2026 tady záruka neplatila a produkt vypsal hlášku,
 *   takže doslovné „odpojím síť a svět se přesto postaví" bylo nepravdivé.
 * - **odchod ze stránky** — navigace pryč přeruší běžící `fetch` a ten odmítne
 *   `AbortError`em. To je normální konec, ne porucha: stavět svět do plátna,
 *   které se právě zahazuje, nemá komu pomoct.
 *
 * Cokoli jiného zůstává hláškou bez světa. `TypeError` je záměrně **jediný**
 * tvar, na který se svět staví — kdyby se stavěl na každou výjimku, schoval by
 * se pod něj i pád ve stavbě světa a náhradní místnost by tvrdila, že spadla
 * síť.
 */
export type UnreachableOutcome = {
  /** Postavit svět v prohlížeči? Pravda jen u spadlé sítě. */
  readonly buildLocally: boolean;
  /** Co vypsat, nebo `null`, když se nevypisuje nic. */
  readonly outcome: PromptOutcome | null;
};

export function outcomeForUnreachable(thrown: unknown): UnreachableOutcome {
  // `DOMException` dědí z `Error`, takže jméno stačí — a je stabilnější než
  // typ, protože prostředí, ve kterých test běží, `DOMException` mít nemusí.
  if (thrown instanceof Error && thrown.name === 'AbortError')
    return { buildLocally: false, outcome: null };

  if (thrown instanceof TypeError)
    return {
      buildLocally: true,
      outcome: {
        message: 'Server je nedostupný, takže tenhle svět postavil prohlížeč sám.',
        fallbackHref: null,
      },
    };

  return {
    buildLocally: false,
    outcome: { message: 'Požadavek se nepodařilo odeslat.', fallbackHref: null },
  };
}
