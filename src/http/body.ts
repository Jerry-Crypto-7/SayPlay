/**
 * Čtení HTTP těla pod dvěma nezávislými mezemi — **velikostí a časem**.
 *
 * Vzniklo v T13 uvnitř `src/app/api/emit/route.ts` a T14 ho přesouvá sem
 * beze změny chování. Důvod je ten, kvůli kterému `pointerTokens` bydlí
 * v `patch/reject.ts` a ne dvakrát: druhý endpoint se stejnými mezemi znamená
 * druhou implementaci téhož, a rozdíl mezi nimi neuhlídá nikdo. Meze tu navíc
 * stály tři kola brány (podmíněný deadline, `cancel()` rozsynchronizující
 * keep-alive spojení) — kopie by ta kola nezdědila.
 *
 * Co chrání velikost: **paměť**. Nad stropem se nedrží nic, takže žádný upload
 * nenafoukne proces. Šířku pásma to nechrání a předstírat se to nebude; na to je
 * reverzní proxy, ne route handler.
 *
 * **Za stropem se dočítá a zahazuje, a ruší se až na deadlinu.** To pořadí je
 * důležité, protože `reader.cancel()` má naměřenou cenu: nechá na keep-alive
 * spojení nepřečtený zbytek těla, takže server začne číst zbytek uploadu jako
 * začátek dalšího požadavku. Naměřeno proti `next start` — po zrušeném 200 kB
 * uploadu **další velký požadavek na témže spojení uvízl** až do timeoutu.
 *
 * **Deadline platí i POD stropem.** První verze ho armovala až v okamžiku
 * přetečení, takže stačil jeden kilobajtový kus a nezavřený stream: nikdy se
 * nepřeteklo, deadline se nenaarmoval a handler visel do výchozích 300 s
 * `requestTimeout` Node — táž denial, jen za 1/64 odeslaných bajtů. Velikost
 * a čas jsou dvě nezávislé meze a nesmí se jedna podmiňovat druhou.
 *
 * **Wall-clock je tu legální.** Zákaz `Date.now()` z `CLAUDE.md` platí na replay
 * cestě, kde je simulovaný tik jedinou jednotkou. Tohle je čtení HTTP těla — do
 * hashovaného stavu z něj nevstupuje nic.
 */

/**
 * Strop těla požadavku.
 *
 * Route handlery App Routeru žádný vlastní nemají. Pro `/api/emit` je legální
 * tělo jedno krátké id; pro `/api/edit` je to celý `WorldDoc`, a ten má ve
 * zmrazeném korpusu do 2 kB (největší `C01`, 1 966 B). 64 kB tedy nechává řád
 * rezervy oběma a pořád je řádově pod čímkoli, čím by šlo zaplnit paměť.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Strop **času** na přečtení celého těla, ne jen jeho přebytku. */
export const BODY_DEADLINE_MS = 5_000;

export type BodyRead = { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'TIMEOUT' };

export async function readBody(request: Request, deadlineMs = BODY_DEADLINE_MS): Promise<BodyRead> {
  if (request.body === null) return { ok: true, text: '' };
  const reader = request.body.getReader();
  // **Jedny hodiny na celé čtení**, naarmované hned. Ne až při přetečení: pod
  // stropem se nepřeteče nikdy, takže podmíněný deadline neplatí zrovna tam,
  // kde je nejlevnější ho obejít.
  const readUntil = Date.now() + deadlineMs;
  let chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;

  for (;;) {
    const chunk = await raceDeadline(reader.read(), readUntil - Date.now());
    if (chunk === null) {
      // Zbytek se zruší; viz `BODY_DEADLINE_MS`, proč zrovna tady.
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: overflowed ? 'TOO_LARGE' : 'TIMEOUT' };
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      if (!overflowed) {
        overflowed = true;
        chunks = [];
      }
      continue;
    }
    chunks.push(chunk.value);
  }
  return overflowed ? { ok: false, reason: 'TOO_LARGE' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** `null` znamená, že vypršel deadline dřív, než dorazil další kus. */
async function raceDeadline<T>(pending: Promise<T>, remainingMs: number): Promise<T | null> {
  if (remainingMs <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
