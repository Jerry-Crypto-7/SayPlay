/**
 * **Čtečka proudu relace: otevřít, číst, po mezeře se obnovit** (P15 T17,
 * design book §20 a §21).
 *
 * Reducer (`reducer.ts`) rozhoduje, co rámec se stavem udělá. Tenhle soubor
 * rozhoduje jen o tom, **odkud rámce berou** — a to je záměrně celá jeho
 * práce. Rozdělené proto, že jedno se dá testovat bez sítě a druhé bez stavu;
 * slepené dohromady se nedá testovat ani jedno.
 *
 * ## Dekodér bydlí tady, ne v komponentě
 *
 * `SseDecoder` byl v `src/components/viewer/sse.ts` a importovaly ho už čtyři
 * místa mimo viewer — dvě serverové testovací sady a e2e spec. Byl to tedy
 * sdílený dekodér drátu na adrese, která tvrdila, že je to kus UI. Přestěhoval
 * se sem, `sse.ts` ho **re-exportuje**, takže starý kontrakt `/api/emit/stream`
 * i všechny jeho importy platí beze změny.
 *
 * ## Zrušení ruší čtení, ne relaci
 *
 * `AbortSignal` zavře reader a vrátí stav, jaký v tu chvíli byl. **Neposílá
 * nic na server** a ani nemá: relace na serveru běží dál pro každého dalšího
 * diváka a klient, který se vrátil, ji podle §21 najde snapshotem. Kdyby
 * odchod jednoho čtenáře generaci rušil, znamenalo by zavření záložky
 * zahozenou zaplacenou práci.
 *
 * ## Mezera se řeší snapshotem, ne dalším pokusem o týž rámec
 *
 * Reducer vrátí `SEQUENCE_GAP` a **stav nechá netknutý**. Číst dál by
 * znamenalo stavět svět s dírou; číst znovu od téhož čísla by znamenalo čekat
 * na rámec, který už proletěl. Jediná odpověď je autoritativní snapshot a za
 * ním proud od jeho `sequence` — přesně protokol §20. Počet obnovení je
 * omezený (`maxResumes`), protože proud, který dává mezeru pořád dokola, je
 * vada serveru a donekonečna se z ní zotavovat znamená točit se na místě.
 */

import type { ComparisonCommit } from './accepted-branch';
import type { BranchComparison } from './branch-controller';
import type { WorldstreamBlueprint } from './schema';
import {
  applySnapshot,
  initialClientState,
  reduceEvent,
  type ClientSnapshot,
  type ClientState,
} from './reducer';
import type { SessionEvent } from './events';

/* ------------------------------------------------------------------ *
 * Dekodér `text/event-stream`.
 * ------------------------------------------------------------------ */

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Rámce z `text/event-stream`, po kusech tak, jak dorazí ze sítě.
 *
 * Drží zbytek mezi voláními, protože rámec se běžně rozpadne přes dva síťové
 * kusy. Rozpad uprostřed `data:` řádku je stav, který nastane v provozu a
 * v testu nikdy, když si test podává celé rámce — proto na něj `sse.test.ts`
 * míří výslovně.
 */
export class SseDecoder {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Rámec končí prázdným řádkem. `\r\n` i `\n` — spec připouští obojí.
    const boundary = /\r?\n\r?\n/;
    let split = boundary.exec(this.buffer);
    while (split !== null) {
      const block = this.buffer.slice(0, split.index);
      this.buffer = this.buffer.slice(split.index + split[0].length);
      const frame = decodeBlock(block);
      if (frame !== null) frames.push(frame);
      split = boundary.exec(this.buffer);
    }

    return frames;
  }
}

function decodeBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Jedna mezera za dvojtečkou patří formátu, ne hodnotě.
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return data.length === 0 ? null : { event, data: data.join('\n') };
}

/* ------------------------------------------------------------------ *
 * Otevření relace.
 * ------------------------------------------------------------------ */

/** Odkud se ten svět vzal, když ho nepsal model. */
export interface AuthoredProvenance {
  /** `nearest` znamená „tuhle větu jsem neuměl a dal ti nejbližší, co mám". */
  readonly match: 'exact' | 'nearest';
}

/** Adresy, které vrátí `POST /api/worldstream/sessions` (202). */
export interface SessionHandle {
  readonly sessionId: string;
  readonly events: string;
  readonly snapshot: string;
  /**
   * `null`, když svět píše model. Route ten klíč posílá **jen tehdy**, když
   * odpovídá sklad uvařených světů — porotce má právo vědět, že tenhle svět
   * vznikl dopředu a jeho věta ho jen našla (`T45-honestlabel`).
   */
  readonly authored: AuthoredProvenance | null;
  /**
   * Proud relace, který přišel rovnou v odpovědi na otevření (P16
   * `T8-stream404`), nebo nic, když server odpověděl 202 s adresami. Čte se
   * jednou — první čtení `followSession()`; obnovení jde přes `events`.
   */
  readonly stream?: Response;
}

export interface ClientOptions {
  /** Vlastní `fetch`. Testy sem dosadí scriptovaný; produkce nechá výchozí. */
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Co navíc smí říct **otevření** relace, a nic z toho neplatí pro čtení proudu
 * (proto vlastní typ, ne další klíč v `ClientOptions`).
 */
export interface OpenOptions extends ClientOptions {
  /**
   * **Dějství II: tenhle svět má napsat model** (P15 `T14r-acttwo`).
   *
   * Výchozí `false` je dějství I, kde odpovídá sklad uvařených světů, kdykoli
   * pro tu větu něco má. Dějství II běží ve **vlastní** relaci s vlastním
   * placeným slotem, takže relace dějství I, její blueprint ani změna, kterou
   * do ní porotce commitnul, se ho netýkají — a to je celý důvod, proč to jsou
   * dvě relace a ne jedna se dvěma generacemi.
   */
  readonly live?: boolean;
}

/**
 * **Věta pro člověka, kód pro stroj — a věta i tam, kde server žádnou neposlal.**
 * Nález šestého kola nezávislé revize (6. 9. 2026), třikrát opsaný: tělo, které
 * nejde přečíst jako JSON, nechá `error` nedefinované, a do panelu na obrazovce
 * pak šel holý `HTTP_504`. Takové tělo produkt sám nevyrábí — route odpovídá
 * výhradně přes `fail()` — vyrábí ho hosting, když funkci dojde čas, a porotce
 * ten řetězec čte stejně. `openWorldstreamSession()` navíc větu serveru
 * neukazovala **nikdy**, ani když ji server poslal.
 *
 * Kód zůstává v závorce za větou, aby se dal nahlásit, když se někdo ptá.
 */
function refusal(
  prefix: string,
  error: { readonly code?: string; readonly message?: string } | undefined,
  status: number,
): string {
  const code = error?.code ?? `HTTP_${status}`;
  return `${prefix}: ${error?.message ?? 'the server did not say why'} (${code})`;
}

/**
 * Věta → relace. Vrací adresy, ne stav: generace teprve začala a všechno, co
 * se o ní dá vědět, teče proudem.
 *
 * Odmítnutí (moderace, souběh placených volání, strop frekvence, vypínač) se
 * sem vrací jako výjimka s kódem serveru, protože 4xx a 5xx tady **nejsou**
 * proud rámců a tichý `null` by z odmítnuté věty udělal větu, která se nikdy
 * nenačetla.
 *
 * ⚠ **Fronta `admission.ts` mezi nimi není** — do 4. 9. 2026 se tu jmenovala.
 * `3235f5b` ji z obojích dveří odstranil jako nedosažitelnou; je to napsaná,
 * nezapojená práce.
 */
export async function openWorldstreamSession(
  prompt: string,
  options: OpenOptions = {},
): Promise<SessionHandle> {
  const call = options.fetch ?? fetch;
  const response = await call('/api/worldstream/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    // **Klíč se posílá jen tehdy, když něco znamená.** Dveře přijímají prompt
    // a `live` a nic jiného, takže `live: false` by byl klíč navíc, který nic
    // nemění — a tělo dějství I má zůstat tím, čím bylo.
    body: JSON.stringify(options.live === true ? { prompt, live: true } : { prompt }),
    signal: options.signal,
  });

  // **Proud v odpovědi je hlavní cesta** (P16 `T8-stream404`): na Vercelu smí
  // druhý požadavek na `/events` dopadnout na instanci, která relaci nezná.
  // Odmítnutí chodí dál jako JSON a 202 s adresami se čte po staru.
  const opened = response.headers.get('x-worldstream-session');
  if (response.ok && opened !== null && response.body !== null) {
    const provenance = response.headers.get('x-worldstream-authored');
    return {
      sessionId: opened,
      events: `/api/worldstream/sessions/${opened}/events`,
      snapshot: `/api/worldstream/sessions/${opened}`,
      authored: provenance === 'exact' || provenance === 'nearest' ? { match: provenance } : null,
      stream: response,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | (Partial<SessionHandle> & { error?: { code?: string; message?: string } })
    | null;

  if (!response.ok) throw new Error(refusal('the world was not opened', body?.error, response.status));
  if (typeof body?.sessionId !== 'string' || typeof body.events !== 'string')
    throw new Error('the world was not opened: the answer named no session');

  // Neznámá hodnota se čte jako „původ neznáme", ne jako `nearest`: popisek
  // o přehrávaném světě je tvrzení a tvrdit se smí jen to, co server řekl.
  const match = body.authored?.match;

  return {
    sessionId: body.sessionId,
    events: body.events,
    snapshot: body.snapshot ?? `/api/worldstream/sessions/${body.sessionId}`,
    authored: match === 'exact' || match === 'nearest' ? { match } : null,
  };
}

/* ------------------------------------------------------------------ *
 * Čtení proudu.
 * ------------------------------------------------------------------ */

export interface FollowOptions extends ClientOptions {
  /** Volané po každém rámci, který stav skutečně změnil. */
  readonly onState?: (state: ClientState) => void;
  /**
   * Kolikrát se smí proud po mezeře obnovit snapshotem. Nula znamená
   * „mezeru neřeš, vrať stav, jaký je".
   */
  readonly maxResumes?: number;
  /** Odkud navázat. Výchozí 0 je „od začátku relace". */
  readonly since?: number;
}

/** Fáze, za kterými už žádný rámec nepřijde. */
function terminal(state: ClientState): boolean {
  return state.phase === 'complete' || state.phase === 'failed';
}

/**
 * Čte proud, dokud relace neskončí, spojení nespadne nebo se nezruší čtení.
 *
 * Vrací poslední stav i tehdy, když se čtení přerušilo — **rozečtený svět je
 * použitelnější než výjimka**. Porotce, kterému usekla síť, má vidět svět,
 * co stihl vzniknout, ne prázdné plátno.
 */
export async function followSession(
  handle: SessionHandle,
  options: FollowOptions = {},
): Promise<ClientState> {
  const call = options.fetch ?? fetch;
  const maxResumes = options.maxResumes ?? 3;

  let state = initialClientState();
  let since = options.since ?? 0;
  let resumes = 0;
  // Proud z odpovědi na otevření začíná od nuly a dá se přečíst jen jednou.
  let opened = since === 0 ? handle.stream : undefined;

  for (;;) {
    const outcome = await readOnce(call, handle, since, state, options, opened);
    opened = undefined;
    state = outcome.state;

    if (outcome.stop === 'done' || outcome.stop === 'aborted') return state;
    if (outcome.stop === 'gap') {
      if (resumes >= maxResumes) return state;
      resumes += 1;
      state = applySnapshot(state, await readSnapshot(call, handle, options.signal));
      options.onState?.(state);
      if (terminal(state)) return state;
      since = state.sequence;
      continue;
    }

    // `closed` — server proud zavřel, aniž by relace došla na konec. Navazuje
    // se od posledního čísla; snapshot k tomu potřeba není, protože žádná
    // mezera nevznikla.
    if (resumes >= maxResumes) return state;
    resumes += 1;
    since = state.sequence;
  }
}

type ReadStop = 'done' | 'gap' | 'closed' | 'aborted';

interface ReadOutcome {
  readonly state: ClientState;
  readonly stop: ReadStop;
}

async function readOnce(
  call: typeof fetch,
  handle: SessionHandle,
  since: number,
  start: ClientState,
  options: FollowOptions,
  opened: Response | undefined,
): Promise<ReadOutcome> {
  let state = start;

  const response =
    opened ??
    (await call(`${handle.events}?since=${since}`, {
      headers: { accept: 'text/event-stream' },
      signal: options.signal,
    }));
  if(response.status===409) {
    const failure=await response.json().catch(()=>null) as {error?:{code?:string}}|null;
    if(failure?.error?.code==='EVENT_HISTORY_TRUNCATED')return {state,stop:'gap'};
  }
  if (!response.ok || response.body === null)
    throw new Error(`the world stream refused to open: HTTP ${response.status}`);

  const decoder = new SseDecoder();
  const text = new TextDecoder();
  const reader = response.body.getReader();

  try {
    for (;;) {
      if (options.signal?.aborted === true) return { state, stop: 'aborted' };

      const { done, value } = await reader.read();
      if (done) return { state, stop: terminal(state) ? 'done' : 'closed' };

      for (const frame of decoder.push(text.decode(value, { stream: true }))) {
        const event = readFrame(frame);
        // Rámec, kterému nerozumíme, není mezera — `sequence` se nehne a
        // reducer o něm nemá co vědět. Heartbeat sem nedojde vůbec, ten
        // dekodér zahodí jako komentář.
        if (event === null) continue;

        const step = reduceEvent(state, event);
        if (!step.ok) {
          if (step.fault === 'SEQUENCE_GAP') return { state, stop: 'gap' };
          // Cizí relace: proud patří někomu jinému, číst dál nemá smysl.
          return { state, stop: 'done' };
        }

        state = step.state;
        if (step.applied) options.onState?.(state);
        if (terminal(state)) return { state, stop: 'done' };
      }
    }
  } catch (thrown) {
    // Zrušení čtení není chyba světa. Cokoli jiného je.
    if (options.signal?.aborted === true) return { state, stop: 'aborted' };
    throw thrown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Rámec drátu → událost §20, nebo `null`, když to událost není. */
function readFrame(frame: SseFrame): SessionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Partial<SessionEvent>;
  if (typeof event.sessionId !== 'string') return null;
  if (typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence)) return null;
  if (typeof event.type !== 'string') return null;

  return event as SessionEvent;
}

async function readSnapshot(
  call: typeof fetch,
  handle: SessionHandle,
  signal: AbortSignal | undefined,
): Promise<ClientSnapshot> {
  const response = await call(handle.snapshot, { headers: { accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`the world snapshot is gone: HTTP ${response.status}`);
  return (await response.json()) as ClientSnapshot;
}

/* ------------------------------------------------------------------ *
 * Druhá věta: preview a commit (`T22`, zapojeno `T35-actsthree4`).
 * ------------------------------------------------------------------ */

/** Co druhá věta udělá, dřív než se cokoli změní. */
export interface ChangePreviewed {
  readonly kind: 'preview';
  readonly changeId: string;
  readonly summary: string;
  readonly target: { readonly stableId: string; readonly label: string };
  readonly scope: {
    readonly shape: boolean;
    readonly behavior: number;
    readonly appearance: number;
  };
  readonly preserved: readonly string[];
  /** `null`, když změnu psal model. Jinak odkud se vzala (`T45-honestlabel`). */
  readonly authored: AuthoredProvenance | null;
}

/** Věta byla nejasná — server nabízí objekty, mezi kterými se má vybrat. */
export interface ChangeAmbiguous {
  readonly kind: 'ambiguous';
  readonly reason: 'NO_MATCH' | 'AMBIGUOUS' | 'UNKNOWN_ID';
  readonly candidates: readonly {
    readonly stableId: string;
    readonly label: string;
    /** Jméno, kterým se objekt do věty trefil. `null`, když se netrefil vůbec. */
    readonly matched: string | null;
  }[];
}

/** Model odpověděl, ale odpověď branou neprošla. Svět se nehnul. */
export interface ChangeRefused {
  readonly kind: 'refused';
  readonly reason: string;
  readonly detail: string;
}

export type ChangeOutcomeRead = ChangePreviewed | ChangeAmbiguous | ChangeRefused;

/**
 * Věta → **plán změny, ne změna**. Design book §4 dějství III: rozsah se ukáže
 * dřív, než se cokoli změní, a commit je druhé rozhodnutí člověka.
 *
 * `stableId` má přednost před textem — když člověk na objekt ukázal, o cíli
 * rozhodl on, ne rozpoznávač.
 *
 * Odmítnutí serveru (vypínač, strop, zavřená relace, chybějící výrobce) se sem
 * vrací jako výjimka s kódem, ze stejného důvodu jako u zakládání relace: 4xx
 * a 5xx nejsou plán a tichý `null` by z odmítnuté věty udělal větu, která se
 * nikdy neodeslala.
 */
export async function requestChange(
  sessionId: string,
  prompt: string,
  options: ClientOptions & { readonly stableId?: string; readonly comparison?: boolean } = {},
): Promise<ChangeOutcomeRead> {
  const call = options.fetch ?? fetch;
  const response = await call(`/api/worldstream/sessions/${sessionId}/changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      ...(options.stableId === undefined ? {} : { stableId: options.stableId }),
      ...(options.comparison === undefined ? {} : { comparison: options.comparison }),
    }),
    signal: options.signal,
  });

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok) {
    // **Ven jde věta serveru, ne jen jeho kód** — nález nezávislé revize
    // 6. 9. 2026. Kód je pro stroj; porotce čte tuhle výjimku na obrazovce
    // v panelu změny, a `NO_AUTHORED_CHANGE` mu neřekne nic.
    throw new Error(
      refusal(
        'the change was not planned',
        body?.error as { code?: string; message?: string } | undefined,
        response.status,
      ),
    );
  }

  if (body?.outcome === 'AMBIGUOUS')
    return {
      kind: 'ambiguous',
      reason: (body.reason ?? 'NO_MATCH') as ChangeAmbiguous['reason'],
      candidates: (body.candidates ?? []) as ChangeAmbiguous['candidates'],
    };

  if (body?.outcome === 'REJECTED')
    return {
      kind: 'refused',
      reason: String(body.reason ?? 'REJECTED'),
      detail: String(body.detail ?? ''),
    };

  if (typeof body?.changeId !== 'string')
    throw new Error('the change was not planned: the answer named no change');

  // Neznámá hodnota se čte jako „původ neznáme", ne jako `nearest` — táž
  // úvaha jako u `openWorldstreamSession()`: popisek je tvrzení a tvrdit se
  // smí jen to, co server řekl.
  const match = (body.authored as { match?: unknown } | undefined)?.match;

  return {
    kind: 'preview',
    changeId: body.changeId,
    summary: String(body.summary ?? ''),
    target: body.target as ChangePreviewed['target'],
    scope: body.scope as ChangePreviewed['scope'],
    preserved: (body.preserved ?? []) as readonly string[],
    authored: match === 'exact' || match === 'nearest' ? { match } : null,
  };
}

/** Jak dopadl commit. Odmítnutí je 200 s verdiktem, ne výjimka. */
export type ChangeCommitted =
  | { readonly kind: 'committed'; readonly stableId: string; readonly summary: string;
      readonly acceptedBlueprint?: WorldstreamBlueprint;
      readonly comparison?: BranchComparison;
      readonly acceptedRevision?: { readonly sim: number; readonly look: number } }
  | { readonly kind: 'refused'; readonly detail: string };

/**
 * Potvrzení plánu — **jediné místo, kde se svět mění**.
 *
 * A4 vrací přesně uložený snapshot a porovnání ověřené před jeho uložením.
 * Ostatní změny zachovávají obnovu přes snapshot relace.
 */
export async function commitChange(
  sessionId: string,
  changeId: string,
  options: ClientOptions & { readonly comparison?: ComparisonCommit } = {},
): Promise<ChangeCommitted> {
  const call = options.fetch ?? fetch;
  const response = await call(
    `/api/worldstream/sessions/${sessionId}/changes/${changeId}/commit`,
    { method: 'POST', signal: options.signal,
      ...(options.comparison === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.comparison),
      }) },
  );

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok) {
    // Táž úvaha jako u `requestChange()` o kus výš: kód je pro stroj, věta pro
    // člověka. Neúspěšné *Apply* je navíc to horší ze dvou míst, kde se tohle
    // porotci ukáže — v tu chvíli už jednou rozhodl.
    throw new Error(
      refusal(
        'the change was not applied',
        body?.error as { code?: string; message?: string } | undefined,
        response.status,
      ),
    );
  }

  if (body?.outcome !== 'COMMITTED')
    return {
      kind: 'refused',
      detail: String(
        (body?.rejections as readonly { detail?: string }[] | undefined)?.[0]?.detail ??
          'the change did not pass the gates',
      ),
    };

  const revisions = body.revisions as { sim?: { after?: unknown }; look?: { after?: unknown } } | undefined;
  const sim = revisions?.sim?.after, look = revisions?.look?.after;
  return {
    kind: 'committed',
    stableId: String(body.stableId ?? ''),
      summary: String(body.summary ?? ''),
      ...(body.acceptedBlueprint === undefined ? {} : { acceptedBlueprint: body.acceptedBlueprint as WorldstreamBlueprint }),
      ...(body.comparison === undefined ? {} : { comparison: body.comparison as BranchComparison }),
    ...(typeof sim === 'number' && Number.isSafeInteger(sim) && sim >= 0 &&
      typeof look === 'number' && Number.isSafeInteger(look) && look >= 0 ? { acceptedRevision: { sim, look } } : {}),
  };
}

/**
 * Blueprint, jak ho drží server **teď**.
 *
 * Commit ho do proudu neposílá — rámec `patch.committed` nese jen to, co se
 * změnilo — takže po commitu si o něj klient řekne sám. Je to táž cesta,
 * kterou se svět obnovuje po mezeře v proudu, jen vyvolaná jiným důvodem.
 */
export async function readBlueprint(
  sessionId: string,
  options: ClientOptions = {},
): Promise<unknown> {
  const call = options.fetch ?? fetch;
  const response = await call(`/api/worldstream/sessions/${sessionId}`, {
    headers: { accept: 'application/json' },
    signal: options.signal,
  });
  if (response.status === 404) throw new Error('The session is unavailable (HTTP 404). It may have expired or the server restarted. Start a new world.');
  if (!response.ok) throw new Error(`the world snapshot is gone: HTTP ${response.status}`);
  return ((await response.json()) as ClientSnapshot).blueprint ?? null;
}

/** Restore server-recorded comparison rules, retaining a monotonically newer revision. */
export async function restoreComparison(sessionId: string,
  expected: { readonly simRevision: number; readonly lookRevision: number; readonly simHash: string },
  options: ClientOptions = {}): Promise<WorldstreamBlueprint> {
  const response = await (options.fetch ?? fetch)(`/api/worldstream/sessions/${sessionId}/comparison/restore`, {
    method: 'POST', signal: options.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(expected),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.outcome !== 'RESTORED')
    throw new Error(refusal('the original rules were not restored', body?.error, response.status));
  return body.acceptedBlueprint as WorldstreamBlueprint;
}
