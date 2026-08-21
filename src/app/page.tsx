'use client';

/**
 * Úvodní stránka — věta dovnitř, svět ven, a od T19 se ten svět dá hrát.
 *
 * Prompt a plátno drží jedna komponenta, protože mezi nimi teče přesně jedna
 * hodnota: emise. `PromptBar` ji přinese z `/api/generate`, tady se z ní postaví
 * běh a `Stage` ho hraje.
 *
 * Svět se staví `buildRuntimeWorld`, tedy **tímtéž vstupním bodem**, jakým prošel
 * certifikát na serveru. Kdyby si stránka stavěla svět po svém, hrála by něco
 * jiného, než co verifikátor prohlásil za platné.
 *
 * ## Proč ovládání bydlí tady, a ne v plátně
 *
 * Stisk klávesy musí skončit ve **stopě téhož běhu**, který je vidět — jinak by
 * se hrálo jedno a měřilo druhé. Stránka proto drží frontu stisků
 * (`src/game/flow.ts`) a plátno si od ní bere vstupy tik po tiku; běh zůstává
 * funkcí `(dokument, stopa)` a restart se dá přehrát na tentýž hash.
 *
 * ## Model se stahuje vedle, ne místo
 *
 * `<ModelProgress />` je jediná věc, která na téhle stránce sahá na váhy — a
 * sahá na ně **až po prvním snímku**, ve vlastním efektu. Stránka na něj nikde
 * nečeká: rozpoznávač tvarů model nepotřebuje, takže věta se dá napsat a svět
 * postavit dřív, než se stáhne první bajt.
 *
 * **Hotový model zatím nikdo nepoužívá**, a je to tak napsané schválně, ne
 * omylem: `onReady` se nepředává a `emitWith()` nemá v produktu volajícího.
 * Jestli se model má do hlavní cesty zapojit, nebo se má naopak přestat
 * stahovat, je otevřené produktové rozhodnutí — souvisí s tím, co má stránka
 * udělat s větou, kterou rozpoznávač nezná.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ModelProgress from '@/components/hud/ModelProgress';
import Program from '@/components/pipeline/Program';
import Timeline from '@/components/pipeline/Timeline';
import WitnessPreview from '@/components/pipeline/WitnessPreview';
import PromptBar from '@/components/PromptBar';
import type { RunnerRef } from '@/components/viewer/WorldScene';
import {
  actorOf,
  arrivedAt,
  createControls,
  phaseOf,
  playableTargets,
  type GamePhase,
} from '@/game/flow';
import { buildRuntimeWorld } from '@/ir/build';
import type { TraceInput, WorldDocRuntime } from '@/sim/interpreter';

declare global {
  interface Window {
    /**
     * Hra, jak ji vidí zvenčí. Každá odpověď se počítá z hraného běhu na plátně,
     * ne z druhého runtimu vedle — jinak by odpovídala o jiné hře, než jakou má
     * divák před sebou.
     */
    __game?: {
      /** Fáze teď. */
      state: () => GamePhase;
      /** Fáze v pořadí, ve kterém nastaly. Vzorkuje se každý snímek. */
      seen: () => readonly GamePhase[];
      /** Cíle v pořadí kláves 1 až 9. */
      targets: () => readonly string[];
      /** Naposledy vybraný cíl. */
      selected: () => string | null;
      /** Stojí hráč na vybraném cíli? */
      arrived: () => boolean;
      /** Hash stavu hraného běhu. */
      hash: () => string;
      /** Co hráč zahrál, s tiky. Přehráním vznikne týž běh. */
      inputs: () => readonly TraceInput[];
      /** Znovu od začátku, týž dokument. */
      restart: () => void;
    };
  }
}

// ssr: false je povinné, ne kosmetické — WebGL kontext na serveru neexistuje
// a `<Canvas>` by při SSR spadl na `document`.
const Stage = dynamic(() => import('@/components/Stage'), { ssr: false });

/**
 * Emise → běh, nebo `null`.
 *
 * Emise, ze které se svět postavit nedá, je normální odpověď modelu, ne výjimka:
 * `/api/generate` vrací emisi tak, jak přišla, a validuje se až tady. Plátno pak
 * zůstane prázdné a uživatel dostane hlášku místo pádu.
 */
function worldFrom(emission: unknown): WorldDocRuntime | null {
  const sim = (emission as { sim?: unknown } | null)?.sim;
  if (sim === undefined || sim === null) return null;

  const built = buildRuntimeWorld(sim);
  return built.ok ? built.world : null;
}

/**
 * Dolní rohy jsou **sloupce, ne hromada**.
 *
 * Čtyři panely se dřív kotvily samy a dva páry z nich seděly na stejném místě se
 * stejným `zIndex`: program s časovou osou vlevo, náhled vítězné cesty s
 * ukazatelem stahování modelu vpravo. U levého páru to nebyla kosmetika —
 * **sbalený panel programu se schoval pod časovou osu a nešel rozbalit**, což je
 * na demu přesně ten pohyb, kvůli kterému se panel sbaluje. Naměřeno
 * `e2e/pipeline-panel.spec.ts`: klik na přepínač hlásil, že ho `timeline-branch`
 * přebírá.
 *
 * Sloupec je průchozí pro kurzor (`pointerEvents: 'none'`) a každý panel si
 * průchodnost vypíná sám. Bez toho by mezera mezi panely byla neviditelný pruh,
 * který bere kliknutí do plátna — táž vada o patro níž.
 */
const CORNER_BASE: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  maxHeight: 'calc(100dvh - 2rem)',
  pointerEvents: 'none',
};

const CORNER_LEFT: React.CSSProperties = { ...CORNER_BASE, left: '1rem', alignItems: 'flex-start' };

const CORNER_RIGHT: React.CSSProperties = { ...CORNER_BASE, right: '1rem', alignItems: 'flex-end' };

export default function Page() {
  const [world, setWorld] = useState<WorldDocRuntime | null>(null);
  const [broken, setBroken] = useState(false);
  // Dvě emise v JEDNOM stavu, ne dva stavy vedle sebe: panel překladu ukazuje
  // ROZDÍL proti minulé větě, a posun "současná se stane minulou" musí být jeden
  // atomický krok. Dvě `useState` by ho složily ze dvou zápisů čtoucích zachycenou
  // hodnotu z minulého renderu — tedy z místa, kde se dá minout právě ta emise,
  // proti které se má porovnávat.
  const [programs, setPrograms] = useState<{ readonly current: unknown; readonly previous: unknown }>({
    current: null,
    previous: null,
  });

  const runnerRef = useRef<RunnerRef['current']>(null);
  const controls = useMemo(createControls, []);
  const seen = useRef<GamePhase[]>([]);

  const actor = world === null ? null : actorOf(world);
  const targets = useMemo(() => (world === null ? [] : playableTargets(world)), [world]);

  const inputs = useCallback(
    (tick: number) => (actor === null ? [] : controls.take(tick, actor)),
    [actor, controls],
  );

  const phase = useCallback((): GamePhase => {
    const runner = runnerRef.current;
    const assembly = runner?.assembly();
    return phaseOf({
      hasWorld: world !== null && runner !== null,
      revealed: assembly?.revealed ?? 0,
      total: assembly?.total ?? 1,
      runState: runner?.runState() ?? 'running',
    });
  }, [world]);

  /**
   * Zapíše fázi do záznamu, když je jiná než naposledy. Volá se ze DVOU míst a obě
   * jsou potřeba: z vlastního vzorkování po snímcích, a z každého dotazu zvenčí.
   *
   * **Vzorkování po snímcích samo nestačí, a je to naměřené.** Při softwarovém
   * vykreslování (SwiftShader v e2e) trvá snímek stovky milisekund, a hodiny
   * simulace v jednom snímku doženou celou dávku zameškaných tiků. Fáze, která
   * začne a skončí uvnitř jedné takové dávky, mezi dvěma snímky prostě není —
   * záznam pak přeskočí `playing` nebo `won`. Dotaz na `state()` proto zapisuje taky:
   * kdo se ptá, ten fázi viděl, a záznam říká právě tohle — kudy hra prokazatelně
   * prošla, ne kudy se dá tušit, že asi šla.
   */
  const record = useCallback((): GamePhase => {
    const now = phase();
    if (seen.current[seen.current.length - 1] !== now) seen.current.push(now);
    return now;
  }, [phase]);

  // Vzorkování je MIMO hashovaný stav, ve stejné kategorii jako kamera nebo
  // částice: nic z toho nevstupuje do tiku, takže tu smí běžet skutečný
  // `requestAnimationFrame`.
  useEffect(() => {
    let frame = requestAnimationFrame(function sample() {
      record();
      frame = requestAnimationFrame(sample);
    });
    return () => cancelAnimationFrame(frame);
  }, [record]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Psaní věty není hraní. Bez téhle podmínky by číslice napsaná do promptu
      // poslala postavu pryč a mezerník mezi slovy by zvedal předměty.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (controls.press(event.key, targets) !== null) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controls, targets]);

  const restart = useCallback(() => {
    controls.reset();
    // Nový OBJEKT téhož dokumentu. `WorldScene` si běh, scénu i rozvrh stavby drží
    // podle identity `world`, takže restart bez nové identity by jen vysypal frontu
    // a nechal rozehraný svět běžet dál.
    setWorld((was) => (was === null ? null : { ...was }));
  }, [controls]);

  useEffect(() => {
    window.__game = {
      state: record,
      seen: () => [...seen.current],
      targets: () => targets,
      selected: controls.selected,
      arrived: () => {
        const selected = controls.selected();
        const runner = runnerRef.current;
        if (selected === null || runner === null || actor === null) return false;
        return arrivedAt(runner.entities(), actor, selected);
      },
      hash: () => runnerRef.current?.hash() ?? '',
      inputs: () => controls.log(),
      restart,
    };
    return () => {
      delete window.__game;
    };
  }, [actor, controls, record, restart, targets]);

  return (
    <main style={{ position: 'relative', height: '100dvh', width: '100vw' }}>
      <PromptBar
        onWorld={(next) => {
          const built = worldFrom(next);
          controls.reset();
          setBroken(built === null);
          setWorld(built);
          setPrograms((was) => ({ current: next, previous: was.current }));
        }}
      />
      {broken ? (
        <p data-testid="world-broken" role="alert" style={BROKEN}>
          Model vrátil svět, který se nedá spustit.
        </p>
      ) : null}
      {world === null ? null : <GameControls targets={targets} onRestart={restart} />}
      <div style={CORNER_LEFT}>
        <Program emission={programs.current} previous={programs.previous} />
        <Timeline world={world} />
      </div>
      <div style={CORNER_RIGHT}>
        <WitnessPreview world={world} />
        <ModelProgress />
      </div>
      <Stage world={world} inputs={inputs} runnerRef={runnerRef} />
    </main>
  );
}

/**
 * Nápověda ovládání.
 *
 * Bez ní je místnost hratelná jen pro toho, kdo četl zdroják: cíle pojmenoval svět,
 * takže je divák nemá odkud znát. Vypisuje se proto to, co svět doopravdy nabízí,
 * ne pevný seznam kláves.
 */
function GameControls({
  targets,
  onRestart,
}: {
  readonly targets: readonly string[];
  readonly onRestart: () => void;
}) {
  return (
    <div data-testid="game-controls" style={PANEL}>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {targets.map((target, at) => (
          <li key={target} data-testid="game-target">
            <kbd style={KEY}>{at + 1}</kbd> jdi k <strong>{target}</strong>
          </li>
        ))}
      </ol>
      <p style={{ margin: '0.4rem 0 0' }}>
        <kbd style={KEY}>mezerník</kbd> seber &middot; <kbd style={KEY}>E</kbd> použij
      </p>
      <button type="button" data-testid="game-restart" onClick={onRestart} style={BUTTON}>
        Od začátku
      </button>
    </div>
  );
}

const BROKEN: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2,
  margin: 0,
  color: '#e8a33d',
};

const PANEL: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  left: '1rem',
  zIndex: 2,
  padding: '0.6rem 0.75rem',
  borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.82)',
  color: '#cfe3e6',
  font: '13px/1.5 ui-monospace, monospace',
};

const KEY: React.CSSProperties = {
  padding: '0 0.3rem',
  borderRadius: 3,
  background: '#1d2b2f',
  color: '#7fd4c1',
};

const BUTTON: React.CSSProperties = {
  marginTop: '0.5rem',
  padding: '0.25rem 0.6rem',
  border: '1px solid #2c4147',
  borderRadius: 4,
  background: '#132022',
  color: '#cfe3e6',
  cursor: 'pointer',
  font: 'inherit',
};
