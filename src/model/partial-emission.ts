/**
 * **Čtení rozepsané odpovědi kompilátoru — jen to, co je dopsané.**
 *
 * Kompilátor píše jednu dlouhou odpověď a medián toho psaní je 103 sekund
 * (naměřeno 13. 9. 2026). Celou tu dobu už přitom leží hotové kusy: první uzel
 * geometrie je dopsaný dávno předtím, než model dopíše `world`. Tenhle modul
 * je ta jediná věc, která z rostoucího textu umí říct, **co už se smí
 * postavit** — a hlavně co ne.
 *
 * ## Proč se to nedá udělat `JSON.parse`em ve `try`
 *
 * Rozepsaný JSON se dá „skoro" rozparsovat, a přesně to je ta past. Prefix
 * `{"placements":[{"stableId":"mast","at":[0,1` je po doplnění závorek validní
 * objekt s **jinými čísly**, než jaké model dopíše — postavil by se předmět,
 * který se za vteřinu sám přepíše. Doplňování závorek proto tenhle modul
 * nedělá vůbec: čte znak po znaku, zná stav uvnitř řetězce i za zpětným
 * lomítkem, a hodnotu vydá **teprve ve chvíli, kdy je uzavřená**.
 *
 * Skalár má navíc vlastní past: `[1` se může protáhnout na `[12`, takže číslo
 * na samém konci předpony dopsané být nemusí. Vydává se proto až tehdy, když
 * za ním něco stojí.
 *
 * ## Co z toho leze
 *
 * `complete` jsou top-level pole odpovědi, jejichž hodnota je celá; `items`
 * jsou hotové prvky polí, na kterých stojí stavba (`geometry.nodes`, `shapes`,
 * `placements`), protože ty přicházejí po jednom a čekat na uzavření celého
 * pole by znamenalo čekat skoro na celou odpověď.
 *
 * **Roste to monotónně.** Co jednou vyšlo ven jako hotové, se v žádné delší
 * předponě nezmění — na tom stojí právo postavit to hned a už na to nesahat.
 */

/** Pole odpovědi, jejichž prvky se vyplácí vydávat po jednom. */
const STREAMED_ARRAYS = ['shapes', 'placements'] as const;

/** Totéž uvnitř `geometry`, kde uzly tvoří většinu odpovědi. */
const STREAMED_GEOMETRY_ARRAY = 'nodes';

export interface StreamedItem {
  /** `shapes`, `placements`, nebo `geometry.nodes`. */
  readonly path: string;
  /** Pořadí v tom poli. Roste o jedna a nikdy se neopakuje. */
  readonly index: number;
  readonly value: unknown;
}

export interface PartialEmission {
  /** Top-level pole, jejichž hodnota je celá dopsaná. */
  readonly complete: Readonly<Record<string, unknown>>;
  /** Hotové prvky sledovaných polí, v pořadí, v jakém je model dopsal. */
  readonly items: readonly StreamedItem[];
  /** Je dopsaná celá odpověď? Pak `complete` je ta odpověď. */
  readonly done: boolean;
}

/** Kde skončí hodnota, která začíná na `from`? `-1` = ještě není dopsaná. */
function endOfValue(text: string, from: number): number {
  const first = text[from];
  if (first === undefined) return -1;

  if (first === '"') {
    for (let at = from + 1; at < text.length; at += 1) {
      const char = text[at];
      if (char === '\\') at += 1;
      else if (char === '"') return at + 1;
    }
    return -1;
  }

  if (first !== '{' && first !== '[') {
    // Skalár končí čárkou, uzavírací závorkou nebo bílým znakem.
    for (let at = from; at < text.length; at += 1) {
      const char = text[at];
      if (char === ',' || char === '}' || char === ']' || /\s/.test(char)) return at;
    }
    return text.length;
  }

  let depth = 0;
  let inString = false;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === '\\') at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** Je hodnota na `from`, která končí na `end`, doopravdy dopsaná? */
function isClosed(text: string, from: number, end: number): boolean {
  if (end === -1) return false;
  const first = text[from];
  // Uzavřený objekt, pole i řetězec poznáme podle vlastní koncové značky.
  // U skaláru ji nemáme, takže za ním musí stát ještě něco dalšího.
  if (first === '{' || first === '[' || first === '"') return true;
  return end < text.length;
}

/** Přeskočí bílé znaky od `from`. */
function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/**
 * Hotové prvky pole, jehož `[` je na pozici `from`.
 *
 * Vrací se i tehdy, když pole samo uzavřené není — o to tu celou dobu jde.
 */
function completeElements(text: string, from: number): unknown[] {
  const values: unknown[] = [];
  let at = skipSpace(text, from + 1);
  while (at < text.length && text[at] !== ']') {
    const end = endOfValue(text, at);
    if (!isClosed(text, at, end)) break;
    try {
      values.push(JSON.parse(text.slice(at, end)));
    } catch {
      break;
    }
    at = skipSpace(text, end);
    if (text[at] !== ',') break;
    at = skipSpace(text, at + 1);
  }
  return values;
}

/** Prvky sledovaného pole, které je celé hotové. */
function pushItems(key: string, value: unknown, items: StreamedItem[]): void {
  if ((STREAMED_ARRAYS as readonly string[]).includes(key) && Array.isArray(value))
    value.forEach((entry, index) => items.push({ path: key, index, value: entry }));
  if (key === 'geometry' && typeof value === 'object' && value !== null) {
    const nodes = (value as Record<string, unknown>)[STREAMED_GEOMETRY_ARRAY];
    if (Array.isArray(nodes))
      nodes.forEach((entry, index) =>
        items.push({ path: `geometry.${STREAMED_GEOMETRY_ARRAY}`, index, value: entry }),
      );
  }
}

/** Hotové prvky uvnitř hodnoty, která sama dopsaná není. */
function collectPartial(text: string, at: number, key: string, items: StreamedItem[]): void {
  if (text[at] === '[' && (STREAMED_ARRAYS as readonly string[]).includes(key)) {
    completeElements(text, at).forEach((value, index) => items.push({ path: key, index, value }));
    return;
  }
  if (text[at] !== '{' || key !== 'geometry') return;

  // `geometry` je rozepsaná — uvnitř ní se hledá jen `nodes`.
  const marker = `"${STREAMED_GEOMETRY_ARRAY}"`;
  const found = text.indexOf(marker, at);
  if (found === -1) return;
  const colon = skipSpace(text, found + marker.length);
  if (text[colon] !== ':') return;
  const opens = skipSpace(text, colon + 1);
  if (text[opens] !== '[') return;
  completeElements(text, opens).forEach((value, index) =>
    items.push({ path: `geometry.${STREAMED_GEOMETRY_ARRAY}`, index, value }),
  );
}

/** Prvky ze všech sledovaných polí hotové odpovědi. */
function itemsOf(answer: Record<string, unknown>): StreamedItem[] {
  const items: StreamedItem[] = [];
  for (const [key, value] of Object.entries(answer)) pushItems(key, value, items);
  return items;
}

/**
 * Přečte, co je v předponě odpovědi hotové.
 *
 * `prefix` je libovolně dlouhý začátek odpovědi. Nic se nedoplňuje a nic se
 * nehádá: co není uzavřené, není v návratu.
 */
export function readPartialEmission(prefix: string): PartialEmission {
  const start = prefix.indexOf('{');
  if (start === -1) return { complete: {}, items: [], done: false };

  const whole = endOfValue(prefix, start);
  if (whole !== -1) {
    try {
      const value = JSON.parse(prefix.slice(start, whole)) as Record<string, unknown>;
      return { complete: value, items: itemsOf(value), done: true };
    } catch {
      /* Uzavřené závorky nad nevalidním JSONem — čte se dál po polích. */
    }
  }

  const complete: Record<string, unknown> = {};
  const items: StreamedItem[] = [];
  let at = skipSpace(prefix, start + 1);

  while (at < prefix.length && prefix[at] === '"') {
    const keyEnd = endOfValue(prefix, at);
    if (keyEnd === -1) break;
    const key = prefix.slice(at + 1, keyEnd - 1);

    at = skipSpace(prefix, keyEnd);
    if (prefix[at] !== ':') break;
    at = skipSpace(prefix, at + 1);

    const end = endOfValue(prefix, at);
    if (!isClosed(prefix, at, end)) {
      // Rozepsaná hodnota. Uvnitř ní ale můžou být hotové prvky.
      collectPartial(prefix, at, key, items);
      break;
    }

    try {
      const value = JSON.parse(prefix.slice(at, end)) as unknown;
      complete[key] = value;
      pushItems(key, value, items);
    } catch {
      break;
    }

    at = skipSpace(prefix, end);
    if (prefix[at] !== ',') break;
    at = skipSpace(prefix, at + 1);
  }

  return { complete, items, done: false };
}
