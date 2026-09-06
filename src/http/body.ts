/**
 * Čtení HTTP těla pod čtyřmi nezávislými mezemi — **velikostí, časem, počtem
 * na volajícího a bajty na instanci**.
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

import { UNIDENTIFIED_CALLER, callerKey, trustedCallerKey } from '../server/rate-limit';

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
 * Kolik čtení těla smí naráz běžet **jednomu volajícímu**.
 *
 * `MAX_BODY_BYTES` říká, kolik drží **jedno** čtení, a `BODY_DEADLINE_MS`, jak
 * dlouho. Ani jedno neříká, kolik jich smí být: N klientů, kteří pošlou
 * hlavičky a pak mlčí, sedí uvnitř `POST` současně, každý s vlastním readerem,
 * spojením a až 64 kB, a odejdou nejdřív za pět sekund. Naměřeno nezávislou
 * revizí 4. 9. 2026 (P15 `T28-editrate`) nad `/api/edit`; týká se to stejně
 * `/api/emit`, `/api/generate` i worldstreamových relací, protože všechny čtou
 * tímhle jedním kusem kódu.
 *
 * **Čtyři, protože tolik prohlížeč doopravdy potřebuje:** viewer posílá jednu
 * větu po druhé a k tomu nejvýš preview a změnu, takže čtyři pokryjí i dvakrát
 * otevřenou záložku. Zdola to drží provoz, shora součin: 4 × `MAX_BODY_BYTES`
 * = 256 kB, tedy osmina rozpočtu instance — jeden volající sám instanci
 * nezaplní, ani kdyby všechna čtyři těla poslal plná.
 */
export const MAX_CONCURRENT_BODY_READS_PER_CALLER = 4;

/**
 * Kolik bajtů smí **všechna rozečtená těla dohromady** naráz držet.
 *
 * ⚠ **Proč to není globální strop na POČET čtení.** Takový strop by naplnila
 * mlčící spojení z podvržených adres — a mlčící spojení dodá **nula bajtů**,
 * takže by dveře zavřelo něco, co paměť nestojí nic. Rozpočet v bajtech se
 * plní tím, co doopravdy dorazilo, a vrací tím vlastnost, kterou strop na
 * počet ztratil: **kdo mlčí, stojí sokety, ne službu ostatních.**
 *
 * **2 MB není nové číslo** — přesně tolik dával součin dřívějších „32 čtení ×
 * 64 kB". Změnilo se jen to, co ohraničuje: dřív počet otevřených čtení
 * (z něhož paměť jen vyplývala), teď rovnou držené bajty.
 *
 * **Rozpočet se soudí i uprostřed čtení, ne jen při vpuštění.** Kdyby se ptal
 * jen na začátku, prošla by libovolně velká vlna spojení, dokud je rozpočet
 * prázdný, a teprve pak by všechna začala posílat — strop by neohraničoval nic.
 * Uvnitř smyčky je vlastnost tvrdá: JavaScript běží v jednom vlákně, takže mezi
 * přičtením kusu a jeho posouzením se nikdo jiný nevloží, a držené bajty tedy
 * nikdy nepřesáhnou tenhle rozpočet o víc než o jeden kus.
 *
 * ⚠ **Je to mez na PROCES, a to je tady správně, ne kompromis.** Chrání paměť
 * a smyčku téhle instance — sdílený obchod by o její zátěži nevěděl nic a řešil
 * by jiný problém (frekvenci, `src/server/rate-limit.ts`).
 *
 * **Plný rozpočet odmítne i toho, kdo nedrží ani bajt — a vstupní kontrola se
 * proto nezrušila.** Nezávislá revize 4. 9. 2026 navrhla vpouštět vždycky
 * a nechat rozhodnout kontrolu uprostřed čtení. **Vyvráceno rozborem kódu:
 * odmítne to tytéž volající, jen o kus později** — nad plným rozpočtem selže
 * `takeBytes()` na prvním kuse každého nového čtení, takže se nic nevpustí a
 * navíc se za každé odmítnutí zaplatí sáhnutím na proud. Rozpočet držený na
 * maximu stojí útočníka **2 MB každých pět sekund, tedy ~400 kB/s** trvale
 * (`BODY_DEADLINE_MS` uvolní i mlčící čtení), a odpověď na to je poctivá:
 * `SERVER_AT_CAPACITY` s `retry-after`. Co by pomohlo, je **rezervovaný díl
 * rozpočtu pro malá těla** — to je ale nová dvoustupňová mez, ne oprava.
 *
 * ⚠ **Tenhle rozpočet je taky na instanci, ne na nasazení, a zůstane tak**
 * (`T28-fleetrate`, rozhodnuto 4. 9. 2026): sdílený čítač se nestaví, protože by
 * stál síťový let před každým požadavkem. Odůvodnění je v hlavičce
 * `src/server/rate-limit.ts` a platí pro obě meze stejně.
 */
export const MAX_BUFFERED_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Kolik čtení smí naráz běžet **kbelíku nerozeznaných volajících**.
 *
 * ⚠ **Nález nezávislé revize 4. 9. 2026, a je to regrese, ne doladění.** Klíč
 * je hlavička od proxy; bez proxy — `next start`, běh bez `x-forwarded-for` —
 * spadnou do klíče `UNIDENTIFIED_CALLER` **všichni**, a strop čtyři je pak
 * mez na celý proces, tedy **osmkrát přísnější** než těch 32, které nahradil:
 * čtyři mlčící spojení by zavřela dveře komukoli.
 *
 * **V jednom kbelíku není koho od koho izolovat**, takže tam per-caller mez
 * nekupuje nic a zbývá jediná mez, která tam něco znamená — rozpočet paměti.
 * Číslo je proto odvozené: přesně tolik plných těl, kolik ten rozpočet unese,
 * tedy chování **před** rozdělením meze. Nové volné číslo to není.
 *
 * ⛔ **Globální strop na počet se tím zpátky nezavádí a druhé kolo to nesmí
 * zkusit** — rozeznaní volající do tohohle kbelíku nespadají, takže jeden klíč
 * nemá jak zavřít dveře ostatním. Přesně to byla vada `cdde072`.
 */
export const MAX_CONCURRENT_BODY_READS_UNIDENTIFIED = MAX_BUFFERED_BODY_BYTES / MAX_BODY_BYTES;

/**
 * Kolik čtení běží komu a kolik bajtů drží. Visí to na `globalThis`, ne na
 * modulu, z téhož naměřeného důvodu jako procesová účetní kniha
 * v `src/server/spend-store.ts`: Next umí postavit víc grafů modulů a modulová
 * proměnná by pak počítala jen uvnitř jednoho z nich, tedy pod mez, která má
 * chránit celý proces.
 *
 * **Záznam volajícího se na nule maže.** Kdyby zůstával, byla by mapa úložiště
 * zdarma pro kohokoli s podvrženou hlavičkou; takhle je velká nanejvýš jako
 * počet právě otevřených spojení, a spojení stojí řádově víc než jeho klíč.
 */
const OPEN_READS_KEY = '__worldsmithOpenBodyReads';

interface BodyReads {
  /**
   * Klíč je `trustedCallerKey() ?? callerKey()` (doktrína u `readBody()`).
   * Hodnota je počet právě běžících čtení.
   */
  perCaller: Map<string, number>;
  /** Kolik bajtů drží rozečtená těla dohromady. */
  bufferedBytes: number;
}

function bodyReads(): BodyReads {
  const holder = globalThis as Record<string, unknown>;
  holder[OPEN_READS_KEY] ??= { perCaller: new Map<string, number>(), bufferedBytes: 0 };
  return holder[OPEN_READS_KEY] as BodyReads;
}

/** Kolik čtení těla právě běží dohromady. Pro diagnostiku a pro testy. */
export function openBodyReads(): number {
  let total = 0;
  for (const count of bodyReads().perCaller.values()) total += count;
  return total;
}

/** Kolik bajtů právě drží rozečtená těla. Pro diagnostiku a pro testy. */
export function bufferedBodyBytes(): number {
  return bodyReads().bufferedBytes;
}

/**
 * Kolik volajících je v mapě. **Není to totéž co počet čtení** a je to jediný
 * způsob, jak se dá zvenčí ověřit, že se záznam na nule maže — tedy že mapa
 * není úložiště zdarma pro kohokoli s podvrženou hlavičkou.
 */
export function trackedBodyCallers(): number {
  return bodyReads().perCaller.size;
}

/**
 * Proč se čtení odmítlo. `BUSY` nese **koho se mez týká**, protože jsou to dvě
 * různá sdělení: „posíláš jich moc" je tvrzení o volajícím a nesmí se říct
 * tomu, kdo poslal jediný požadavek do plné instance. Týž nález, jaký u stropu
 * frekvence zavřel `rateLimitedResponse()`.
 */
export type BodyFailure =
  | { readonly reason: 'TOO_LARGE' }
  | { readonly reason: 'TIMEOUT' }
  | { readonly reason: 'BUSY'; readonly scope: 'caller' | 'instance' };

export type BodyRead =
  | { readonly ok: true; readonly text: string }
  | ({ readonly ok: false } & BodyFailure);

export interface BodyRefusal {
  readonly status: 413 | 408 | 429;
  readonly code:
    | 'PAYLOAD_TOO_LARGE'
    | 'BODY_TIMEOUT'
    | 'TOO_MANY_BODY_READS'
    | 'SERVER_AT_CAPACITY';
  readonly message: string;
  /** Kolik sekund má smysl počkat. `undefined` tam, kde opakování nepomůže. */
  readonly retryAfterSeconds?: number;
}

/**
 * Překlad odmítnutého čtení na stav a kód — **jednou pro všechny dveře**.
 *
 * Čtou tímhle kusem kódu patery (`edit`, `emit`, `generate`, worldstreamové
 * relace a jejich změny) a do 4. 9. 2026 si každé psalo vlastní ternární výraz
 * nad `reason`. Přibytí třetího důvodu tuhle vadu ukázalo naráz na všech
 * místech: `reason === 'TOO_LARGE' ? 413 : 408` vydá na nápor **408 „tělo
 * dorazilo pomalu"**, což je tvrzení o volajícím, a ten přitom neudělal nic.
 * Proto překlad bydlí tady, u meze, a ne u dveří.
 *
 * **Bere celé selhání, ne holý `reason`** — jinak se nedá odlišit „posíláš
 * jich moc" od „server je plný" a odmítnutí zase obviní volajícího z něčeho,
 * co neudělal. Naplněný rozpočet instance proto mluví **týmiž slovy jako
 * `rateLimitedResponse()`**: zvenčí je to jedna a tatáž situace a klient nemá
 * důvod poznat, která z instančních mezí se naplnila.
 */
export function bodyRefusal(failure: BodyFailure): BodyRefusal {
  if (failure.reason === 'TOO_LARGE')
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
    };
  if (failure.reason === 'TIMEOUT')
    return {
      status: 408,
      code: 'BODY_TIMEOUT',
      message: `request body did not arrive within ${String(BODY_DEADLINE_MS)} ms`,
    };
  // **Pět sekund je odvozených, ne vybraných:** `BODY_DEADLINE_MS` ručí za to,
  // že se každý obsazený slot i každý držený bajt do té doby uvolní, i kdyby
  // druhá strana mlčela.
  const retryAfterSeconds = Math.ceil(BODY_DEADLINE_MS / 1000);
  return failure.scope === 'instance'
    ? {
        status: 429,
        code: 'SERVER_AT_CAPACITY',
        message: 'this instance is at capacity right now',
        retryAfterSeconds,
      }
    : {
        status: 429,
        code: 'TOO_MANY_BODY_READS',
        message: 'too many request bodies from this client',
        retryAfterSeconds,
      };
}

/**
 * Hotová odpověď na odmítnuté čtení.
 *
 * Tvar `{ requestId, error: { code, message } }` mají všechny dveře shodný —
 * je to týž kontrakt, jen se do 4. 9. 2026 skládal na čtyřech místech.
 * `retry-after` se posílá jen u těch důvodů, u kterých opakování pomůže.
 */
export function bodyRefusalResponse(requestId: string, failure: BodyFailure): Response {
  const refusal = bodyRefusal(failure);
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

  const reads = bodyReads();
  // **Rozpočet instance se soudí PRVNÍ**, protože je to mez na paměť. Pod ním
  // se teprve ptáme, kdo volá — opačné pořadí by plné instanci dovolilo vydat
  // „posíláš jich moc" komukoli, kdo poslal svůj první požadavek.
  if (reads.bufferedBytes >= MAX_BUFFERED_BODY_BYTES)
    return { ok: false, reason: 'BUSY', scope: 'instance' };

  // **Klíč je důvěryhodný konec řetězu, `callerKey()` je jen pád** — blokující
  // nález nezávislé revize 6. 9. 2026 (`T29-freeunbounded`). Tenhle čítač nemá
  // v klíči jméno dveří, takže je to nejlevnější páka v celém provozu: čtyři
  // pomalá těla poslaná pod adresou oběti jí zavřou `generate`, `edit`, `emit`
  // i `sessions` naráz, a to na celý `BODY_DEADLINE_MS`, za necelý požadavek
  // za sekundu. Dokud se klíčovalo `callerKey()`, byla ta adresa vstup
  // volajícího (první položka `x-forwarded-for`), tedy volba oběti.
  //
  // Mimo platformu vrací `trustedCallerKey()` `null` a pádem se vrací staré
  // chování; bez toho pádu by všichni volající spadli do jedné přihrádky, což
  // je měřeně horší než žádná mez (hlavička `rate-limit.ts`).
  const caller = trustedCallerKey(request) ?? callerKey(request);
  // **Nerozeznaný volající má vlastní strop a vlastní sdělení.** V jednom
  // kbelíku se nedá říct „posíláš jich moc ty" — je to tvrzení o volajícím,
  // který za naplněný kbelík nemusí moci — takže odmítnutí je `instance`.
  const unidentified = caller === UNIDENTIFIED_CALLER;
  const limit = unidentified
    ? MAX_CONCURRENT_BODY_READS_UNIDENTIFIED
    : MAX_CONCURRENT_BODY_READS_PER_CALLER;
  const open = reads.perCaller.get(caller) ?? 0;
  if (open >= limit)
    return { ok: false, reason: 'BUSY', scope: unidentified ? 'instance' : 'caller' };
  reads.perCaller.set(caller, open + 1);

  const held = { bytes: 0 };
  try {
    return await readBodyInner(request, deadlineMs, held);
  } finally {
    // **`finally`, ne konec šťastné cesty.** `reader.read()` se odmítnout může
    // (přerušené spojení, vadná komprese) a slot ani bajty, které by se tím
    // ztratily, se už nikdy nevrátí — mez by se po pár takových požadavcích
    // utáhla na nulu a vypadala by jako nápor.
    const left = (reads.perCaller.get(caller) ?? 1) - 1;
    if (left <= 0) reads.perCaller.delete(caller);
    else reads.perCaller.set(caller, left);
    releaseBytes(held);
  }
}

/** Přičíst k rozpočtu a říct, jestli se do něj ještě vejdeme. */
function takeBytes(held: { bytes: number }, byteLength: number): boolean {
  const reads = bodyReads();
  reads.bufferedBytes += byteLength;
  held.bytes += byteLength;
  return reads.bufferedBytes <= MAX_BUFFERED_BODY_BYTES;
}

/** Vrátit rozpočtu všechno, co tohle čtení drží. Volá se i na zahození kusů. */
function releaseBytes(held: { bytes: number }): void {
  bodyReads().bufferedBytes -= held.bytes;
  held.bytes = 0;
}

function refused(reason: 'TOO_LARGE' | 'BUSY'): BodyRead {
  return reason === 'TOO_LARGE'
    ? { ok: false, reason: 'TOO_LARGE' }
    : { ok: false, reason: 'BUSY', scope: 'instance' };
}

async function readBodyInner(
  request: Request,
  deadlineMs: number,
  held: { bytes: number },
): Promise<BodyRead> {
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  // **Jedny hodiny na celé čtení**, naarmované hned. Ne až při přetečení: pod
  // stropem se nepřeteče nikdy, takže podmíněný deadline neplatí zrovna tam,
  // kde je nejlevnější ho obejít.
  const readUntil = Date.now() + deadlineMs;
  let chunks: Uint8Array[] = [];
  let size = 0;
  /** Rozhodnuté odmítnutí. Dál se jen dočítá a zahazuje; první důvod platí. */
  let refusal: 'TOO_LARGE' | 'BUSY' | null = null;

  for (;;) {
    const chunk = await raceDeadline(reader.read(), readUntil - Date.now());
    if (chunk === null) {
      // Zbytek se zruší; viz `BODY_DEADLINE_MS`, proč zrovna tady. **Nečeká se
      // na to**: `cancel()` mluví s protistranou, která právě dokázala, že
      // neodpovídá, a `await` by za deadline, jehož celý smysl je ohraničit
      // čekání, přilepil čekání bez horní meze — i s obsazeným slotem a bajty.
      void reader.cancel().catch(() => undefined);
      return refusal === null ? { ok: false, reason: 'TIMEOUT' } : refused(refusal);
    }
    if (chunk.done) break;
    if (refusal !== null) continue;

    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) refusal = 'TOO_LARGE';
    else if (!takeBytes(held, chunk.value.byteLength)) refusal = 'BUSY';
    else {
      chunks.push(chunk.value);
      continue;
    }
    // Zahozené kusy nesmí dál blokovat rozpočet nikomu jinému.
    chunks = [];
    releaseBytes(held);
  }
  return refusal === null
    ? { ok: true, text: Buffer.concat(chunks).toString('utf8') }
    : refused(refusal);
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
