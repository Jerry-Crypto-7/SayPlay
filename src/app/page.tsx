'use client';

/**
 * Úvodní stránka — věta dovnitř, svět ven, a od T19 se ten svět dá hrát.
 *
 * Prompt a plátno drží jedna komponenta, protože mezi nimi teče přesně jedna
 * hodnota: emise. `PromptBar` ji vybere z korpusu, rozpoznávače nebo lokálního
 * modelu, tady se z ní postaví běh a `Stage` ho hraje.
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
 * ## Model je třetí cesta, ne vstupní závora (P12 V1 T9)
 *
 * Po zmrazeném korpusu a deterministickém rozpoznávači dostane neznámou větu
 * model v prohlížeči. Jeho naměřený medián je 33,9 s, takže se na něj nesmí
 * čekat s prvním světem: nejdřív stojí hratelná a pravdivě označená náhradní
 * místnost, kterou certifikovaná modelová emise později transakčně nahradí.
 *
 * `ModelProgress` nejdřív zdarma ověří WebGPU. Teprve kladný probe smí načíst
 * WebLLM a váhy; na stroji bez akcelerace neodejde jediný jejich bajt. Hotový
 * engine vede přes `PromptBar` do produkčního `emitLocally()`, takže panel už
 * neplatí cenu bez volajícího. Měří to `e2e/model-wired.spec.ts`.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import FirstRun from '@/components/hud/FirstRun';
import ModelProgress, { type ModelPhase, type ModelState } from '@/components/hud/ModelProgress';
import RepairRounds from '@/components/hud/RepairRounds';
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
import type { ChatEngine } from '@/model/local/engine';
import type { EmissionSource } from '@/model/source';
import type { Round } from '@/model/local/emit';
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
 * Emise, ze které se svět postavit nedá, je normální odpověď některé vstupní
 * cesty, ne výjimka: dokument se validuje až tady. Plátno pak zůstane prázdné
 * a uživatel dostane hlášku místo pádu.
 */
function worldFrom(emission: unknown): WorldDocRuntime | null {
  const sim = (emission as { sim?: unknown } | null)?.sim;
  if (sim === undefined || sim === null) return null;

  const built = buildRuntimeWorld(sim);
  return built.ok ? built.world : null;
}

/**
 * Výtvarná část emise. Vybírá rodinu kulisy (`chooseFamily`) a je to **odkaz do
 * uloženého objektu**, ne nová hodnota — kdyby vznikala při každém renderu,
 * `WorldScene` by přestavovala scénu pořád dokola.
 */
function lookOf(emission: unknown): unknown {
  return (emission as { look?: unknown } | null)?.look ?? null;
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
 *
 * **Potřetí, 25. 8. 2026: herní HUD (`GameControls`) do sloupce nepatřil.** Kotvil
 * se sám na `bottom/left: 1rem`, tedy do téhož rohu, a protože sloupec stojí
 * v DOM za ním, lehla si časová osa navrch: `elementFromPoint` ve středu
 * `game-restart` vracel `timeline-outcome`, takže **restart nešlo kliknout**.
 * Vada přežila proto, že se soudila jako kosmetika. Hlídá ji od té doby
 * `e2e/pipeline-panel.spec.ts` zásahovou zkouškou nad celým rohem — nový panel
 * patří do sloupce a do toho seznamu, ne na vlastní `position: absolute`.
 */
const CORNER_BASE: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  // Horní pruh patří vstupu, ne panelům. `PromptBar` roste dolů, kdykoli k větě
  // něco říká — po nepřečtené větě přibude řádek o náhradní místnosti i nabídka
  // záložní větve — a zároveň teď taková věta staví svět, takže panely stojí.
  // Naměřeno `e2e/prompt-to-world.spec.ts`: nadpis panelu programu zachytával
  // klik do odkazu na záložní větev.
  maxHeight: 'calc(100dvh - 17rem)',
  pointerEvents: 'none',
};

const CORNER_LEFT: React.CSSProperties = { ...CORNER_BASE, left: '1rem', alignItems: 'flex-start' };

const CORNER_RIGHT: React.CSSProperties = { ...CORNER_BASE, right: '1rem', alignItems: 'flex-end' };

export default function Page() {
  const [world, setWorld] = useState<WorldDocRuntime | null>(null);
  const [broken, setBroken] = useState(false);
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [modelPhase, setModelPhase] = useState<ModelPhase>('probing');
  /**
   * Kola opravné smyčky poslední věty. Prázdné, dokud model neběžel.
   *
   * Bydlí tady, ne v `PromptBar`, protože panel patří do pravého sloupce —
   * kotvit se sám mu `CORNER_RIGHT` zakazuje a dvakrát to už stálo několik dní
   * červené e2e sady.
   */
  const [rounds, setRounds] = useState<readonly Round[]>([]);
  // Dvě emise v JEDNOM stavu, ne dva stavy vedle sebe: panel překladu ukazuje
  // ROZDÍL proti minulé větě, a posun "současná se stane minulou" musí být jeden
  // atomický krok. Dvě `useState` by ho složily ze dvou zápisů čtoucích zachycenou
  // hodnotu z minulého renderu — tedy z místa, kde se dá minout právě ta emise,
  // proti které se má porovnávat.
  const [programs, setPrograms] = useState<{
    readonly current: unknown;
    readonly previous: unknown;
    readonly source: EmissionSource | null;
  }>({
    current: null,
    previous: null,
    source: null,
  });

  const runnerRef = useRef<RunnerRef['current']>(null);
  const controls = useMemo(createControls, []);
  const seen = useRef<GamePhase[]>([]);

  const acceptWorld = useCallback(
    (next: unknown, nextSource: EmissionSource): void => {
      const built = worldFrom(next);
      controls.reset();
      setBroken(built === null);
      setWorld(built);
      setPrograms((was) => ({ current: next, previous: was.current, source: nextSource }));
    },
    [controls],
  );

  // Stabilní identity jsou součást správnosti: `ModelProgress` má callbacky v
  // závislostech efektu. Inline funkce by při každém renderu zrušila právě
  // běžící probe nebo download a začala znovu.
  const acceptEngine = useCallback((next: ChatEngine): void => setEngine(next), []);
  const acceptModelState = useCallback((next: ModelState): void => setModelPhase(next.phase), []);

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
    // **Uvolnit starý běh dřív, než se vymění svět.** `phaseOf()` odpovídá `won`
    // dřív, než se vůbec podívá na rozvrh stavby (a je to tak schválně, drží to
    // zelený test v `src/game/__tests__/flow.test.ts`). Restart se ale dělá po
    // dohrané partii, takže dokud tady visí vyhraný běh, čte se fáze z něj:
    // záznam zůstane stát na `won`, druhé `building` se nikdy nezapíše a
    // `e2e/playable-loop.spec.ts` na něj čeká marně. Bez běhu vyjde `building`,
    // protože `hasWorld` je nepravda a stav se čte jako `running`.
    runnerRef.current = null;
    // Zapsat hned, ne až po snímcích. Rozvrh stavby může doběhnout uvnitř jedné
    // dávky tiků a fáze, která začne a skončí mezi dvěma snímky, v záznamu není —
    // týž důvod, proč `record()` zapisuje i při dotazu zvenčí.
    record();
    // Nový OBJEKT téhož dokumentu. `WorldScene` si běh, scénu i rozvrh stavby drží
    // podle identity `world`, takže restart bez nové identity by jen vysypal frontu
    // a nechal rozehraný svět běžet dál.
    setWorld((was) => (was === null ? null : { ...was }));
  }, [controls, record]);

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
        onWorld={acceptWorld}
        onRounds={setRounds}
        engine={engine}
        modelPhase={modelPhase}
      />
      {/* Prázdný stav plátna. Mizí, jakmile návštěvník poprvé odešle větu — i
          když se z ní svět postavit nepodařilo, protože pak mluví hláška o
          chybě a dvě sdělení přes sebe by si braly pozornost. Stojí AŽ ZA
          `PromptBar`, aby prvním interaktivním prvkem stránky zůstal vstup
          pro větu; hlídá to `e2e/render-quality.spec.ts`. */}
      {world === null && programs.current === null ? <FirstRun /> : null}
      {broken ? (
        <p data-testid="world-broken" role="alert" style={BROKEN}>
          The model returned a world that cannot be run.
        </p>
      ) : null}
      <div style={CORNER_LEFT}>
        <Program emission={programs.current} previous={programs.previous} source={programs.source} />
        <Timeline world={world} />
        {world === null ? null : <GameControls targets={targets} onRestart={restart} />}
      </div>
      <div style={CORNER_RIGHT}>
        <WitnessPreview world={world} />
        <RepairRounds rounds={rounds} />
        <ModelProgress onReady={acceptEngine} onState={acceptModelState} />
      </div>
      {/* `look` jde z TÉŽE emise jako svět, ne z vedlejšího stavu: obojí zapisuje
          `acceptWorld` jedním krokem, takže si kulisa a hra nemůžou patřit dvěma
          různým větám. Vybírá výtvarnou rodinu kulisy (`chooseFamily`). */}
      <Stage world={world} look={lookOf(programs.current)} inputs={inputs} runnerRef={runnerRef} />
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
            <kbd style={KEY}>{at + 1}</kbd> walk to <strong>{target}</strong>
          </li>
        ))}
      </ol>
      <p style={{ margin: '0.4rem 0 0' }}>
        <kbd style={KEY}>space</kbd> pick up &middot; <kbd style={KEY}>E</kbd> use
      </p>
      <button type="button" data-testid="game-restart" onClick={onRestart} style={BUTTON}>
        Restart
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
  // Žádné vlastní ukotvení do rohu — panel je členem `CORNER_LEFT` a roh drží
  // sloupec. Dokud se kotvil sám (`bottom`/`left: 1rem`, `zIndex: 2`), lehl si
  // přesně pod časovou osu a `game-restart` nešlo kliknout: `elementFromPoint`
  // ve středu tlačítka vracel `timeline-outcome`.
  pointerEvents: 'auto',
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
