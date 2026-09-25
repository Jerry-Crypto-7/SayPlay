'use client';

/**
 * PLAY shell (P23-C T5): plátno, HUD, karty cílů, overlay konce.
 *
 * Svět se staví z blueprintu stejnou cestou jako hlavní demo
 * (`buildProxyWorldFrom` + cachovaný mesh klient) a hraje se přes
 * `bindRuntime(...).controller`. Tik posouvá `setInterval` po 50 ms – to je
 * tempo zobrazení, ne stav: hash světa určuje jen počet tiků a vstupy, ne
 * kdy nástěnné hodiny ukázaly kolik. Skrytá záložka tikat přestane, aby se
 * hra nedohrála bez hráče.
 *
 * Žádný technický panel (Program, Timeline, Inspect…) se tu nerenderuje;
 * sonda `window.__playShell` je jediné okno dovnitř a slouží e2e.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { GameVersion } from '@/play/contracts';
import type { Honesty } from '@/play/draft/unsupported';
import type { GameSpecV1 } from '@/play/spec';
import { createMeshClient } from '@/shape/mesh-client';
import { createCachedMeshClient } from '@/shape/mesh-cache';
import { buildProxyWorldFrom, type ProxyWorld } from '@/worldstream/proxy';
import { bindRuntime, type RuntimeController } from '@/worldstream/runtime-controller';
import type { RuntimeAction } from '@/worldstream/runtime-input';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import { ArcadePlay } from './arcade/ArcadePlay';
import { isTyping } from './arcade/input';
import { HonestyStrip } from './HonestyStrip';
import { HowItWorks } from './HowItWorks';
import { Hud, TICKS_PER_SECOND, secondsOf } from './Hud';
import type { LabFacts, ReadFacts } from './lab';
import { Lineage } from './Lineage';
import { loopEvent, loopImpression } from './loop-client';
import { SentenceRead } from './SentenceRead';
import { OrderBubbles } from './OrderBubbles';
import { PatrolSight } from './PatrolSight';
import { PostRun } from './PostRun';
import { RemixReadyChip, useRemixJob } from './RemixBox';
import { TargetCards } from './TargetCards';
import { UpgradeBanner } from './UpgradeBanner';
import { idleProps, keyAction, playerActor, tapAction, targetCards } from './targets';

// `ssr: false` je povinné – WebGL2 kontext na serveru není a `<Canvas>` by
// při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), { ssr: false });

const TICK_MS = 1000 / TICKS_PER_SECOND;
/** Nejdelší hra podle schématu je 180 s; svědek nesmí točit déle. */
const WITNESS_TICK_CAP = 180 * TICKS_PER_SECOND;

interface PlayProbe {
  inputs(): ReturnType<RuntimeController['getInputLog']>;
  tick(): number;
  /**
   * Přehraje dalších `count` kroků `witness.ops` (výchozí všechny); po
   * posledním dotočí běh do konce. `last` je akce posledního zahraného kroku.
   */
  playWitness(count?: number): { readonly runState: string; readonly tick: number; readonly last: string | null; readonly left: number };
}

declare global {
  interface Window {
    __playShell?: PlayProbe;
  }
}

/** Svědek ze `sim.witness` je ve schématu `unknown`; tady se čtou jen kroky, seřazené podle tiku. */
function witnessOps(witness: unknown): readonly { readonly tick: number; readonly action: RuntimeAction }[] {
  const ops = (witness as { readonly ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return [];
  return ops
    .map((op) => op as { readonly tick?: unknown; readonly actor?: unknown; readonly actionId?: unknown; readonly target?: unknown })
    // Svědek kompilátoru PLAY herce nepíše (hraje vždy hráč); `playWitness` ho
    // doplní z akcí runtime. Svědek bez herce i bez hráče nemá kdo zahrát.
    .filter((op) => typeof op.actionId === 'string')
    .map((op) => ({
      tick: typeof op.tick === 'number' ? op.tick : 0,
      action: { actor: typeof op.actor === 'string' ? op.actor : '', actionId: op.actionId as string, ...(typeof op.target === 'string' ? { target: op.target } : {}) },
    }))
    .sort((a, b) => a.tick - b.tick);
}

export interface PlayShellProps {
  readonly versionId: string;
  readonly spec: GameSpecV1;
  readonly blueprint: WorldstreamBlueprint;
  /** Od kořene k listu; poslední záznam je tahle hra. */
  readonly lineage: readonly GameVersion[];
  readonly remixes: number;
  /** Hra je AI verze návrhu (`relation: 'upgrade'`); rodokmen to řekne místo „Remixed from“. */
  readonly aiVersion?: boolean;
  readonly lab: LabFacts;
  readonly read: ReadFacts;
  /** Adresa `GET …/upgrade`, když je hra návrh z věty; `null` = není na co čekat. */
  readonly upgrade: string | null;
}

/**
 * Arkádová hra (P25A) jde do `ArcadePlay`, mřížková beze změny. Poctivá hláška
 * (P25E) leží nad oběma, proto ji kreslí rozcestník, ne shell.
 */
export function PlayShell({
  blueprint,
  arcade,
  honesty = null,
  ...rest
}: Omit<PlayShellProps, 'blueprint'> & { readonly blueprint: WorldstreamBlueprint | null; readonly arcade?: ArcadeWorld; readonly honesty?: Honesty | null }) {
  if (blueprint === null && arcade === undefined) throw new Error('PlayShell: a grid game needs its blueprint');
  const shell = arcade !== undefined ? <ArcadePlay {...rest} arcade={arcade} /> : blueprint !== null && <GridShell {...rest} blueprint={blueprint} />;
  if (honesty === null) return shell;
  // Proužek hru odsune, nepřekryje: HUD s cílem hry musí zůstat vidět.
  return (
    <div className="play-honest-frame">
      <HonestyStrip honesty={honesty} />
      {shell}
    </div>
  );
}

function GridShell({ versionId, spec, blueprint, lineage, remixes, aiVersion = false, lab, read, upgrade }: PlayShellProps) {
  const [controller] = useState(() => bindRuntime(null, versionId, blueprint.world).controller);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const cards = useMemo(
    () => targetCards(controller.actions, blueprint.objects, idleProps(spec, blueprint.world.sim)),
    [controller, blueprint, spec],
  );
  const running = snapshot.runState === 'running';
  const remix = useRemixJob(versionId, !running);
  const built = world?.kind === 'built';

  // Stavba světa: jednou na připojení, zrušená při odchodu ze stránky.
  useEffect(() => {
    const client = createCachedMeshClient(createMeshClient());
    const control = new AbortController();
    void buildProxyWorldFrom(blueprint, { mesh: (order) => client.mesh(order, control.signal), quality: 'full' })
      .then((result) => {
        if (control.signal.aborted) return;
        if (result.kind === 'built') setWorld(result);
        else setFault(result.reason);
      })
      .catch((error: unknown) => {
        if (!control.signal.aborted) setFault(error instanceof Error ? error.message : String(error));
      });
    return () => {
      control.abort();
      client.dispose();
    };
  }, [blueprint]);

  // Hodiny hry: běží, dokud hra běží, svět stojí a záložka je vidět.
  useEffect(() => {
    if (!running || !built) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') controller.advanceTicks(1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [controller, running, built]);

  const send = useCallback((action: RuntimeAction | null, nextSelected: string) => {
    setSelected(nextSelected);
    if (action !== null) controller.dispatch(action);
  }, [controller]);

  // Klávesy 1–9 / mezerník / E jako záloha za karty – jen dokud hra běží (P28B T3).
  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const hit = keyAction(event.key, cards, selected);
      if (hit === null) return;
      event.preventDefault();
      send(hit.action, hit.selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards, selected, send, running]);

  // Události smyčky (P27D T4): zobrazení, první vstup a konec běhu – ne za svědka ze sondy.
  const witnessed = useRef(false);
  useEffect(() => loopImpression(versionId), [versionId]);
  useEffect(() => {
    let reported = false;
    return controller.subscribe(() => {
      if (witnessed.current) return;
      const now = controller.getSnapshot();
      if (now.runState === 'running') reported = false;
      if (controller.getInputLog().length > 0) loopEvent('first_input', versionId);
      if (now.runState !== 'running' && !reported) {
        reported = true;
        loopEvent(now.runState === 'won' ? 'win' : 'lose', versionId);
      }
    });
  }, [controller, versionId]);

  // Sonda pro e2e.
  useEffect(() => {
    const actor = playerActor(controller.actions);
    let cursor = 0;
    let base = 0;
    const probe: PlayProbe = {
      inputs: () => controller.getInputLog(),
      tick: () => controller.getSnapshot().tick,
      playWitness: (count = Infinity) => {
        witnessed.current = true;
        // Kroky svědka se posouvají o tik prvního volání: hra už mohla chvíli
        // běžet a couvnout nejde – vstup je dovolený jen na nejnovějším tiku.
        if (cursor === 0) base = controller.getSnapshot().tick;
        const ops = witnessOps(blueprint.world.sim.witness);
        const batch = ops.slice(cursor, cursor + count);
        for (const op of batch) {
          const at = base + op.tick;
          const now = controller.getSnapshot().tick;
          if (at > now) controller.advanceTicks(at - now);
          controller.dispatch(actor === null ? op.action : { ...op.action, actor });
        }
        cursor += batch.length;
        const last = batch.at(-1)?.action.actionId ?? null;
        if (cursor < ops.length) return { runState: controller.getSnapshot().runState, tick: controller.getSnapshot().tick, last, left: ops.length - cursor };
        let guard = 0;
        while (controller.getSnapshot().runState === 'running' && guard < WITNESS_TICK_CAP) {
          controller.advanceTicks(1);
          guard += 1;
        }
        const end = controller.getSnapshot();
        return { runState: end.runState, tick: end.tick, last, left: 0 };
      },
    };
    window.__playShell = probe;
    return () => {
      if (window.__playShell === probe) delete window.__playShell;
    };
  }, [controller, blueprint]);

  return (
    <main className="play-shell">
      <div className="play-stage" aria-hidden="true">
        <WorldstreamCanvas world={world} controller={controller} sceneId={versionId} framing="scene" guide={false}>
          {built && blueprint.world.sim !== null && (
            <>
              <PatrolSight sim={blueprint.world.sim} controller={controller} />
              <OrderBubbles sim={blueprint.world.sim} roles={spec.roles} controller={controller} />
            </>
          )}
        </WorldstreamCanvas>
      </div>
      <Hud spec={spec} snapshot={snapshot} versionId={versionId} />
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      <UpgradeBanner request={upgrade} sentence={read.sentence} />
      {running && <RemixReadyChip job={remix} />}
      <SentenceRead read={read} />
      <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />
      {!built && fault === null && (
        <p className="play-building" data-testid="play-building" aria-live="polite">Building the world…</p>
      )}
      {fault !== null && (
        <p className="play-alert" role="alert">This game could not be built: {fault}</p>
      )}
      <TargetCards cards={cards} selected={selected} disabled={!snapshot.canInput || !built} onTap={(card) => {
        const hit = tapAction(card, selected);
        send(hit.action, hit.selected);
      }} />
      {!running && (
        <section className="play-outcome" data-testid="play-outcome" role="status">
          <h2 className="play-outcome-title">{snapshot.runState === 'won' ? 'You won' : 'You lost'}</h2>
          <p className="play-outcome-detail" data-tick={snapshot.tick}>
            {snapshot.runState === 'won' ? 'in' : 'after'} {secondsOf(snapshot.tick, TICKS_PER_SECOND)}
          </p>
          <PostRun
            versionId={versionId}
            remix={remix}
            onReplay={() => {
              if (!witnessed.current) loopEvent('restart', versionId);
              witnessed.current = false;
              controller.observeAt(0);
            }}
          />
        </section>
      )}
    </main>
  );
}
