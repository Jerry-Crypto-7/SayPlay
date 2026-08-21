'use client';

/**
 * Přetočit čas, vypnout jedno pravidlo, dívat se, jak se budoucnost přepočítá
 * (P11 T17).
 *
 * Panel drží **vlastní běh** téhož světa — stejně jako `WitnessPreview`, který
 * si svět taky ověřuje sám vedle plátna. Je to schválně: časová osa je pohled na
 * simulaci, ne na její vykreslení, a všechno, co tvrdí, se dá zkontrolovat
 * hashem zabaleného stavu, ne pohledem na obrázek.
 *
 * ## Proč se vypíná pravidlo, které mluví do budoucnosti
 *
 * Vypnout kterékoli pravidlo je legální změna, jenže většina pravidel v daném
 * okně vůbec nespustí — nad zmrazeným `C01` spustí po tiku 40 **jediné, a dvakrát**
 * (naměřeno 21. 8. 2026). Vypnout kterékoli jiné by dalo budoucnost bitově
 * shodnou s původní, a panel by tvrdil „přepočítáno", zatímco by se nezměnilo nic.
 * Vybírá se proto pravidlo s nejvíc spuštěními od tiku větvení dál, a když
 * takové není, panel to **řekne** místo aby odbočil naprázdno.
 *
 * ## Rychlost je wall-clock, obsah není
 *
 * Posuvník je vstup od člověka a překreslení je animace. Sám běh je ale
 * deterministický: tik je jediná jednotka, hash se počítá ze zabaleného stavu a
 * `seekTo` dá tentýž stav bez ohledu na to, kudy se k němu došlo.
 */

import { useEffect, useMemo, useState } from 'react';

import { visitedZones } from '@/sim/agents';
import { hashHex } from '@/sim/hash';
import { createRuntime, step, type Runtime, type WorldDocRuntime } from '@/sim/interpreter';
import { rebranchAt, type RebranchReason } from '@/sim/rebranch';
import { advance, createTimeline, seekTo, type Timeline as Axis } from '@/sim/timeline';

/** Okno, ve kterém se čas přetáčí. Táž mez, jakou měří e2e úlohy T17. */
const HORIZON = 200;
/** Kolik tiků se skáče lacino ze snímku; zbytek dopočítá kotva. */
const CAPACITY = 64;

export type BranchOutcome =
  | { readonly verdict: 'BRANCHED'; readonly ruleId: string; readonly firings: number }
  | { readonly verdict: 'NOTHING_FIRES' }
  | { readonly verdict: 'REJECTED'; readonly reason: RebranchReason; readonly detail: string };

declare global {
  interface Window {
    __timeline?: {
      readonly horizon: number;
      /** Zahodí větev i přetáčení a postaví původní běh znovu od tiku nula. */
      fresh: () => void;
      /** Dopočítá dopředu. Vrací tik, na kterém běh skutečně stojí. */
      runTo: (tick: number) => number;
      /** Přetočí obousměrně. Vrací tik, na kterém běh skutečně stojí. */
      seek: (tick: number) => number;
      /** Vypne pravidlo mluvící do budoucnosti a odbočí na daném tiku. */
      branch: (tick: number) => BranchOutcome;
      tick: () => number;
      /** Hash zabaleného stavu — táž funkce, jakou hashuje ověřovač. */
      hash: () => string;
      /** `ruleId` vypnutého pravidla, nebo `null`, dokud se neodbočilo. */
      branchedRule: () => string | null;
      /**
       * Zóny, kterými entita prošla za prvních `ticks` tiků běhu, seřazené.
       *
       * Horizont je **argument**, ne pozice posuvníku: odpověď se tím nedá
       * změnit tím, jak kdo předtím přetáčel čas. Počítá se čerstvým během nad
       * dokumentem, na kterém běh právě jede — po odbočení tedy nad tím
       * změněným, což je přesně to, na co se člověk po změně pravidla ptá.
       */
      visited: (entity: string, ticks: number) => readonly string[];
    };
  }
}

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

/** Týž svět bez jednoho pravidla. Sloty, entity ani prostor se nehnou. */
function without(doc: WorldDocRuntime, ruleId: string): WorldDocRuntime {
  return { ...doc, ir: { ...doc.ir, rules: doc.ir.rules.filter((rule) => rule.ruleId !== ruleId) } };
}

interface Controller {
  runtime: Runtime;
  axis: Axis;
  /** Dokument, podle kterého běh právě jede. Po odbočení je to ten bez pravidla. */
  doc: WorldDocRuntime;
  /** Dokument, se kterým svět přišel. `fresh()` se vrací k němu, ne k větvi. */
  readonly origin: WorldDocRuntime;
  branchedRule: string | null;
  /** `ruleId` spuštěné v každém tiku původního běhu, indexováno tikem. */
  readonly firedAt: readonly (readonly string[])[];
  /** Hash zabaleného stavu na horizontu původního běhu. */
  readonly originalHash: string;
}

/**
 * Odkrokuje původní běh na horizont a zapíše, co ve kterém tiku spustilo.
 *
 * Běží to jednou při stavbě světa, synchronně: dvě stě tiků je pod milisekundu
 * a jediná alternativa je počítat totéž znovu při každém sáhnutí na posuvník.
 */
function survey(doc: WorldDocRuntime): { readonly firedAt: string[][]; readonly hash: string } {
  const runtime = createRuntime(doc);
  const firedAt: string[][] = [];
  for (let i = 0; i < HORIZON; i += 1) {
    const at = runtime.tick;
    const result = step(runtime, inputsAt(doc, at));
    firedAt[at] = [...result.fired];
  }
  return { firedAt, hash: hashHex(runtime.state) };
}

/** Pravidlo s nejvíc spuštěními od `from` dál. Shodu rozhoduje `ruleId`, ať je volba stabilní. */
function busiestFrom(firedAt: readonly (readonly string[])[], from: number): { id: string; firings: number } | null {
  const counts = new Map<string, number>();
  for (let tick = from; tick < firedAt.length; tick += 1) {
    for (const ruleId of firedAt[tick] ?? []) counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  }
  let best: { id: string; firings: number } | null = null;
  for (const [id, firings] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (best === null || firings > best.firings) best = { id, firings };
  }
  return best;
}

/**
 * Postaví běh **na tiku nula**, ne na horizontu.
 *
 * Do 21. 8. 2026 tu byl doběh na horizont rovnou, a `fresh()` tím přestalo
 * znamenat „od začátku": vracelo běh na konec, takže `runTo(40)` po něm nemělo
 * kam jít a mlčky zůstalo stát na dvoustovce. Panel to neukázal, protože po
 * mountu horizont stejně chce — chybu našel až e2e, který si o tik 40 řekl
 * dopředu. Doběh na horizont dělá teď mount, ne stavba.
 */
function build(doc: WorldDocRuntime): Controller {
  const surveyed = survey(doc);
  const runtime = createRuntime(doc);
  return {
    runtime,
    axis: createTimeline(runtime, CAPACITY),
    doc,
    origin: doc,
    branchedRule: null,
    firedAt: surveyed.firedAt,
    originalHash: surveyed.hash,
  };
}

export default function Timeline({ world }: { readonly world: WorldDocRuntime | null }) {
  const controller = useMemo(() => (world === null ? null : build(world)), [world]);

  // Řízené hodnoty pro překreslení. Pravdu drží `controller`, tohle je její obraz.
  const [tick, setTick] = useState(0);
  const [hash, setHash] = useState('');
  const [outcome, setOutcome] = useState<BranchOutcome | null>(null);
  /** Hash na horizontu po odbočení. `null`, dokud se neodbočilo. */
  const [branchHash, setBranchHash] = useState<string | null>(null);

  const api = useMemo(() => {
    if (controller === null) return null;

    const publish = () => {
      setTick(controller.runtime.tick);
      setHash(hashHex(controller.runtime.state));
      return controller.runtime.tick;
    };

    const runTo = (target: number) => {
      while (controller.runtime.tick < target && controller.runtime.runState === 'running') {
        advance(controller.axis, controller.runtime, inputsAt(controller.doc, controller.runtime.tick));
      }
      return publish();
    };

    const branch = (at: number): BranchOutcome => {
      const busiest = busiestFrom(controller.firedAt, at);
      if (busiest === null) {
        const nothing = { verdict: 'NOTHING_FIRES' } as const;
        setOutcome(nothing);
        return nothing;
      }
      const next = without(controller.doc, busiest.id);
      const result = rebranchAt(controller.axis, controller.runtime, at, next);
      if (result.verdict === 'REJECTED') {
        const rejected = { verdict: 'REJECTED', reason: result.reason, detail: result.detail } as const;
        setOutcome(rejected);
        publish();
        return rejected;
      }
      controller.runtime = result.runtime;
      controller.axis = result.timeline;
      controller.doc = next;
      controller.branchedRule = busiest.id;
      const branched = { verdict: 'BRANCHED', ruleId: busiest.id, firings: busiest.firings } as const;
      setOutcome(branched);
      publish();
      return branched;
    };

    return {
      horizon: HORIZON,
      fresh: () => {
        const rebuilt = build(controller.origin);
        controller.runtime = rebuilt.runtime;
        controller.axis = rebuilt.axis;
        controller.doc = controller.origin;
        controller.branchedRule = null;
        setOutcome(null);
        setBranchHash(null);
        return publish();
      },
      runTo,
      seek: (target: number) => {
        seekTo(controller.axis, controller.runtime, target);
        return publish();
      },
      branch,
      tick: () => controller.runtime.tick,
      hash: () => hashHex(controller.runtime.state),
      branchedRule: () => controller.branchedRule,
      visited: (entity: string, ticks: number) => visitedZones(controller.doc, entity, ticks),
    };
  }, [controller]);

  useEffect(() => {
    if (api === null) return undefined;
    window.__timeline = api;
    // Po stavbě světa chce panel ukázat celé okno, ne prázdný tik nula. Doběh
    // patří sem, ne do `build` — `fresh()` musí zůstat cestou na začátek.
    api.runTo(HORIZON);
    return () => {
      delete window.__timeline;
    };
  }, [api]);

  if (controller === null || api === null) return null;

  const branchedRule = controller.branchedRule;
  // Srovnává se horizont s horizontem. Živý hash by po dalším přetočení mluvil
  // o jiném tiku a věta „budoucnost vyšla stejně" by se stala náhodou.
  const changed = branchHash !== null && branchHash !== controller.originalHash;

  return (
    <section data-testid="timeline" data-tick={String(tick)} data-branched={branchedRule ?? ''} style={PANEL}>
      <div style={HEAD}>
        <strong>Čas</strong>
        <span data-testid="timeline-tick" style={MUTED}>
          tik {String(tick)} / {String(HORIZON)}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={HORIZON}
        value={tick}
        data-testid="timeline-scrub"
        aria-label="Přetočit čas"
        onChange={(event) => api.seek(Number(event.target.value))}
        style={SCRUB}
      />

      <p data-testid="timeline-hash" style={ROW}>
        stav <code style={CODE}>{hash}</code>
        {branchedRule === null ? null : (
          <>
            {' · '}původní <code style={CODE}>{controller.originalHash}</code>
          </>
        )}
      </p>

      <button
        type="button"
        data-testid="timeline-branch"
        onClick={() => {
          const result = api.branch(controller.runtime.tick);
          api.runTo(HORIZON);
          setBranchHash(result.verdict === 'BRANCHED' ? api.hash() : null);
        }}
        style={ACTION}
      >
        Vypnout jedno pravidlo a přepočítat budoucnost
      </button>

      {outcome === null ? null : (
        <p data-testid="timeline-outcome" role="status" style={ROW}>
          {outcome.verdict === 'BRANCHED'
            ? `Bez pravidla ${outcome.ruleId} (spustilo ${String(outcome.firings)}×). Budoucnost ${changed ? 'se přepočítala' : 'vyšla stejně'}.`
            : outcome.verdict === 'NOTHING_FIRES'
              ? 'Od tohohle tiku už žádné pravidlo nespustí — vypnout kterékoli by nezměnilo nic.'
              : `Odbočit tady nejde: ${outcome.detail}`}
        </p>
      )}
    </section>
  );
}

const PANEL: React.CSSProperties = {
  position: 'absolute',
  bottom: '1rem',
  left: '1rem',
  zIndex: 2,
  width: 'min(22rem, calc(100vw - 2rem))',
  padding: '0.6rem 0.75rem',
  borderRadius: '0.6rem',
  background: 'rgba(12, 22, 26, 0.9)',
  border: '1px solid #24383d',
  color: '#dceaec',
  fontSize: '0.82rem',
};

const HEAD: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: '0.5rem',
};

const MUTED: React.CSSProperties = {
  color: '#9fc0c2',
  fontSize: '0.76rem',
  fontVariantNumeric: 'tabular-nums',
};

const SCRUB: React.CSSProperties = {
  width: '100%',
  margin: '0.45rem 0 0.3rem',
  accentColor: '#2f9e8f',
};

const ROW: React.CSSProperties = {
  margin: '0.25rem 0 0',
  color: '#9fc0c2',
  fontSize: '0.76rem',
};

const CODE: React.CSSProperties = {
  color: '#dceaec',
  fontVariantNumeric: 'tabular-nums',
};

const ACTION: React.CSSProperties = {
  marginTop: '0.45rem',
  padding: '0.3rem 0.6rem',
  borderRadius: '0.35rem',
  border: '1px solid #e8a33d',
  background: 'transparent',
  color: '#e8a33d',
  font: 'inherit',
  fontSize: '0.78rem',
  cursor: 'pointer',
};
