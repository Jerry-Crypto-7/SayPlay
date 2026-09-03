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
 * Vyhodí nejstarší **dokončenou** relaci, dokud se registr nevejde do stropu.
 *
 * Pořadí `Map` je pořadí vložení, takže nejstarší je první. Běžící relace se
 * nevyhazuje ani tehdy, když je nejstarší: vyhodit ji znamená utnout proud
 * někomu, kdo se právě dívá, a to je horší než o jednu relaci nad strop.
 */
function evict(): void {
  if (live.size <= MAX_LIVE_SESSIONS) return;
  for (const [id, stored] of live) {
    if (live.size <= MAX_LIVE_SESSIONS) return;
    const phase = stored.session.phase;
    if (phase === 'complete' || phase === 'failed') live.delete(id);
  }
}

export function putSession(stored: StoredSession): void {
  live.set(stored.session.sessionId, stored);
  evict();
}

export function getSession(sessionId: string): StoredSession | null {
  return live.get(sessionId) ?? null;
}

/** Jen pro testy: registr je proces-globální a testy se jinak ovlivňují. */
export function clearSessions(): void {
  live.clear();
}

export function liveSessionCount(): number {
  return live.size;
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

export function openSession(sessionId: string, sessionSeed: number): StoredSession {
  const stored: StoredSession = {
    session: createSession({ sessionId, sessionSeed }),
    blueprint: null,
    fault: null,
    changes: new Map(),
  };
  putSession(stored);
  return stored;
}
