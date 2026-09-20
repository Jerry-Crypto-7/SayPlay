/**
 * Typy kompilátoru simulace (P23-A, T3).
 *
 * Povrchový `sim` má tvar zmrazených odpovědí (`evals/frozen/responses/index.jsonl`
 * C01) a snižuje ho existující `buildRuntimeWorld`; tady jsou jen tak přesné
 * typy, aby adaptér nemohl vydat pravidlo bez události nebo akci bez druhu.
 * Sémantiku (jaké klíče událost žádá) drží `src/ir/surface.ts`, ne tenhle soubor.
 */

import type { SurfaceEventName } from '@/ir/types';

import type { MechanicBinding, RoleBinding } from '../contracts';
import type { RuntimeAction } from '../registry';
import type { GameRole, GameSpecV1 } from '../spec';
import type { Cell, Layout, Rect } from './layout';
import type { CompileRng } from './rng';

export interface SurfaceEvent {
  readonly kind: SurfaceEventName;
  readonly [key: string]: unknown;
}

export interface SurfaceCondition {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface SurfaceAction {
  readonly kind: RuntimeAction;
  readonly [key: string]: unknown;
}

export interface SurfaceRule {
  readonly id: string;
  readonly phase: number;
  readonly priority: number;
  readonly event: SurfaceEvent;
  readonly condition: SurfaceCondition | null;
  readonly actions: readonly SurfaceAction[];
}

export interface SurfaceEntity {
  readonly role: string;
  readonly socket: string;
  readonly state: string;
  readonly locked?: boolean;
}

export interface CounterDecl {
  readonly min: number;
  readonly max: number;
  readonly init: number;
}

export interface TimerDecl {
  readonly durationTicks: number;
  readonly init: number;
}

export interface AgentDecl {
  readonly id: string;
  readonly disposition: 'bold' | 'wary' | 'restless';
  readonly goals: readonly string[];
}

export interface SurfaceState {
  readonly counters: Record<string, CounterDecl>;
  readonly flags: Record<string, { readonly init: boolean }>;
  readonly timers: Record<string, TimerDecl>;
  readonly zones: Record<string, readonly Rect[]>;
  readonly slots: number;
  readonly pool: Record<string, { readonly size: number; readonly tag: string }>;
  readonly agents?: readonly AgentDecl[];
}

export interface WitnessOp {
  readonly tick: number;
  readonly actionId: string;
  readonly target: string;
}

export interface SurfaceSim {
  readonly layout: { readonly width: number; readonly height: number };
  readonly grid: { readonly cell: 1 };
  readonly sockets: Record<string, Cell>;
  readonly collisionAabb: Record<string, Rect>;
  readonly entities: Record<string, SurfaceEntity>;
  readonly state: SurfaceState;
  readonly rules: Record<string, SurfaceRule>;
  readonly witness: { readonly tier: 'short'; readonly H_cert: number; readonly ops: readonly WitnessOp[] };
}

/** Co adaptér vidí: spec, rozvržení a překlad rolí na entity. */
export interface AdapterContext {
  readonly spec: GameSpecV1;
  readonly layout: Layout;
  readonly rng: CompileRng;
  /** Entita hráče (`role: 'actor'`). */
  readonly player: string;
  readonly role: (roleId: string) => GameRole;
  /** ID instancí role = ID entit i soketů (`roleInstanceId`). */
  readonly instances: (roleId: string) => readonly string[];
}

/**
 * Krok svědka, který mechanika k výhře potřebuje. Kompilátor kroky seřadí
 * podle `stage` (0 = předpoklady jako sběr a spínače, 1 = závěr jako vstup do
 * východu), doplní tiky podle vzdáleností a stopu ověří `verifyWitness` –
 * jeden replay místo hledání, které nad 7 sokety × 5 předměty stojí desítky
 * sekund (naměřeno 20. 9. 2026: 2 623 uzlů, 48 s).
 */
export interface WitnessStep {
  readonly actionId: 'moveTo' | 'pickup' | 'use';
  readonly target: string;
  readonly stage: 0 | 1;
}

/** Co adaptér přidá do `sim`. Klíče pravidel a entit musí být v celém `sim` jedinečné. */
export interface AdapterOutput {
  readonly rules: Record<string, SurfaceRule>;
  readonly witness?: readonly WitnessStep[];
  readonly entities?: Record<string, SurfaceEntity>;
  readonly counters?: Record<string, CounterDecl>;
  readonly flags?: Record<string, { readonly init: boolean }>;
  readonly timers?: Record<string, TimerDecl>;
  readonly zones?: Record<string, readonly Rect[]>;
  readonly pool?: Record<string, { readonly size: number; readonly tag: string }>;
  readonly agents?: readonly AgentDecl[];
  /** Kolik inventárních slotů mechanika žádá (`giveItem`/`hasItem`). */
  readonly slots?: number;
}

export type MechanicAdapter<P = unknown> = (params: P, ctx: AdapterContext) => AdapterOutput;

export interface SimCompilation {
  readonly sim: SurfaceSim;
  readonly layout: Layout;
  readonly mechanics: readonly MechanicBinding[];
  readonly roles: readonly RoleBinding[];
}

export type SimCompileResult =
  | { readonly ok: true; readonly value: SimCompilation }
  | { readonly ok: false; readonly reason: 'LAYOUT_FAILED' | 'MECHANIC_UNSUPPORTED'; readonly issues: readonly string[] };
