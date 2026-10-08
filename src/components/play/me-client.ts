/**
 * Kdo hraje, z obrazovky výsledku (P44B T10): `GET /api/play/me` vrátí přezdívku (hráči bez cookie
 * ji rovnou vydá), `PUT` ji změní. Poslední jisté jméno žije po dobu stránky, takže další výsledek
 * ho ukáže hned; jména vypnutá na serveru (`503`) si stránka pamatuje taky, přechodnou chybu ne.
 */

/** Znění z kitu (`docs/brand/docs/11-voice-copy.md`), stejné jako v odpovědi routy. */
export const NAME_RULE = 'Use 2–20 letters or numbers.';
export const NAME_REFUSED = "We can't use that name. Try another one.";
const NAME_NOT_SAVED = "We couldn't save your name. Try again.";

/** `undefined` = stránka se ještě nezeptala, `null` = jména jsou na serveru vypnutá. */
let known: string | null | undefined;

export const knownName = (): string | null | undefined => known;

/** Přezdívka hráče; `null` = jména vypnutá nebo čtení selhalo – řádek „Playing as“ se nekreslí. */
export async function fetchMe(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetcher('/api/play/me', { cache: 'no-store', signal });
    if (response.status === 503) return (known = null);
    if (!response.ok) return null;
    const { nickname } = (await response.json()) as { nickname?: unknown };
    return typeof nickname === 'string' ? (known = nickname) : null;
  } catch {
    return null;
  }
}

/** Výsledek uložení: `error: null` = jména vypnutá (`503`), řádek se skryje místo hlášky. */
export type NameSave = { readonly ok: true; readonly nickname: string } | { readonly ok: false; readonly error: string | null };

/** Pošle jméno tak, jak ho hráč napsal – ořez a pravidla jsou na serveru (`readNickname`). */
export async function saveNickname(nickname: string, fetcher: typeof fetch = fetch): Promise<NameSave> {
  try {
    const response = await fetcher('/api/play/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname }),
    });
    if (response.status === 503) return { ok: false, error: null };
    if (response.status === 400) return { ok: false, error: NAME_RULE };
    if (response.status === 422) return { ok: false, error: NAME_REFUSED };
    if (!response.ok) return { ok: false, error: NAME_NOT_SAVED };
    const body = (await response.json()) as { nickname?: unknown };
    if (typeof body.nickname !== 'string') return { ok: false, error: NAME_NOT_SAVED };
    known = body.nickname;
    return { ok: true, nickname: body.nickname };
  } catch {
    return { ok: false, error: NAME_NOT_SAVED };
  }
}
