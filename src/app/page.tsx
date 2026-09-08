'use client';

/**
 * Hlavní cesta: relace dodá blueprint, ProxyWorld nese podobu a jediný
 * runtime controller spouští jeho sim. Renderer nevlastní hodiny ani engine.
 * Změna vzhledu zachová controller; nová relace založí nový běh.
 * Certifikační witness se za návštěvníka automaticky nepřehrává.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';

import ChangePreview, { type ChangeState } from '@/components/worldstream/ChangePreview';
import WorldStatus, { type WorldStatusState } from '@/components/worldstream/WorldStatus';
import WorldstreamApp from '@/components/worldstream/WorldstreamApp';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import {
  commitChange,
  followSession,
  openWorldstreamSession,
  readBlueprint,
  requestChange,
  type AuthoredProvenance,
  type SessionHandle,
} from '@/worldstream/client';
import {
  buildProxyWorldFrom,
  PROXY_RUNG_LABELS,
  type ProxyWorld,
} from '@/worldstream/proxy';
import { pickQualityTier, type QualityTier } from '@/worldstream/quality';
import { bindRuntime, type RuntimeBinding, type RuntimeController } from '@/worldstream/runtime-controller';
import { buildRuntimeWorld } from '@/ir/build';
import { canonical } from '@/ir/worlddoc';
import { prepareBranch, compareAcceptedBranch, type PreparedBranch } from '@/worldstream/accepted-branch';
import { MAX_COMPARISON_TICK, type BranchComparison as Comparison } from '@/worldstream/branch-controller';
import BranchComparison from '@/components/worldstream/BranchComparison';
import RuntimeInteraction from '@/components/worldstream/RuntimeInteraction';
import SourcePanel, { type SourceGeneration } from '@/components/worldstream/SourcePanel';
import type { ProjectRevision } from '@/worldstream/evidence-commit';
import { sourceProxy } from '@/worldstream/source-view';
import { createRuntimeController } from '@/worldstream/runtime-controller';
import { createClock, pump } from '@/sim/clock';
import type { WorldDoc } from '@/ir/worlddoc';
import { blueprintSchema } from '@/worldstream/schema';

// `ssr: false` je povinné, ne kosmetické — WebGL2 kontext na serveru
// neexistuje a `<Canvas>` by při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), {
  ssr: false,
});

/**
 * Věta, kterou porotce uvidí, když relace skončí bez světa a bez důvodu.
 *
 * Text poruchy ze serveru je **veřejná věta** (`SESSION_FAULTS`), ne výjimka
 * poskytovatele — do proudu se nic jiného nedostane. Když ani ta nedorazí,
 * zbude tahle: relace skončila a svět nevznikl, což je celá pravda, kterou
 * v tu chvíli známe.
 */
const UNKNOWN_FAULT = 'the session ended without a world';

/** Co z relace vyleze: buď blueprint, nebo věta, proč žádný nebude. */
type Arrival = { readonly blueprint: unknown } | { readonly fault: string };

/**
 * Hotové dějství II — **svět a adresa jeho relace, nerozdělitelně**.
 *
 * Ta dvojice je celý důvod, proč to je typ a ne dvě proměnné: svět bez své
 * relace by druhé větě ukazoval na relaci dějství I, tedy na jiný svět, než
 * jaký je na plátně.
 */
interface SecondAct {
  readonly world: ProxyWorld;
  readonly sessionId: string;
  readonly document: WorldDoc;
}

/**
 * První blueprint z relace — **ne její konec**.
 *
 * `followSession()` se vrátí až na koncové fázi, jenže `advance('complete')`
 * nemá v provozu volajícího (`sessions.ts`): relace zůstává po `world.ready`
 * otevřená, aby do ní mohla přijít druhá věta a hlášení o mešovaných tvarech
 * (§21). Čekat na její konec by tedy znamenalo čekat navždy — naměřeno
 * 6. 9. 2026, stavová věta stála na `building` devadesát vteřin.
 *
 * Čte se proto `onState`: jakmile proud donese blueprint, je co stavět.
 * Proud se přitom **nezavírá** — běží dál pod rukou, protože další rámce téže
 * relace patří téhle stránce. Zavře ho až druhá věta nebo odchod.
 *
 * Slib se plní **právě jednou**; `then` níž je proto druhá větev, ne návazný
 * krok: relace, která skončila bez blueprintu, musí umět vydat svoji větu.
 */
function firstBlueprint(
  handle: SessionHandle,
  signal: AbortSignal,
): Promise<Arrival> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (arrival: Arrival): void => {
      if (settled) return;
      settled = true;
      resolve(arrival);
    };

    void followSession(handle, {
      signal,
      onState: (state) => {
        if (state.blueprint !== null) done({ blueprint: state.blueprint });
      },
    })
      .then((final) => done({ fault: final.fault ?? UNKNOWN_FAULT }))
      .catch((error: unknown) =>
        done({ fault: error instanceof Error ? error.message : String(error) }),
      );
  });
}

export default function Page() {
  const [sourceProject, setSourceProject] = useState<ProjectRevision | null>(null);
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const sourceRuntimes = useRef(new Map<ProjectRevision, RuntimeController>());
  const binding = useRef<RuntimeBinding | null>(null);
  const documentRef = useRef<WorldDoc | null>(null);
  const previewBranch = useRef<PreparedBranch | null>(null);
  const [comparison, setComparison] = useState<{ result: Comparison; world: ProxyWorld; source: RuntimeController; changedWorld: ProxyWorld } | null>(null);
  const [viewOriginal, setViewOriginal] = useState(false);
  const [comparisonNote, setComparisonNote] = useState<string | null>(null);
  const [forkTick, setForkTick] = useState(0);
  const [observationTick, setObservationTick] = useState(0);
  const [controller, setController] = useState<RuntimeController | null>(null);
  const installRuntime = useCallback((id: string, document: WorldDoc) => {
    setSourceProject(null);
    const next = bindRuntime(binding.current, id, document);
    binding.current = next;
    documentRef.current = document;
    previewBranch.current = null;
    setComparison(null);
    setViewOriginal(false);
    setComparisonNote(null);
    setController(next.controller);
  }, []);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  /** Běží relace? Rozhoduje o stavové větě i o zamčeném tlačítku. */
  const [streaming, setStreaming] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  /**
   * Odkud je svět na plátně. `null` znamená „napsal ho model teď".
   *
   * Přepisuje se **až se světem**, ne při odeslání věty: dokud stará scéna
   * stojí, platí o ní starý popisek. Kdyby se nuloval dřív, produkt by během
   * generace jednu vteřinu tvrdil, že přehrávaný svět je čerstvý.
   */
  const [provenance, setProvenance] = useState<AuthoredProvenance | null>(null);
  const [sentence, setSentence] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const toggleInspect = useCallback(() => setInspecting((was) => !was), []);

  /* ---------------------------------------------------------------- *
   * Dějství III: druhá věta (`T35-actsthree4`).
   * ---------------------------------------------------------------- */

  /**
   * Relace, do které se druhá věta posílá. `null` znamená „zatím není co měnit".
   *
   * Drží se **relace, ne svět**: preview i commit jsou dvoje dveře jedné relace
   * a obojí potřebuje její id. Svět na plátně je až její výsledek.
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [second, setSecond] = useState('');
  const [change, setChange] = useState<ChangeState | null>(null);
  /** Odkud je plán změny. `null` znamená „napsal ho model teď". */
  const [changeFrom, setChangeFrom] = useState<AuthoredProvenance | null>(null);
  /** Běží preview nebo commit? Dvojklik by jinak poslal dvě žádosti. */
  const [changing, setChanging] = useState(false);

  /* ---------------------------------------------------------------- *
   * Dějství II: model píše svou verzi (`T14r-acttwo`).
   * ---------------------------------------------------------------- */

  /**
   * Hotový svět dějství II, který **čeká na svolení**. `null` znamená „není co
   * nabízet" — buď dějství II neběželo, nebo se svět vyměnil sám.
   */
  const [offer, setOffer] = useState<SecondAct | null>(null);
  /**
   * Píše model svou verzi právě teď?
   *
   * Zapíná se **až když relace dějství II doopravdy vznikla**, ne při odeslání
   * věty. Na nasazení bez modelu ty dveře odmítnou (`LIVE_UNAVAILABLE`) a věta
   * o píšícím modelu se tam tím pádem neobjeví ani na okamžik — je to jediný
   * způsob, jak ten popisek nemůže lhát.
   */
  const [writing, setWriting] = useState(false);
  /**
   * Sáhl porotce do světa, který má na plátně?
   *
   * **Ref, ne `useState`, a je to celý důvod, proč to funguje:** čte se to až ve
   * chvíli, kdy dějství II dorazí, tedy o minuty později než se ta uzávěra
   * vyrobila. Hodnota ze `useState` by v ní byla ta, která platila při odeslání
   * věty — tedy vždycky `false` — a hotový svět by porotci přepsal jeho změnu
   * přesně v tom případě, kvůli kterému tahle větev existuje.
   */
  const committed = useRef(false);
  /** Čtení relace dějství II. Nová věta ho ruší stejně jako to první. */
  const secondReading = useRef<AbortController | null>(null);
  /**
   * **Které dějství platí.** Zvyšuje se při nové větě a při každé výměně světa.
   *
   * ⚠ **Bez tohohle čísla se dá vyrobit rozpor, který vypadá správně** — nález
   * nezávislé revize commitu `b0b95da`, ověřený čtením. `plan()` i `apply()`
   * si při vzniku zapamatují `sessionId` z toho vykreslení a čekají vteřiny na
   * model. Dějství II se do toho okna vejde: vymění svět i adresu relace, a
   * doběhlá půlka staré operace pak zapíše svůj výsledek přes něj. Na plátně
   * zůstane svět jedné relace, v poli druhé věty adresa druhé a popisek původu
   * třetí pravda.
   *
   * Ref, ne stav: čte se to až za `await`em, tedy o vteřiny později, než se
   * uzávěra vyrobila.
   */
  const generation = useRef(0);

  /**
   * Meshovací klient. **Jeden na celou stránku**, ne jeden na relaci: worker
   * stojí start a druhá věta by ho zaplatila znovu. Zavírá se s odchodem
   * ze stránky.
   */
  const mesher = useRef<MeshClient | null>(null);
  /** Čtení právě běžící relace. Nová věta to předchozí zruší. */
  const reading = useRef<AbortController | null>(null);
  /** Úroveň kvality. Čte se jednou, po připojení — sahá na `document`. */
  const tier = useRef<QualityTier>('full');

  useEffect(() => {
    const client = createMeshClient();
    mesher.current = client;
    tier.current = pickQualityTier(window.location.search);

    return () => {
      reading.current?.abort();
      secondReading.current?.abort();
      mesher.current = null;
      client.dispose();
    };
  }, []);

  /**
   * **Přepnutí na svět dějství II — naráz, nebo vůbec.**
   *
   * Svět, adresa relace a popisek původu jsou jedno tvrzení ve třech
   * proměnných. Kdyby se přepnul jen svět, ukazovalo by pole druhé věty pořád
   * na relaci dějství I (commit by skončil na cizím světě) a popisek by o světě
   * od modelu tvrdil, že je ze skladu. React ty zápisy z jedné funkce dávkuje,
   * takže je vidí jedno vykreslení.
   *
   * `setProvenance(null)` je tady to podstatné slovo: `null` znamená „napsal ho
   * model teď", což je poprvé v celém produktu pravda.
   */
  const adopt = useCallback((next: SecondAct): void => {
    setSourceEpoch(value => value + 1);
    // **První řádek, ne poslední.** Od téhle chvíle je všechno rozdělané z té
    // předchozí relace neplatné, a poznají to podle tohohle čísla.
    installRuntime(next.sessionId, next.document);
    generation.current += 1;
    setWorld(next.world);
    setSessionId(next.sessionId);
    setProvenance(null);
    // Plán změny patřil relaci dějství I. Ta zůstala stát na serveru, ale
    // `changeId` z ní se do nové relace poslat nedá — commit by byl 404.
    setChange(null);
    setChangeFrom(null);
    setSecond('');
    setOffer(null);
    setWriting(false);
    // Rozdělaná operace staré relace svůj `finally` zahodí, takže odemknout
    // panel musí výměna sama — jinak by tlačítka zůstala zamčená navždy.
    setChanging(false);
    committed.current = false;
  }, [installRuntime]);

  /**
   * **Dějství II: druhá relace, vlastní placený slot, nabídnutý výsledek.**
   *
   * Běží jedině nad uvařeným světem — když první větu psal model, není co
   * dohánět. Odsud dál se nesahá na nic z dějství I: jiná relace znamená, že
   * blueprint ani commit porotce nemá tahle větev jak přepsat, a to je
   * konstrukce, ne hlídání (debata Opus ↔ Codex 7. 9. 2026, nález F2).
   *
   * **Spadlé dějství II nemění na plátně nic** — žádná porucha, žádné prázdno.
   * Porotce má na plátně svět z dějství I a ten platí dál.
   */
  const runSecondAct = useCallback(
    async (prompt: string): Promise<void> => {
      const control = new AbortController();
      secondReading.current = control;

      try {
        const handle = await openWorldstreamSession(prompt, {
          signal: control.signal,
          live: true,
        });
        if (control.signal.aborted) return;
        setWriting(true);

        const arrival = await firstBlueprint(handle, control.signal);
        if (control.signal.aborted || !('blueprint' in arrival)) return;

        const parsed = blueprintSchema.safeParse(arrival.blueprint);
        if (!parsed.success) return;

        const client = mesher.current;
        if (client === null) return;
        const built = await buildProxyWorldFrom(parsed.data, {
          mesh: (order) => client.mesh(order),
          quality: tier.current,
        });
        if (control.signal.aborted || built.kind !== 'built') return;

        // **Tady se rozhoduje, jestli je to výměna, nebo nabídka.** Automaticky
        // přepsat svět, do kterého porotce zasáhl, nemá žádné produktové
        // odůvodnění; dokud nezasáhl, je výměna to, co chtěl.
        const next: SecondAct = { world: built, sessionId: handle.sessionId, document: parsed.data.world };
        if (committed.current || (binding.current?.controller.getInputLog().length ?? 0) > 0) setOffer(next);
        else adopt(next);
      } catch {
        // Odmítnuté dveře i spadlá relace končí stejně: mlčením.
      } finally {
        if (!control.signal.aborted) setWriting(false);
      }
    },
    [adopt],
  );

  const submit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      const prompt = sentence.trim();
      if (prompt === '' || streaming) return;
      setSourceEpoch(value => value + 1);
      setSourceProject(null);
      sourceRuntimes.current.clear();

      // Předchozí čtení se ruší **před** otevřením nové relace, aby dva proudy
      // nepsaly do jednoho stavu. Relaci to na serveru neruší, jen ji přestaneme
      // poslouchat.
      reading.current?.abort();
      // Dějství II staré věty by doneslo svět k větě, která už na plátně není.
      secondReading.current?.abort();
      const control = new AbortController();
      reading.current = control;

      setStreaming(true);
      setFault(null);
      setWorld(null);
      binding.current = null;
      documentRef.current = null;
      previewBranch.current = null;
      setComparison(null);
      setViewOriginal(false);
      setComparisonNote(null);
      setController(null);
      // Nová věta zakládá **novou** relaci, takže po té staré nesmí zůstat ani
      // rozdělaný plán změny, ani její adresa: commit do zavřené relace by
      // skončil 404 a panel by mezitím tvrdil, že se pořád o něčem rozhoduje.
      setSessionId(null);
      setChange(null);
      setChangeFrom(null);
      setOffer(null);
      setWriting(false);
      generation.current += 1;
      committed.current = false;
      // Odpověď staré relace už svým finally ovládání neodemkne.
      // Nový svět proto začíná bez zámku jejího preview nebo commitu.
      setChanging(false);

      try {
        const handle = await openWorldstreamSession(prompt, { signal: control.signal });
        const arrival = await firstBlueprint(handle, control.signal);
        if (control.signal.aborted) return;

        if (!('blueprint' in arrival)) {
          setFault(arrival.fault);
          return;
        }

        // Server blueprint validoval taky. Čte se podruhé, protože mezi tím je
        // síť a `unknown` — bez toho by se dovnitř dostal objekt, o kterém
        // překladač jen věří, že má správný tvar.
        const parsed = blueprintSchema.safeParse(arrival.blueprint);
        if (!parsed.success) {
          setFault(`the world that arrived does not parse: ${parsed.error.issues[0]?.message ?? '?'}`);
          return;
        }

        const client = mesher.current;
        if (client === null) return;
        const built = await buildProxyWorldFrom(parsed.data, {
          mesh: (order) => client.mesh(order),
          quality: tier.current,
        });
        if (control.signal.aborted) return;

        // Odmítnutý svět není svět. Věta o něm je ta, kterou napsal
        // `buildProxyWorldFrom()` — ta ví, na čem stavba ztroskotala.
        if (built.kind === 'built') {
          installRuntime(handle.sessionId, parsed.data.world);
          setWorld(built);
          setProvenance(handle.authored);
          setSessionId(handle.sessionId);
          // **Dějství II začíná jedině nad uvařeným světem.** `authored === null`
          // znamená, že tenhle svět napsal model — druhá relace by pak psala
          // podruhé totéž a platilo by se to dvakrát.
          if (handle.authored !== null) void runSecondAct(prompt);
        } else setFault(built.reason);
      } catch (error: unknown) {
        if (control.signal.aborted) return;
        setFault(error instanceof Error ? error.message : String(error));
      } finally {
        if (!control.signal.aborted) setStreaming(false);
      }
    },
    [installRuntime, runSecondAct, sentence, streaming],
  );

  /**
   * Druhá věta → **plán, ne změna**. Design book §4 dějství III: rozsah se
   * ukáže dřív, než se cokoli změní.
   *
   * `stableId` má přednost před textem, a je to celý smysl nabídky kandidátů:
   * když porotce na objekt ukázal, o cíli rozhodl on, ne rozpoznávač. Grounding
   * je přitom na serveru **před** modelem, takže nejasná věta nestojí nic.
   */
  const plan = useCallback(
    async (stableId?: string): Promise<void> => {
      const prompt = second.trim();
      // The pilot retains one intervention. Chaining edits would require a
      // revisioned history of rule sets before each fork, not just an input log.
      if (sessionId === null || prompt === '' || changing || comparison !== null) return;
      const signal = reading.current?.signal;
      // Známka relace, do které se tenhle plán posílá. Za `await`em už nemusí
      // platit — viz `generation`.
      const era = generation.current;

      setChanging(true);
      previewBranch.current = null;
      try {
        const prepared = documentRef.current && binding.current
          ? prepareBranch(documentRef.current, binding.current.controller) : null;
        const outcome = await requestChange(sessionId, prompt, {
          ...(signal === undefined ? {} : { signal }),
          ...(stableId === undefined ? {} : { stableId }),
        });
        // **Plán patří relaci, která už není na plátně.** `changeId` z ní se do
        // té nové poslat nedá, takže ukázat ho znamená nabídnout tlačítko,
        // které skončí 404 nad světem, o kterém porotce nic neví.
        if (era !== generation.current) return;

        if (outcome.kind === 'ambiguous') {
          setChange({
            kind: 'candidates',
            reason: outcome.reason,
            candidates: outcome.candidates,
          });
          setChangeFrom(null);
          return;
        }
        if (outcome.kind === 'refused') {
          setChange({ kind: 'refused', message: outcome.detail });
          setChangeFrom(null);
          return;
        }

        previewBranch.current = prepared;
        setForkTick(0);
        setObservationTick(Math.min(MAX_COMPARISON_TICK, prepared?.source.getSnapshot().observationTick ?? 0));
        setChange({
          kind: 'preview',
          changeId: outcome.changeId,
          summary: outcome.summary,
          target: outcome.target,
          scope: outcome.scope,
          preserved: outcome.preserved,
        });
        setChangeFrom(outcome.authored);
      } catch (error: unknown) {
        if (era !== generation.current) return;
        setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
        setChangeFrom(null);
      } finally {
        if (era === generation.current) setChanging(false);
      }
    },
    [second, sessionId, changing, comparison],
  );

  /**
   * Potvrzení plánu — **jediné místo, kde se svět mění**.
   *
   * Nový svět se čte ze snapshotu relace, ne z odpovědi commitu: autoritativní
   * stav je snapshot (§21), takže druhá kopie světa v odpovědi by byla druhá
   * pravda. Stavba pak jde toutéž cestou jako po první větě — `blueprintSchema`
   * podruhé, `buildProxyWorldFrom()`, plátno.
   */
  const apply = useCallback(async (): Promise<void> => {
    if (sessionId === null || change === null || change.kind !== 'preview' || changing) return;
    const client = mesher.current;
    if (client === null) return;
    const signal = reading.current?.signal;
    const era = generation.current;
    const prepared = previewBranch.current;
    const behavior = change.scope.behavior > 0;
    if (behavior && prepared && prepared.base.inputCount !== prepared.source.getInputLog().length) {
      setChange({ kind: 'refused', message: 'Visitor inputs changed after the preview. Request the change again.' });
      return;
    }
    if (behavior && (!Number.isSafeInteger(forkTick) || !Number.isSafeInteger(observationTick)
      || forkTick < 0 || observationTick < forkTick || observationTick > MAX_COMPARISON_TICK)) {
      setChange({ kind: 'refused', message: 'Choose an observation tick after the fork, between 0 and 12000.' });
      return;
    }

    setChanging(true);
    // **Před voláním, ne po něm** — nález nezávislé revize commitu `b0b95da`.
    // Commit trvá vteřiny a dějství II se do toho okna vejde; kdyby se tahle
    // vlajka zvedala až za ním, hotový svět by porotci právě rozdělanou změnu
    // přepsal — tedy přesně v tom jediném případě, kvůli kterému existuje.
    //
    // **Odmítnutý commit ji nesnižuje**, a je to rozhodnutí, ne opomenutí:
    // porotce do tohohle světa sáhl, ať mu server odpověděl jakkoli, takže
    // hotové dějství II se odsud dál jen nabízí. Jeden klik ho pořád vydá.
    committed.current = true;
    try {
      const done = await commitChange(sessionId, change.changeId, {
        ...(signal === undefined ? {} : { signal }),
      });
      // Svět se pod tímhle commitem mohl vyměnit. Zapsat jeho výsledek by
      // znamenalo postavit na plátno svět jedné relace a do pole druhé věty
      // adresu druhé.
      if (era !== generation.current) return;
      if (done.kind === 'refused') {
        setChange({ kind: 'refused', message: done.detail });
        return;
      }

      const parsed = blueprintSchema.safeParse(
        await readBlueprint(sessionId, { ...(signal === undefined ? {} : { signal }) }),
      );
      if (era !== generation.current) return;
      if (!parsed.success) {
        setChange({ kind: 'refused', message: 'the changed world does not parse' });
        return;
      }

      const built = await buildProxyWorldFrom(parsed.data, {
        mesh: (order) => client.mesh(order),
        quality: tier.current,
      });
      if (era !== generation.current) return;
      if (built.kind !== 'built') {
        setChange({ kind: 'refused', message: built.reason });
        return;
      }

      const compared = behavior && prepared
        ? compareAcceptedBranch(prepared, parsed.data.world, { forkTick, observationTick }) : null;
      if (compared?.verdict === 'COMPARED' && world) {
        const result = compared.snapshot.comparison!;
        const runtime = buildRuntimeWorld(parsed.data.world.sim);
        if (!runtime.ok) throw new Error('The accepted branch cannot run.');
        const fork = prepared!.source.forkAt(runtime.world, result.forkTick, result.observationTick);
        if (fork.verdict !== 'REBRANCHED') throw new Error(fork.detail);
        const next = fork.controller;
        next.setPaused(true);
        prepared!.source.setPaused(true);
        binding.current = { sessionId, simulation: canonical(parsed.data.world.sim), controller: next };
        documentRef.current = parsed.data.world;
        setController(next);
        setComparison({ result, world, source: prepared!.source, changedWorld: built });
        setViewOriginal(false);
        setComparisonNote(null);
      } else {
        installRuntime(sessionId, parsed.data.world);
        if (compared?.verdict === 'REJECTED') setComparisonNote(`Change accepted. Comparison unavailable: ${compared.detail}`);
      }
      previewBranch.current = null;
      setWorld(built);
      setChange(null);
      setChangeFrom(null);
      setSecond('');
    } catch (error: unknown) {
      if (era !== generation.current) return;
      setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (era === generation.current) setChanging(false);
    }
  }, [change, changing, installRuntime, sessionId, world, forkTick, observationTick]);

  /** Zahození plánu. Sahá **jen** na panel — svět ani revize se nehnou. */
  const discard = useCallback(() => {
    previewBranch.current = null;
    setChange(null);
    setChangeFrom(null);
  }, []);

  // Pořadí je pořadí pravdy: porucha přebíjí běžící relaci, protože relace
  // skončila; běžící relace přebíjí prázdno, protože se něco děje.
  const status: WorldStatusState =
    fault !== null ? 'broken' : streaming ? 'building' : world === null ? 'empty' : 'live';

  function acceptSource(project: ProjectRevision, _generation: SourceGeneration) {
    let next = sourceRuntimes.current.get(project);
    const built = buildRuntimeWorld(project.world.sim);
    if (!built.ok) throw new Error('The source world cannot run.');
    if (!next) {
      if (project.parent && project.comparison) {
        const original = sourceRuntimes.current.get(project.parent);
        if (!original) throw new Error('Original source branch is unavailable.');
        const fork = original.forkAt(built.world, project.comparison.forkTick, project.comparison.observationTick);
        if (fork.verdict !== 'REBRANCHED') throw new Error(fork.detail);
        original.setPaused(true);
        next = fork.controller;
        next.setPaused(true);
      } else {
        next = createRuntimeController({ ...built.world, trace: [] });
        sourceRuntimes.current.clear();
      }
      sourceRuntimes.current.set(project, next);
    }
    controller?.setPaused(true);
    reading.current?.abort(); secondReading.current?.abort();
    generation.current++;
    binding.current = { sessionId: project.projectRevision, simulation: canonical(project.world.sim), controller: next };
    documentRef.current = project.world;
    previewBranch.current = null;
    setWorld(sourceProxy(project.world, project.sources[0]?.title ?? 'Source scenario'));
    setController(next); setSourceProject(project);
    setSessionId(null); setComparison(null); setViewOriginal(false); setComparisonNote(null);
    setChange(null); setChangeFrom(null); setOffer(null); setWriting(false);
    setStreaming(false); setChanging(false); setFault(null); setProvenance(null);
  }

  return (
    <WorldstreamApp
      inspecting={inspecting}
      onInspect={toggleInspect}
      prompt={
        <>
        <form onSubmit={(event) => void submit(event)} data-testid="prompt-form" style={FORM}>
          <input
            data-testid="prompt-input"
            aria-label="Describe a place"
            placeholder="a drowned cathedral lit from below"
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
            style={INPUT}
          />
          <button type="submit" data-testid="prompt-submit" disabled={streaming} style={BUTTON}>
            {streaming ? 'Building…' : 'Build the world'}
          </button>
        </form>
        <SourcePanel project={sourceProject} controller={controller} epoch={sourceEpoch} disabled={streaming || changing}
          onBegin={() => { committed.current = true; }}
          onAccept={acceptSource} />
        </>
      }
      status={<WorldStatus state={status} detail={fault} />}
      provenance={
        <>
          <AuthoredNotice provenance={world === null ? null : provenance} />
          {writing ? (
            <p className="ws-provenance" data-testid="second-act-writing">
              The model is writing its own version of this world.
            </p>
          ) : null}
          {offer === null ? null : (
            <SecondActOffer onShow={() => adopt(offer)} onKeep={() => setOffer(null)} />
          )}
        </>
      }
      change={
        sessionId === null || world === null ? null : (
          <>
            {change === null ? null : (
              <ChangePreview
                state={change}
                onChoose={(stableId) => void plan(stableId)}
                onApply={() => void apply()}
                onDiscard={discard}
                busy={changing}
              />
            )}
            <AuthoredChangeNotice provenance={change === null ? null : changeFrom} />
            {change?.kind === 'preview' && change.scope.behavior > 0 && <fieldset style={{ ...FACTS, maxWidth: 'none' }}>
              <legend>Compare the same visitor inputs</legend>
              <label>Fork tick <input data-testid="branch-fork-input" type="number" min={0} max={MAX_COMPARISON_TICK}
                value={forkTick} disabled={changing} onChange={e => setForkTick(e.target.valueAsNumber)} /></label>
              <label>Observation tick <input data-testid="branch-observation-input" type="number" min={forkTick} max={MAX_COMPARISON_TICK}
                value={observationTick} disabled={changing} onChange={e => setObservationTick(e.target.valueAsNumber)} /></label>
              <p>Fork before the timer starts. Both branches replay your recorded actions.</p>
            </fieldset>}
            {comparisonNote && <p role="status" data-testid="branch-note" style={FACTS}>{comparisonNote}</p>}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void plan();
              }}
              data-testid="refine-form"
              style={FORM}
            >
              <input
                data-testid="refine-input"
                aria-label="Change one thing in this world"
                placeholder="paint the containers rust red"
                value={second}
                onChange={(event) => setSecond(event.target.value)}
                style={INPUT}
              />
              <button type="submit" data-testid="refine-submit" disabled={changing || comparison !== null} style={BUTTON}>
                {changing ? 'Working…' : 'Change it'}
              </button>
            </form>
          </>
        )
      }
      axis={<div style={{ maxHeight: '48dvh', overflow: 'auto' }}>
        {comparison && <BranchComparison comparison={comparison.result} original={viewOriginal} busy={changing}
          onOriginal={() => {
            binding.current?.controller.setPaused(true);
            setController(comparison.source);
            setWorld(comparison.world);
            setViewOriginal(true);
            setChange(null);
            setChangeFrom(null);
            previewBranch.current = null;
          }}
          onChanged={() => {
            comparison.source.setPaused(true);
            setController(binding.current!.controller);
            setWorld(comparison.changedWorld);
            setViewOriginal(false);
          }} />}
        {controller === null ? null : <RuntimeControls controller={controller} />}
      </div>}
      inspect={<><WorldFacts world={world} />{world && !sourceProject && <p style={FACTS} data-testid="no-source-evidence">
        No source evidence is attached to this world. A prompt alone is not a citation.
      </p>}</>}
      stage={<WorldstreamCanvas world={world} controller={controller} />}
    />
  );
}

/**
 * „Tenhle svět jsem uměl dopředu" — **nahlas, anglicky, na obrazovce**
 * (`T45-honestlabel`).
 *
 * Model se pro tohle demo nekupuje (`G2`, 5. 9. 2026), takže neznámou větu
 * obslouží nejbližší svět ze skladu uvařeného dopředu. Bez téhle věty by
 * produkt tvrdil, že tuhle větu napsal model teď — a je to nepravda, kterou
 * porotce odhalí druhou větou, protože dvě různé věty dostanou tentýž svět.
 * **Poctivost je tady levnější než iluze.**
 *
 * Mlčí se **jedině tehdy, když svět napsal model** (`provenance` je `null`).
 *
 * ⚠ **Do 7. 9. 2026 se mlčelo i u přesné shody a od `T14r-actone` je to
 * nepravda.** Tehdy platilo „nic se nenahrazovalo, není co přiznávat": sklad
 * uměl právě tuhle větu, takže odpověď byla její. Od `T14r-actone` ale uvařený
 * svět vydávají i dveře, na které nevyšel placený slot, takže přesná shoda
 * přestala znamenat „sklad tuhle větu uměl" a začala znamenat „tenhle svět je
 * uložený". Uložený svět bez popisku je tvrzení, že ho model napsal teď.
 * **Rozhodla debata Opus ↔ Codex 7. 9. 2026**, `.claude/debate/worldstream-twoacts-decision.md`.
 *
 * Dvě věty, protože „nejbližší" a „přesně tenhle" jsou dvě různé pravdy a
 * jedna společná by musela lhát u jedné z nich.
 *
 * Text jmenuje, co se stalo, a neomlouvá se. Omluva by z poctivosti udělala
 * vadu; tohle je vlastnost.
 */
function AuthoredNotice({
  provenance,
}: {
  readonly provenance: AuthoredProvenance | null;
}) {
  if (provenance === null) return null;

  return (
    <p className="ws-provenance" data-testid="world-authored">
      {provenance.match === 'exact'
        ? 'This world was authored ahead of time.'
        : 'This is the closest world authored ahead of time.'}
    </p>
  );
}

/**
 * **Hotové dějství II se nabízí, když porotce do světa zasáhl** (`T14r-acttwo`).
 *
 * Dokud necommitnul žádnou změnu, se svět vymění sám a tahle komponenta se
 * nevykreslí vůbec. Jakmile commitnul, je na plátně něco, co udělal on — a
 * přepsat to bez zeptání nemá žádné produktové odůvodnění (odpověď na
 * Codexovu otázku č. 1, debata 7. 9. 2026).
 *
 * ⚠ **Nesmí nést `.ws-provenance`, i když sedí na témž místě v doku.** Ta třída
 * má `pointer-events: none`, protože je to sdělení; tohle jsou dvě tlačítka a
 * pod tou třídou by se nedala zmáčknout.
 *
 * Věta říká, co se stane, protože obojí je nevratné: „Show it" zahodí změnu,
 * kterou porotce udělal, „Keep this one" zahodí svět, za který se zaplatilo.
 */
function SecondActOffer({
  onShow,
  onKeep,
}: {
  readonly onShow: () => void;
  readonly onKeep: () => void;
}) {
  return (
    <div data-testid="second-act-offer" style={OFFER}>
      <span>The model wrote its own version. Showing it drops your change.</span>
      <button type="button" data-testid="second-act-show" onClick={onShow} style={BUTTON}>
        Show it
      </button>
      <button type="button" data-testid="second-act-keep" onClick={onKeep} style={BUTTON}>
        Keep this one
      </button>
    </div>
  );
}

/**
 * Totéž o **druhé** větě (`T35-actsthree4`).
 *
 * Je to samostatná komponenta, ne parametr té nad ní, protože říká jinou věc:
 * tam se přiznává původ **světa**, tady původ **plánu změny**. Jeden text pro
 * obojí by porotci nad změněným světem tvrdil, že je přehrávaný celý svět.
 *
 * Mlčí ze stejných dvou důvodů: změnu píše model (`null`), nebo věta trefila
 * uvařenou změnu **přesně** — tam se nic nenahrazovalo.
 */
function AuthoredChangeNotice({
  provenance,
}: {
  readonly provenance: AuthoredProvenance | null;
}) {
  if (provenance === null || provenance.match !== 'nearest') return null;

  return (
    <p className="ws-provenance" data-testid="change-authored">
      This is the closest change authored ahead of time.
    </p>
  );
}

/**
 * Co v tom světě doopravdy stojí — **jediný panel Inspectu na hlavní cestě**.
 *
 * Není to log a není to ozdoba: hrubý svět dává každému objektu příčku žebříku
 * (§27) a právě ta odpovídá na otázku „proč tenhle kus vypadá jako bedna?".
 * Bez ní je hlína němá a porotce ji čte jako vadu vykreslování.
 *
 * Pět panelů staré stránky (`Program`, `Timeline`, `WitnessPreview`,
 * `RepairRounds`, `ModelProgress`) sem **nejde**: stojí nad lokální emisí a
 * `WorldDocRuntime`, tedy nad systémem, který na `/classic` zůstal celý.
 */
function WorldFacts({ world }: { readonly world: ProxyWorld | null }) {
  if (world === null || world.kind !== 'built') return null;

  return (
    <section data-testid="world-facts" style={FACTS}>
      <h2 style={FACTS_TITLE}>{world.title}</h2>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {world.slots.map(({ slot, form }) => (
          <li key={slot.stableId} data-testid="world-facts-slot" data-rung={form.rung}>
            <strong>{slot.label}</strong> — {PROXY_RUNG_LABELS[form.rung]}
            {form.kind === 'clay' ? `: ${form.reason}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}

const FACTS: React.CSSProperties = {
  pointerEvents: 'auto',
  maxWidth: '26rem',
  padding: '0.6rem 0.75rem',
  borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.82)',
  color: '#cfe3e6',
  font: '12px/1.5 ui-monospace, monospace',
};

const FACTS_TITLE: React.CSSProperties = {
  margin: '0 0 0.4rem',
  font: 'inherit',
  color: '#7fd4c1',
};

const OFFER: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  // **Sdělení mlčí, nabídka se maká.** Sousední `.ws-provenance` má
  // `pointer-events: none`; tady by to tlačítka umrtvilo.
  pointerEvents: 'auto',
  padding: '0.4rem 0.2rem',
  color: '#cfe3e6',
  font: '12px/1.5 ui-monospace, monospace',
};

const FORM: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  pointerEvents: 'auto',
};

const INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '0.55rem 0.75rem',
  border: '1px solid #2c4147',
  borderRadius: 4,
  background: 'rgba(11, 18, 20, 0.86)',
  color: '#cfe3e6',
  font: '14px/1.4 ui-monospace, monospace',
};

const BUTTON: React.CSSProperties = {
  padding: '0.55rem 1rem',
  border: '1px solid #2c4147',
  borderRadius: 4,
  background: '#132022',
  color: '#cfe3e6',
  cursor: 'pointer',
  font: '14px/1.4 ui-monospace, monospace',
};

/** Jediné živé hodiny. Pauza zahodí nástěnný zbytek, nikoli stav enginu. */
function RuntimeControls({ controller }: { readonly controller: RuntimeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (state.paused || state.endedAtTick !== null) return;
    const clock = createClock();
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const due = pump(clock, now - last);
      last = now;
      controller.advanceTicks(due);
    }, 50);
    return () => window.clearInterval(timer);
  }, [controller, state.paused, state.endedAtTick]);
  return (
    <section data-testid="runtime-controls" style={{ ...FACTS, maxWidth: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.65rem' }} aria-label="Simulation controls">
      <div data-testid="runtime-tick" data-tick={state.tick}>Tick {state.tick}</div>
      <div data-testid="runtime-state">{state.runState}</div>
      {state.endedAtTick !== null && <div>Ended at tick {state.endedAtTick}</div>}
      <div data-testid="runtime-observation">Observation tick {state.observationTick}</div>
      <button type="button" data-testid="runtime-pause" style={BUTTON}
        disabled={state.endedAtTick !== null}
        onClick={() => controller.setPaused(!state.paused)}>
        {state.paused ? 'Resume' : 'Pause'}
      </button>
      <RuntimeInteraction controller={controller} />
    </section>
  );
}
