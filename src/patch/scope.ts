/**
 * Skutečný dosah patche — **diffem stavu, nikdy čtením operací**.
 *
 * Zmrazený protokol to má jako vlastní pravidlo (`editContract.changedLeafRule`)
 * a formuluje ho i s důvodem: *„Množina skutečně změněných LISTOVÝCH JSON
 * pointerů se počítá DIFFEM STAVU PŘED A PO aplikaci, nikdy čtením operací
 * patche. Jinak `replace` na povoleném předkovi přepíše nepovolené potomky
 * a formálně projde."*
 *
 * ## Proč čtení operací nestačí, konkrétně
 *
 * Review v3 nejdřív navrhlo strop **počtu** operací. Jedna operace ale umí
 * přepsat libovolně velký podstrom, takže počítání nedokazuje nic. Review v4
 * ukázalo, že ani kontrola cest v operacích nestačí: kontrola typu „cesta
 * operace je prefixem některé povolené cesty" propustí `replace /sim`, protože
 * `/sim` je prefixem úplně každé povolené cesty — a přitom přepíše celý svět.
 *
 * Rozvinutá množina listů tuhle díru zavírá tím, že se **neptá, co patch řekl,
 * ale co se v dokumentu doopravdy pohnulo**. Ať se `/sim/state/timers/flood`
 * přepíše celý nebo se sáhne rovnou na `durationTicks`, výsledek je tatáž
 * odpověď: změnil se `durationTicks`, a pokud se změnil i `init`, je vidět i on.
 *
 * ## Co je list
 *
 * Skalár, prázdný objekt nebo prázdné pole — tedy místo, pod kterým už není nic,
 * co by šlo adresovat. Prázdné kontejnery se počítají jako listy schválně: jinak
 * by se změna `{}` → `{a:1}` na jedné straně vykázala a opačná změna
 * `{a:1}` → `{}` by po sobě nenechala žádný pointer.
 *
 * Změna tvaru (objekt → skalár, pole → objekt) vykáže listy **obou** stran:
 * zmizelé i vzniklé. Vykázat jen jednu by znamenalo, že se přepsáním podstromu
 * na číslo dosah patche opticky zmenší.
 *
 * ## Pořadí a stabilita
 *
 * Vrací se **seřazená** množina. Dosah je vlastnost výsledku, ne pořadí, ve
 * kterém se do něj přišlo — a stabilní pořadí je to, co dovoluje množinu
 * porovnat mezi dvěma běhy (T17 řetězí hashe stadií).
 */

import { canonical } from '../ir/worlddoc';
import { pointerOf } from './reject';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Všechny listy hodnoty. `undefined` nemá žádné — neexistuje, tedy ani nezmizelo. */
function collectLeaves(value: unknown, tokens: readonly string[], out: Set<string>): void {
  if (value === undefined) return;

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.add(pointerOf(tokens));
      return;
    }
    for (const key of keys) collectLeaves(value[key], [...tokens, key], out);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.add(pointerOf(tokens));
      return;
    }
    value.forEach((item, index) => collectLeaves(item, [...tokens, String(index)], out));
    return;
  }

  out.add(pointerOf(tokens));
}

function diff(before: unknown, after: unknown, tokens: readonly string[], out: Set<string>): void {
  // `canonical` je táž serializace, jakou se dokument hashuje — takže „nezměnilo
  // se to" tu znamená přesně to, co znamená pro `simHash`. Vlastní porovnání by
  // se s hashem mohlo rozejít a dosah by pak tvrdil něco jiného než identita.
  if (canonical(before) === canonical(after)) return;

  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      diff(before[key], after[key], [...tokens, key], out);
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Pole se porovnává **po indexech**, ne jako množina: index je součást
    // adresy, takže vložení prvku doprostřed opravdu pohne vším za ním a dosah
    // to musí přiznat. Párování podle podobnosti by ho uměle zmenšilo.
    for (let i = 0; i < Math.max(before.length, after.length); i += 1)
      diff(before[i], after[i], [...tokens, String(i)], out);
    return;
  }

  // Tvar se rozešel, nebo je to skalár proti skaláru. Obě strany, viz docblock.
  collectLeaves(before, tokens, out);
  collectLeaves(after, tokens, out);
}

/**
 * Listové JSON pointery, které se mezi `before` a `after` doopravdy pohnuly.
 *
 * `prefix` ukotví výsledek do souřadnic dokumentu (`/sim`, `/look`). Bez něj by
 * dosah mluvil v souřadnicích části, zatímco kontrakt (`allowedPaths`) i patch
 * mluví v souřadnicích dokumentu — a porovnávaly by se dvě různé adresy.
 */
export function changedLeaves(before: unknown, after: unknown, prefix = ''): readonly string[] {
  const out = new Set<string>();
  diff(before, after, prefix === '' ? [] : [prefix.replace(/^\//, '')], out);
  return [...out].sort();
}
