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

/**
 * Kolik čtení těla smí běžet **naráz** — třetí mez, a bez ní ty dvě nad ní
 * neomezují nic dohromady.
 *
 * `MAX_BODY_BYTES` říká, kolik drží **jedno** čtení, a `BODY_DEADLINE_MS`, jak
 * dlouho. Ani jedno neříká, kolik jich smí být: N klientů, kteří pošlou
 * hlavičky a pak mlčí, sedí uvnitř `POST` současně, každý s vlastním readerem,
 * spojením a až 64 kB, a odejdou nejdřív za pět sekund. Naměřeno nezávislou
 * revizí 4. 9. 2026 (P15 `T28-editrate`) nad `/api/edit`; týká se to stejně
 * `/api/emit` i worldstreamových relací, protože všechny čtou tímhle jedním
 * kusem kódu.
 *
 * **32 je součin, ne vkus:** 32 × `MAX_BODY_BYTES` = 2 MB je strop paměti, kterou
 * čtená těla smí naráz držet, a `BODY_DEADLINE_MS` říká, že se slot uvolní
 * nejpozději za pět sekund i tehdy, když druhá strana mlčí. Kdo tohle číslo
 * zvedá, zvedá tím obojí.
 *
 * ⚠ **Je to mez na PROCES, a to je tady správně, ne kompromis.** Chrání paměť
 * a smyčku téhle instance — sdílený obchod by o její zátěži nevěděl nic a řešil
 * by jiný problém (frekvenci, `src/server/rate-limit.ts`).
 */
export const MAX_CONCURRENT_BODY_READS = 32;

/**
 * Kolik čtení právě běží. Visí to na `globalThis`, ne na modulu, z téhož
 * naměřeného důvodu jako procesová účetní kniha v `src/server/spend-store.ts`:
 * Next umí postavit víc grafů modulů a modulová proměnná by pak počítala jen
 * uvnitř jednoho z nich, tedy pod mez, která má chránit celý proces.
 */
const OPEN_READS_KEY = '__worldsmithOpenBodyReads';

function openReads(): { count: number } {
  const holder = globalThis as Record<string, unknown>;
  holder[OPEN_READS_KEY] ??= { count: 0 };
  return holder[OPEN_READS_KEY] as { count: number };
}

/** Kolik čtení těla právě běží. Pro diagnostiku a pro testy. */
export function openBodyReads(): number {
  return openReads().count;
}

export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'TOO_LARGE' | 'TIMEOUT' | 'BUSY' };

export interface BodyRefusal {
  readonly status: 413 | 408 | 429;
  readonly code: 'PAYLOAD_TOO_LARGE' | 'BODY_TIMEOUT' | 'TOO_MANY_BODY_READS';
  readonly message: string;
  /** Kolik sekund má smysl počkat. `undefined` tam, kde opakování nepomůže. */
  readonly retryAfterSeconds?: number;
}

/**
 * Překlad odmítnutého čtení na stav a kód — **jednou pro všechny dveře**.
 *
 * Čtou tímhle kusem kódu čtvery (`edit`, `emit`, `generate`, worldstreamové
 * relace) a do 4. 9. 2026 si každé psalo vlastní ternární výraz nad `reason`.
 * Přibytí třetího důvodu tuhle vadu ukázalo naráz na všech čtyřech místech:
 * `reason === 'TOO_LARGE' ? 413 : 408` vydá na nápor **408 „tělo dorazilo
 * pomalu"**, což je tvrzení o volajícím, a ten přitom neudělal nic. Proto
 * překlad bydlí tady, u meze, a ne u dveří.
 */
export function bodyRefusal(reason: 'TOO_LARGE' | 'TIMEOUT' | 'BUSY'): BodyRefusal {
  if (reason === 'TOO_LARGE')
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
    };
  if (reason === 'TIMEOUT')
    return {
      status: 408,
      code: 'BODY_TIMEOUT',
      message: `request body did not arrive within ${String(BODY_DEADLINE_MS)} ms`,
    };
  return {
    status: 429,
    code: 'TOO_MANY_BODY_READS',
    message: 'too many request bodies are being read right now',
    // **Pět sekund je odvozených, ne vybraných:** `BODY_DEADLINE_MS` ručí za to,
    // že se každý obsazený slot do té doby uvolní, i kdyby druhá strana mlčela.
    retryAfterSeconds: Math.ceil(BODY_DEADLINE_MS / 1000),
  };
}

/**
 * Hotová odpověď na odmítnuté čtení.
 *
 * Tvar `{ requestId, error: { code, message } }` mají všechny čtvery dveře
 * shodný — je to týž kontrakt, jen se do 4. 9. 2026 skládal na čtyřech místech.
 * `retry-after` se posílá jen u toho důvodu, u kterého opakování pomůže.
 */
export function bodyRefusalResponse(
  requestId: string,
  reason: 'TOO_LARGE' | 'TIMEOUT' | 'BUSY',
): Response {
  const refusal = bodyRefusal(reason);
  return Response.json(
    { requestId, error: { code: refusal.code, message: refusal.message } },
    {
      status: refusal.status,
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { headers: { 'retry-after': String(refusal.retryAfterSeconds) } }),
    },
  );
}

export async function readBody(request: Request, deadlineMs = BODY_DEADLINE_MS): Promise<BodyRead> {
  // **Tělo, které není, slot nebere.** Držet by nemělo co a odmítnout požadavek
  // bez těla kvůli plné čtecí frontě by byla mez na něčem, co ji nezatěžuje.
  if (request.body === null) return { ok: true, text: '' };

  const open = openReads();
  if (open.count >= MAX_CONCURRENT_BODY_READS) return { ok: false, reason: 'BUSY' };
  open.count += 1;
  try {
    return await readBodyInner(request, deadlineMs);
  } finally {
    // **`finally`, ne konec šťastné cesty.** `reader.read()` se odmítnout může
    // (přerušené spojení, vadná komprese) a slot, který by se tím ztratil, se
    // už nikdy nevrátí — mez by se po pár takových požadavcích utáhla na nulu
    // a vypadala by jako nápor.
    open.count -= 1;
  }
}

async function readBodyInner(request: Request, deadlineMs: number): Promise<BodyRead> {
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
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
