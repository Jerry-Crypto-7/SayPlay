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
import { createBranchStore, type BranchStore, type BranchView } from '@/sim/branches';
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
       * Všechny větve, které kdy vznikly — **veřejné dveře úlohy T38**. Do ní
       * osa každé odbočení předchozí větev přepsala, takže „dvě budoucnosti
       * vedle sebe" neexistovaly ani jako data.
       */
      branches: () => readonly BranchView[];
      /** Postaví se na jinou větev. `false` znamená neznámé id. */
      switchTo: (id: string) => boolean;
      /**
       * Dokument, podle kterého aktivní větev jede.
       *
       * Je to jediná cesta, jak může e2e **přehrát tentýž svět v Node** — bez
       * něj by se referenční hash počítal nad světem, o kterém se jen doufá, že
       * je týž, jaký si postavil prohlížeč.
       */
      document: () => WorldDocRuntime;
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
  /**
   * Všechny budoucnosti, ne jedna. Do T38 tu stály `runtime`, `axis` a `doc`
   * jako tři pole, která odbočení **přepsalo** — a předchozí větev tím zmizela.
   */
  store: BranchStore;
  /** Dokument, se kterým svět přišel. `fresh()` se vrací k němu, ne k větvi. */
  readonly origin: WorldDocRuntime;
  branchedRule: string | null;
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
    store: createBranchStore({ doc, runtime, timeline: createTimeline(runtime, CAPACITY) }),
    origin: doc,
    branchedRule: null,
    originalHash: surveyed.hash,
  };
}

export default function Timeline({ world }: { readonly world: WorldDocRuntime | null }) {
  const controller = useMemo(() => (world === null ? null : build(world)), [world]);

  // Řízené hodnoty pro překreslení. Pravdu drží `controller`, tohle je její obraz.
  const [tick, setTick] = useState(0);
  const [hash, setHash] = useState('');
  const [outcome, setOutcome] = useState<BranchOutcome | null>(null);
  const [branches, setBranches] = useState<readonly BranchView[]>([]);
  const [active, setActive] = useState('origin');
  /** Hash na horizontu po odbočení. `null`, dokud se neodbočilo. */
  const [branchHash, setBranchHash] = useState<string | null>(null);

  const api = useMemo(() => {
    if (controller === null) return null;

    const publish = () => {
      const live = controller.store.active();
      setTick(live.runtime.tick);
      setHash(hashHex(live.runtime.state));
      setBranches(controller.store.list());
      setActive(live.id);
      return live.runtime.tick;
    };

    /**
     * Doběhne a **zapečetí**. Pečeť je hluboká kopie, takže zůstane platná i
     * potom, co z téhle větve někdo odbočí dál a přetočí její runtime do
     * minulosti — právě o to celé úložiště je.
     */
    const runTo = (target: number) => {
      const live = controller.store.active();
      while (live.runtime.tick < target && live.runtime.runState === 'running') {
        advance(live.timeline, live.runtime, inputsAt(live.doc, live.runtime.tick));
      }
      controller.store.seal();
      return publish();
    };

    const branch = (at: number): BranchOutcome => {
      const live = controller.store.active();
      // Profil se počítá nad **aktivním** dokumentem, ne nad původním: druhá
      // odbočka z už odbočené větve musí vybírat z pravidel, která v ní ještě
      // jsou. Je to volba, ne tvrzení o historii — běh od nuly nad dokumentem
      // větve není tatáž trajektorie, jakou si větev odžila.
      const busiest = busiestFrom(survey(live.doc).firedAt, at);
      if (busiest === null) {
        const nothing = { verdict: 'NOTHING_FIRES' } as const;
        setOutcome(nothing);
        return nothing;
      }
      const next = without(live.doc, busiest.id);
      const result = rebranchAt(live.timeline, live.runtime, at, next);
      if (result.verdict === 'REJECTED') {
        const rejected = { verdict: 'REJECTED', reason: result.reason, detail: result.detail } as const;
        setOutcome(rejected);
        publish();
        return rejected;
      }
      controller.store.open({
        parentId: live.id,
        atTick: at,
        ruleId: busiest.id,
        doc: next,
        runtime: result.runtime,
        timeline: result.timeline,
      });
      controller.branchedRule = busiest.id;
      const branched = { verdict: 'BRANCHED', ruleId: busiest.id, firings: busiest.firings } as const;
      setOutcome(branched);
      publish();
      return branched;
    };

    return {
      horizon: HORIZON,
      fresh: () => {
        controller.store = build(controller.origin).store;
        controller.branchedRule = null;
        setOutcome(null);
        setBranchHash(null);
        return publish();
      },
      runTo,
      seek: (target: number) => {
        const live = controller.store.active();
        seekTo(live.timeline, live.runtime, target);
        return publish();
      },
      branch,
      tick: () => controller.store.active().runtime.tick,
      hash: () => hashHex(controller.store.active().runtime.state),
      branchedRule: () => controller.branchedRule,
      branches: () => controller.store.list(),
      switchTo: (id: string) => {
        if (!controller.store.switchTo(id)) return false;
        publish();
        return true;
      },
      document: () => controller.store.active().doc,
      visited: (entity: string, ticks: number) => visitedZones(controller.store.active().doc, entity, ticks),
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
        <strong>Time</strong>
        <span data-testid="timeline-tick" style={MUTED}>
          tick {String(tick)} / {String(HORIZON)}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={HORIZON}
        value={tick}
        data-testid="timeline-scrub"
        aria-label="Rewind time"
        onChange={(event) => api.seek(Number(event.target.value))}
        style={SCRUB}
      />

      <p data-testid="timeline-hash" style={ROW}>
        state <code style={CODE}>{hash}</code>
        {branchedRule === null ? null : (
          <>
            {' · '}was <code style={CODE}>{controller.originalHash}</code>
          </>
        )}
      </p>

      {/* Strom větví. Porotce má dvě budoucnosti **vidět vedle sebe**, ne o nich
          číst ve stavové větě — jediný uzel je legitimní stav, ne prázdno. */}
      <div data-testid="branch-tree" style={TREE}>
        {branches.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid="branch-node"
            data-branch-id={entry.id}
            data-parent-id={entry.parentId ?? ''}
            data-at-tick={String(entry.atTick)}
            data-rule={entry.ruleId ?? ''}
            data-hash={entry.hash}
            aria-pressed={entry.id === active}
            onClick={() => api.switchTo(entry.id)}
            style={{ ...NODE, ...(entry.id === active ? NODE_ON : null) }}
          >
            {entry.ruleId === null ? 'as written' : `without ${entry.ruleId}`}
            {entry.hash === '' ? '' : ` · ${entry.hash}`}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="timeline-branch"
        onClick={() => {
          const result = api.branch(api.tick());
          api.runTo(HORIZON);
          setBranchHash(result.verdict === 'BRANCHED' ? api.hash() : null);
        }}
        style={ACTION}
      >
        Switch one rule off and recompute the future
      </button>

      {outcome === null ? null : (
        <p data-testid="timeline-outcome" role="status" style={ROW}>
          {outcome.verdict === 'BRANCHED'
            ? `Without rule ${outcome.ruleId} (it fired ${String(outcome.firings)}×). The future ${changed ? 'was recomputed' : 'came out the same'}.`
            : outcome.verdict === 'NOTHING_FIRES'
              ? 'From this tick on no rule fires — switching any of them off would change nothing.'
              : `No branch from here: ${outcome.detail}`}
        </p>
      )}
    </section>
  );
}

const PANEL: React.CSSProperties = {
  // Ukotvení nese sloupec v `src/app/page.tsx` — viz tentýž komentář v `Program`.
  pointerEvents: 'auto',
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

const TREE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.3rem',
  marginTop: '0.35rem',
};

const NODE: React.CSSProperties = {
  padding: '0.15rem 0.4rem',
  borderRadius: '0.3rem',
  border: '1px solid #24383d',
  background: 'transparent',
  color: '#9fc0c2',
  font: 'inherit',
  fontSize: '0.72rem',
  cursor: 'pointer',
};

const NODE_ON: React.CSSProperties = {
  borderColor: '#2f9e8f',
  color: '#dceaec',
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
