'use client';

/**
 * HUD a scéna fallbacku. Prezentační vrstva — rozhoduje se v `router.ts`, počítá
 * se v `loop.ts`, tady se to jen kreslí.
 *
 * Importuje **jen kit**, nikdy moduly jádra (axiom architektonické nezávislosti
 * — jejich cesty se v tomhle adresáři nepíšou, viz `loop.ts`). Proto tu není
 * `components/Stage.tsx`: to plátno na jádro sahá.
 *
 * Žádný `<Environment preset>` z drei: stahoval by HDRI za běhu a rozbil by
 * „žádný loading screen". Světlo je ruční, kusy generuje kód.
 */

import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';

import { buildLayoutScene, layoutById } from '../kit';
import { TICK_HZ, type GameView } from './loop';
import type { NoFitDecision, RouteDecision } from './router';

/** Scéna z kitu. Když by layout neexistoval, je to chyba dat, ne stav k vykreslení. */
export function FallbackScene({ layoutId }: { layoutId: string }) {
  const scene = useMemo(() => {
    const layout = layoutById(layoutId);
    if (layout === undefined) {
      throw new Error(`fallback odkazuje na neznámý layout ${layoutId}`);
    }
    return buildLayoutScene(layout);
  }, [layoutId]);

  return (
    <Canvas
      data-testid="fallback-canvas"
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ position: [7, 7, 9], fov: 45 }}
    >
      <ambientLight intensity={0.65} />
      <directionalLight position={[5, 8, 4]} intensity={1.3} />
      <primitive object={scene} />
    </Canvas>
  );
}

const OVERLAY: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: '0.9rem',
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  fontFamily: 'system-ui, sans-serif',
  color: '#e8efee',
  textShadow: '0 1px 3px rgba(0,0,0,0.75)',
};

const BANNER: Record<GameView['phase'], string> = {
  running: '',
  won: 'Vyhráno',
  lost: 'Prohráno',
};

/** Cíl, počítadla, čas a stav hry. Čte jen `GameView`, nikdy vnitřní stav hry. */
export function Hud({ view }: { view: GameView }) {
  const seconds = view.timeLeftTicks === null ? null : Math.ceil(view.timeLeftTicks / TICK_HZ);

  return (
    <div style={OVERLAY} data-testid="fallback-hud">
      <strong data-testid="hud-goal">{view.goal}</strong>
      <div style={{ display: 'flex', gap: '1rem' }}>
        {view.counters.map((counter) => (
          <span key={counter.label} data-testid={`hud-counter-${counter.label}`}>
            {counter.label}: {counter.value}
            {counter.max === null ? '' : ` / ${counter.max}`}
          </span>
        ))}
        {seconds === null ? null : <span data-testid="hud-time">Čas: {seconds} s</span>}
      </div>
      {view.phase === 'running' ? null : (
        <p data-testid="hud-banner" style={{ fontSize: '1.5rem', margin: 0 }}>
          {BANNER[view.phase]}
        </p>
      )}
      {view.message === null ? null : <p style={{ margin: 0 }}>{view.message}</p>}
    </div>
  );
}

/**
 * Přiznané `NO_FIT`. Věta je odvozená z rozdílu množin (`ARCHETYPES.md` §5),
 * takže nemůže tvrdit, že systém umí něco, co manifest nemá.
 *
 * **Vždycky nad scénou z kitu, nikdy nad prázdnou obrazovkou** — `DESIGN-BOOK.md`
 * §13.4. Fallback, který na nesplnitelný prompt ukáže černo, by byl horší než
 * věc, kterou nahrazuje.
 */
export function NoFitNotice({ decision }: { decision: NoFitDecision }) {
  return (
    <div style={OVERLAY} data-testid="fallback-no-fit">
      <strong>Tenhle prompt neumím celý</strong>
      <p style={{ margin: 0, maxWidth: '46ch' }} data-testid="no-fit-reason">
        {decision.reason}
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {decision.blocking.map((token) => (
          <li key={token} data-testid={`no-fit-token-${token}`}>
            {token}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Celá obrazovka fallbacku. Scéna se kreslí v obou větvích rozhodnutí — tohle
 * je místo, kde se garance „`NO_FIT` není prázdná obrazovka" drží konstrukčně,
 * ne slibem.
 */
export function FallbackStage({
  decision,
  view,
}: {
  decision: RouteDecision;
  view: GameView | null;
}) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <FallbackScene layoutId={decision.sceneLayout} />
      {decision.kind === 'no_fit' ? (
        <NoFitNotice decision={decision} />
      ) : view === null ? null : (
        <Hud view={view} />
      )}
    </div>
  );
}
