'use client';

/**
 * `/classic` — stará herní scéna: věta dovnitř, svět ven, a ten svět se dá hrát.
 *
 * ## Proč to bydlí na vlastní adrese (P15 `T21b` / `T47-t21bunblock`)
 *
 * Do 6. 9. 2026 tohle byla hlavní stránka. Hlavní cestou produktu je od té
 * chvíle worldstream (`src/app/page.tsx`): věta otevře relaci, server napíše
 * blueprint a prohlížeč z něj postaví hrubý svět. Tahle stránka je **jiný
 * systém** — lokální emise (`emitLocally()`), `WorldDocRuntime`, simulace na
 * tikách, hratelná místnost.
 *
 * Nemaže se a je to rozhodnutí z 27. 8. 2026: `WorldScene.tsx` i `src/fallback`
 * zůstávají jako doložitelná práce. Vlastní adresa je jediné, co se změnilo —
 * sady, které tuhle scénu měří, míří sem místo na kořen.
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
 *
 * ## Rozvržení odešlo do skořápky (P13 vlna 0 T1)
 *
 * Do 27. 8. 2026 tahle stránka rozvržení i držela: dva sloupce v rozích, pole na
 * větu v horním pruhu a pět průsvitných karet s vnitřnostmi potrubí, které
 * viděl každý, kdo přišel napsat větu. Design book §15.3 to obrací — plátno má
 * celý viewport a rozhraní jsou tři věci u spodní hrany. Rozvržení teď dělá
 * `WorldstreamApp`, tady zůstal **stav**: svět, emise, fáze hry, `window.__game`.
 *
 * Pět panelů se **nemaže**, stěhuje se do Inspect zásuvky. Jediná výjimka je
 * `ModelProgress`, který je současně panel i motor stahování modelu; drží ho
 * proto `inspectBackground` připojený pořád a vykreslí se až po otevření.
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
import WorldStatus, { type WorldStatusState } from '@/components/worldstream/WorldStatus';
import WorldstreamApp from '@/components/worldstream/WorldstreamApp';
import type { CameraMode } from '@/components/viewer/FollowCamera';
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

export default function Page() {
  const [world, setWorld] = useState<WorldDocRuntime | null>(null);
  const [broken, setBroken] = useState(false);
  // Výchozí stav je sledovací a je to rozhodnutí, ne shoda okolností: divák,
  // který o přepínači neví, musí vidět hru, ne prázdno vedle ní.
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [modelPhase, setModelPhase] = useState<ModelPhase>('probing');
  /**
   * Kola opravné smyčky poslední věty. Prázdné, dokud model neběžel.
   *
   * Bydlí tady, ne v `PromptBar`, protože panel patří do Inspect zásuvky —
   * kotvit se sám mu `.ws-inspect-panels` zakazuje a dvakrát to už stálo několik
   * dní červené e2e sady.
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

  /**
   * Je Inspect otevřený?
   *
   * Bydlí to tady, ne v `WorldstreamApp`, kvůli `ModelProgress`: ten je současně
   * panel i motor stahování modelu, takže se nesmí odpojit se zavřenou zásuvkou.
   * Stránka mu proto podává `visible` a on zůstává připojený pořád.
   */
  const [inspecting, setInspecting] = useState(false);
  const toggleInspect = useCallback(() => setInspecting((was) => !was), []);

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

  // Jedna věta o stavu světa, ne panel logů (design book §15.3). Rozbitý svět má
  // přednost před živým: kdyby se poslední věta nedala postavit, je to to jediné,
  // co uživatel v tu chvíli potřebuje vědět.
  const statusState: WorldStatusState = broken ? 'broken' : world === null ? 'empty' : 'live';

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
    <WorldstreamApp
      inspecting={inspecting}
      onInspect={toggleInspect}
      prompt={
        <PromptBar
          onWorld={acceptWorld}
          onRounds={setRounds}
          engine={engine}
          modelPhase={modelPhase}
        />
      }
      status={<WorldStatus state={statusState} />}
      /* Prázdný stav plátna. Mizí, jakmile návštěvník poprvé odešle větu — i
         když se z ní svět postavit nepodařilo, protože pak mluví stavová věta o
         chybě a dvě sdělení přes sebe by si braly pozornost. */
      empty={world === null && programs.current === null ? <FirstRun /> : null}
      controls={
        world === null ? null : (
          <GameControls
            targets={targets}
            onRestart={restart}
            cameraMode={cameraMode}
            onCameraMode={() => setCameraMode((now) => (now === 'follow' ? 'free' : 'follow'))}
          />
        )
      }
      /* Pět panelů, které do vlny 0 stály v rozích a vidělo je i to, kdo přišel
         jenom napsat větu. Nemažou se — jsou to důkazy, na kterých produkt stojí
         (design book §15.5). Do stromu se dostanou teprve po otevření zásuvky. */
      inspect={
        <>
          <Program
            emission={programs.current}
            previous={programs.previous}
            source={programs.source}
          />
          <Timeline world={world} />
          <WitnessPreview world={world} />
          <RepairRounds rounds={rounds} />
        </>
      }
      inspectBackground={
        <ModelProgress onReady={acceptEngine} onState={acceptModelState} visible={inspecting} />
      }
      /* `look` jde z TÉŽE emise jako svět, ne z vedlejšího stavu: obojí zapisuje
         `acceptWorld` jedním krokem, takže si kulisa a hra nemůžou patřit dvěma
         různým větám. Vybírá výtvarnou rodinu kulisy (`chooseFamily`). */
      stage={
        <Stage
          world={world}
          look={lookOf(programs.current)}
          inputs={inputs}
          runnerRef={runnerRef}
          cameraMode={cameraMode}
        />
      }
    />
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
  cameraMode,
  onCameraMode,
}: {
  readonly targets: readonly string[];
  readonly onRestart: () => void;
  readonly cameraMode: CameraMode;
  readonly onCameraMode: () => void;
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
      {/* Přepínač stojí vedle restartu, ne ve vlastní komponentě: ovládání hry
          žije tady a druhý panel v témž rohu je ta vada, kvůli které sloupce
          vznikly. `aria-pressed` nese stav i pro toho, kdo popisek neuvidí. */}
      <button
        type="button"
        data-testid="camera-mode"
        aria-pressed={cameraMode === 'free'}
        onClick={onCameraMode}
        style={{ ...BUTTON, marginLeft: '0.4rem' }}
      >
        {cameraMode === 'free' ? 'Follow the hero' : 'Turn the world'}
      </button>
    </div>
  );
}

const PANEL: React.CSSProperties = {
  // Žádné vlastní ukotvení do rohu — panel je členem `.ws-controls` a roh drží
  // ten sloupec. Dokud se kotvil sám (`bottom`/`left: 1rem`, `zIndex: 2`), lehl
  // si přesně pod časovou osu a `game-restart` nešlo kliknout:
  // `elementFromPoint` ve středu tlačítka vracel `timeline-outcome`.
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
