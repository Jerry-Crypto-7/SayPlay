/**
 * Úložiště větví času (P15 T38).
 *
 * `rebranchAt` umí z minulosti odbočit, ale výsledek nikam neukládá — vrátí
 * runtime a osu a odejde. Kdo si je nikam nedá, ten předchozí budoucnost
 * ztratil: přesně to dělal panel času do téhle úlohy (`controller.axis =
 * result.timeline`, tedy **přepis**). „Dvě budoucnosti vedle sebe" tím pádem
 * neexistovaly ani jako data, natož na obrazovce.
 *
 * ## Proč se pečetí, a proč hlubokou kopií
 *
 * Živý runtime větve je pořád živý: `step` píše do `runtime.state` **na místě**
 * (`writeSlot` v interpretu), takže větev, která si svůj výsledek drží odkazem,
 * o něm přestane mluvit pravdu, jakmile se z ní krokuje dál — hash pak popisuje
 * tik, na kterém běh právě stojí, ne ten, na kterém větev dopadla.
 *
 * Pečeť je proto `runtime.state.slice()`, tedy vlastní pole.
 *
 * **Naměřeno 3. 9. 2026, ať to nikdo nemusí zkoušet podruhé:** nahradit ten
 * `slice()` odkazem shodí **jenom** jednotkový test „krokování runtimu po
 * zapečetění hashem větve nehne". Přetáčení tu vadu neodhalí a `branch-replay`
 * nad ní zůstane zelený, protože `restore` v `timeline.ts:82` dělá
 * `runtime.state = snapshot.state.slice()`, tedy pole **vymění**; zapečetěné
 * pole tím osiří a náhodou zůstane platné. Je to shoda okolností, ne záruka —
 * jakmile někdo `restore` zlevní na `runtime.state.set(...)`, spadnou hashe
 * všech větví naráz a jediné, co to chytí, je ten jednotkový test.
 *
 * ## Co tady schválně není
 *
 * **Krokování.** Úložiště větve zakládá, pečetí a přepíná; kolik tiků kdo
 * doběhne, je rozhodnutí volajícího. Kdyby si běh řídilo samo, muselo by znát
 * horizont, vstupy i to, jestli se právě kreslí — tři věci, které patří panelu.
 */

import { hashHex } from './hash';
import type { Runtime, WorldDocRuntime } from './interpreter';
import type { Timeline } from './timeline';

export interface Branch {
  readonly id: string;
  /** Větev, ze které se odbočilo. `null` jen u kořene. */
  readonly parentId: string | null;
  /** Tik, ve kterém se odbočilo. Nula u kořene. */
  readonly atTick: number;
  /** Pravidlo, které se v téhle větvi vypnulo. `null` u kořene. */
  readonly ruleId: string | null;
  readonly doc: WorldDocRuntime;
  readonly runtime: Runtime;
  readonly timeline: Timeline;
}

/** Co o větvi ví okolí. Pečeť, ne živý stav — právě proto se dá porovnávat. */
export interface BranchView {
  readonly id: string;
  readonly parentId: string | null;
  readonly atTick: number;
  readonly ruleId: string | null;
  /** Tik, na kterém větev odpočívala, když se pečetila. `-1` = ještě nikdy. */
  readonly tick: number;
  /** Hash zapečetěného stavu. Prázdný řetězec, dokud se nezapečetilo. */
  readonly hash: string;
}

export interface BranchStore {
  active: () => Branch;
  list: () => readonly BranchView[];
  view: (id: string) => BranchView | null;
  /**
   * Zapíše novou větev a **postaví se na ni**. Přepnutí je součástí zakládání
   * schválně: odbočka, po které se dál krokuje ta stará, je vada, kterou by
   * nikdo neviděl.
   */
  open: (spec: {
    readonly parentId: string;
    readonly atTick: number;
    readonly ruleId: string;
    readonly doc: WorldDocRuntime;
    readonly runtime: Runtime;
    readonly timeline: Timeline;
  }) => Branch;
  /** Zapečetí **aktivní** větev tam, kde právě stojí. */
  seal: () => void;
  switchTo: (id: string) => boolean;
}

interface Record_ {
  readonly branch: Branch;
  /** Zapečetěný zabalený stav — vlastní pole, nikdy odkaz do runtimu. */
  outcome: Uint32Array | null;
  outcomeTick: number;
}

function viewOf(record: Record_): BranchView {
  return {
    id: record.branch.id,
    parentId: record.branch.parentId,
    atTick: record.branch.atTick,
    ruleId: record.branch.ruleId,
    tick: record.outcomeTick,
    hash: record.outcome === null ? '' : hashHex(record.outcome),
  };
}

/** Kořen je větev jako každá jiná — jen nemá rodiče a nic v ní nezmlklo. */
export function createBranchStore(root: {
  readonly doc: WorldDocRuntime;
  readonly runtime: Runtime;
  readonly timeline: Timeline;
}): BranchStore {
  const records: Record_[] = [
    {
      branch: { id: 'origin', parentId: null, atTick: 0, ruleId: null, ...root },
      outcome: null,
      outcomeTick: -1,
    },
  ];
  let active = 0;

  return {
    active: () => records[active].branch,
    list: () => records.map(viewOf),
    view: (id) => {
      const found = records.find((record) => record.branch.id === id);
      return found === undefined ? null : viewOf(found);
    },
    open: (spec) => {
      const branch: Branch = { id: `branch-${String(records.length)}`, ...spec };
      records.push({ branch, outcome: null, outcomeTick: -1 });
      active = records.length - 1;
      return branch;
    },
    seal: () => {
      const record = records[active];
      // **Tenhle `slice()` je celá úloha.** Bez něj pečeť ukazuje do runtimu,
      // který se dál hýbe, a větev by o svém konci lhala hned, jak z ní někdo
      // odbočí dál — `rebranchAt` rodičovský runtime přetáčí do minulosti.
      record.outcome = record.branch.runtime.state.slice();
      record.outcomeTick = record.branch.runtime.tick;
    },
    switchTo: (id) => {
      const index = records.findIndex((record) => record.branch.id === id);
      if (index < 0) return false;
      active = index;
      return true;
    },
  };
}
