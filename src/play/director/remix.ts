/**
 * Remix (P23-B T8): čipy jdou deterministicky, volná věta přes model.
 *
 * Čtyři čipy z `docs/play/pack/PRODUCT_COPY.md` se přeloží na RFC 6902
 * operace bez modelu: dítě se sestaví nad kopií rodiče a záplata je
 * `createPatch(parent, child)` – takže obálka dostane totéž, co by dostala od
 * modelu, a `applyRemix` je jedna cesta pro obě. `reskin` sahá jen na `theme`,
 * `title` a `label`y; `mechanics`, `objective` a `verification` zůstávají
 * bajtově stejné (test to drží). `harder` mění právě jeden parametr mechaniky
 * a dorovná čísla, která na něm stojí (`objective.count`, `count` role),
 * jinak by kritik vrátil `CONTRADICTION`. U hry žánru posune parametr
 * generátoru režimu (`GENRE_HARDER`); ostatní čipy kromě `reskin` ji nemění.
 *
 * `classifyRemix` řadí volnou větu do třídy kontraktu (`RemixClass`); třídy
 * `mechanic`, `topology` a `objective` jdou vždy přes model
 * (`buildRemixRequest`), `parameter` a `presentation` bez čipu také – jen
 * čipy jsou bez modelu.
 */

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { type Operation, applyPatch, createPatch } from 'rfc6902';

import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import { MODE_GENERATORS } from '../arcade/library';
import { arcadeWorldOf, preloadPhysics } from '../arcade/compile';
import { loadRapier } from '../arcade/physics/world';
import { verifyArcade } from '../arcade/verify';
import { matchesWitness, type ActionWitness } from '../arcade/witness';
import { assemblyOfCell, liveCells } from '../compose/allowed';
import { compileRecipe } from '../compose/compile';
import { PRESETS } from '../compose/presets';
import type { CastItem } from '../genre/contract';
import { ACTIONS, MOVES, THREATS, essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import { STEER_DIFFICULTIES } from '../arcade/pieces/steer';
import { aimHarder, aimSwap, beatHarder, difficultyHarder, hazardSwap, runnerHarder, runnerSwapObstacles, runnerTwist, targetSwap } from '../arcade/remix';
import { pickControl } from '../draft/controls';
import { ARCHETYPES, type MechanicId } from '../registry';
import { readGameSpec, type GameSpecReason, type GameSpecV1, type GameRole } from '../spec';

import { renderRegistry } from './prompt';
import { OBJECTIVE_WORDS, type RemixChip, classifyRemix } from './remix-words';
import { REPAIR_RULES, keypointFor } from './repair';

export {
  MECHANIC_VERBS,
  OBJECTIVE_WORDS,
  PARAMETER_WORDS,
  PRESENTATION_WORDS,
  REMIX_CHIPS,
  REMIX_CHIP_LABELS,
  type RemixChip,
  TOPOLOGY_WORDS,
  chipOf,
  classifyRemix,
} from './remix-words';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface RecipeRemixSuggestion {
  readonly id: string;
  readonly label: string;
  readonly cellId: string;
  readonly spec: GameSpecV1;
  readonly ops: readonly Operation[];
}

/** Server-only: revalidate these at POST time, never trust a client-supplied spec. */
export async function verifiedRecipeRemixes(parent: GameSpecV1, seed: number, options: {
  readonly intent?: Intent;
  readonly unmet?: readonly IntentTriple[];
} = {}): Promise<readonly RecipeRemixSuggestion[]> {
  // An unfinished request must not be advertised as a complete remix.
  if (options.unmet?.length) return [];
  await preloadPhysics(parent, loadRapier);
  const original = arcadeWorldOf(parent, seed);
  if (!original.ok) return [];
  const before = verifyArcade(original.world, undefined, original.roleBindings);
  if (!before.publishEligible) return [];
  const hero = parent.roles.find(role => role.kind === 'player')?.label ?? 'hero';
  const has = (verb: string) => before.witnesses.some(witness => witness.verb === verb);
  const preset = parent.genre === undefined ? undefined : PRESETS[`${parent.genre.id}.${parent.genre.mode}`];
  const declared = options.intent?.items.filter(item => item.essential);
  const moves = declared === undefined ? preset === undefined ? MOVES.filter(has) : MOVES.filter(move => move === preset.move) : MOVES.filter(move => declared.some(item => item.axis === 'move' && item.verb === move));
  const actions = declared === undefined ? ACTIONS.filter(action => (preset === undefined ? has(action) : preset.actions.includes(action)) || (parent.addons as readonly string[] | undefined)?.includes(action)) : ACTIONS.filter(action => declared.some(item => item.axis === 'action' && item.verb === action));
  const threats = declared === undefined ? THREATS.filter(threat => (preset === undefined ? has(threat) : preset.threats.includes(threat)) || (parent.addons as readonly string[] | undefined)?.includes(threat)) : THREATS.filter(threat => declared.some(item => item.axis === 'threat' && item.verb === threat));
  const retainedVerbs: readonly string[] = [...moves, ...actions, ...threats, ...(preset === undefined ? ['race', 'escape', 'reach', 'score'].filter(has) : [preset.objective])];
  const triples = options.intent === undefined
    ? before.witnesses.filter(witness => retainedVerbs.includes(witness.verb)).map(witness => ({ actor: witness.actor.label, verb: witness.verb, object: witness.object?.label ?? null }))
    : essentialTriples(options.intent);
  if (triples.some(triple => !before.witnesses.some(witness => matchesWitness(triple, witness)))) return [];
  const cast: CastItem[] = [];
  const castRole: Readonly<Record<string, CastItem['does']>> = { shoot: 'shoot_at', throw: 'throw_at', fight: 'fight', collect: 'collect', reach: 'reach', interact: 'reach' };
  for (const witness of before.witnesses) {
    const does = witness.actor.player ? castRole[witness.verb] : ['chaser', 'guard'].includes(witness.verb) ? 'chase_me' : undefined;
    const label = witness.actor.player ? witness.object?.label : witness.actor.label;
    if (does !== undefined && label !== undefined && !cast.some(item => item.label === label && item.does === does)) cast.push({ label, does });
  }
  const result: RecipeRemixSuggestion[] = [];
  const choices = [
    { id: 'add-shooting', label: 'Add shooting', verb: 'shoot' },
    { id: 'make-race', label: 'Make it a race', verb: 'race' },
    { id: 'swap-boat', label: 'Swap to a boat', verb: 'drive' },
    { id: 'add-chase', label: 'Add a chase', verb: 'chaser' },
    { id: 'add-collecting', label: 'Add collecting', verb: 'collect' },
  ];
  for (const choice of choices) {
    if (result.length === 3) break;
    const swap = choice.id === 'swap-boat';
    if (swap ? /\b(?:boat|ship|sailboat|yacht)\b/i.test(hero) : has(choice.verb)) continue;
    for (const cell of liveCells()) {
      const recipe = cell.recipe;
      if (swap ? recipe.move !== 'drive' : moves.length > 0 && !moves.includes(recipe.move as typeof moves[number])) continue;
      if (actions.some(action => !recipe.actions.includes(action)) || threats.some(threat => !recipe.threats.includes(threat))) continue;
      if (!swap && !([...recipe.actions, recipe.objective, ...recipe.threats] as readonly string[]).includes(choice.verb)) continue;
      // A race request replaces the goal; other chips retain a proved race/escape.
      if (choice.verb !== 'race' && ['race', 'escape'].some(verb => has(verb) && recipe.objective !== verb)) continue;
      const content = { ...cell.preset, hero: swap ? 'boat' : hero, setting: swap ? 'ocean' : parent.theme.setting,
        cast: [...cast, ...(cell.preset.cast ?? []).filter(item => !cast.some(existing => existing.does === item.does))] };
      let spec: GameSpecV1;
      let witnesses: readonly ActionWitness[];
      try {
        spec = compileRecipe(assemblyOfCell(cell, content));
        await preloadPhysics(spec, loadRapier);
        const built = arcadeWorldOf(spec, seed);
        if (!built.ok) continue;
        const verified = verifyArcade(built.world, undefined, built.roleBindings);
        if (!verified.publishEligible) continue;
        witnesses = verified.witnesses;
      } catch { continue; }
      const needed = [...(recipe.move === 'stationary' ? [] : [recipe.move]), ...recipe.actions, ...recipe.threats, recipe.objective];
      if (needed.some(verb => !witnesses.some(witness => witness.verb === verb))) continue;
      const preserved = triples.filter(triple => !(swap && (MOVES as readonly string[]).includes(triple.verb)) && !(choice.verb === 'race' && ['reach', 'score', 'survive'].includes(triple.verb)))
        .map(triple => swap ? { ...triple, actor: triple.actor === hero || triple.actor === 'hero' ? 'boat' : triple.actor, object: triple.object === hero ? 'boat' : triple.object } : triple);
      if (preserved.some(triple => !witnesses.some(witness => matchesWitness(triple, witness)))) continue;
      result.push({ id: choice.id, label: choice.label, cellId: cell.id, spec, ops: createPatch(parent, spec) });
      break;
    }
  }
  return result;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

function mechanic<P>(spec: GameSpecV1, id: MechanicId): P | undefined {
  return spec.mechanics.find((m) => m.id === id)?.params as P | undefined;
}

const SPEEDS = ['slow', 'normal', 'fast'] as const;

/** Právě jedna změna parametru; první z tabulky, která na spec sedí. */
function harder(child: GameSpecV1): boolean {
  const ids = child.mechanics.map((m) => m.id);
  const chaser = mechanic<{ speed: (typeof SPEEDS)[number] }>(child, 'chaser');
  if (chaser !== undefined && chaser.speed !== 'fast') {
    const next = SPEEDS[SPEEDS.indexOf(chaser.speed) + 1];
    // `fast` bez omráčení ani checkpointu je pro kritika UNFAIR_SPAWN.
    if (next !== 'fast' || ids.includes('stun') || ids.includes('checkpoint')) {
      chaser.speed = next;
      return true;
    }
  }
  const timer = mechanic<{ seconds: number }>(child, 'timer');
  if (timer !== undefined && Math.round(timer.seconds * 0.8) >= 5) {
    timer.seconds = Math.round(timer.seconds * 0.8);
    if (child.objective.seconds !== undefined) child.objective.seconds = timer.seconds;
    return true;
  }
  const collectible = mechanic<{ role: string; count: number }>(child, 'collectible');
  if (collectible !== undefined && collectible.count + 2 <= 20) {
    collectible.count += 2;
    if (child.objective.role === collectible.role && child.objective.count !== undefined) child.objective.count = collectible.count;
    const role = child.roles.find((r) => r.id === collectible.role);
    if (role !== undefined && role.count < collectible.count) role.count = collectible.count;
    return true;
  }
  const defeat = mechanic<{ hitsPerTarget: number }>(child, 'defeat');
  if (defeat !== undefined && defeat.hitsPerTarget < 3) {
    defeat.hitsPerTarget += 1;
    return true;
  }
  const patrol = mechanic<{ stops: number }>(child, 'patrol');
  if (patrol !== undefined && patrol.stops < 6) {
    patrol.stops += 1;
    return true;
  }
  const hazard = mechanic<{ pulse?: { onSeconds: number; offSeconds: number } }>(child, 'hazard_zone');
  if (hazard?.pulse !== undefined && hazard.pulse.offSeconds > 1) {
    hazard.pulse.offSeconds -= 1;
    return true;
  }
  const sw = mechanic<{ switchRoles: string[]; required: string[] }>(child, 'switch');
  if (sw !== undefined) {
    const spare = sw.switchRoles.find((id) => !sw.required.includes(id));
    if (spare !== undefined && sw.required.length < 6) {
      sw.required.push(spare);
      return true;
    }
  }
  const checkpoint = mechanic<{ count: number; role: string }>(child, 'checkpoint');
  if (checkpoint !== undefined && checkpoint.count < 8) {
    checkpoint.count += 1;
    if (child.objective.role === checkpoint.role && child.objective.count !== undefined) child.objective.count = checkpoint.count;
    const role = child.roles.find((r) => r.id === checkpoint.role);
    if (role !== undefined && role.count < checkpoint.count) role.count = checkpoint.count;
    return true;
  }
  return false;
}

interface GenreStep {
  readonly key: string;
  /** Krok čísla (záporný = menší je těžší), nebo pořadí hodnot od nejlehčí. */
  readonly step: number | readonly string[];
  /** Druh role, jejíž počet parametr nese – dorovná se v roli, v cíli i v jeho textu. */
  readonly role?: GameRole['kind'];
}

/**
 * Čip `harder` u hry žánru (P32B T5b): parametr generátoru režimu o krok, první
 * z řádku, který mez schématu generátoru ještě pustí a hra s ním projde `accept`.
 * Rychlost a výdrž soupeře před počtem – počet mění i to, co hra slibuje.
 */
const GENRE_HARDER: Readonly<Record<string, readonly GenreStep[]>> = {
  arena_catch: [{ key: 'preySpeed', step: 20 }],
  arena_escape: [{ key: 'chaserSpeed', step: 10 }, { key: 'chasers', step: 1, role: 'chaser' }],
  arena_collect: [{ key: 'items', step: 2, role: 'collectible' }],
  fight: [{ key: 'enemyHp', step: 1 }, { key: 'enemySpeed', step: 10 }],
  quest_spatial: [{ key: 'rocks', step: 1 }, { key: 'chaserSpeed', step: 10 }],
  quest_station: [{ key: 'window', step: -15 }],
  voyage_race: [{ key: 'difficulty', step: STEER_DIFFICULTIES }, { key: 'lengthM', step: 50 }],
  voyage_land: [{ key: 'difficulty', step: STEER_DIFFICULTIES }, { key: 'lengthM', step: 50 }],
};

function genreHarder(child: GameSpecV1, accept?: (spec: GameSpecV1) => boolean): boolean {
  const { generator, tuning = {}, ...own } = child.controlParams as Record<string, unknown> & { readonly generator?: string; readonly tuning?: Record<string, unknown> };
  const mode = generator !== undefined && Object.hasOwn(MODE_GENERATORS, generator) ? MODE_GENERATORS[generator] : undefined;
  if (generator === undefined || mode === undefined) return false;
  // Generátor čte vlastní parametry ovládání i `tuning` (`ownParams` v `arcade/compile.ts`).
  const params = { ...own, ...tuning };
  const current = mode.params.parse(params) as Record<string, unknown>;
  for (const { key, step, role: kind } of GENRE_HARDER[generator] ?? []) {
    const now = current[key];
    const value = typeof step === 'number' ? (typeof now === 'number' ? now + step : undefined) : step[step.indexOf(String(now)) + 1];
    if (value === undefined || !mode.params.safeParse({ ...params, [key]: value }).success) continue;
    // Klíč, který soudí schéma ovládání (obtížnost plavby), patří do `controlParams`, jinak do `tuning` (`spec.ts`).
    const inTuning = { tuning: { ...tuning, [key]: value } };
    const places = Object.hasOwn(tuning, key) ? [inTuning] : Object.hasOwn(own, key) ? [{ [key]: value }] : [inTuning, { [key]: value }];
    for (const place of places) {
      const probe = clone(child);
      probe.controlParams = { ...probe.controlParams, ...place };
      const role = kind === undefined ? undefined : probe.roles.find((candidate) => candidate.kind === kind);
      if (role !== undefined && typeof now === 'number' && typeof value === 'number') {
        role.count = value;
        if (probe.objective.role === role.id && probe.objective.count !== undefined) {
          probe.objective.count = value;
          const old = new RegExp(`\\b${String(now)}\\b`);
          probe.objective.description = probe.objective.description.replace(old, String(value));
          probe.tutorial.goalLine = probe.tutorial.goalLine.replace(old, String(value));
        }
      }
      if (!readGameSpec(probe).ok || (accept !== undefined && !accept(probe))) continue;
      Object.assign(child, probe);
      return true;
    }
  }
  return false;
}

const ENEMY_LABELS = ['security drone', 'angry goose', 'haunted vacuum', 'clockwork knight', 'giant crab', 'shadow cat'] as const;
const DISPOSITIONS = ['bold', 'wary', 'restless'] as const;

function swapEnemy(child: GameSpecV1, pick: (max: number) => number): boolean {
  const enemy = child.roles.find((role) => role.kind === 'chaser' || role.kind === 'patrol');
  if (enemy === undefined) return false;
  const candidates = ENEMY_LABELS.filter((label) => label !== enemy.label);
  enemy.label = candidates[pick(candidates.length)];
  const patrol = mechanic<{ role: string; disposition: (typeof DISPOSITIONS)[number] }>(child, 'patrol');
  if (patrol !== undefined && patrol.role === enemy.id) {
    const others = DISPOSITIONS.filter((d) => d !== patrol.disposition);
    patrol.disposition = others[pick(others.length)];
  }
  return true;
}

const SKINS = [
  { name: 'Neon', setting: 'neon sci-fi station', mood: 'electric', adjective: 'neon' },
  { name: 'Reef', setting: 'sunlit coral reef', mood: 'dreamy', adjective: 'coral' },
  { name: 'Haunted', setting: 'haunted forest at midnight', mood: 'eerie', adjective: 'ghostly' },
  { name: 'Candy', setting: 'candy kingdom', mood: 'playful', adjective: 'candy' },
] as const;

function reskin(child: GameSpecV1, pick: (max: number) => number): void {
  const candidates = SKINS.filter((skin) => skin.setting !== child.theme.setting);
  const skin = candidates[pick(candidates.length)];
  child.theme = { setting: skin.setting, mood: skin.mood };
  child.title = cap(`${child.title} – ${skin.name}`, 80);
  // Popisek má nejvýš tři slova (`roleLabel`), přídavné jméno proto nahradí první z nich.
  for (const role of child.roles) role.label = cap(`${skin.adjective} ${role.label.split(' ').slice(-2).join(' ')}`, 60);
}

/** Nová role pro přidanou mechaniku; `id` uhýbá kolizi. */
function addRole(child: GameSpecV1, id: string, kind: GameRole['kind'], label: string, count = 1): string {
  const taken = new Set(child.roles.map((role) => role.id));
  const roleId = taken.has(id) ? `${id}_2` : id;
  child.roles.push({ id: roleId, kind, label, count });
  return roleId;
}

/** Výchozí parametry přidané mechaniky, i s rolí, kterou potřebuje; `null` = nejde bez modelu. */
function twistParams(child: GameSpecV1, id: MechanicId): Record<string, unknown> | null {
  const roleOf = (kind: GameRole['kind']): string | undefined => child.roles.find((role) => role.kind === kind)?.id;
  switch (id) {
    case 'chaser':
      return { role: roleOf('chaser') ?? addRole(child, 'chaser', 'chaser', 'security drone'), speed: 'normal', catchEffect: 'lose' };
    case 'patrol':
      return { role: roleOf('patrol') ?? addRole(child, 'guard', 'patrol', 'sleepy guard'), disposition: 'wary', stops: 3, touchEffect: 'lose' };
    case 'hazard_zone':
      return { role: roleOf('hazard') ?? addRole(child, 'hazard', 'hazard', 'sparking floor', 2), effect: 'lose', pulse: { onSeconds: 2, offSeconds: 4 } };
    case 'timer':
      return { id: 'clock', seconds: child.targetDurationSec, onEnd: 'lose' };
    case 'health': {
      // Zdraví ubírá jen zásah s účinkem `damage`; bez něj pravidlo nikdy
      // nevystřelí, keypoint `health_fires` neprojde a čip končí 422.
      const damaging = child.mechanics.some((m) => {
        const params = m.params as Record<string, unknown>;
        return params.effect === 'damage' || params.catchEffect === 'damage' || params.touchEffect === 'damage';
      });
      return damaging ? { max: 3 } : null;
    }
    case 'stun': {
      const target = roleOf('chaser') ?? roleOf('patrol');
      return target === undefined ? null : { targetRole: target, seconds: 3, uses: 3 };
    }
    case 'collectible':
      return { role: addRole(child, 'bonus', 'collectible', 'bonus coin', 3), count: 3, counter: 'bonus' };
    case 'checkpoint':
      return { role: roleOf('checkpoint') ?? addRole(child, 'flag', 'checkpoint', 'flag', 3), count: 3, ordered: false };
    case 'lock_key':
      return { keyRole: addRole(child, 'key', 'key', 'brass key'), doorRole: addRole(child, 'gate', 'door', 'locked gate'), keysNeeded: 1 };
    default:
      return null;
  }
}

/**
 * `accept` pustí jen kandidáta, jehož hra projde vlastními kontrolami. Pět
 * mechanik (chaser, patrol, timer, health, lock_key) nemá keypoint ve
 * fixturách a dostane náhradní „vystřelí do 30 tiků“ – časovač ani zdraví bez
 * zásahu to nikdy nesplní a čip končil 422 (22. 9. 2026).
 */
function twist(child: GameSpecV1, pick: (max: number) => number, accept?: (spec: GameSpecV1) => boolean): boolean {
  if (child.mechanics.length >= 4) return false;
  const present = new Set(child.mechanics.map((m) => m.id));
  // `timer` u `survive` a `zone_trigger` bez smyslu se přeskočí; ostatní jdou přes `twistParams`.
  const candidates = [...new Set(ARCHETYPES[child.archetype].allowedMechanics)].filter(
    (id) => !present.has(id) && !['zone_trigger', 'spawn_wave', 'property_transform', 'counter', 'defeat', 'carry', 'switch'].includes(id) && !(id === 'timer' && child.objective.kind === 'survive'),
  );
  // Zkouší se od vylosovaného dál, aby nesplnitelná (stun bez nepřítele) nezastavila čip.
  const start = candidates.length === 0 ? 0 : pick(candidates.length);
  for (let step = 0; step < candidates.length; step += 1) {
    const id = candidates[(start + step) % candidates.length];
    const probe = clone(child);
    const params = twistParams(probe, id);
    if (params === null) continue;
    probe.mechanics.push({ id, params });
    const keypoint = keypointFor(probe, { id, params });
    if (keypoint !== null) probe.verification.push(keypoint);
    if (!readGameSpec(probe).ok) continue;
    if (accept !== undefined && !accept(probe)) continue;
    Object.assign(child, probe);
    return true;
  }
  return false;
}

/** RFC 6902 operace čipu; stejný `seed` dá stejné operace. Prázdné pole = na tomhle specu čip nemá co změnit. */
export function remixPatch(chip: RemixChip, parent: GameSpecV1, seed = 1, accept?: (spec: GameSpecV1) => boolean): Operation[] {
  const rng = xoroshiro128plus(seed);
  const pick = (max: number): number => uniformInt(rng, 0, max - 1);
  const child = clone(parent);
  // Parametry hry s delegovaným generátorem (P32-0 T4) patří generátoru režimu: `harder` zná jeho krok, ostatní čipy ne.
  const delegated = parent.controlParams !== undefined && ('generator' in parent.controlParams || 'tuning' in parent.controlParams);
  if (delegated && chip === 'harder') return genreHarder(child, accept) ? createPatch(parent, child) : [];
  if (delegated && chip !== 'reskin') return [];
  if (parent.control === 'runner' && chip !== 'reskin') {
    if (chip === 'harder') runnerHarder(child);
    else if (chip === 'twist') runnerTwist(child, pick, accept);
    else runnerSwapObstacles(child, pick);
    return createPatch(parent, child);
  }
  if ((parent.control === 'platform' || parent.control === 'flap' || parent.control === 'steer' || parent.control === 'move_free') && chip !== 'reskin') {
    if (chip === 'harder') difficultyHarder(child);
    else if (chip === 'twist') runnerTwist(child, pick, accept);
    else hazardSwap(child, pick);
    return createPatch(parent, child);
  }
  if ((parent.control === 'shooter' || parent.control === 'throw') && chip !== 'reskin') {
    if (chip === 'harder') aimHarder(child);
    else if (chip === 'twist') runnerTwist(child, pick, accept);
    else aimSwap(child, pick);
    return createPatch(parent, child);
  }
  if ((parent.control === 'timing' || parent.control === 'rhythm' || parent.control === 'duel') && chip !== 'reskin') {
    if (chip === 'harder') beatHarder(child);
    else if (chip === 'twist') runnerTwist(child, pick, accept);
    else targetSwap(child, pick);
    return createPatch(parent, child);
  }
  switch (chip) {
    case 'harder':
      harder(child);
      break;
    case 'twist':
      twist(child, pick, accept);
      break;
    case 'swap_enemy':
      if (!swapEnemy(child, pick)) harder(child);
      break;
    case 'reskin':
      reskin(child, pick);
      break;
  }
  return createPatch(parent, child);
}

export type RemixApplyReason = 'PATCH_FAILED' | GameSpecReason;

export function applyRemix(parent: GameSpecV1, ops: readonly Operation[]): { ok: true; spec: GameSpecV1 } | { ok: false; reason: RemixApplyReason; detail: string } {
  const work = clone(parent) as unknown;
  const errors = applyPatch(work, ops as Operation[]);
  const failed = errors.findIndex((error) => error !== null);
  if (failed >= 0) return { ok: false, reason: 'PATCH_FAILED', detail: `operation ${String(failed)}: ${errors[failed]?.message ?? 'failed'}` };
  const result = readGameSpec(work);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.issues.join('; ') };
  return { ok: true, spec: result.value };
}

const REMIX_ANSWER_LINE =
  'The player asked for a change to an existing game. Answer with a JSON array of RFC 6902 operations ({"op":"replace"|"add"|"remove","path":"/json/pointer","value":...}) over SPEC and nothing else. Never touch /schema or /archetype. Keep every mechanic the request does not mention; every mechanic you add needs a role and a verification keypoint.';

/**
 * Slova, kterými si věta o jiného hrdinu řekne výslovně („play as a cat“).
 * Holé „player“ ne – „enemies chase the player faster“ o hrdinovi nemluví.
 */
const HERO_WORDS = /\b(play(?:ing)? as|(?:new|different|another) (?:hero|character)|make me|i am|i'm)\b/i;

/** Rovnost bez ohledu na pořadí klíčů – uložený rodič je kanonicky seřazený, záplatované dítě ne. */
function same(a: unknown, b: unknown): boolean {
  return createPatch({ value: a }, { value: b }).length === 0;
}

/**
 * Stráž remixu vlastní větou (P27C T4): dítě smí změnit ovládání (`control`,
 * `controlParams`, `addons`), cíl (archetyp, druh a roli `objective`, kterýkoli
 * keypoint rodiče) a hrdinu (roli `player`) jen tehdy, když o to věta
 * výslovně žádá – slovesem ovládání (`pickControl` z návrhu ze slov), slovem
 * cíle nebo hrdiny. „add snow“, po kterém se hraje jinak, je rozbitá hra,
 * i když projde ověřením robotem. `false` = odmítnout (`UNASKED_CHANGE`).
 * Nové keypointy smí přibýt vždy: každá přidaná mechanika jeden potřebuje.
 */
export function remixKeeps(parent: GameSpecV1, child: GameSpecV1, sentence: string): boolean {
  // Každá část má svá slova: „make enemies shoot fireballs“ je sloveso ovládání,
  // ale o jiný cíl ani jiného hrdinu si neříká (revize T4, nález 4).
  const text = sentence.toLowerCase();
  const askedControl = pickControl(text) !== null;
  const askedGoal = OBJECTIVE_WORDS.test(text);
  const askedHero = HERO_WORDS.test(text);

  const control = !same([parent.control, parent.controlParams, parent.addons], [child.control, child.controlParams, child.addons]);
  if (control && !askedControl) return false;

  const kept = new Map(child.verification.map((assertion) => [assertion.id, assertion]));
  const goal =
    parent.archetype !== child.archetype ||
    parent.objective.kind !== child.objective.kind ||
    parent.objective.role !== child.objective.role ||
    parent.verification.some((assertion) => !same(assertion, kept.get(assertion.id)));
  if (goal && !askedGoal) return false;

  // Všechny role hráče, ne první: přidaný druhý hráč je taky jiný hrdina.
  const heroesOf = (spec: GameSpecV1) => spec.roles.filter((role) => role.kind === 'player');
  if (!same(heroesOf(parent), heroesOf(child)) && !askedHero) return false;
  return true;
}

const PART_NAMES: Readonly<Record<string, string>> = {
  theme: 'setting',
  title: 'title',
  objective: 'goal',
  verification: 'checks',
  control: 'controls',
  controlParams: 'controls',
  addons: 'extras',
  targetDurationSec: 'length',
  budgets: 'limits',
};

function words(key: string): string {
  return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Lidský seznam změněných částí z RFC 6902 operací – co hráči ukázat pod
 * „What changed“. Parametr mechaniky nese jméno mechaniky („chaser speed“),
 * role svůj popisek („bear“), návod se nepočítá – jen popisuje zbytek.
 */
export function describeRemix(parent: GameSpecV1, ops: readonly Operation[]): string[] {
  const parts: string[] = [];
  for (const operation of ops) {
    const [top, index, field, param] = operation.path.split('/').slice(1);
    if (top === undefined || top === 'tutorial' || top === 'schema') continue;
    let part = PART_NAMES[top] ?? words(top);
    if (top === 'mechanics') {
      const id = parent.mechanics[Number(index)]?.id;
      part = id !== undefined && field === 'params' && param !== undefined ? `${words(id)} ${words(param)}` : 'rules';
    } else if (top === 'roles') {
      const role = parent.roles[Number(index)];
      part = role === undefined ? 'characters' : field === 'count' ? `number of ${role.label}s` : role.label;
    } else if (top === 'controlParams' && index !== undefined) {
      part = words(index);
    }
    if (!parts.includes(part)) parts.push(part);
  }
  return parts;
}

/** Volná remixová věta pro model – pro `mechanic`/`topology`/`objective` a pro `parameter`/`presentation` bez čipu. */
export function buildRemixRequest(sentence: string, parent: GameSpecV1): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: [REPAIR_RULES, REMIX_ANSWER_LINE, renderRegistry()].join('\n\n'),
    user: `SPEC:\n${JSON.stringify(parent)}\n\nREQUEST (${classifyRemix(sentence, parent)}):\n${sentence.trim()}`,
  };
}
