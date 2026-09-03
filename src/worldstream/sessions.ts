/**
 * **Serverová polovina relace: kdo si ji pamatuje a kdo ji naplní** (P13 T16).
 *
 * Route jsou tři (§21) a všechny tři mluví o **téže** relaci: POST ji založí,
 * SSE proud ji čte, snapshot ji vydá celou. Musí ji proto najít někdo čtvrtý —
 * tenhle modul. Kdyby si ji držela route, která ji založila, ostatní dvě by
 * ji nenašly; sdílený modul je jediný tvar, u kterého se nemusí spoléhat na
 * to, jak bundler poskládá route do chunků.
 *
 * ## ⚠ Registr žije v paměti procesu, a nasazení to pozná
 *
 * Je to **tatáž vada, kterou má `src/server/spend-cap.ts`** a kterou P13 vlna 7
 * (T29, T30) opravuje persistencí: na Vercelu je každý požadavek klidně jiná
 * instance, takže POST na instanci A a proud na instanci B se nepotkají a
 * klient dostane 404. Nikde se proto netvrdí, že relace přežije nasazení —
 * přežije **proces**, a to je všechno. Do vlny 7 je to vědomý dluh, ne
 * nedopatření, a je zapsaný tady, ne jen v plánu.
 *
 * ## Registr má strop, a ten strop nic nezastavuje
 *
 * Relace zakládá **kdokoli s adresou**, takže neomezená mapa je únik paměti
 * dosažitelný zvenčí. Strop je proto na tom, co registr **drží**, ne na tom,
 * kolik jich smí vzniknout: nová relace vždycky projde a nejstarší dokončená
 * vypadne. Odmítat nové relace kvůli počtu by z hlídání paměti udělalo
 * odmítnutí služby.
 */

import { frozenGrammar } from '@/model/client';
import type { Grammar } from '@/model/prompt';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { MAX_PENDING_CHANGES, type PendingChange } from '@/model/worldstream-refine';
import { compileWithRepair, type BlueprintEmitter } from '@/model/worldstream-repair';
import type { WorldstreamBlueprint } from './schema';
import { createSession, type GenerationSession } from './session';
import { shareWorld } from './snapshot-store';

/**
 * Kolik relací registr drží. Jedna relace je desítky rámců a jeden blueprint,
 * tedy jednotky až desítky kilobajtů; 64 je řádově víc, než kolik jich porotce
 * na jednom procesu otevře, a řádově pod čímkoli, co by procesu vadilo.
 */
export const MAX_LIVE_SESSIONS = 64;

export interface StoredSession {
  readonly session: GenerationSession;
  /** Autoritativní blueprint pro reconnect (§21). `null`, dokud nevznikl. */
  blueprint: WorldstreamBlueprint | null;
  /** Proč to skončilo, **veřejnou** větou. `null`, dokud to neskončilo. */
  fault: string | null;
  /**
   * Adresa hotového světa ve sdíleném registru (`snapshot-store.ts`), nebo
   * `null`, dokud svět nevznikl. Snapshot relace ji vydává ven, aby ji měl kdo
   * předat dál — sdílení je lidský akt a bez adresy ho nikdo neudělá.
   */
  sharedWorld: string | null;
  /**
   * Previewy druhé věty čekající na commit (T22, §21).
   *
   * Bydlí tady ze stejného důvodu jako celý tenhle modul: preview zakládá jedna
   * route a commituje ho druhá, takže si ho ani jedna z nich nesmí držet sama.
   * Životnost je životnost relace — vypadne-li relace z registru, vypadnou
   * s ní i její previewy a nezůstane po nich mapa, kterou nikdo neuklidí.
   */
  readonly changes: Map<string, PendingChange>;
}

const live = new Map<string, StoredSession>();

/**
 * Jak dlouho smí relace stát bez jediného nového rámce, než ji registr pustí.
 *
 * **Bez téhle meze strop `MAX_LIVE_SESSIONS` nedrží nic** — nález nezávislé
 * revize 2. 9. 2026. `evict()` uměl uvolnit jen fáze `complete` a `failed`,
 * jenže úspěšná generace končí ve fázi `world` a `session.complete` dnes
 * neemituje nikdo. Jediná relace, kterou registr uměl uvolnit, byla ta
 * **neúspěšná**, takže na nasazení, kde relace začnou uspívat, roste mapa bez
 * konce. V dnešní sadě to nevidět: bez `.env` skončí každá relace `failed`
 * a uklidí se.
 *
 * ⚠ **Řešení je stárnutí, ne přejmenování fáze.** Relace ve `world` je právem
 * otevřená: prohlížeč teprve mele tvary a hlásí je zpátky (T18), takže proud
 * musí zůstat živý a `session.complete` patří až za poslední tvar.
 *
 * Hodina je řádově víc, než trvá nejpomalejší meshing, a řádově míň, než jak
 * dlouho by kdokoli nechal otevřené okno, do kterého se dívá.
 */
export const IDLE_SESSION_MS = 60 * 60 * 1000;

/**
 * Kdy naposledy se relaci pohnul proud — **vlastní čtení registru**, ne značka
 * v logu.
 *
 * Log rámce časem razítkuje (`at`), ale to razítko je podle `events.ts`
 * výslovně observační a nesmí nic řídit. Registr si proto vede vlastní
 * záznam: číslo posledního rámce a čas, kdy ho poprvé viděl stát. Pohnulo-li
 * se číslo, relace žije; nepohnulo-li se hodinu, je to okno, které někdo
 * zavřel, aniž by to kdo řekl.
 */
interface IdleWatch {
  readonly sequence: number;
  readonly since: number;
}

const watched = new Map<string, IdleWatch>();

/**
 * Uvolní relaci **a řekne to jejímu proudu**.
 *
 * ⚠ **To druhé je celá pointa, a chybělo to.** Nález nezávislé revize
 * 3. 9. 2026, `VERDICT: blocking`: smazat relaci ze dvou map paměť neuvolní.
 * Otevřený SSE proud (`sessions/[sessionId]/events/route.ts`) si drží odběr
 * logu a patnáctivteřinový časovač, a ten časovač je kořen, ze kterého vede
 * řetěz na celý `StoredSession` — blueprint, mesh cache i previewy. Vlastní
 * úklid route spouští jedině odchod klienta. **Naměřeno:** 65 POSTů s otevřeným
 * `/events` u každého → registr hlásí 64, proces drží 65 relací a 65 běžících
 * časovačů, a klient první relace dostává tep dál, zatímco všechny ostatní
 * dveře na tutéž relaci odpovídají 404.
 *
 * Dokud uvolňovaly jen `complete` a `failed`, nebylo to vidět: takový proud se
 * zavře sám, protože terminální rámec zavolá `finish()`. Třetí kolo stropu je
 * první cesta, která pustí relaci, jež do koncové fáze **nikdy nedojde**.
 *
 * Řešení proto tou cestou jde: relace se **ukončí** dřív, než zmizí z mapy.
 * `fail()` zapíše `session.failed`, odběratel ho dostane synchronně, uvidí
 * koncovou fázi a zavolá `finish()` — tedy `clearInterval` i odhlášení. Klient
 * se současně dozví **proč**, místo aby dostával tep do prázdna. Na relaci,
 * která už koncová je, je `fail()` bez účinku, takže dvoje dveře nevadí.
 */
function release(sessionId: string): void {
  const stored = live.get(sessionId);
  if (stored !== undefined && stored.fault === null) {
    stored.fault = SESSION_FAULTS.SESSION_RELEASED;
    stored.session.fail(SESSION_FAULTS.SESSION_RELEASED);
  }
  live.delete(sessionId);
  // Previewy druhé věty visí na `StoredSession`, takže odcházejí s ní
  // (T22-previewleak). Zůstat tu smí jen to, co registr sám založil.
  watched.delete(sessionId);
}

/**
 * Stojí ta relace tak dlouho, že už se na ni nikdo nedívá?
 *
 * **Dva signály života, otevřený proud je ten první.** ⚠ Nález nezávislé
 * revize 4. 9. 2026, `VERDICT: blocking`: samotné `sequence` tuhle otázku
 * zodpovědět neumí. Po `world.ready` ho v provozu **nehne nic** — meshování
 * běží v prohlížeči a žádná route mu rámec nevrací (`session.queue()` nemá
 * mimo testy volajícího), tep SSE se píše rovnou do proudu a do logu nejde.
 * Číslo tedy zamrzne pár vteřin po založení úplně každé relaci a hodina se
 * počítá od té chvíle. Jeden porotce, jedna věta, hodinu otevřená karta —
 * a další POST kohokoli jiného mu tu relaci uklidí pod rukama, i když
 * registr nikde netlačí na strop.
 *
 * Otevřený odběr logu je proti tomu přímý důkaz, že na druhé straně někdo
 * je: `sessions/[sessionId]/events/route.ts` ho drží přesně tak dlouho, jak
 * dlouho drží spojení, a pouští ho, jakmile klient odejde. Relace s divákem
 * proto stárnout nezačne; `sequence` zůstává jako druhý signál pro relace,
 * které nikdo nesleduje a přesto se v nich něco děje.
 *
 * ⚠ **Strop tím obejít nejde.** Tohle je jen první kolo `evict()`. Když se
 * registr přeplní samými sledovanými relacemi, třetí kolo je pustí stejně —
 * proto se `watched` obnovuje i tady, aby se v tom pořadí sledovaná relace
 * řadila za tu, kterou nikdo nedrží, místo před ni.
 */
function idleFor(sessionId: string, stored: StoredSession, now: number): boolean {
  const { sequence, watchers } = stored.session.events;
  const seen = watched.get(sessionId);
  if (seen === undefined || seen.sequence !== sequence || watchers > 0) {
    watched.set(sessionId, { sequence, since: now });
    return false;
  }
  return now - seen.since >= IDLE_SESSION_MS;
}

/**
 * Uvolní, co registr držet nemá — **ve třech kolech, od nejlevnější ztráty**.
 *
 * 1. Relace, které nikdo nesleduje a hodinu se v nich nic nestalo, ať jsou
 *    v jakékoli fázi. **Stárnutí je na divákovi a na pohybu proudu, ne na
 *    fázi** — relace s otevřeným proudem nebo s přibývajícími rámci se tohle
 *    kolo nedotkne, i kdyby běžela den (`idleFor` níž).
 * 2. Nad stropem: nejstarší **dokončené**, tedy `complete` a `failed`.
 * 3. Pořád nad stropem: ty, které **stojí nejdéle**, bez ohledu na fázi.
 *
 * ⚠ **Třetí kolo je změna doktríny a je vynucená měřením.** Do 3. 9. 2026 tu
 * stálo, že běžící relace se nevyhodí ani jako nejstarší, protože „utnout proud
 * někomu, kdo se dívá, je horší než o jednu relaci nad strop". Nezávislá revize
 * ukázala, že „o jednu" byla nepravda: se stárnutím na hodinu a bez třetího
 * kola zní mez **„příchody za hodinu"**, ne `MAX_LIVE_SESSIONS`. Dvě stě
 * požadavků v jedné hodině — tedy den, na který se tenhle produkt chystá —
 * drží dvě stě relací a strop 64 nedělá nic. Neomezená mapa dosažitelná zvenčí
 * je přesně to, proti čemu strop je.
 *
 * Obětuje se proto ta, která stojí nejdéle: `watched.since` je čas, kdy registr
 * naposledy viděl proud té relace **hnout se**, takže relace, do které se
 * právě píše, je v tom pořadí poslední. První kolo `watched` přepíše pro
 * všechny, takže se řadí nad čerstvými čísly, ne nad zbytky.
 *
 * Zametá se při zakládání nové relace, tedy tehdy, když registr roste. Když
 * nikdo nezakládá, nic neroste a není co zametat.
 */
function evict(now: number): void {
  for (const [id, stored] of live) if (idleFor(id, stored, now)) release(id);

  if (live.size <= MAX_LIVE_SESSIONS) return;
  for (const [id, stored] of live) {
    if (live.size <= MAX_LIVE_SESSIONS) return;
    const phase = stored.session.phase;
    if (phase === 'complete' || phase === 'failed') release(id);
  }

  if (live.size <= MAX_LIVE_SESSIONS) return;
  const podleStání = [...live.keys()].sort(
    (a, b) => (watched.get(a)?.since ?? 0) - (watched.get(b)?.since ?? 0),
  );
  for (const id of podleStání) {
    if (live.size <= MAX_LIVE_SESSIONS) return;
    release(id);
  }
}

/**
 * `now` je vstřícnost k testům: hodinu nejde odčekat a `Date.now()` se posunout
 * nedá. Provoz ho nepředává.
 */
export function putSession(stored: StoredSession, now: number = Date.now()): void {
  live.set(stored.session.sessionId, stored);
  evict(now);
}

export function getSession(sessionId: string): StoredSession | null {
  return live.get(sessionId) ?? null;
}

/** Jen pro testy: registr je proces-globální a testy se jinak ovlivňují. */
export function clearSessions(): void {
  live.clear();
  watched.clear();
}

export function liveSessionCount(): number {
  return live.size;
}

/**
 * Kolik relací registr **hlídá na stárnutí**. Jen pro testy.
 *
 * Existuje proto, že `watched` je druhá mapa vedle `live` a druhá mapa je druhé
 * místo, kde může vzniknout přesně ten únik, který `T16-evictworld` zavírá —
 * jen o patro níž a bez jediného viditelného následku. Mutační kontrola
 * 3. 9. 2026 to potvrdila: vynechaný úklid `watched` nezabil ani jeden test.
 */
export function watchedSessionCount(): number {
  return watched.size;
}

/**
 * Uloží preview a udrží jich nejvýš `MAX_PENDING_CHANGES`.
 *
 * Strop je na tom, co se **drží**, ne na tom, kolik se jich smí založit — táž
 * úvaha jako u `evict()` o pár řádků výš. Odmítat nový preview kvůli počtu by
 * z hlídání paměti udělalo odmítnutí služby, a to zrovna u dveří, kterými
 * porotce mění svět.
 */
export function putChange(stored: StoredSession, change: PendingChange): void {
  stored.changes.set(change.changeId, change);
  // Pořadí `Map` je pořadí vložení, takže první je nejstarší.
  for (const oldest of stored.changes.keys()) {
    if (stored.changes.size <= MAX_PENDING_CHANGES) break;
    stored.changes.delete(oldest);
  }
}

/**
 * Vyzvedne preview **a zároveň ho spotřebuje**.
 *
 * Jedno preview je jeden commit: kdyby šlo commitnout dvakrát, druhý pokus by
 * proběhl proti revizi, kterou zvedl ten první — tedy přesně ten zastaralý
 * commit, který §9.8 zakazuje. Bránu na revize to nenahrazuje, jen jí ubírá
 * jediný případ, u kterého by musela hádat, co se stalo dřív.
 */
export function takeChange(stored: StoredSession, changeId: string): PendingChange | null {
  const change = stored.changes.get(changeId) ?? null;
  if (change !== null) stored.changes.delete(changeId);
  return change;
}

/* ------------------------------------------------------------------ *
 * Generace.
 * ------------------------------------------------------------------ */

/**
 * Proč generace skončila bez světa — **veřejným slovníkem**.
 *
 * Detail poskytovatele ven nejde nikdy. `fetch` píše do svých hlášek celou
 * adresu koncového bodu a ta umí nést i pověření (`?key=`, `https://user:heslo@…`);
 * naměřilo to review 31. 8. 2026 nad měřidlem T14, kde tatáž věta došla až do
 * commitnutého reportu. Ven jde tedy kód a věta bez čísel a cest, do logu
 * operátora všechno ostatní.
 */
export const SESSION_FAULTS = {
  PLANNER_REJECTED: 'the sentence could not be turned into a plan',
  BLUEPRINT_REJECTED: 'the model could not write a world that holds together',
  MODEL_UNAVAILABLE: 'the model could not be reached',
  BAD_REQUEST: 'the request was built wrong before the model saw it',
  /**
   * Registr relaci pustil, aby se vešly novější (`release()` výš).
   *
   * Není to selhání generace a věta to tak neříká: svět, který vznikl, je
   * pořád ve sdíleném registru pod svou adresou. Skončila jen **relace**.
   * Fáze je přesto `failed`, protože jiná koncová fáze s důvodem neexistuje —
   * a koncová být musí, jinak se proud nedozví, že má skončit.
   */
  SESSION_RELEASED: 'the session was closed to make room for newer ones',
} as const;

export type SessionFault = keyof typeof SESSION_FAULTS;

export interface GenerationDeps {
  /** Model. Jedno volání, jeden požadavek — strop řeší volající. */
  readonly emit: BlueprintEmitter;
  readonly grammar: Grammar;
  /** Kam se zapisuje to, co ven nesmí. */
  readonly log?: (fault: SessionFault, detail: string) => void;
}

/** Grammar ze zmrazeného protokolu, nebo věta, proč nejde přečíst. */
export function serverGrammar(): Grammar | string {
  const read = frozenGrammar();
  return read.ok ? read.value : `${read.reason}: ${read.detail}`;
}

/**
 * Věta → záměr → blueprint → commit hrubého světa.
 *
 * **Meshing tu není a nebude** (§21: „meshing nemá route"). Server dojde
 * k blueprintu a tím je hrubý svět hotový — `world.ready` je proto vydané
 * dřív, než kterýkoli tvar existuje, a přesně to po něm chce AC úlohy.
 * Tvary si prohlížeč mele sám a hlásí je do téže relace (T18).
 *
 * Funkce **nevyhazuje**. Běží na pozadí za odpovědí 202, takže odmítnutý slib
 * by skončil jako `unhandledRejection` a relace by zůstala navždy v `accepted`.
 * Každá cesta ven proto končí buď `world.ready`, nebo `session.failed`.
 */
export async function runGeneration(
  stored: StoredSession,
  prompt: string,
  deps: GenerationDeps,
): Promise<void> {
  const { session } = stored;
  const report = deps.log ?? (() => undefined);

  function stop(fault: SessionFault, detail: string): void {
    report(fault, detail);
    stored.fault = SESSION_FAULTS[fault];
    session.fail(SESSION_FAULTS[fault]);
  }

  let plan;
  try {
    plan = readPlannerEmission(await deps.emit(buildIntentRequest(prompt)));
  } catch (thrown) {
    stop('MODEL_UNAVAILABLE', thrown instanceof Error ? thrown.message : String(thrown));
    return;
  }
  if (!plan.ok) {
    stop('PLANNER_REJECTED', `${plan.reason}: ${plan.detail}`);
    return;
  }

  session.advance('intent', {
    setting: plan.value.intent.setting,
    spatialThesis: plan.value.intent.spatialThesis,
    heroObjects: plan.value.intent.heroObjects,
    unsupported: plan.value.intent.unsupported,
  });

  const outcome = await compileWithRepair({
    plan: plan.value,
    grammar: deps.grammar,
    sessionSeed: session.sessionSeed,
    emit: deps.emit,
  });

  if (outcome.kind !== 'compiled') {
    const detail =
      outcome.kind === 'unavailable' || outcome.kind === 'invalidInput'
        ? outcome.detail
        : `${outcome.fault.reason}: ${outcome.fault.detail}`;
    stop(
      outcome.kind === 'unavailable'
        ? 'MODEL_UNAVAILABLE'
        : outcome.kind === 'invalidInput'
          ? 'BAD_REQUEST'
          : 'BLUEPRINT_REJECTED',
      detail,
    );
    return;
  }

  const blueprint = outcome.result.value;
  stored.blueprint = blueprint;

  // **Blueprint jde celý jedním rámcem, `world.ready` je pak jen povel.**
  // Klient, který se připojí až po něm, si ho vezme ze snapshotu (§21) — proto
  // je autoritativní snapshot, ne rámec, a proto se blueprint neposílá dvakrát.
  session.advance('blueprint', { blueprint, rounds: outcome.rounds.length });
  session.register(blueprint.objects.map((object) => object.stableId));
  // **Hotový svět dostane adresu, která přežije relaci** (T30, §22.4). Relace
  // je živá věc — vypadne z registru, skončí s procesem, stojí slot. Sdílený
  // svět je záznam, který se dá číst i ve chvíli, kdy je model vypnutý.
  //
  // Adresu spočítá server z obsahu, takže ji jako první zná jedině prohlížeč
  // téhle relace; §24 („běžná relace se automaticky nestává galerií") je tím
  // splněné rozdílem mezi *adresovatelný* a *vypsaný* — výpis neexistuje.
  stored.sharedWorld = shareWorld(blueprint, Date.now());

  session.advance('world', {
    title: blueprint.title,
    objects: blueprint.objects.length,
    shapes: blueprint.shapes.length,
  });
}

/**
 * Relace se `sessionSeed`, které píše **systém**.
 *
 * `blueprintSchema` chce kladné 32bitové celé číslo, aby se v Node a
 * v prohlížeči nezaokrouhlilo jinak. `Math.random` tu **není na replay cestě**
 * — semínko je vstup relace, ne krok simulace; jakmile vznikne, je konstantní
 * a celý zbytek světa je z něj deterministický.
 */
export function newSessionSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 2_147_483_647);
}

export function openSession(
  sessionId: string,
  sessionSeed: number,
  now: number = Date.now(),
): StoredSession {
  const stored: StoredSession = {
    session: createSession({ sessionId, sessionSeed }),
    blueprint: null,
    fault: null,
    sharedWorld: null,
    changes: new Map(),
  };
  putSession(stored, now);
  return stored;
}
