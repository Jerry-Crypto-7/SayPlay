'use client';

/**
 * Hlavní cesta: relace dodá blueprint, ProxyWorld nese podobu a jediný
 * runtime controller spouští jeho sim. Renderer nevlastní hodiny ani engine.
 * Změna vzhledu zachová controller; nová relace založí nový běh.
 * Certifikační witness se za návštěvníka automaticky nepřehrává.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';

import ChangePreview, { type ChangeState } from '@/components/worldstream/ChangePreview';
import WorldStatus, { type WorldStatusState } from '@/components/worldstream/WorldStatus';
import WorldstreamApp from '@/components/worldstream/WorldstreamApp';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import { createCachedMeshClient } from '@/shape/mesh-cache';
import {
  commitChange,
  followSession,
  openWorldstreamSession,
  readBlueprint,
  requestChange,
  restoreComparison,
  type AuthoredProvenance,
  type SessionHandle,
} from '@/worldstream/client';
import type { ClientState } from '@/worldstream/reducer';
import {
  buildProxyWorldFrom,
  buildVisualPreviewFrom,
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
import type { EntityNames } from '@/worldstream/comparison-narration';
import RuntimeInteraction from '@/components/worldstream/RuntimeInteraction';
import SourcePanel, { type SourceGeneration } from '@/components/worldstream/SourcePanel';
import type { ProjectRevision } from '@/worldstream/evidence-commit';
import { sourceProxyFromRuntime } from '@/worldstream/source-view';
import { createRuntimeController } from '@/worldstream/runtime-controller';
import { createClock, pump } from '@/sim/clock';
import type { WorldDoc } from '@/ir/worlddoc';
import { blueprintSchema, visualPreviewSchema, type VisualPreview } from '@/worldstream/schema';
import { visibilityReport } from '@/scene/visibility-report';
import type { ShapeDetailAssessment } from '@/shape/detail-policy';
import { createPipelineMetrics, type PipelineMetricsSnapshot, type PipelineRunHandle, type PipelineStageHandle,
  type PipelineProvenance } from '@/worldstream/pipeline-metrics';

declare global { interface Window { __worldstreamMetrics?: { snapshot(): PipelineMetricsSnapshot } } }

// `ssr: false` je povinné, ne kosmetické — WebGL2 kontext na serveru
// neexistuje a `<Canvas>` by při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), {
  ssr: false,
});
const FutureViews = dynamic(() => import('@/components/worldstream/FutureViews'), { ssr: false });

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
  onIntent?: (intent: NonNullable<ClientState['intent']>) => void,
  onVisualPreview?: (preview:VisualPreview) => void,
): Promise<Arrival> {
  return new Promise((resolve) => {
    let settled = false;
    let lastPreview:VisualPreview|null=null;
    const done = (arrival: Arrival): void => {
      if (settled) return;
      settled = true;
      resolve(arrival);
    };

    void followSession(handle, {
      signal,
      onState: (state) => {
        // Planner odpoví desítky vteřin před compilerem; co přečetl, patří na
        // obrazovku hned, ne až se světem.
        if (state.intent !== null && !settled) onIntent?.(state.intent);
        if (!settled && !state.blueprint && state.visualPreview && state.visualPreview!==lastPreview) {
          lastPreview=state.visualPreview;onVisualPreview?.(state.visualPreview);
        }
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
  const [metrics] = useState(() => createPipelineMetrics());
  const activeMeasurement = useRef<PipelineRunHandle | null>(null);
  const editMeasurement = useRef<{ run: PipelineRunHandle; review: PipelineStageHandle | null } | null>(null);
  const [displayMeasurement, setDisplayMeasurement] = useState<{ run: PipelineRunHandle;
    frame: PipelineStageHandle | null; interaction: PipelineStageHandle | null; initialInputs: number; targetWorld?: ProxyWorld } | null>(null);
  const registerMeasurement = useCallback((run: PipelineRunHandle) => {
    activeMeasurement.current = run; setDisplayMeasurement(null);
  }, []);
  const measureDisplay = useCallback((run: PipelineRunHandle, provenance: PipelineProvenance, initialInputs = 0,
    waitForInteraction = true, targetWorld?: ProxyWorld) => {
    const comparison = metrics.snapshot().runs.find(entry => entry.runId === run.runId)?.stages.some(stage => stage.name === 'compare');
    setDisplayMeasurement({ run, initialInputs, targetWorld, frame: metrics.startStage(run, 'first-frame', provenance),
      interaction: comparison || !waitForInteraction ? null : metrics.startStage(run, 'first-interaction', provenance) });
  }, [metrics]);
  useEffect(() => {
    const probe = { snapshot: metrics.snapshot }; window.__worldstreamMetrics = probe;
    return () => { if (window.__worldstreamMetrics === probe) delete window.__worldstreamMetrics;
      if (activeMeasurement.current) metrics.finishRun(activeMeasurement.current, 'cancelled'); };
  }, [metrics]);
  const [sourceProject, setSourceProject] = useState<ProjectRevision | null>(null);
  const [sourceGeneration, setSourceGeneration] = useState<SourceGeneration>('live');
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const [cameraReset, setCameraReset] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [cutaway, setCutaway] = useState(true);
  /** Zastávky cesty, kterou naposledy našel průvodce. Prázdné, dokud se nikdo nezeptal. */
  const [routeHighlight, setRouteHighlight] = useState<readonly string[]>([]);
  const sourceRuntimes = useRef(new Map<ProjectRevision, RuntimeController>());
  const binding = useRef<RuntimeBinding | null>(null);
  const documentRef = useRef<WorldDoc | null>(null);
  const previewBranch = useRef<PreparedBranch | null>(null);
  const [comparison, setComparison] = useState<{ result: Comparison; world: ProxyWorld; source: RuntimeController; changedWorld: ProxyWorld; summary: string; names: EntityNames } | null>(null);
  const [viewOriginal, setViewOriginal] = useState(false);
  const [comparisonNote, setComparisonNote] = useState<string | null>(null);
  const [forkTick, setForkTick] = useState(0);
  const rewindChoice = useRef<{ tick: number; end: number } | null>(null);
  const [observationTick, setObservationTick] = useState(0);
  const [controller, setController] = useState<RuntimeController | null>(null);
  const [recovery, setRecovery] = useState<{ message: string; retry: () => Promise<void>; detailOnly?: boolean } | null>(null);
  const installRuntime = useCallback((id: string, document: WorldDoc) => {
    setRecovery(null);
    setSourceProject(null);
    const next = bindRuntime(binding.current, id, document);
    binding.current = next;
    documentRef.current = document;
    rewindChoice.current = null;
    previewBranch.current = null;
    setComparison(null);
    setFocusId(null);
    setViewOriginal(false);
    setComparisonNote(null);
    setController(next.controller);
  }, []);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [visualWorld,setVisualWorld]=useState<ProxyWorld|null>(null);
  const [visualStage,setVisualStage]=useState<VisualPreview['stage']>(undefined);
  const displayedWorld=world??visualWorld;
  // Keep the one-attempt inspection budget when the drawer closes/reopens.
  const visualRepairAttempts=useMemo(()=>new Set<string>(),[displayedWorld]);
  const presented = useCallback((paintedWorld: ProxyWorld) => {
    if (!displayMeasurement || paintedWorld !== (displayMeasurement.targetWorld ?? world)) return;
    metrics.finishStage(displayMeasurement.frame); metrics.finishRun(displayMeasurement.run);
  }, [world, displayMeasurement, metrics]);
  useEffect(() => {
    if (!controller || !displayMeasurement) return;
    const { run, interaction, initialInputs } = displayMeasurement;
    const observeInput = () => {
      const inputs = controller.getInputLog();
      const latest = inputs[inputs.length - 1];
      // Records a visitor input in a rule-firing step. A timeout may also fire
      // in that step; this is not independent proof that the input caused it.
      if (inputs.length > initialInputs && controller.getSnapshot().transitions.some(transition =>
        transition.tick === latest.tick && transition.inputs.length > 0 && transition.ruleIds.length > 0)) {
        metrics.finishStage(interaction); metrics.finishRun(run);
      }
    };
    const unsubscribe = controller.subscribe(observeInput); observeInput();
    return unsubscribe;
  }, [controller, displayMeasurement, metrics]);
  /** Běží relace? Rozhoduje o stavové větě i o zamčeném tlačítku. */
  const [streaming, setStreaming] = useState(false);
  /** Co planner z věty přečetl, dokud compiler píše; s novou větou i se světem se maže. */
  const [intent, setIntent] = useState<ClientState['intent']>(null);
  const [stopped, setStopped] = useState<string | null>(null);
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
  const [generationMode, setGenerationMode] = useState<'live' | 'prepared'>('live');
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
  /** Proč dějství II nedorazilo, když už porotce četl „is writing". `null` = není co hlásit. */
  const [secondActMiss, setSecondActMiss] = useState<string | null>(null);
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
  /** Pole na větu — příklad z prázdné scény ho vyplní a předá mu kurzor (P21 T10). */
  const promptInput = useRef<HTMLInputElement | null>(null);
  /** Úroveň kvality. Čte se jednou, po připojení — sahá na `document`. */
  const tier = useRef<QualityTier>('full');

  useEffect(() => {
    const client = createCachedMeshClient(createMeshClient());
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
    // The second session must not complete the first session's pending timings.
    if (activeMeasurement.current) metrics.finishRun(activeMeasurement.current, 'cancelled');
    setDisplayMeasurement(null);
    setStopped(null);
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
  }, [installRuntime, metrics]);

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
      setIntent(null);
      setStopped(null);
      setFault(null);
      setWorld(null);
      setVisualWorld(null);
      binding.current = null;
      documentRef.current = null;
      rewindChoice.current = null;
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
      setSecondActMiss(null);
      generation.current += 1;
      setRecovery(null);
      committed.current = false;
      // Odpověď staré relace už svým finally ovládání neodemkne.
      // Nový svět proto začíná bez zámku jejího preview nebo commitu.
      setChanging(false);

      const era = generation.current;
      const measured = metrics.startRun({ generation: era, kind: 'prompt' });
      registerMeasurement(measured);
      const requestTiming = metrics.startStage(measured, 'session-request');
      try {
        const handle = await openWorldstreamSession(prompt, { signal: control.signal, live: generationMode === 'live' });
        const origin = handle.authored ? 'prepared' : 'unknown';
        metrics.setRunProvenance(measured, origin);
        metrics.finishStage(requestTiming, 'completed', origin);
        const blueprintTiming = metrics.startStage(measured, 'blueprint-wait', origin);
        let previewVersion=0;
        const arrival = await firstBlueprint(handle, control.signal, (read) => {
          if (!control.signal.aborted) setIntent(read);
        }, (preview) => {
          const version=++previewVersion;
          const parsed=visualPreviewSchema.safeParse(preview),client=mesher.current;
          if(!parsed.success||!client)return;
          void buildVisualPreviewFrom(parsed.data,{mesh:order=>client.mesh(order,control.signal),quality:tier.current})
            .then(built=>{if(!control.signal.aborted&&era===generation.current&&version===previewVersion&&built.kind==='built'){setVisualStage(parsed.data.stage);setVisualWorld(built);}})
            .catch(()=>{/* The rejected simulation stays rejected if its optional visual preview also fails. */});
        });
        metrics.finishStage(blueprintTiming, 'blueprint' in arrival ? 'completed' : 'failed');
        if (control.signal.aborted) return;

        if (!('blueprint' in arrival)) {
          metrics.finishRun(measured, 'failed');
          setFault(arrival.fault);
          return;
        }
        previewVersion++;setVisualWorld(null);

        // Server blueprint validoval taky. Čte se podruhé, protože mezi tím je
        // síť a `unknown` — bez toho by se dovnitř dostal objekt, o kterém
        // překladač jen věří, že má správný tvar.
        const validationTiming = metrics.startStage(measured, 'validation', origin);
        const parsed = blueprintSchema.safeParse(arrival.blueprint);
        metrics.finishStage(validationTiming, parsed.success ? 'completed' : 'failed');
        if (!parsed.success) {
          metrics.finishRun(measured, 'failed');
          setFault(`the world that arrived does not parse: ${parsed.error.issues[0]?.message ?? '?'}`);
          return;
        }

        const client = mesher.current;
        if (client === null) { metrics.finishRun(measured, 'failed'); return; }
        const coarseTiming = metrics.startStage(measured, 'coarse-build', origin);
        const coarse = await buildProxyWorldFrom(parsed.data, {
          mesh: (order) => client.mesh(order, control.signal), quality: tier.current, deferMeshes: true,
        });
        if (control.signal.aborted || era !== generation.current) return;
        metrics.finishStage(coarseTiming, coarse.kind === 'built' ? 'completed' : 'failed');
        if (coarse.kind !== 'built') { metrics.finishRun(measured, 'failed'); setFault(coarse.reason); return; }
        const loweringTiming = metrics.startStage(measured, 'lowering', origin);
        installRuntime(handle.sessionId, parsed.data.world);
        metrics.finishStage(loweringTiming);
        measureDisplay(measured, origin);
        setWorld(coarse); setProvenance(handle.authored); setSessionId(handle.sessionId);
        const detailTiming = metrics.startStage(measured, 'mesh', origin);
        let requestedMeshes = 0, cachedMeshes = 0, failedMeshes = 0;
        const built = await buildProxyWorldFrom(parsed.data, {
          mesh: async (order) => { requestedMeshes++;
            try { const result = await client.mesh(order, control.signal); if (result.cacheHit) cachedMeshes++; return result; }
            catch (error) { failedMeshes++; throw error; } },
          quality: tier.current,
        });
        if (control.signal.aborted || era !== generation.current) return;
        metrics.finishStage(detailTiming, built.kind === 'built' && failedMeshes === 0 ? 'completed' : 'failed',
          requestedMeshes > 0 && requestedMeshes === cachedMeshes ? 'cache' : origin);
        metrics.finishRun(measured);

        // Odmítnutý svět není svět. Věta o něm je ta, kterou napsal
        // `buildProxyWorldFrom()` — ta ví, na čem stavba ztroskotala.
        if (built.kind === 'built') {
          // An edit can win while coarse geometry is already interactive.
          // Its accepted world must never be overwritten by older detail.
          if (!committed.current) setWorld(built);

        } else setFault(built.reason);
      } catch (error: unknown) {
        metrics.finishRun(measured, control.signal.aborted ? 'cancelled' : 'failed');
        if (control.signal.aborted) return;
        setFault(error instanceof Error ? error.message : String(error));
      } finally {
        if (control.signal.aborted) metrics.finishRun(measured, 'cancelled');
        if (!control.signal.aborted) setStreaming(false);
      }
    },
    [installRuntime, generationMode, sentence, streaming, metrics, registerMeasurement, measureDisplay],
  );

  function stopWaiting() {
    if (changing) return;
    if (activeMeasurement.current) metrics.finishRun(activeMeasurement.current, 'cancelled');
    setDisplayMeasurement(null);
    generation.current++;
    reading.current?.abort(); secondReading.current?.abort();
    // A displayed coarse world is still editable. New edits need a fresh signal,
    // while the old request and its mesh jobs retain their cancelled signal.
    reading.current = new AbortController();
    committed.current = true;
    setStreaming(false); setWriting(false); setOffer(null);
    setChange(null); setChangeFrom(null); previewBranch.current = null;
    setStopped('Stopped waiting. Late results will not replace this view. A remote request may still finish.');
  }

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
      if (sessionId === null || prompt === '' || changing || comparison !== null || recovery !== null) return;
      const signal = reading.current?.signal;
      // Známka relace, do které se tenhle plán posílá. Za `await`em už nemusí
      // platit — viz `generation`.
      const era = generation.current;

      setChanging(true);
      const measured = metrics.startRun({ generation: era, kind: 'prompt-edit' });
      registerMeasurement(measured);
      editMeasurement.current = { run: measured, review: null };
      const requestTiming = metrics.startStage(measured, 'change-request');
      previewBranch.current = null;
      try {
        const prepared = documentRef.current && binding.current
          ? prepareBranch(documentRef.current, binding.current.controller) : null;
        const outcome = await requestChange(sessionId, prompt, {
          comparison: true,
          ...(signal === undefined ? {} : { signal }),
          ...(stableId === undefined ? {} : { stableId }),
        });
        // **Plán patří relaci, která už není na plátně.** `changeId` z ní se do
        // té nové poslat nedá, takže ukázat ho znamená nabídnout tlačítko,
        // které skončí 404 nad světem, o kterém porotce nic neví.
        if (era !== generation.current) return;

        const origin = 'authored' in outcome && outcome.authored ? 'prepared' : 'unknown';
        metrics.setRunProvenance(measured, origin);
        metrics.finishStage(requestTiming, outcome.kind === 'refused' ? 'failed' : 'completed', origin);
        if (outcome.kind === 'ambiguous') {
          metrics.finishRun(measured);
          setChange({
            kind: 'candidates',
            reason: outcome.reason,
            candidates: outcome.candidates,
          });
          setChangeFrom(null);
          return;
        }
        if (outcome.kind === 'refused') {
          metrics.finishRun(measured, 'failed');
          setChange({ kind: 'refused', message: outcome.detail });
          setChangeFrom(null);
          return;
        }

        previewBranch.current = prepared;
        editMeasurement.current = { run: measured, review: metrics.startStage(measured, 'change-review', origin) };
        setForkTick(rewindChoice.current?.tick ?? 0);
        setObservationTick(Math.min(MAX_COMPARISON_TICK, Math.max(rewindChoice.current?.end ?? 0,
          prepared?.source.getSnapshot().observationTick ?? 0)));
        setChange({
          kind: 'preview',
          changeId: outcome.changeId,
          summary: outcome.summary,
          target: outcome.target,
          scope: outcome.scope,
          preserved: outcome.preserved,
          ...(outcome.pieces === undefined ? {} : { pieces: outcome.pieces }),
        });
        setChangeFrom(outcome.authored);
      } catch (error: unknown) {
        if (era !== generation.current) return;
        metrics.finishRun(measured, signal?.aborted ? 'cancelled' : 'failed');
        setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
        setChangeFrom(null);
      } finally {
        if (era === generation.current) setChanging(false);
      }
    },
    [second, sessionId, changing, comparison, recovery, metrics, registerMeasurement],
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
    // Přidání se nesrovnává: svět před ním ten objekt neměl, takže není s čím
    // (server takové tělo odmítá 422). Operace přidání jdou commitem bez větve.
    const behavior = change.scope.behavior > 0 && change.scope.addition !== true;
    if (behavior && prepared && (prepared.base.comparisonRevision !== 0 || prepared.base.inputCount !== prepared.source.getInputLog().length)) {
      setChange({ kind: 'refused', message: 'Visitor inputs changed after the preview. Request the change again.' });
      return;
    }
    if (behavior && (!Number.isSafeInteger(forkTick) || !Number.isSafeInteger(observationTick)
      || forkTick < 0 || observationTick < forkTick || observationTick > MAX_COMPARISON_TICK)) {
      setChange({ kind: 'refused', message: 'Choose an observation tick after the fork, between 0 and 12000.' });
      return;
    }

    setChanging(true);
    const measured = editMeasurement.current?.run ?? metrics.startRun({ generation: era, kind: 'prompt-edit' });
    metrics.finishStage(editMeasurement.current?.review ?? null);
    const commitTiming = metrics.startStage(measured, 'commit-request');
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
        ...(behavior && prepared ? { comparison: { base: { ...prepared.base, comparisonRevision: 0 as const },
          inputs: [...prepared.source.getInputLog()], forkTick, observationTick } } : {}),
      });
      // Svět se pod tímhle commitem mohl vyměnit. Zapsat jeho výsledek by
      // znamenalo postavit na plátno svět jedné relace a do pole druhé věty
      // adresu druhé.
      if (era !== generation.current) return;
      metrics.finishStage(commitTiming, done.kind === 'refused' ? 'failed' : 'completed');
      if (done.kind === 'refused') {
        metrics.finishRun(measured, 'failed');
        setChange({ kind: 'refused', message: done.detail });
        return;
      }
      // Acceptance and display are distinct transactions. Retrying this closure
      // only reads the accepted snapshot; it never sends another commit.
      const display = async () => {
      const snapshotTiming = metrics.startStage(measured, 'snapshot-request');
      let snapshot;
      try {
        snapshot = done.acceptedBlueprint ?? await readBlueprint(sessionId, { ...(signal === undefined ? {} : { signal }) });
        metrics.finishStage(snapshotTiming);
      } catch (error) { metrics.finishStage(snapshotTiming, 'failed'); throw error; }
      const validationTiming = metrics.startStage(measured, 'validation');
      const parsed = blueprintSchema.safeParse(snapshot);
      metrics.finishStage(validationTiming, parsed.success ? 'completed' : 'failed');
      if (era !== generation.current) return;
      if (!parsed.success) {
        throw new Error('The accepted world could not be read.');
      }
      if (done.acceptedRevision && (parsed.data.world.simRevision !== done.acceptedRevision.sim ||
        parsed.data.world.lookRevision !== done.acceptedRevision.look))
        throw new Error('The session now has a different revision. Start a new world to continue.');

      let meshFailures = 0;
      let meshRequests = 0;
      let cacheHits = 0;
      const failedShapes = new Set<string>();
      const buildAccepted = () => buildProxyWorldFrom(parsed.data, {
        mesh: async (order) => {
          meshRequests++;
          try {
            const mesh = await client.mesh(order, signal);
            if (mesh.cacheHit) cacheHits++;
            failedShapes.delete(order.program.shapeId);
            return mesh;
          } catch (error) { meshFailures++; failedShapes.add(order.program.shapeId); throw error; }
        },
        quality: tier.current,
      });
      const meshTiming = metrics.startStage(measured, 'mesh');
      const built = await buildAccepted();
      metrics.finishStage(meshTiming, built.kind === 'built' && meshFailures === 0 ? 'completed' : 'failed',
        meshRequests > 0 && cacheHits === meshRequests ? 'cache' : 'unknown');
      if (era !== generation.current) return;
      if (built.kind !== 'built') {
        throw new Error(built.reason);
      }

      const compareTiming = behavior && prepared ? metrics.startStage(measured, 'compare') : null;
      const compared = done.comparison ? { verdict: 'COMPARED' as const, snapshot: { comparison: done.comparison } } : behavior && prepared
        ? compareAcceptedBranch(prepared, parsed.data.world, { forkTick, observationTick }) : null;
      metrics.finishStage(compareTiming, compared?.verdict === 'REJECTED' ? 'failed' : 'completed');
      const loweringTiming = metrics.startStage(measured, 'lowering');
      if (compared?.verdict === 'COMPARED' && world) {
        const result = compared.snapshot.comparison!;
        const runtime = buildRuntimeWorld(parsed.data.world.sim);
        if (!runtime.ok) throw new Error('The accepted branch cannot run.');
        const fork = prepared!.source.forkAt(runtime.world, result.forkTick, result.observationTick);
        if (fork.verdict !== 'REBRANCHED') throw new Error(fork.detail);
        const next = fork.controller;
        next.setPaused(true);
        prepared!.source.setPaused(true);
        prepared!.source.observeAt(result.observationTick);
        binding.current = { sessionId, simulation: canonical(parsed.data.world.sim), controller: next };
        documentRef.current = parsed.data.world;
        setController(next);
        setComparison({ result, world, source: prepared!.source, changedWorld: built, summary: change.summary,
          names: Object.fromEntries(parsed.data.objects.map(object => [object.stableId, object.label])) });
        setViewOriginal(false);
        setComparisonNote(null);
      } else {
        installRuntime(sessionId, parsed.data.world);
        if (compared?.verdict === 'REJECTED') setComparisonNote(`Change accepted. Comparison unavailable: ${compared.detail}`);
      }
      previewBranch.current = null;
      metrics.finishStage(loweringTiming);
      measureDisplay(measured, changeFrom ? 'prepared' : 'unknown', binding.current?.controller.getInputLog().length ?? 0);
      setWorld(built);
      setChange(null);
      setChangeFrom(null);
      // Fronta kusů (P21 T9/T10): zbytek věty se předvyplní do pole, aby další
      // odeslání pokračovalo tam, kde tahle věta skončila. Spojené tečkou, tedy
      // hranicí, na které server řeže — pošle se zase jen první kus a zbytek
      // se vrátí jako nová fronta.
      setSecond(change.pieces === undefined ? '' : change.pieces.remaining.join('. '));
      setRecovery(null);
      if (failedShapes.size > 0) {
        // The accepted document and runtime already work. Retry only its local
        // representation: no GET, commit, replay, fork, or controller replacement.
        let retryingDetail = false;
        const retryDetail = async () => {
          if (era !== generation.current || documentRef.current !== parsed.data.world || retryingDetail) return;
          retryingDetail = true; setChanging(true); meshFailures = 0; meshRequests = 0; cacheHits = 0; failedShapes.clear();
          const retryRun = metrics.startRun({ generation: era, kind: 'prompt-detail-retry', provenance: changeFrom ? 'prepared' : 'unknown' });
          registerMeasurement(retryRun);
          const retryMesh = metrics.startStage(retryRun, 'mesh');
          try {
            const detailed = await buildAccepted();
            if (era !== generation.current || documentRef.current !== parsed.data.world) return;
            metrics.finishStage(retryMesh, detailed.kind === 'built' && meshFailures === 0 ? 'completed' : 'failed',
              meshRequests > 0 && cacheHits === meshRequests ? 'cache' : 'unknown');
            if (detailed.kind !== 'built') throw new Error(detailed.reason);
            if (failedShapes.size > 0) throw new Error('Detailed geometry is still unavailable.');
            measureDisplay(retryRun, changeFrom ? 'prepared' : 'unknown', 0, false, detailed);
            setComparison(current => current ? { ...current, changedWorld: detailed } : null);
            setWorld(current => current === built ? detailed : current);
            setRecovery(null);
          } catch (error) {
            metrics.finishRun(retryRun, signal?.aborted ? 'cancelled' : 'failed');
            if (era !== generation.current || documentRef.current !== parsed.data.world) return;
            setRecovery({ detailOnly: true, retry: retryDetail,
              message: `Your accepted revision is running with coarse geometry. ${error instanceof Error ? error.message : 'Detail unavailable.'}` });
          } finally { retryingDetail = false; if (era === generation.current) setChanging(false); }
        };
        setRecovery({ detailOnly: true, retry: retryDetail,
          message: `Your change was accepted${done.acceptedRevision ? ` (simulation ${done.acceptedRevision.sim}, appearance ${done.acceptedRevision.look})` : ''}. The accepted revision is running with coarse geometry. You can retry its detail.` });
      }
      };
      let retrying = false;
      const retry = async () => {
        if (era !== generation.current || retrying) return;
        retrying = true; setChanging(true);
        try { await display(); }
        catch (error) {
          if (era !== generation.current) return;
          binding.current?.controller.setPaused(true);
          setChange(null);
          const revision = done.acceptedRevision ? ` (simulation ${done.acceptedRevision.sim}, appearance ${done.acceptedRevision.look})` : '';
          setRecovery({ message: `Your change was accepted${revision}, but its display could not be updated. The previous view is paused. ${error instanceof Error ? error.message : 'Display unavailable.'}`, retry });
        } finally { retrying = false; if (era === generation.current) setChanging(false); }
      };
      await retry();
    } catch (error: unknown) {
      if (era !== generation.current) return;
      metrics.finishRun(measured, signal?.aborted ? 'cancelled' : 'failed');
      setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (era === generation.current) setChanging(false);
    }
  }, [change, changing, installRuntime, sessionId, world, forkTick, observationTick, metrics, changeFrom, measureDisplay, registerMeasurement]);

  /** Zahození plánu. Sahá **jen** na panel — svět ani revize se nehnou. */
  const discard = useCallback(() => {
    if (editMeasurement.current) metrics.finishRun(editMeasurement.current.run, 'cancelled');
    editMeasurement.current = null;
    previewBranch.current = null;
    setChange(null);
    setChangeFrom(null);
  }, [metrics]);

  // Pořadí je pořadí pravdy: porucha přebíjí běžící relaci, protože relace
  // skončila; běžící relace přebíjí prázdno, protože se něco děje.
  const status: WorldStatusState =
    visualWorld && !world ? 'preview' : fault !== null ? 'broken' : streaming ? 'building' : world === null ? 'empty' : 'live';

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
    setRecovery(null);
    binding.current = { sessionId: project.projectRevision, simulation: canonical(project.world.sim), controller: next };
    documentRef.current = project.world;
    previewBranch.current = null;
    setWorld(sourceProxyFromRuntime(built.world, project.sources[0]?.title ?? 'Source scenario'));
    setVisualWorld(null);
    setController(next); setSourceProject(project);
    setSourceGeneration(_generation);
    setSessionId(null); setComparison(null); setViewOriginal(false); setComparisonNote(null);
    setChange(null); setChangeFrom(null); setOffer(null); setWriting(false); setSecondActMiss(null);
    setStreaming(false); setChanging(false); setFault(null); setProvenance(null);
    setStopped(null);
  }

  return (
    <WorldstreamApp
      inspecting={inspecting}
      onInspect={toggleInspect}
      empty={displayedWorld === null && !streaming && fault === null ? (
        <EmptyScene onExample={(text) => { setSentence(text); promptInput.current?.focus(); }} />
      ) : null}
      prompt={
        <>
        <form onSubmit={(event) => void submit(event)} data-testid="prompt-form" className="ws-prompt-form" style={FORM}>
          <label className="ws-generation-mode">World source <select data-testid="generation-mode" value={generationMode} disabled={streaming}
            onChange={event => setGenerationMode(event.target.value as 'live' | 'prepared')}>
            <option value="live">Generate my world</option>
            <option value="prepared">Prepared demo</option>
          </select></label>
          <input
            ref={promptInput}
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
          metrics={metrics} onMeasurementRun={registerMeasurement} onMeasureDisplay={measureDisplay}
          runtimes={sourceRuntimes.current}
          onRestore={restored => { sourceRuntimes.current = restored.runtimes; acceptSource(restored.selected, restored.generation); }}
          onBegin={() => { committed.current = true; }}
          onAccept={acceptSource} />
        </>
      }
      status={<>
        <WorldStatus state={status} detail={fault} detailPending={streaming && world !== null} intent={world === null ? intent : null} />
        {visualWorld && !world && <p style={FACTS} data-testid="visual-preview-notice" data-stage={visualStage??'compiler-visuals'}>
          {visualStage==='intent-layout' ? 'Provisional layout from your plan. Placement and unfinished forms may change.' : 'Noninteractive scene preview.'}
          {' '}{stopped ? 'Waiting stopped before an accepted world arrived.' : streaming ? visualStage==='intent-layout' ? 'Building and checking the rules.' : 'Checking a repair to the rules.' : 'The rules did not pass verification.'}
          {' '}Actions, time travel and sharing are unavailable.</p>}
        {(streaming || writing) && <button data-testid="world-cancel" disabled={changing} onClick={stopWaiting}>Stop waiting</button>}
        {stopped && <p role="status" data-testid="world-cancelled" style={FACTS}>{stopped}</p>}
      </>}
      provenance={
        <>
          <AuthoredNotice provenance={world === null ? null : provenance} />
          {world && sourceProject && <p className="ws-provenance" data-testid="world-source-origin">
            {sourceGeneration === 'fixture' ? 'Scripted source fixture' : 'Live model generation from source'} · schematic geometry
          </p>}
          {world && !sourceProject && provenance === null && <p className="ws-provenance" data-testid="world-live-origin">Live model generation</p>}
          {writing ? (
            <p className="ws-provenance" data-testid="second-act-writing">
              {intent === null
                ? 'The model is writing its own version of this world.'
                : `The model read it as ${intent.setting} and is writing its own version.`}
            </p>
          ) : null}
          {secondActMiss === null ? null : (
            <p className="ws-provenance" data-testid="second-act-missed">
              {`The model's own version did not arrive (${secondActMiss}). This world stays.`}
            </p>
          )}
          {offer === null ? null : (
            <SecondActOffer onShow={() => adopt(offer)} onKeep={() => setOffer(null)} />
          )}
        </>
      }
      change={
        sessionId === null || world === null ? null : (
          <>
            {recovery && <section role="status" data-testid="change-recovery" style={FACTS}>
              <p>{recovery.message}</p>
              <button data-testid="change-resync" disabled={changing} onClick={() => void recovery.retry()}>{recovery.detailOnly ? 'Retry accepted detail' : 'Restore accepted change'}</button>
            </section>}
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
              <label>Change begins at {(forkTick / 20).toFixed(1)}s
                <input aria-label="Change begins" type="range" min={0} max={Math.max(observationTick,1)} value={forkTick}
                  onChange={event => setForkTick(event.target.valueAsNumber)} /></label>
              <label>Look ahead {(observationTick / 20).toFixed(1)}s
                <input aria-label="Look ahead" type="range" min={forkTick} max={Math.min(MAX_COMPARISON_TICK,Math.max(400,observationTick))}
                  value={observationTick} onChange={event => setObservationTick(event.target.valueAsNumber)} /></label>
              <details><summary>Exact simulation times</summary>
              <label>Fork tick <input data-testid="branch-fork-input" type="number" min={0} max={MAX_COMPARISON_TICK}
                value={forkTick} disabled={changing} onChange={e => setForkTick(e.target.valueAsNumber)} /></label>
              <label>Observation tick <input data-testid="branch-observation-input" type="number" min={forkTick} max={MAX_COMPARISON_TICK}
                value={observationTick} disabled={changing} onChange={e => setObservationTick(e.target.valueAsNumber)} /></label>
              </details>
              <p>Return before the action you want to change. Both futures replay your recorded actions.</p>
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
                placeholder="make the main arch taller"
                value={second}
                onChange={(event) => setSecond(event.target.value)}
                style={INPUT}
              />
              <button type="submit" data-testid="refine-submit" disabled={changing || comparison !== null || recovery !== null} style={BUTTON}>
                {changing ? 'Working…' : 'Change it'}
              </button>
            </form>
          </>
        )
      }
      controls={displayedWorld ? <div className="ws-runtime-tools">
        {comparison && <BranchComparison comparison={comparison.result} names={comparison.names} original={viewOriginal} busy={changing} summary={comparison.summary}
          onRestart={() => {
            if (!sessionId || !documentRef.current) return;
            const accepted = documentRef.current;
            const restoreEra = generation.current;
            setChanging(true);
            void restoreComparison(sessionId, { simRevision: accepted.simRevision, lookRevision: accepted.lookRevision, simHash: accepted.simHash })
              .then(restored => {
                if (generation.current !== restoreEra || documentRef.current !== accepted) return;
                restored = blueprintSchema.parse(restored);
                const source = comparison.source;
                source.observeAt(comparison.result.forkTick); source.setPaused(true);
                binding.current = { sessionId, simulation: canonical(restored.world.sim), controller: source };
                documentRef.current = restored.world;
                setController(source); setWorld(comparison.changedWorld); setComparison(null); setViewOriginal(false);
                setChange(null); previewBranch.current = null; setComparisonNote('Original rules restored. Try another change; your scene stays.');
              }).catch(error => { if (generation.current === restoreEra) setComparisonNote(error instanceof Error ? error.message : 'The original rules could not be restored.'); })
              .finally(() => { if (generation.current === restoreEra) setChanging(false); });
          }}
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
        {controller === null ? null : comparison
          ? <details><summary>Visitor replay</summary><RuntimeControls controller={controller} comparing /></details>
          : <RuntimeControls controller={controller} onRoute={setRouteHighlight} onRewind={(tick,end) => { rewindChoice.current={tick,end}; setForkTick(tick); }} />}
        <div style={FACTS}><button data-testid="camera-reset" onClick={() => { setFocusId(null); setCameraReset(value => value + 1); }}>Frame scene</button>
          <span> Drag to orbit · scroll to zoom · arrow keys to pan</span></div>
        {displayedWorld?.kind === 'built' && displayedWorld.environment?.kind === 'interior' && <div style={FACTS}>
          <button data-testid="cutaway-toggle" aria-pressed={cutaway} onClick={() => setCutaway(value => !value)}>{cutaway ? 'Show full walls' : 'Cut away walls'}</button>
          <span>{cutaway ? ' Cutaway inspection · rules and collisions stay unchanged' : ' Full architecture'}</span>
        </div>}
      </div> : null}
      inspect={<><WorldFacts world={displayedWorld} repairAttempts={visualRepairAttempts} allowAssetRepair={world?.kind==='built'&&!comparison&&!sourceProject}
        onFocus={comparison ? undefined : id => { setFocusId(id); setCameraReset(value => value + 1); }} />{world && !sourceProject && <p style={FACTS} data-testid="no-source-evidence">
        No source evidence is attached to this world. A prompt alone is not a citation.
      </p>}</>}
      stage={comparison && binding.current ? <FutureViews original={comparison.world} changed={comparison.changedWorld}
        source={comparison.source} target={binding.current.controller} forkTick={comparison.result.forkTick}
        endTick={comparison.result.observationTick} reset={cameraReset} onPresented={presented} cutaway={cutaway} /> : <WorldstreamCanvas world={displayedWorld} controller={world?controller:null} reset={cameraReset}
        onPresented={presented} focusId={focusId} cutaway={cutaway} routeHighlight={routeHighlight}
        framing={sourceProject ? 'diagram' : 'scene'}
        sceneId={sourceProject ? (sourceProject.parent ?? sourceProject).projectRevision : sessionId} />}
    />
  );
}

/** Věta, kterou prázdná scéna nabízí. Táž, co stojí v `placeholder` pole. */
const EXAMPLE_SENTENCE = 'a drowned cathedral lit from below';

/**
 * Prázdná nasvícená scéna s jedním příkladem věty (P21 T10).
 *
 * Do T10 byla výchozí obrazovka plátno bez ničeho a pole s `placeholder`em —
 * cizí člověk (G-V) nevěděl, že se má psát celou větou, ani že svět pak
 * poroste po větách. Tři řádky: co udělat, jeden příklad k odkliknutí, a co
 * přijde potom. Příklad je tlačítko, které pole **vyplní, ne odešle** —
 * odeslání je rozhodnutí porotce a stojí placené volání.
 *
 * Mizí s prvním světem, s prvním náhledem i s rozběhnutou stavbou, protože
 * v té chvíli už plátno mluví samo.
 */
function EmptyScene({ onExample }: { readonly onExample: (sentence: string) => void }) {
  return (
    <section data-testid="empty-scene" aria-label="How to begin">
      <p className="ws-empty-lead">Describe a place in one sentence, and it will stand here.</p>
      <button type="button" data-testid="example-sentence" className="ws-empty-example" onClick={() => onExample(EXAMPLE_SENTENCE)}>
        Try: {EXAMPLE_SENTENCE}
      </button>
      <p className="ws-empty-next">Then keep talking. Each sentence adds one thing or changes one rule, and time can always be rewound.</p>
    </section>
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
        : 'This is the closest world authored ahead of time. Relevance to your request has not been verified.'}
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
function WorldFacts({ world, onFocus, allowAssetRepair, repairAttempts }: { readonly world: ProxyWorld | null; onFocus?: (id: string) => void;
  allowAssetRepair: boolean; repairAttempts: Set<string> }) {
  const [visibility, setVisibility] = useState<ReturnType<typeof visibilityReport> | null>(null);
  const [detail, setDetail] = useState<readonly {id:string; assessment:ShapeDetailAssessment; action:{kind:'repeat-instanced'|'unsupported';reason:string}|null}[]>([]);
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(()=>new Set(repairAttempts));
  const [assetRepairs,setAssetRepairs]=useState<ReturnType<NonNullable<Window['__worldstreamStage']>['slots']>>([]);
  const [repairMessage,setRepairMessage]=useState<string|null>(null);
  const era=useRef(0);
  useEffect(() => {
    era.current++;setVisibility(null);setDetail([]);setAttempted(new Set(repairAttempts));setAssetRepairs([]);setRepairMessage(null);
    return ()=>{era.current++;};
  }, [world,repairAttempts]);
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
        <button data-testid="inspect-visibility" onClick={() => {
          const stage=window.__worldstreamStage;
          setVisibility(world.sceneSpec ? visibilityReport(world.sceneSpec,stage?.visibility() ?? []) : null);
          setDetail((stage?.slots() ?? []).flatMap(slot=>slot.detailAssessment ? [{id:slot.stableId,assessment:slot.detailAssessment,action:slot.samplingAction}] : []));
          setAssetRepairs(stage?.slots()??[]);
        }}>
          Check this view
        </button>
        {allowAssetRepair && assetRepairs.some(slot=>slot.assetRetry.status!=='unavailable') && <div data-testid="asset-repair-report">
          <p>One retry can reload the same approved object after a download or loading failure. It does not change the world or its rules.</p>
          {assetRepairs.filter(slot=>slot.assetRetry.status!=='unavailable').map(slot=><p key={slot.stableId} data-testid="asset-repair-row" data-object={slot.stableId}>
            {slot.stableId}: {slot.assetRetry.status}{slot.assetRetry.reason ? ` · ${slot.assetRetry.reason}` : ''}
            {slot.assetRetry.status==='available' && <button data-testid="asset-repair-retry" disabled={attempted.has(slot.stableId)} onClick={async()=>{
              const stage=window.__worldstreamStage;if(!stage||repairAttempts.has(slot.stableId))return;
              const currentEra=era.current;repairAttempts.add(slot.stableId);setAttempted(new Set(repairAttempts));
              setRepairMessage(`Reloading ${slot.stableId}…`);
              try{
                const result=await stage.retryAsset(slot.stableId);
                if(era.current!==currentEra||window.__worldstreamStage!==stage)return;
                setAssetRepairs(stage.slots());setVisibility(world.sceneSpec?visibilityReport(world.sceneSpec,stage.visibility()):null);
                setRepairMessage(result.status==='loaded'?`${slot.stableId} reloaded. Check this view; recognition still needs human review.`
                  :`${slot.stableId}: ${result.status}. ${result.reason??'The object was not replaced.'}`);
              }catch{
                if(era.current===currentEra&&window.__worldstreamStage===stage)setRepairMessage(`${slot.stableId}: reload failed. No further automatic attempt is available.`);
              }
            }}>Retry this object</button>}
          </p>)}
        </div>}
        {allowAssetRepair&&repairMessage&&<p role="status" data-testid="asset-repair-status">{repairMessage}</p>}
        {detail.some(item=>item.assessment.recommendation) && <div data-testid="shape-detail-report">
          <p>Shape sampling diagnostics. Recognition still needs human review.</p>
          {detail.filter(item=>item.assessment.recommendation).map(item=><p key={item.id}><strong>{item.id}</strong>: {item.action?.kind==='repeat-instanced'
            ? `Applied: ${item.action.reason} The original whole-object grid had a sampling risk; inspect the resulting detail.`
            : <>{item.assessment.recommendation}{item.action ? ` Automatic change unavailable: ${item.action.reason}` : ''}</>}</p>)}
        </div>}
      {world.sceneSpec && <>
        {visibility && <div data-testid="visibility-report">
          <p>Five sampled sight lines per object; 24px diagnostic minimum. Recognition still needs human review. Recheck after one targeted camera adjustment.</p>
          {visibility.map((requirement,index) => <div key={index}><strong>{requirement.description}</strong>
            {requirement.instances.map(instance => <p key={instance.stableId}>{instance.stableId}: {instance.status}
              {instance.observation ? ` · ${Math.round(instance.observation.screenPixels)}px` : ''}
              {instance.repair ? ` · ${instance.repair}` : ''}
              {instance.status === 'loaded' && onFocus && <button disabled={attempted.has(instance.stableId)}
                onClick={() => { repairAttempts.add(instance.stableId);setAttempted(new Set(repairAttempts));onFocus(instance.stableId); }}>Inspect this object</button>}
              {attempted.has(instance.stableId) && instance.status === 'loaded' ? ' · One targeted repair attempted; recheck. If still hidden, geometry or occlusion needs review.' : ''}</p>)}
          </div>)}
        </div>}
      </>}
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
function RuntimeControls({ controller, comparing = false, onRewind, onRoute }: { readonly controller: RuntimeController; readonly comparing?: boolean;
  readonly onRewind?: (tick:number,end:number)=>void; readonly onRoute?: (highlight: readonly string[]) => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const furthest = useRef(state.observationTick);
  const previousController = useRef(controller);
  if (previousController.current !== controller) { previousController.current=controller; furthest.current=state.observationTick; }
  furthest.current = Math.max(furthest.current,state.observationTick);
  const rewind = (tick:number) => { controller.setPaused(true); controller.observeAt(tick); onRewind?.(tick,furthest.current); };
  useEffect(() => {
    if (comparing || state.paused || state.endedAtTick !== null) return;
    const clock = createClock();
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const due = pump(clock, now - last);
      last = now;
      controller.advanceTicks(due);
    }, 50);
    return () => window.clearInterval(timer);
  }, [controller, state.paused, state.endedAtTick, comparing]);
  return (
    <section data-testid="runtime-controls" style={{ ...FACTS, maxWidth: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.65rem' }} aria-label="Simulation controls">
      <RuntimeInteraction controller={controller} readOnly={comparing} onRoute={onRoute} />
      {!comparing && <div style={{flexBasis:'100%'}}>
        <label>Time · {(state.observationTick/20).toFixed(1)}s <input data-testid="world-time" type="range" min={0}
          max={Math.max(1,furthest.current)} value={state.observationTick} onChange={event => rewind(event.target.valueAsNumber)} /></label>
        <button data-testid="rewind-before-action" disabled={controller.getInputLog().length===0}
          onClick={() => rewind(controller.getInputLog().at(-1)!.tick)}>Before my last action</button>
        <details><summary>Your actions</summary>{controller.getInputLog().map((input,index) => <button key={index}
          onClick={() => rewind(input.tick)}>{(input.tick/20).toFixed(1)}s · {input.actionId} {input.target ?? ''}</button>)}</details>
      </div>}
      <div data-testid="runtime-state">{state.runState}</div>
      <button type="button" data-testid="runtime-pause" style={BUTTON}
        disabled={comparing || state.endedAtTick !== null}
        onClick={() => controller.setPaused(!state.paused)}>
        {state.paused ? 'Resume' : 'Pause'}
      </button>
      <details><summary>Simulation details</summary>
        <div data-testid="runtime-tick" data-tick={state.tick}>Tick {state.tick}</div>
        {state.endedAtTick !== null && <div>Ended at tick {state.endedAtTick}</div>}
        <div data-testid="runtime-observation">Observation tick {state.observationTick}</div>
      </details>
    </section>
  );
}
