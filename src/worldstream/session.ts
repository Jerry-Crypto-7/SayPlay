/**
 * **Automat relace: fáze, reprezentace a pravidlo o zastaralém výsledku**
 * (P13 vlna 3, T15).
 *
 * Design book §9.7 (stav reprezentace), §9.8 (revize), §10.5 (zrušení) a §20
 * (události). Jeden objekt drží tři věci, které se nesmějí rozejít: **kam až
 * relace došla**, **jakou podobu má který objekt** a **co o obojím ví proud**.
 * Kdyby stav a log byly dva nezávislé kusy, dala by se do proudu zapsat
 * událost, kterou stav neuznal — a klient by si postavil svět, který na serveru
 * neexistuje.
 *
 * ## Kdo tenhle soubor spouští
 *
 * **Oba konce.** Server řídí fáze (`intent.ready → blueprint.ready →
 * world.ready`, T16), prohlížeč řídí reprezentace, protože meshing podle §21
 * žádnou route nemá a běží u klienta (T18). Modul proto neimportuje nic ze
 * `three`, z Nextu ani z Node — je to čistý automat nad daty.
 *
 * ## Jediná vada, kterou tenhle soubor doopravdy zavírá
 *
 * **Pozdní výsledek staré revize.** Druhá věta zvedne revizi objektu a zruší
 * běžící práci (§10.5), jenže pracovník se ukončuje na hranici bloku, ne
 * uprostřed — takže výsledek staré revize může dorazit **po** commitu nové.
 * Bez kontroly to je tichá výměna: objekt dostane podobu, kterou porotce
 * právě odvolal, a nikde to nevyskočí. `apply()` proto před každou změnou
 * projde §9.8 a neshodu pojmenuje `STALE_ARTIFACT`.
 *
 * Podmínky 4 a 5 z §9.8 (artefakt prošel bránou, rozpočty se vejdou) tady
 * **nejsou schválně**: brána je vlastní úloha (T19) a běží *před* `apply()`.
 * Její selhání se sem vrací jako `failed` s `GATE_REJECTED`, ne jako zamítnutá
 * změna. Duplikovat ji tady znamená dvě brány, které se časem rozejdou.
 */

import {
  createEventLog,
  isCoalescable,
  type SessionEvent,
  type SessionEventLog,
  type SessionEventType,
} from './events';
import {
  createMeshCache,
  restoreMeshCache,
  type MeshArtifact,
  type MeshCache,
  type MeshCacheSnapshot,
  type MeshFailure,
  type MeshResolution,
} from './cache';
import type { QualityTier } from './quality';
import { canonical } from '@/ir/worlddoc';
import { blueprintSchema, semanticObjectSchema, type SemanticObject, type WorldstreamBlueprint } from './schema';
import { findBlueprintReferenceIssues } from './references';
import type { AssetManifest } from '@/assets/manifest';
import { assetObjectIssues } from '@/assets/binding';

/* ------------------------------------------------------------------ *
 * Fáze relace.
 * ------------------------------------------------------------------ */

/**
 * Žebřík relace. Pořadí je pořadí, ve kterém se rozsvěcují události §20:
 * `session.accepted → intent.ready → blueprint.ready → world.ready →
 * session.complete`.
 *
 * `failed` v poli není, protože není příčka — dá se do něj spadnout odkudkoli.
 */
export const SESSION_PHASES = ['accepted', 'intent', 'blueprint', 'world', 'complete'] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number] | 'failed';

/**
 * Ke které příčce patří která událost.
 *
 * `Record` přes celý žebřík znovu kvůli **úplnosti**: nová fáze bez události
 * neprojde přes `tsc`, takže se nemůže stát, že by relace postoupila a proud
 * o tom mlčel.
 */
const PHASE_EVENT: Record<(typeof SESSION_PHASES)[number], SessionEventType> = {
  accepted: 'session.accepted',
  intent: 'intent.ready',
  blueprint: 'blueprint.ready',
  world: 'world.ready',
  complete: 'session.complete',
};

/* ------------------------------------------------------------------ *
 * Stav reprezentace — design book §9.7.
 * ------------------------------------------------------------------ */

/**
 * Žebřík podoby jednoho objektu. `failed` je mimo něj.
 *
 * `validating` a `revealing` **nevydávají rámec** a je to správně: brána §12 i
 * odhalení §13.3 běží celé v prohlížeči a trvají desítky milisekund. Slovník
 * §20 má pro tvar pět událostí, ne sedm, a tohle jsou právě ty dvě, které
 * v něm nejsou.
 */
export const REPRESENTATION_RUNGS = [
  'planned',
  'coarse',
  'refining',
  'validating',
  'revealing',
  'refined',
] as const;

export type RepresentationRung = (typeof REPRESENTATION_RUNGS)[number];

export type RepresentationState =
  | { readonly kind: 'planned' }
  | { readonly kind: 'coarse'; readonly artifact: MeshArtifact }
  | { readonly kind: 'refining'; readonly from: MeshArtifact }
  | { readonly kind: 'validating' }
  | { readonly kind: 'revealing'; readonly artifact: MeshArtifact }
  | { readonly kind: 'refined'; readonly artifact: MeshArtifact }
  | { readonly kind: 'failed'; readonly reason: MeshFailure; readonly retryable: boolean };

/** Kterou událost §20 ta příčka vydá. Tři příčky nevydávají žádnou. */
const RUNG_EVENT: Partial<Record<RepresentationState['kind'], SessionEventType>> = {
  coarse: 'shape.coarse',
  refining: 'shape.refining',
  refined: 'shape.ready',
  failed: 'shape.failed',
};

function rungIndex(kind: RepresentationState['kind']): number {
  return REPRESENTATION_RUNGS.indexOf(kind as RepresentationRung);
}

/** Co se o té příčce pošle ven. Payload skládá relace, ne volající. */
function rungPayload(stableId: string, state: RepresentationState): unknown {
  switch (state.kind) {
    case 'coarse':
    case 'revealing':
    case 'refined':
      return {
        stableId,
        contentHash: state.artifact.contentHash,
        resolution: state.artifact.resolution,
        triangles: state.artifact.triangles,
      };
    case 'refining':
      return { stableId, from: state.from.contentHash };
    case 'failed':
      return { stableId, reason: state.reason, retryable: state.retryable };
    default:
      return { stableId };
  }
}

/* ------------------------------------------------------------------ *
 * Doručení a jeho odmítnutí.
 * ------------------------------------------------------------------ */

export interface RepresentationDelivery {
  readonly sessionId: string;
  readonly stableId: string;
  /** Revize, **proti které** práce vznikla. Ne aktuální revize objektu. */
  readonly representationRevision: number;
  readonly next: RepresentationState;
}

/**
 * Proč se doručení nepřijalo. Všechny čtyři jsou `STALE_ARTIFACT` z §13.4 —
 * liší se tím, co přesně se mezitím změnilo, a to je jediné, co operátorovi
 * a Inspect vrstvě řekne, kde se závod odehrál.
 */
export type StaleReason =
  | 'UNKNOWN_SESSION'
  | 'SESSION_CLOSED'
  | 'UNKNOWN_OBJECT'
  | 'STALE_REVISION'
  | 'NOT_MONOTONE';

export type ApplyOutcome =
  | { readonly ok: true; readonly state: RepresentationState; readonly event: SessionEvent | null }
  | { readonly ok: false; readonly fault: 'STALE_ARTIFACT'; readonly reason: StaleReason };

export type PhaseOutcome =
  | { readonly ok: true; readonly event: SessionEvent }
  | { readonly ok: false; readonly reason: 'NOT_MONOTONE' | 'SESSION_CLOSED' };

/* ------------------------------------------------------------------ *
 * Relace.
 * ------------------------------------------------------------------ */

export interface RepresentationRecord {
  readonly object?: SemanticObject;
  readonly stableId: string;
  readonly revision: number;
  readonly state: RepresentationState;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly sessionSeed: number;
  readonly phase: SessionPhase;
  /**
   * Úroveň kvality relace (P15 T26, §23: „tier jde do snapshotu relace").
   *
   * **Je ve snapshotu proto, aby přežila reconnect**, ne kvůli evidenci.
   * Meshing běží v prohlížeči (§21) a `contentHash` se skládá z programu
   * **a rozlišení** (`shapeContentHash()`), takže klient, který se vrátí a
   * zvolí si úroveň znovu, by objednal tytéž tvary pod jinými hashi: cache by
   * je minula, kontrolní přečtení §13.3 by je odmítlo jako `READBACK_MISMATCH`
   * a porotce by po výpadku sítě viděl, jak se svět staví celý znovu.
   */
  readonly quality: QualityTier;
  /** Kde je proud. Klient si po reconnectu vyžádá události za tímhle číslem. */
  readonly sequence: number;
  readonly representations: readonly RepresentationRecord[];
  readonly cache: MeshCacheSnapshot;
}

export interface GenerationSession {
  readonly sessionId: string;
  readonly sessionSeed: number;
  readonly phase: SessionPhase;
  readonly events: SessionEventLog;
  readonly cache: MeshCache;
  readonly representations: readonly RepresentationRecord[];
  stateOf(stableId: string): RepresentationState | null;
  revisionOf(stableId: string): number | null;
  /** Objekty z blueprintu. Zakládá je jako `planned`, rámec nevydává. */
  register(stableIds: readonly string[]): void;
  registerBlueprint(blueprint: WorldstreamBlueprint, assets?: AssetManifest): void;
  replaceAsset(stableId: string, expectedRevision: number, object: SemanticObject, assets: AssetManifest):
    { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly reason: string };
  advance(to: SessionPhase, payload?: unknown): PhaseOutcome;
  fail(reason: string): PhaseOutcome;
  /** Práce zadaná pracovníkovi. Příčku nemění, vydá `shape.queued`. */
  queue(stableId: string, resolution: MeshResolution): boolean;
  apply(delivery: RepresentationDelivery): ApplyOutcome;
  /** Druhá věta změnila tvar: zvedne revizi a shodí podobu na `planned`. */
  revise(stableId: string): number | null;
  /** Výslovný retry po `failed`. Revizi **nemění** — je to týž program. */
  retry(stableId: string): boolean;
  snapshot(): SessionSnapshot;
}

export interface SessionOptions {
  readonly sessionId: string;
  readonly sessionSeed: number;
  readonly now?: () => string;
  /** Úroveň kvality. Výchozí `full`, tedy co relace dostávaly do `T26`. */
  readonly quality?: QualityTier;
}

interface SessionSeed {
  readonly sessionId: string;
  readonly sessionSeed: number;
  readonly phase: SessionPhase;
  readonly quality: QualityTier;
  readonly representations: readonly RepresentationRecord[];
  readonly cache: MeshCache;
  readonly log: SessionEventLog;
}

function build(seed: SessionSeed): GenerationSession {
  const log = seed.log;
  const cache = seed.cache;
  const records = new Map<string, RepresentationRecord>(
    seed.representations.map((record) => [record.stableId, structuredClone(record)]),
  );
  let phase: SessionPhase = seed.phase;

  function closed(): boolean {
    return phase === 'complete' || phase === 'failed';
  }

  function write(stableId: string, revision: number, state: RepresentationState): void {
    const object = records.get(stableId)?.object;
    records.set(stableId, { stableId, revision, state, ...(object ? { object } : {}) });
  }

  return {
    sessionId: seed.sessionId,
    sessionSeed: seed.sessionSeed,
    events: log,
    cache,

    get phase() {
      return phase;
    },

    get representations() {
      return structuredClone([...records.values()]);
    },

    stateOf(stableId) {
      return records.get(stableId)?.state ?? null;
    },

    revisionOf(stableId) {
      return records.get(stableId)?.revision ?? null;
    },

    register(stableIds) {
      for (const stableId of stableIds) {
        // Objekt, který už existuje, se neresetuje. Blueprint se může
        // zopakovat (reconnect, druhá věta), a přepsat běžící podobu na
        // `planned` by odpojilo mesh, který na scéně stojí.
        if (!records.has(stableId)) write(stableId, 0, { kind: 'planned' });
      }
    },

    registerBlueprint(blueprint, assets) {
      blueprint = blueprintSchema.parse(blueprint);
      const issues = findBlueprintReferenceIssues(blueprint, assets);
      if (issues.length) throw new Error(issues.map(issue => `${issue.where}: ${issue.detail}`).join('; '));
      // Reconnect must not overwrite an accepted object's runtime contract.
      for (const object of blueprint.objects) {
        const old = records.get(object.stableId)?.object;
        if (old && canonical(old) !== canonical(object)) throw new Error('Registered object has changed');
      }
      for (const object of blueprint.objects) {
        const old = records.get(object.stableId);
        records.set(object.stableId, { stableId: object.stableId, revision: old?.revision ?? 0,
          state: old?.state ?? { kind: 'planned' }, object: structuredClone(object) });
      }
    },

    replaceAsset(stableId, expectedRevision, input, assets) {
      const record = records.get(stableId);
      if (closed()) return { ok: false, reason: 'SESSION_CLOSED' };
      if (!record?.object) return { ok: false, reason: 'UNKNOWN_OBJECT' };
      if (record.revision !== expectedRevision) return { ok: false, reason: 'STALE_REVISION' };
      const parsed = semanticObjectSchema.safeParse(input);
      if (!parsed.success || parsed.data.source.kind !== 'asset' || !parsed.data.binding)
        return { ok: false, reason: 'INVALID_ASSET_OBJECT' };
      const next = parsed.data;
      // Only representation data may change; identity, placement, collider,
      // entity, part and socket contracts remain the accepted values.
      const contract = ({ source: _source, stretchAxes: _stretch, ...rest }: SemanticObject) => rest;
      if (canonical(contract(record.object)) !== canonical(contract(next)))
        return { ok: false, reason: 'BINDING_MISMATCH' };
      const resolved = assets.resolve(next.source);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const issues = assetObjectIssues(next, resolved.asset);
      if (issues.length) return { ok: false, reason: issues.join('; ') };
      const revision = record.revision + 1;
      records.set(stableId, { stableId, revision, state: { kind: 'planned' }, object: structuredClone(next) });
      return { ok: true, revision };
    },

    advance(to, payload = {}) {
      if (closed()) return { ok: false, reason: 'SESSION_CLOSED' };
      // `failed` se z `advance` nedá zvolit: není to příčka a jeho rámec nese
      // důvod, ne payload volajícího. Vede tam `fail()`, jedna cesta.
      if (to === 'failed') return { ok: false, reason: 'NOT_MONOTONE' };

      // **Přesně další příčka, ne „aspoň tak daleko".** Planner, compiler
      // a commit hrubého světa proběhnou v generaci vždycky všechny tři
      // (§10.1), takže přeskok není zkratka, ale ztracený krok — a klient by
      // se o něm nedozvěděl, protože chybějící rámec vypadá jako rámec, co
      // teprve přijde.
      const index = SESSION_PHASES.indexOf(phase as (typeof SESSION_PHASES)[number]);
      const target = SESSION_PHASES.indexOf(to);
      if (target !== index + 1) return { ok: false, reason: 'NOT_MONOTONE' };

      phase = to;
      return { ok: true, event: log.append(PHASE_EVENT[to], payload) };
    },

    fail(reason) {
      if (closed()) return { ok: false, reason: 'SESSION_CLOSED' };
      phase = 'failed';
      return { ok: true, event: log.append('session.failed', { reason }) };
    },

    queue(stableId, resolution) {
      const record = records.get(stableId);
      if (record === undefined || closed()) return false;
      log.append('shape.queued', { stableId, resolution }, stableId);
      return true;
    },

    apply(delivery) {
      // Pořadí kontrol je pořadí §9.8 a záleží na něm: doručení do cizí relace
      // se nesmí odmítnout jako „neznámý objekt", protože to by operátora
      // poslalo hledat objekt do relace, které se to netýká.
      if (delivery.sessionId !== seed.sessionId) {
        return { ok: false, fault: 'STALE_ARTIFACT', reason: 'UNKNOWN_SESSION' };
      }
      if (closed()) return { ok: false, fault: 'STALE_ARTIFACT', reason: 'SESSION_CLOSED' };

      const record = records.get(delivery.stableId);
      if (record === undefined) {
        return { ok: false, fault: 'STALE_ARTIFACT', reason: 'UNKNOWN_OBJECT' };
      }
      if (record.revision !== delivery.representationRevision) {
        return { ok: false, fault: 'STALE_ARTIFACT', reason: 'STALE_REVISION' };
      }

      const next = delivery.next;
      // **Jediná příčka, která se smí zopakovat, je ta, jejíž rámec se smí
      // sloučit.** Průběh refinování dorazí vícekrát a je to jeho smysl;
      // druhá `coarse` nebo druhá `refined` je naopak tichá výměna meshe za
      // jiný na téže příčce, tedy přesně ten závod, který tenhle soubor
      // zavírá. Jedna množina rozhoduje obojí (`isCoalescable`), aby se ty dvě
      // pravdy nemohly rozejít.
      const type = RUNG_EVENT[next.kind];
      const repeats =
        next.kind === record.state.kind && type !== undefined && isCoalescable(type);
      const monotone =
        record.state.kind !== 'failed' &&
        (next.kind === 'failed' || repeats || rungIndex(next.kind) > rungIndex(record.state.kind));
      if (!monotone) return { ok: false, fault: 'STALE_ARTIFACT', reason: 'NOT_MONOTONE' };

      write(delivery.stableId, record.revision, next);

      const event =
        type === undefined
          ? null
          : log.append(type, rungPayload(delivery.stableId, next), delivery.stableId);
      return { ok: true, state: next, event };
    },

    revise(stableId) {
      const record = records.get(stableId);
      if (record === undefined || closed()) return null;
      const revision = record.revision + 1;
      write(stableId, revision, { kind: 'planned' });
      return revision;
    },

    retry(stableId) {
      const record = records.get(stableId);
      if (record === undefined || closed()) return false;
      // Retry je podle §9.7 **výslovný**, a jediné, co ho smí vyvolat, je
      // selhání, které se opakovat vyplatí. `isRetryable` to rozhoduje
      // z naměřeného determinismu meshovače, ne z odhadu.
      if (record.state.kind !== 'failed' || !record.state.retryable) return false;
      write(stableId, record.revision, { kind: 'planned' });
      return true;
    },

    snapshot() {
      return {
        sessionId: seed.sessionId,
        sessionSeed: seed.sessionSeed,
        phase,
        quality: seed.quality,
        sequence: log.sequence,
        representations: structuredClone([...records.values()]),
        cache: cache.snapshot(),
      };
    },
  };
}

/**
 * Nová relace. Vzniká **až po moderaci a po čítači souběžných placených
 * volání**, takže první, co udělá, je rámec `session.accepted` — relace bez
 * něj by v proudu začínala uprostřed.
 *
 * ⚠ **Fronta `src/server/admission.ts` v tom NENÍ**, ačkoli tu do 4. 9. 2026
 * stálo, že ano. `3235f5b` (`T22-admissiondead`) obě volání `admit()`
 * odstranil, protože ta brána nemohla odmítnout nikdy nikoho: rozhodovala po
 * 12 s čekání, kdežto čtení těla má vlastní strop `BODY_DEADLINE_MS = 5 000`.
 * Modul zůstal v repu jako napsaná, **nezapojená** práce — jestli se zapojí
 * s deadlinem předaným až k poskytovateli, rozhoduje `T28`.
 */
export function createSession(options: SessionOptions): GenerationSession {
  const log = createEventLog(options.sessionId, { now: options.now });
  const session = build({
    sessionId: options.sessionId,
    sessionSeed: options.sessionSeed,
    phase: 'accepted',
    quality: options.quality ?? 'full',
    representations: [],
    cache: createMeshCache(options.sessionSeed),
    log,
  });
  log.append('session.accepted', {});
  return session;
}

/**
 * Obnoví relaci ze snapshotu (§21: autoritativní snapshot pro reconnect).
 *
 * **Historii rámců snapshot nenese a nemá.** Protokol §20 je „snapshot plus
 * události za posledním číslem", takže obnovená relace navazuje číslováním
 * (`startAt`), ale starší rámce už nikomu nedluží — kdo je potřeboval, dostal
 * je dřív, a kdo přichází teď, dostal celý stav jedním kusem. Kdyby se log
 * obnovoval prázdný a číslo od nuly, druhá relace by vydávala čísla, která
 * u klienta znamenají něco jiného.
 */
export function restoreSession(
  snapshot: SessionSnapshot,
  options: { readonly now?: () => string;readonly eventLog?:import('./events').EventLogCheckpoint } = {},
): GenerationSession {
  return build({
    sessionId: snapshot.sessionId,
    sessionSeed: snapshot.sessionSeed,
    phase: snapshot.phase,
    quality: snapshot.quality,
    representations: snapshot.representations,
    cache: restoreMeshCache(snapshot.cache, snapshot.sessionSeed),
    log: createEventLog(snapshot.sessionId, { now: options.now, startAt: snapshot.sequence,checkpoint:options.eventLog }),
  });
}
