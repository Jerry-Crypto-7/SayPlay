/**
 * Dvojník kompilátoru her (P23-C, než dorazí P23-A).
 *
 * Skutečný kompilátor staví `WorldDoc` z mechanik ve specu. Ten tu ještě
 * není, a obálka, publikace a remix se přesto musí dát stavět a hrát. Proto
 * každý archetyp dostane **jeden uvařený svět ze skladu** (`authored-worlds.json`),
 * zkompilovaný tou samou cestou jako živá emise – tedy s validací, snížením
 * do IR a svědkem, který už našel opravný krok kompilátoru. Spec se do světa
 * nepropisuje; nese se vedle něj, aby hash, verze a remix měly nad čím stát.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route. Jediné místo mimo
 * `src/play/compile`, které smí sáhnout na sklad kvůli hře.
 */

import type { CompiledGame, CompileGameResult, GameCompiler } from '@/play/contracts';
import type { ArchetypeId } from '@/play/registry';
import { gameSpecHash } from '@/play/spec';
import { AUTHORED_STORE } from '@/worldstream/authored';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { compileBlueprint } from '@/model/worldstream-compiler';
import { readPlannerEmission } from '@/model/worldstream-intent';
import { canonicalHash } from '@/ir/worlddoc';

/** Verze dvojníka; jiná než `GAME_COMPILER_VERSION`, aby se dvojník nikdy nespletl se skutečným kompilátorem. */
export const STUB_COMPILER_VERSION = 'stub-authored-v1';

/** Archetyp → uvařený svět. Jen světy s vyplněným svědkem (c03 a c10 ho mají prázdný). */
const WORLD_BY_ARCHETYPE: Readonly<Record<ArchetypeId, string>> = {
  collect_exit: 'c01',
  chase_escape: 'c20',
  survival_timer: 'c17',
  checkpoint_race: 'c04',
  delivery: 'c09',
  switch_puzzle: 'c15',
  hazard_crossing: 'c24',
  combat_lite: 'c25',
};

type WorldResult =
  | { readonly ok: true; readonly blueprint: WorldstreamBlueprint }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Semínko relace, které dvojník posílá kompilátoru – **jedno pro všechny hry**.
 * Svět je uvařený a semínko volajícího by na něm nic nezměnilo; kdyby ale bylo
 * v klíči cache, každý požadavek s jiným semínkem by přidal 50 ms CPU a ~46 kB
 * haldy navždy (nález revize T3). Semínko hry žije ve `CompiledGame.seed` a v
 * hashi verze, ne tady.
 */
const STUB_SESSION_SEED = 1;

/** Kompilace trvá 10–150 ms; každý svět se staví jednou – nejvýš 8 záznamů. */
const compiledWorlds = new Map<string, WorldResult>();

function compileWorld(worldId: string): WorldResult {
  const cached = compiledWorlds.get(worldId);
  if (cached !== undefined) return cached;

  const world = AUTHORED_STORE.worlds.find((entry) => entry.id === worldId)!;
  const plan = readPlannerEmission(world.planner, { requireSceneSpec: false });
  let result: WorldResult;
  if (!plan.ok) {
    result = { ok: false, issues: [`${worldId}: planner ${plan.reason}: ${plan.detail}`] };
  } else {
    const compiled = compileBlueprint(world.compiler, plan.value, {
      sessionSeed: STUB_SESSION_SEED,
      upstream: { model: 'authored', system: '', user: '' },
    });
    result = compiled.ok
      ? { ok: true, blueprint: compiled.value }
      : { ok: false, issues: [`${worldId}: ${compiled.reason}: ${compiled.detail}`, ...compiled.issues] };
  }
  compiledWorlds.set(worldId, result);
  return result;
}

/** Svědek ze `sim.witness` je ve schématu `unknown`; tady se čte jen délka cesty k výhře. */
function winsAtTickOf(sim: WorldstreamBlueprint['world']['sim']): number | null {
  const witness = sim.witness as { readonly ops?: unknown; readonly L_witness?: unknown } | null | undefined;
  if (!witness || !Array.isArray(witness.ops) || witness.ops.length === 0) return null;
  return typeof witness.L_witness === 'number' && Number.isFinite(witness.L_witness) ? witness.L_witness : null;
}

export function getCompiler(): GameCompiler {
  return (spec, seed): CompileGameResult => {
    const world = compileWorld(WORLD_BY_ARCHETYPE[spec.archetype]);
    if (!world.ok) return { ok: false, reason: 'WORLD_REJECTED', issues: world.issues };
    const { blueprint } = world;
    const value: CompiledGame = {
      spec,
      specHash: gameSpecHash(spec),
      seed,
      // Kontrakt zatím verzi typuje jako literál skutečného kompilátoru; dvojník
      // hlásí svou vlastní (viz docs/play/CONTRACT-CHANGES.md, P23-C).
      compilerVersion: STUB_COMPILER_VERSION as CompiledGame['compilerVersion'],
      blueprint,
      worldHash: canonicalHash(blueprint.world.sim),
      mechanics: [],
      roles: [],
      winsAtTick: winsAtTickOf(blueprint.world.sim),
    };
    return { ok: true, value };
  };
}
