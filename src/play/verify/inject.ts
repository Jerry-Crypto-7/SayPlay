/**
 * Vstřik stavu pro keypoint (P23-A, T9).
 *
 * Runtime se **nemění a nic se do něj nepřidává**: umístění (`placeAt`) se
 * zapíše přepsáním soketu v kopii povrchového `sim`, ze které se svět postaví
 * znovu (`buildRuntimeWorld`), čítače, flagy, stavy a zámky se po
 * `createRuntime` zapíší přes `writeSlot`. Jiná cesta k počátečnímu stavu
 * neexistuje – veřejné mutační API runtime nemá a mít nemá.
 *
 * Klíče vstřiku jsou ID **rolí** ze specu, ne entity; překlad drží
 * `RoleBinding` zkompilované hry. Role s víc instancemi: stav a zámek se
 * vstříknou všem (hráč stojí na jedné a nevíme na které), `placeAt` hýbe
 * první – přesunout všech šest dlaždic na hráče by zónu, o které tvrzení
 * mluví, rozpustilo.
 */

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entitySlotId } from '@/sim/interpreter';
import { writeSlot } from '@/sim/state';

import type { CompiledGame } from '../contracts';
import type { Cell } from '../compile/layout';
import type { SurfaceSim } from '../compile/types';
import type { VerificationAssertion } from '../spec';

export type StateSetup = NonNullable<VerificationAssertion['setup']>;

export interface Injected {
  readonly runtime: Runtime;
  /** Entita hráče – actor každého vstupu keypointu. */
  readonly player: string;
  /** Buňky soketů po `placeAt`; plánovač akcí z nich počítá tiky chůze. */
  readonly cells: Readonly<Record<string, Cell>>;
  /** Co se vstříknout nepodařilo. Neprázdné = tvrzení neprošlo. */
  readonly failures: readonly string[];
}

export function surfaceOf(compiled: CompiledGame): SurfaceSim {
  return compiled.blueprint.world.sim as unknown as SurfaceSim;
}

/** Instance role podle `RoleBinding`; neznámá role dá prázdné pole. */
export function entitiesOfRole(compiled: CompiledGame, roleId: string): readonly string[] {
  return compiled.roles.find((binding) => binding.roleId === roleId)?.entityIds ?? [];
}

export function playerOf(compiled: CompiledGame): string {
  const role = compiled.spec.roles.find((candidate) => candidate.kind === 'player');
  return entitiesOfRole(compiled, role?.id ?? '')[0] ?? '';
}

export function injectSetup(compiled: CompiledGame, setup: StateSetup | undefined): Injected {
  const failures: string[] = [];
  const base = surfaceOf(compiled);
  const cells: Record<string, Cell> = { ...base.sockets };

  for (const [from, at] of Object.entries(setup?.placeAt ?? {})) {
    const mover = entitiesOfRole(compiled, from)[0];
    const anchor = entitiesOfRole(compiled, at)[0];
    if (mover === undefined || anchor === undefined) {
      failures.push(`placeAt: no entity for role ${from} or ${at}`);
      continue;
    }
    cells[base.entities[mover].socket] = base.sockets[base.entities[anchor].socket];
  }

  const built = buildRuntimeWorld({ ...base, sockets: cells });
  // Kompilace týž `sim` už postavila; rozdíl je jen v buňkách soketů, a ty
  // pocházejí z jiných soketů téhož světa. Selhání je tedy chyba kompilátoru.
  if (!built.ok) throw new Error(`keypoint injection: ${built.issues.join('; ')}`);
  const runtime = createRuntime(built.world);

  const write = (slot: string, value: number, where: string): void => {
    if (!runtime.layout.index.has(slot)) {
      failures.push(`${where}: the world declares no slot ${slot}`);
      return;
    }
    writeSlot(runtime.layout, runtime.state, slot, value);
  };

  for (const [id, value] of Object.entries(setup?.counters ?? {})) write(`c:${id}`, value, 'counters');
  for (const [id, value] of Object.entries(setup?.flags ?? {})) write(`f:${id}`, value ? 1 : 0, 'flags');
  for (const [roleId, value] of Object.entries(setup?.entityStates ?? {})) {
    for (const id of entitiesOfRole(compiled, roleId)) {
      const index = runtime.entityStates.get(id)?.index.get(value);
      if (index === undefined) {
        failures.push(`entityStates: ${id} has no state ${value}`);
        continue;
      }
      write(entitySlotId(id, 'state'), index, 'entityStates');
    }
  }
  for (const [roleId, value] of Object.entries(setup?.locked ?? {})) {
    for (const id of entitiesOfRole(compiled, roleId)) write(entitySlotId(id, 'locked'), value ? 1 : 0, 'locked');
  }

  return { runtime, player: playerOf(compiled), cells, failures };
}
