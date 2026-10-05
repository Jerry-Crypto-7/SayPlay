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
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { lookOf, sceneLook } from '@/play/arcade/look';
import { createMeshClient } from '@/shape/mesh-client';
import { createCachedMeshClient } from '@/shape/mesh-cache';
import { buildProxyWorldFrom, type ProxyWorld } from '@/worldstream/proxy';
import { bindRuntime, type RuntimeController } from '@/worldstream/runtime-controller';
import type { RuntimeAction } from '@/worldstream/runtime-input';

import { installSoundControls, playMusic, playSfx, setSoundLook } from '@/play/audio';
import { musicFor } from '@/play/audio/library';

import { isTyping } from './arcade/input';
import { wakesGame } from './arcade/ready-gate';
import { GridScenery } from './arcade/look/Scenery';
import { HowItWorks } from './HowItWorks';
import { FirstPrompt } from './FirstPrompt';
import { MoreGames } from './MoreGames';
import { MuteButton } from './MuteButton';
import { ShareButton } from './ShareButton';
import { Hud, TICKS_PER_SECOND, gridFacts, objectiveCounter } from './Hud';
import { Lineage } from './Lineage';
import { loopEvent, loopImpression } from './loop-client';
import { AboutButton, SentenceRead } from './SentenceRead';
import { OrderBubbles } from './OrderBubbles';
import { PatrolSight } from './PatrolSight';
import type { PlayShellProps } from './PlayShell';
import { PostRun } from './PostRun';
import { RemixBox, RemixReadyChip, useRemixJob } from './RemixBox';
import { gridOf } from './sight';
import type { ProjectTarget } from './TapTargets';
import { TargetCards } from './TargetCards';
import { BuildingScreen, Button, CHANGE_LABEL, Icon, PauseCard, Sheet, useHudKeys } from './ui';
import { UpgradeBanner } from './UpgradeBanner';
import { avoidCards, idleProps, keyAction, playerActor, roleKinds, tapAction, type TargetCard, targetCards } from './targets';

// `ssr: false` je povinné – WebGL2 kontext na serveru není a `<Canvas>` by
// při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), { ssr: false });
const TapTargets = dynamic(() => import('./TapTargets').then((module) => module.TapTargets), { ssr: false });

const TICK_MS = 1000 / TICKS_PER_SECOND;
/** Klepnutí dál než tohle od každého cíle je klepnutí do prázdna (px). */
const TAP_RADIUS_PX = 96;
/** Posun prstu, od kterého klepnutí není klepnutí, ale tah (px). */
const TAP_SLOP_PX = 10;
/** Tolik tiků bez kroku = hráč dál nejde; chůze stojí nejvýš tik čekání mezi kroky. */
const STALL_TICKS = 3;
/** Jako `SCORE_POP_MS` arkády; odtamtud se nebere, ať shell netáhne plátno arkády. */
const SCORE_POP_MS = 500;
/** Nejdelší hra podle schématu je 180 s; svědek nesmí točit déle. */
const WITNESS_TICK_CAP = 180 * TICKS_PER_SECOND;
/** Štítků ve světě nejvýš tolik naráz (kit `08-game-hud.md`). */
const MAX_TAGS = 3;
/** Cíle, které dostanou slunečný štítek: kam hra vede, ne každý sbíraný kus (ty počítá pilulka postupu). */
const GOAL_TAG_KINDS: ReadonlySet<string> = new Set(['exit', 'door', 'destination']);

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface PlayProbe {
  inputs(): ReturnType<RuntimeController['getInputLog']>;
  tick(): number;
  /**
   * Přehraje dalších `count` kroků `witness.ops` (výchozí všechny); po
   * posledním dotočí běh do konce. `last` je akce posledního zahraného kroku.
   */
  playWitness(count?: number): { readonly runState: string; readonly tick: number; readonly last: string | null; readonly left: number };
  /**
   * Cíle, na které jde klepnout, v pixelech okna (P28C T4) – táž projekce, kterou
   * vybírá klepnutí na plátno; cíl zakrytý kartou nebo HUD tu není. Pořadí: jak na ně
   * sahá svědek světa, zbytek za nimi.
   */
  targets(): readonly { readonly id: string; readonly x: number; readonly y: number }[];
  /** Pustí hodiny jako ťuk na prázdnou scénu (P33 T11) – e2e, které čekají na běžící hru. */
  start(): void;
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
  // Restart z HUD (P34 T5) je nová relace runtime: `observeAt(0)` by přehrál hráčův záznam, ne začal znovu.
  const [controller, setController] = useState(() => bindRuntime(null, versionId, blueprint.world).controller);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Pauza (P34 T5): karta pauzy, list „About“ nad ní, nebo list „Change one thing“ – hodiny i vstupy stojí.
  const [paused, setPaused] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [changing, setChanging] = useState<'play' | 'pause' | null>(null);
  const frozen = paused || changing !== null;
  useEffect(() => {
    controller.setPaused(frozen);
  }, [controller, frozen]);
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const kinds = useMemo(() => roleKinds(spec, blueprint.world.sim), [spec, blueprint]);
  const avoid = useMemo(() => avoidCards(kinds, blueprint.objects), [kinds, blueprint]);
  // Nepřítel (P33 T6) kartu nedostane – ani číslo klávesy, ani klepnutí na plátně.
  const cards = useMemo(
    () => targetCards(controller.actions, blueprint.objects, new Set([...idleProps(spec, blueprint.world.sim), ...avoid.map((enemy) => enemy.id)])),
    [controller, blueprint, spec, avoid],
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

  // Hodiny hry: běží, dokud hra běží, svět stojí, záložka je vidět a hráč se už dotkl
  // (P33 T11) – liška by jinak prohrála dřív, než hráč najde první vejce. Replay po hře
  // přehrává hráčův vlastní záznam a klik na něj je vstup hráče, proto hodiny pouští sám.
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    if (!running || !built || waiting || frozen) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') controller.advanceTicks(1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [controller, running, built, waiting, frozen]);
  // První dotek: ťuk na scénu nebo kartu cíle, nebo klávesa – v zachytávací fázi, před akcí karty.
  useEffect(() => {
    if (!waiting) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="play-grid-stage"], .play-targets') !== null) setWaiting(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (wakesGame(event)) setWaiting(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [waiting]);

  const send = useCallback((action: RuntimeAction | null, nextSelected: string) => {
    setSelected(nextSelected);
    pending.current = null;
    if (action !== null) controller.dispatch(action);
  }, [controller]);

  // Klepnutí na plátno (P28C T4): nejbližší cíl, dojdi a seber (nebo použij) jedním
  // klepnutím. Druhá akce počká, až hráč dojde – o vzdálenosti a zámcích dál rozhoduje runtime.
  const project = useRef<ProjectTarget | null>(null);
  const pending = useRef<{ readonly action: RuntimeAction; readonly after: number } | null>(null);
  const slots = useMemo(
    () => new Map(blueprint.objects.map((object) => [object.binding?.entityId ?? object.stableId, object.stableId] as const)),
    [blueprint],
  );
  // Zem a kulisy podle místa z věty (P30B T6): deska pod hrou i plocha za ní.
  const scene = useMemo(() => sceneLook(spec.theme), [spec.theme]);
  const goTo = useCallback((card: TargetCard) => {
    send(card.moveTo, card.id);
    if (card.second !== null) pending.current = { action: card.second, after: controller.getSnapshot().tick };
  }, [controller, send]);
  useEffect(() => {
    const actor = playerActor(controller.actions);
    let still = 0;
    let lastAt = '';
    let watching: object | null = null;
    return controller.subscribe(() => {
      const next = pending.current;
      const now = controller.getSnapshot();
      if (next === null || actor === null || now.tick <= next.after || !now.canInput) return;
      if (watching !== next) {
        watching = next;
        still = 0;
        lastAt = '';
      }
      const player = now.entities.find((entity) => entity.stableId === actor);
      const at = player === undefined ? '' : `${player.x},${player.y}`;
      still = at === lastAt ? still + 1 : 0;
      lastAt = at;
      // Hráč došel (runtime vynuluje cíl chůze), nebo uvízl u cíle a dál nejde – o dosahu rozhodne runtime.
      if (now.values[`e:${actor}:moveTo`] !== 0 && still < STALL_TICKS) return;
      pending.current = null;
      controller.dispatch(next.action);
    });
  }, [controller]);
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const nearestCard = (x: number, y: number): TargetCard | null => {
    let best: TargetCard | null = null;
    let bestDistance = TAP_RADIUS_PX;
    for (const card of cards) {
      const at = project.current?.(card.id);
      if (at === null || at === undefined) continue;
      const distance = Math.hypot(at.x - x, at.y - y);
      if (distance <= bestDistance) {
        best = card;
        bestDistance = distance;
      }
    }
    return best;
  };

  // Zvuk a „+1“ (P28C T2/T3): čítač cíle hry povyskočil → sebrání; konec běhu → výhra či prohra.
  const [pops, setPops] = useState<readonly { readonly id: number; readonly amount: number; readonly x: number | null; readonly y: number | null }[]>([]);
  useEffect(() => installSoundControls(), []);
  // Vlastní hudba a zvuky looku (P29D T5); bez gesta nic nestahuje.
  useEffect(() => {
    setSoundLook(lookOf(spec.theme));
    const stop = playMusic(musicFor(spec.theme));
    return () => {
      stop();
      setSoundLook(null);
    };
  }, [spec.theme]);
  useEffect(() => {
    const counter = objectiveCounter(spec);
    const read = (): number => (counter === null ? 0 : (controller.getSnapshot().values[`c:${counter}`] ?? 0));
    let last = read();
    let lastState = controller.getSnapshot().runState;
    let next = 0;
    const timers = new Set<number>();
    const off = controller.subscribe(() => {
      const value = read();
      const runState = controller.getSnapshot().runState;
      const gained = value - last;
      const ended = lastState === 'running' && runState !== 'running';
      last = value;
      lastState = runState;
      if (witnessed.current) return;
      if (ended) playSfx(runState === 'won' ? 'win' : 'lose');
      else if (gained > 0) playSfx('pickup');
      if (gained > 0) {
        // Nad hráčem – sebraný objekt už runtime schoval.
        const actor = playerActor(controller.actions);
        const at = actor === null ? null : (project.current?.(actor) ?? null);
        const pop = { id: (next += 1), amount: gained, x: at?.x ?? null, y: at?.y ?? null };
        setPops((current) => [...current, pop]);
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          setPops((current) => current.filter((entry) => entry.id !== pop.id));
        }, SCORE_POP_MS);
        timers.add(timer);
      }
    });
    return () => {
      off();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [controller, spec]);

  // Klávesy 1–9 / mezerník / E jako záloha za karty – jen dokud hra běží (P28B T3).
  // Použitou klávesu hra zabere (`preventDefault`), takže mezerník sebrání pauzu nezapne.
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
      start: () => setWaiting(false),
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
      targets: () => {
        const order = [...new Set(witnessOps(blueprint.world.sim.witness).map((op) => op.action.target).filter((id) => id !== undefined))];
        const rank = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length);
        return [...cards]
          .sort((a, b) => rank(a.id) - rank(b.id))
          .flatMap((card) => {
            const at = project.current?.(card.id) ?? null;
            // Jen cíl, na který klepnutí doopravdy dopadne na plátno – ne pod kartu nebo HUD.
            const reachable = at !== null && document.elementFromPoint(at.x, at.y)?.closest('[data-testid="play-grid-stage"]') != null;
            return at === null || !reachable ? [] : [{ id: card.id, x: at.x, y: at.y }];
          });
      },
    };
    window.__playShell = probe;
    return () => {
      if (window.__playShell === probe) delete window.__playShell;
    };
  }, [controller, blueprint, cards]);

  // Nová relace od tiku 0 (P34 T5). Restart z HUD a z karty pauzy čeká na první dotek;
  // nový pokus z výsledku (P36B T3) běží hned jako dřív – jen už nepřehrává prohraný záznam.
  const startOver = useCallback(
    (wait: boolean) => {
      if (!witnessed.current) loopEvent('restart', versionId);
      witnessed.current = false;
      pending.current = null;
      setSelected(null);
      setPops([]);
      setPaused(false);
      setWaiting(wait);
      setController(bindRuntime(null, versionId, blueprint.world).controller);
    },
    [versionId, blueprint],
  );
  const restart = useCallback(() => startOver(true), [startOver]);
  useHudKeys(running && built && changing === null && !aboutOpen, () => paused, (action) => {
    if (action === 'restart') restart();
    else setPaused(action === 'pause');
  });

  // Štítky ve světě (kit `.sp-world-tag`): nepřítel rajčatově, kam hra vede slunečně – jména z blueprintu, nic vymyšleného.
  const tagLayer = useRef<HTMLDivElement>(null);
  const worldTags = useMemo(
    () =>
      [
        ...avoid.map((enemy) => ({ id: enemy.id, text: capital(enemy.label), goal: false })),
        ...cards.filter((card) => GOAL_TAG_KINDS.has(kinds.get(card.id) ?? '')).map((card) => ({ id: card.id, text: capital(card.label), goal: true })),
      ].slice(0, MAX_TAGS),
    [avoid, cards, kinds],
  );
  const cardShown = paused && running && changing === null && !aboutOpen;

  return (
    // Pod plátnem obloha sady jako u arkády (P32D T6, P33 T14): do prvního snímku ne tmavá plocha.
    <main className="play-shell play-shell-grid" style={{ '--_sky': scene.sky } as CSSProperties}>
      <div
        className="play-stage"
        aria-hidden="true"
        data-testid="play-grid-stage"
        onPointerDown={(event) => {
          tapStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = tapStart.current;
          tapStart.current = null;
          if (start === null || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
          if (!snapshot.canInput || !built) return;
          const card = nearestCard(event.clientX, event.clientY);
          if (card !== null) goTo(card);
        }}
      >
        <WorldstreamCanvas world={world} controller={controller} sceneId={versionId} framing="scene" guide={false} ground={scene.ground}>
          <TapTargets slots={slots} project={project} tags={tagLayer} />
          {built && blueprint.world.sim !== null && (
            <>
              <GridScenery look={scene} {...gridOf(blueprint.world.sim)} />
              <PatrolSight sim={blueprint.world.sim} controller={controller} />
              <OrderBubbles sim={blueprint.world.sim} roles={spec.roles} controller={controller} />
            </>
          )}
        </WorldstreamCanvas>
        {built && running && worldTags.length > 0 && (
          <div ref={tagLayer} className="play-world-tags" data-testid="play-world-tags">
            {/* Skryté, dokud je `TapTargets` neposadí nad objekt. */}
            {worldTags.map((tag) => (
              <span key={tag.id} className={tag.goal ? 'sp-world-tag sp-world-tag--goal' : 'sp-world-tag'} data-tag-for={tag.id} style={{ visibility: 'hidden' }}>
                {tag.text}
              </span>
            ))}
          </div>
        )}
        {pops.map((pop) => (
          <span
            key={pop.id}
            className="play-score-pop"
            data-testid="score-pop"
            style={{ left: pop.x === null ? '50%' : `${pop.x}px`, ...(pop.y === null ? {} : { top: `${pop.y - 48}px` }) }}
          >
            +{pop.amount}
          </span>
        ))}
      </div>
      {/* HUD kitu (P34 T5): lišta cílů a stav AI verze jsou kusy jeho vrstvy, ať na desktopu sedí na scéně 16:9. */}
      <Hud
        spec={spec}
        snapshot={snapshot}
        paused={paused}
        onPause={running && built ? () => setPaused(true) : undefined}
        bottom={
          running &&
          built && (
            <>
              <button type="button" className="sp-hud-btn play-hud-round" data-testid="play-hud-restart" aria-label="Restart" title="Restart (R)" onClick={restart}>
                <Icon name="restart" />
              </button>
              <Button variant="secondary" className="play-hud-change" data-testid="play-change" aria-haspopup="dialog" onClick={() => setChanging('play')}>
                <Icon name="wand" />
                {CHANGE_LABEL}
              </Button>
              {/* Sdílení po dohrání nese `PostRun`. */}
              <ShareButton versionId={versionId} title={spec.title} variant="hud" className="play-hud-share" />
            </>
          )
        }
      >
        {running && (
          <TargetCards cards={cards} avoid={avoid} kinds={kinds} selected={selected} disabled={!snapshot.canInput || !built} onTap={(card) => {
            const hit = tapAction(card, selected);
            send(hit.action, hit.selected);
          }} />
        )}
        <UpgradeBanner request={upgrade} sentence={read.sentence} />
        {running && <RemixReadyChip job={remix} />}
      </Hud>
      {running && waiting && <FirstPrompt controlsHint={spec.tutorial.controlsHint} keys="or press the number on a card" />}
      <Lineage lineage={lineage} remixes={remixes} aiVersion={aiVersion} />
      <SentenceRead read={read} open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <HowItWorks facts={lab} versionId={versionId} lineage={lineage} />
      {!built && fault === null && (
        <div className="play-building" data-testid="play-building">
          <BuildingScreen />
        </div>
      )}
      {fault !== null && (
        <p className="play-alert" role="alert">This game could not be built: {fault}</p>
      )}
      {cardShown && (
        <PauseCard onResume={() => setPaused(false)} onRestart={restart} onChange={() => setChanging('pause')} controlsHint={spec.tutorial.controlsHint}>
          <MuteButton />
          <AboutButton onOpen={() => setAboutOpen(true)} />
          <MoreGames />
        </PauseCard>
      )}
      {/* „Change one thing“ během hry (P34 T5): remix na novou verzi, hra zatím stojí. Z karty pauzy se na ni vrací. */}
      <Sheet open={changing !== null} title={CHANGE_LABEL} onClose={() => setChanging(null)}>
        <RemixBox job={remix} />
      </Sheet>
      {/* Výsledek kitu (P34 T6): zamrzlá scéna nahoře, list s nadpisem, statistikami a akcemi. */}
      {!running && (
        <PostRun
          versionId={versionId}
          remix={remix}
          facts={gridFacts(spec, snapshot)}
          onReplay={() => startOver(false)}
        />
      )}
    </main>
  );
}
