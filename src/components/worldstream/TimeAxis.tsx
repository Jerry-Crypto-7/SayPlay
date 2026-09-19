'use client';

/**
 * Osa u spodní hrany — **jeden prvek, dvě funkce** (P15 T24, design book §15.3).
 *
 * Vlevo doprava ukazuje, jak daleko došla materializace (`intent → world →
 * detail → change`); táž stopa je zároveň přetáčení času. Nejsou to dva
 * ovladače nad sebou schválně: porotce nemá vedle světa luštit rozhraní, a obojí
 * je odpověď na tutéž otázku „kde v ději jsme".
 *
 * ## Co je tady pravda a co jenom obraz
 *
 * Pravdu drží `controller` — pole větví, každá s vlastním runtimem a vlastní
 * osou. `useState` v komponentě je jen jeho obraz pro překreslení, stejně jako
 * v panelu `src/components/pipeline/Timeline.tsx`. Rozdíl proti tomu panelu je
 * jediný a je to celý smysl téhle úlohy: **odbočení tu předchozí větev
 * neztratí**. Panel dělá `controller.axis = result.timeline`, tedy přepis;
 * tady se nová větev do pole přidá a na tu starou se dá přepnout zpátky.
 *
 * ⚠ **Úložiště větví je zatím uvnitř komponenty.** `T38` ho má vytáhnout do
 * `src/sim/branches.ts` jako `BranchStore` a přiživit z něj i ten panel — do té
 * doby by dvě kopie téhož byly horší než jedna tady.
 *
 * ## Meshe jsou mimo hashovaný stav, takže přetočení je zdarma
 *
 * Osa sahá **výhradně** na simulaci: `seekTo` obnoví zabalený stav a nic víc.
 * Reprezentace (`RepresentationRegistry`), částice, zvuk, kamera, tweeny ani
 * postprocessing v hashovaném stavu nesedí, takže se přetočením nepřepočítávají
 * — a `e2e/worldstream-time.spec.ts` to měří na počtu geometrií, které renderer
 * doopravdy drží, ne na tom, že to tenhle komentář tvrdí.
 *
 * ## Nástěnný čas se sem nesmí dostat
 *
 * `Date.now()`, `performance.now()` ani skutečný `requestAnimationFrame` na
 * replay cestě nemají co dělat (`CLAUDE.md`, Determinismus). Simulovaný tik je
 * jediná jednotka; hlídá to lexikálně `src/sim/__tests__/rebranch.test.ts`.
 *
 * ## Značky „proč" (P22 T8)
 *
 * `WhyMarkers` níž je druhá věc, kterou tenhle soubor exportuje: řada značek
 * nad tiky, ve kterých spustilo aspoň jedno pravidlo. Klik na značku **není
 * přetočení** — jen vybere tik pro panel `WhyPanel`; kdo chce čas vrátit, má
 * na to posuvník. Značky tu bydlí proto, že patří k ose, ne k ovládání; jenže
 * osa v téhle komponentě běží nad vlastními větvemi a **kauzální kruh drží
 * `RuntimeController`** (`src/worldstream/runtime-controller.ts`), který na
 * hlavní cestě stojí pod ovládáním v `src/app/page.tsx`. Tiky proto dodává
 * volající z toho kruhu, a `TimeAxis` sama značky nekreslí — její větve žádný
 * kruh nemají a lhát „vysvětlím ti to" nad během bez záznamu by nemělo smysl.
 */

import { useEffect, useMemo, useState } from 'react';

import { hashHex } from '@/sim/hash';
import { createRuntime, type RunState, type Runtime, type WorldDocRuntime } from '@/sim/interpreter';
import { rebranchAt, type RebranchReason } from '@/sim/rebranch';
import { advance, createTimeline, seekTo, type Timeline as Axis } from '@/sim/timeline';

/** Fáze materializace. Levá polovina významu osy. */
export const AXIS_PHASES = ['intent', 'world', 'detail', 'change'] as const;

export type AxisPhase = (typeof AXIS_PHASES)[number];

/** Okno, ve kterém se čas přetáčí. Táž mez, jakou měří osa v Inspectu. */
const HORIZON = 200;
/** Kolik tiků se skáče lacino ze snímku; zbytek dopočítá kotva. */
const CAPACITY = 64;

/**
 * Jedna budoucnost.
 *
 * `endTick` a `endHash` se zapisují ve chvíli, kdy větev poprvé dojde tam, kam
 * dojít umí. Bez nich by se dvě budoucnosti daly porovnat jedině tak, že se obě
 * doběhnou znovu pokaždé, kdy se na ně někdo podívá.
 */
export interface BranchView {
  readonly id: string;
  readonly parentId: string | null;
  /** Tik, ve kterém se odbočilo. Nula u původního běhu. */
  readonly fromTick: number;
  /** Pravidlo, které druhá věta umlčela. `null` u původního běhu. */
  readonly ruleId: string | null;
  readonly endTick: number;
  readonly endHash: string;
  /**
   * Jak ta budoucnost dopadla.
   *
   * ⚠ **Nese to informaci, kterou hash nemá** — naměřeno 3. 9. 2026 nad
   * ukázkovým světem: vypnout vítězné pravidlo dá běh, který nikdy nevyhraje,
   * a přesto **bitově tentýž** zabalený stav (`f5a593ab` obojí). `hashHex`
   * hashuje sloty, `runState` mezi ně nepatří. Porovnávat dvě budoucnosti
   * samotným hashem by tedy uměla minout právě tu změnu, kvůli které porotce
   * druhou větu napsal.
   */
  readonly outcome: RunState;
}

export type BranchOutcome =
  | { readonly verdict: 'BRANCHED'; readonly id: string; readonly ruleId: string }
  /** Volající nemá čím odbočit — druhá věta zatím žádný jiný dokument nedala. */
  | { readonly verdict: 'NO_CHANGE' }
  | { readonly verdict: 'REJECTED'; readonly reason: RebranchReason; readonly detail: string };

declare global {
  interface Window {
    /**
     * Veřejné dveře osy. E2E se o React strom neopírá — je to jediné rozhraní,
     * které přežije přesun panelu i změnu rozvržení.
     */
    __timeAxis?: {
      readonly horizon: number;
      phase: () => AxisPhase;
      tick: () => number;
      /** Hash zabaleného stavu — táž funkce, jakou hashuje ověřovač. */
      hash: () => string;
      /** Přetočí obousměrně. Vrací tik, na kterém běh skutečně stojí. */
      seek: (tick: number) => number;
      /** Dopočítá dopředu. Vrací tik, na kterém běh skutečně stojí. */
      runTo: (tick: number) => number;
      /** Odbočí na daném tiku do dokumentu, který dá volající. */
      branch: (tick: number) => BranchOutcome;
      branches: () => readonly BranchView[];
      active: () => string;
      /** Postaví se na jinou větev. `false` znamená neznámé id. */
      switchTo: (id: string) => boolean;
    };
  }
}

interface Branch {
  readonly id: string;
  readonly parentId: string | null;
  readonly fromTick: number;
  readonly ruleId: string | null;
  readonly doc: WorldDocRuntime;
  runtime: Runtime;
  axis: Axis;
  endTick: number;
  endHash: string;
  outcome: RunState;
}

interface Controller {
  branches: Branch[];
  active: number;
}

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

function view(branch: Branch): BranchView {
  return {
    id: branch.id,
    parentId: branch.parentId,
    fromTick: branch.fromTick,
    ruleId: branch.ruleId,
    endTick: branch.endTick,
    endHash: branch.endHash,
    outcome: branch.outcome,
  };
}

/**
 * Odkrokuje větev tak daleko, jak umí, a zapíše, kde se zastavila.
 *
 * `advance` zapisuje snímky do osy, takže je to zároveň jediná cesta, jak se
 * později dá levně přetáčet. Krokovat `step`em by osu nechalo prázdnou a každé
 * přetočení by muselo z kotvy.
 */
function runTo(branch: Branch, target: number): number {
  while (branch.runtime.tick < target && branch.runtime.runState === 'running') {
    advance(branch.axis, branch.runtime, inputsAt(branch.doc, branch.runtime.tick));
  }
  if (branch.runtime.tick > branch.endTick) {
    branch.endTick = branch.runtime.tick;
    branch.endHash = hashHex(branch.runtime.state);
    branch.outcome = branch.runtime.runState;
  }
  return branch.runtime.tick;
}

function origin(doc: WorldDocRuntime): Controller {
  const runtime = createRuntime(doc);
  return {
    branches: [
      {
        id: 'origin',
        parentId: null,
        fromTick: 0,
        ruleId: null,
        doc,
        runtime,
        axis: createTimeline(runtime, CAPACITY),
        endTick: 0,
        endHash: hashHex(runtime.state),
        outcome: runtime.runState,
      },
    ],
    active: 0,
  };
}

export default function TimeAxis({
  world,
  phase,
  nextDocument,
}: {
  /** Svět, nad kterým osa běží. Bez něj zbude z osy jenom stopa materializace. */
  readonly world: WorldDocRuntime | null;
  /** Jak daleko došla materializace. Pravá polovina významu osy. */
  readonly phase: AxisPhase;
  /**
   * Dokument, do kterého se má odbočit — v provozu ho vyrábí commitnutá druhá
   * věta, na vývojové adrese je scriptovaný. Bez něj se nevětví: osa sama žádné
   * pravidlo nevybírá, protože o tom, co se má změnit, rozhoduje porotce.
   */
  readonly nextDocument?: (current: WorldDocRuntime, tick: number) => { doc: WorldDocRuntime; ruleId: string } | null;
}) {
  const controller = useMemo(() => (world === null ? null : origin(world)), [world]);

  const [tick, setTick] = useState(0);
  const [active, setActive] = useState('origin');
  const [branches, setBranches] = useState<readonly BranchView[]>([]);
  const [rejection, setRejection] = useState<string | null>(null);

  const api = useMemo(() => {
    if (controller === null) return null;

    const current = () => controller.branches[controller.active];

    const publish = () => {
      const branch = current();
      setTick(branch.runtime.tick);
      setActive(branch.id);
      setBranches(controller.branches.map(view));
      return branch.runtime.tick;
    };

    const branch = (at: number): BranchOutcome => {
      const parent = current();
      const written = nextDocument?.(parent.doc, at) ?? null;
      if (written === null) {
        setRejection('nothing to change here yet');
        return { verdict: 'NO_CHANGE' };
      }

      const result = rebranchAt(parent.axis, parent.runtime, at, written.doc);
      if (result.verdict === 'REJECTED') {
        setRejection(result.detail);
        publish();
        return { verdict: 'REJECTED', reason: result.reason, detail: result.detail };
      }

      const id = `branch-${String(controller.branches.length)}`;
      const child: Branch = {
        id,
        parentId: parent.id,
        fromTick: at,
        ruleId: written.ruleId,
        doc: written.doc,
        runtime: result.runtime,
        axis: result.timeline,
        endTick: result.tick,
        endHash: hashHex(result.runtime.state),
        outcome: result.runtime.runState,
      };
      controller.branches.push(child);
      controller.active = controller.branches.length - 1;
      setRejection(null);
      runTo(child, HORIZON);
      publish();
      return { verdict: 'BRANCHED', id, ruleId: written.ruleId };
    };

    return {
      horizon: HORIZON,
      phase: () => phase,
      tick: () => current().runtime.tick,
      hash: () => hashHex(current().runtime.state),
      seek: (target: number) => {
        const branch = current();
        seekTo(branch.axis, branch.runtime, target);
        return publish();
      },
      runTo: (target: number) => {
        runTo(current(), target);
        return publish();
      },
      branch,
      branches: () => controller.branches.map(view),
      active: () => current().id,
      switchTo: (id: string) => {
        const index = controller.branches.findIndex((entry) => entry.id === id);
        if (index < 0) return false;
        controller.active = index;
        publish();
        return true;
      },
    };
    // Přestavba `api` je levná a `controller` se jí **nedotkne** — větve i jejich
    // runtimy tedy posun fáze přežijí. Kdyby se sem dostal `controller`, jediná
    // změna fáze by svět postavila znovu od tiku nula.
  }, [controller, nextDocument, phase]);

  useEffect(() => {
    if (api === null) return undefined;
    window.__timeAxis = api;
    // Osa má ukázat celý oblouk světa, ne prázdný tik nula. Doběh patří sem,
    // ne do `origin()` — ta musí zůstat cestou na začátek.
    api.runTo(HORIZON);
    return () => {
      delete window.__timeAxis;
    };
  }, [api]);

  const reached = AXIS_PHASES.indexOf(phase);
  const span = branches.length === 0 ? HORIZON : Math.max(...branches.map((entry) => entry.endTick), 1);

  return (
    <div className="ws-axis" data-testid="time-axis" data-phase={phase} data-tick={String(tick)} data-branch={active}>
      <div style={MARKS}>
        {AXIS_PHASES.map((name, index) => (
          <span
            key={name}
            data-testid={`axis-phase-${name}`}
            data-reached={index <= reached}
            style={{ ...MARK, color: index <= reached ? 'var(--ws-nacre)' : 'var(--ws-muted)' }}
          >
            {name}
          </span>
        ))}
      </div>

      <input
        type="range"
        min={0}
        max={span}
        value={Math.min(tick, span)}
        data-testid="axis-scrub"
        aria-label="Rewind time"
        disabled={api === null}
        onChange={(event) => api?.seek(Number(event.target.value))}
        style={SCRUB}
      />

      {api === null ? null : (
        <div style={FOOT}>
          <span data-testid="axis-tick" style={MUTED}>
            tick {String(tick)} / {String(span)}
          </span>
          {branches.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-testid="axis-branch"
              data-branch-id={entry.id}
              data-hash={entry.endHash}
              data-outcome={entry.outcome}
              data-from-tick={String(entry.fromTick)}
              aria-pressed={entry.id === active}
              onClick={() => api.switchTo(entry.id)}
              style={{ ...CHIP, ...(entry.id === active ? CHIP_ON : null) }}
            >
              {entry.ruleId === null ? 'as written' : `without ${entry.ruleId}`} · {entry.endHash}
            </button>
          ))}
          {nextDocument === undefined ? null : (
            <button
              type="button"
              data-testid="axis-branch-here"
              onClick={() => {
                api.branch(api.tick());
              }}
              style={ACTION}
            >
              Change one law here
            </button>
          )}
        </div>
      )}

      {rejection === null ? null : (
        <p data-testid="axis-rejection" role="status" style={MUTED}>
          No branch from here: {rejection}
        </p>
      )}
    </div>
  );
}

/**
 * Značky tiků, ve kterých spustilo pravidlo. Klik vybere tik, nic nepřetáčí.
 *
 * `ticks` jsou tiky z kauzálního kruhu běhu (`explainTick`), ne z obrazu
 * v komponentě — když kruh tik zapomene nebo ho přetočení smaže, značka zmizí
 * s ním a panel nad ním nemá co ukázat.
 */
export function WhyMarkers({
  ticks,
  selected,
  onSelect,
}: {
  readonly ticks: readonly number[];
  readonly selected: number | null;
  readonly onSelect: (tick: number) => void;
}) {
  if (ticks.length === 0) return null;
  return (
    <div className="ws-why-markers" data-testid="why-markers" aria-label="Ticks where a rule fired">
      <span className="ws-why-markers-label">Why?</span>
      {ticks.map((tick) => (
        <button
          key={tick}
          type="button"
          className="ws-why-marker"
          data-testid={`why-marker-${String(tick)}`}
          aria-pressed={tick === selected}
          title={`Why did a rule fire at tick ${String(tick)}?`}
          onClick={() => onSelect(tick)}
        >
          {String(tick)}
        </button>
      ))}
    </div>
  );
}

const MARKS: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.7rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const MARK: React.CSSProperties = {
  textShadow: 'var(--ws-text-shadow)',
};

const SCRUB: React.CSSProperties = {
  width: '100%',
  margin: '0.2rem 0',
  accentColor: 'var(--ws-verdigris)',
};

const FOOT: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.74rem',
};

const MUTED: React.CSSProperties = {
  margin: 0,
  color: 'var(--ws-muted)',
  fontVariantNumeric: 'tabular-nums',
  textShadow: 'var(--ws-text-shadow)',
};

const CHIP: React.CSSProperties = {
  padding: '0.15rem 0.45rem',
  borderRadius: '0.3rem',
  border: '1px solid var(--ws-basalt)',
  background: 'transparent',
  color: 'var(--ws-muted)',
  font: 'inherit',
  fontSize: '0.72rem',
  cursor: 'pointer',
};

const CHIP_ON: React.CSSProperties = {
  borderColor: 'var(--ws-verdigris)',
  color: 'var(--ws-nacre)',
};

const ACTION: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '0.15rem 0.45rem',
  borderRadius: '0.3rem',
  border: '1px solid var(--ws-amber)',
  background: 'transparent',
  color: 'var(--ws-amber)',
  font: 'inherit',
  fontSize: '0.72rem',
  cursor: 'pointer',
};
