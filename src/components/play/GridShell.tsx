'use client';

/**
 * Mřížková hra PLAY (P23-C T5): plátno, HUD, karty cílů, overlay konce.
 *
 * Svět se staví z blueprintu stejnou cestou jako hlavní demo
 * (`buildProxyWorldFrom` + cachovaný mesh klient) a hraje se přes
 * `bindRuntime(...).controller`. Tik posouvá `setInterval` po 50 ms – to je
 * tempo zobrazení, ne stav: hash světa určuje jen počet tiků a vstupy, ne
 * kdy nástěnné hodiny ukázaly kolik. Skrytá záložka tikat přestane, aby se
 * hra nedohrála bez hráče.
 *
 * Vlastní soubor kvůli startu arkády (P28E-R2): `PlayShell` ho načítá přes
 * `next/dynamic`, takže arkádová hra nevyhodnocuje runtime, mesh klienta ani
 * jejich Zod schémata, které potřebuje jen mřížka.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createMeshClient } from '@/shape/mesh-client';
import { createCachedMeshClient } from '@/shape/mesh-cache';
import { buildProxyWorldFrom, type ProxyWorld } from '@/worldstream/proxy';
import { bindRuntime, type RuntimeController } from '@/worldstream/runtime-controller';
import type { RuntimeAction } from '@/worldstream/runtime-input';

import { HowItWorks } from './HowItWorks';
import { Hud } from './Hud';
import { Lineage } from './Lineage';
import { loopEvent, loopImpression } from './loop-client';
import { OrderBubbles } from './OrderBubbles';
import { PatrolSight } from './PatrolSight';
import type { PlayShellProps } from './PlayShell';
import { PostRun } from './PostRun';
import { SentenceRead } from './SentenceRead';
import { TargetCards } from './TargetCards';
import { UpgradeBanner } from './UpgradeBanner';
import { idleProps, keyAction, playerActor, tapAction, targetCards } from './targets';

// `ssr: false` je povinné – WebGL2 kontext na serveru není a `<Canvas>` by
// při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), { ssr: false });

const TICK_MS = 50;
/** Nejdelší hra podle schématu je 180 s; svědek nesmí točit déle. */
const WITNESS_TICK_CAP = 180 * 20;

interface PlayProbe {
  inputs(): ReturnType<RuntimeController['getInputLog']>;
  tick(): number;
  /** Přehraje `witness.ops` světa od aktuálního tiku a dotočí běh do konce. */
  playWitness(): { readonly runState: string; readonly tick: number };
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

export default function GridShell({ versionId, spec, blueprint, lineage, remixes, aiVersion = false, lab, read, upgrade }: PlayShellProps) {
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

  // Klávesy 1–9 / mezerník / E jako záloha za karty.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const hit = keyAction(event.key, cards, selected);
      if (hit === null) return;
      event.preventDefault();
      send(hit.action, hit.selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards, selected, send]);

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
    const probe: PlayProbe = {
      inputs: () => controller.getInputLog(),
      tick: () => controller.getSnapshot().tick,
      playWitness: () => {
        witnessed.current = true;
        // Kroky svědka se posouvají o aktuální tik: hra už mohla chvíli běžet
        // a couvnout nejde – vstup je dovolený jen na nejnovějším tiku.
        const base = controller.getSnapshot().tick;
        for (const op of witnessOps(blueprint.world.sim.witness)) {
          const at = base + op.tick;
          const now = controller.getSnapshot().tick;
          if (at > now) controller.advanceTicks(at - now);
          controller.dispatch(actor === null ? op.action : { ...op.action, actor });
        }
        let guard = 0;
        while (controller.getSnapshot().runState === 'running' && guard < WITNESS_TICK_CAP) {
          controller.advanceTicks(1);
          guard += 1;
        }
        const end = controller.getSnapshot();
        return { runState: end.runState, tick: end.tick };
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
          <p className="play-outcome-detail">at tick {snapshot.tick}</p>
          <PostRun
            versionId={versionId}
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
