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

/**
 * Třídy z `theme.css`, ne inline styl.
 *
 * Jméno třídy je obyčejný řetězec, takže tenhle soubor pořád nic neimportuje
 * mimo kit — důkaz izolace platí dál. Barvy tím ale drží tatáž paleta jako
 * zbytek produktu, včetně varianty pro barvoslepé.
 */

const BANNER: Record<GameView['phase'], string> = {
  running: '',
  won: 'Vyhráno',
  lost: 'Prohráno',
};

/** Cíl, počítadla, čas a stav hry. Čte jen `GameView`, nikdy vnitřní stav hry. */
export function Hud({ view }: { view: GameView }) {
  const seconds = view.timeLeftTicks === null ? null : Math.ceil(view.timeLeftTicks / TICK_HZ);

  return (
    <div className="ws-overlay" data-testid="fallback-hud">
      <strong className="ws-hud-goal" data-testid="hud-goal">{view.goal}</strong>
      <div className="ws-hud-row">
        {view.counters.map((counter) => (
          <span key={counter.label} data-testid={`hud-counter-${counter.label}`}>
            {counter.label}: {counter.value}
            {counter.max === null ? '' : ` / ${counter.max}`}
          </span>
        ))}
        {seconds === null ? null : <span data-testid="hud-time">Čas: {seconds} s</span>}
      </div>
      {view.phase === 'running' ? null : (
        <p className="ws-hud-banner" data-phase={view.phase} data-testid="hud-banner">
          {BANNER[view.phase]}
        </p>
      )}
      {view.message === null ? null : <p className="ws-hud-message">{view.message}</p>}
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
    <div className="ws-overlay" data-testid="fallback-no-fit">
      <strong>Tenhle prompt neumím celý</strong>
      <p className="ws-no-fit-reason" data-testid="no-fit-reason">
        {decision.reason}
      </p>
      <ul className="ws-no-fit-list">
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
