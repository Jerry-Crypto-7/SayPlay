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
 * jinak by kritik vrátil `CONTRADICTION`.
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

import { aimHarder, aimSwap, beatHarder, difficultyHarder, hazardSwap, runnerHarder, runnerSwapObstacles, runnerTwist, targetSwap } from '../arcade/remix';
import type { RemixClass } from '../contracts';
import { ARCHETYPES, type MechanicId } from '../registry';
import { readGameSpec, type GameSpecReason, type GameSpecV1, type GameRole } from '../spec';

import { renderRegistry } from './prompt';
import { REPAIR_RULES, keypointFor } from './repair';

export const REMIX_CHIPS = ['harder', 'twist', 'swap_enemy', 'reskin'] as const;
export type RemixChip = (typeof REMIX_CHIPS)[number];

/** Doslova `docs/play/pack/PRODUCT_COPY.md`; test drží shodu se souborem. */
export const REMIX_CHIP_LABELS: Readonly<Record<RemixChip, string>> = {
  harder: 'Make it harder',
  twist: 'Add a twist',
  swap_enemy: 'Swap the enemy',
  reskin: 'Change the world, keep the rules',
};

const CHIP_CLASS: Readonly<Record<RemixChip, RemixClass>> = { harder: 'parameter', swap_enemy: 'parameter', twist: 'mechanic', reskin: 'presentation' };

const MECHANIC_VERBS = /\b(stun|stuns|freeze|freezes|carry|carries|press|presses|collect|collects|chase|chases)\b/i;
const TOPOLOGY_WORDS = /\b(bigger|smaller|maze|rooms|islands|layout)\b/i;
const OBJECTIVE_WORDS = /\b(instead|goal|win by|objective)\b/i;
const PARAMETER_WORDS = /\b(twice as fast|faster|slower|more|fewer|\d+ seconds)\b/i;
const PRESENTATION_WORDS = /\b(neon|sci-fi|forest|underwater|make it look|theme)\b/i;

export function chipOf(sentence: string): RemixChip | null {
  const text = sentence.trim().toLowerCase();
  return REMIX_CHIPS.find((chip) => chip === text || REMIX_CHIP_LABELS[chip].toLowerCase() === text) ?? null;
}

/** Deterministická třída věty; `parent` je tu pro kontrakt, pravidla zatím čtou jen text. */
export function classifyRemix(sentence: string, _parent: GameSpecV1): RemixClass {
  const chip = chipOf(sentence);
  if (chip !== null) return CHIP_CLASS[chip];
  if (MECHANIC_VERBS.test(sentence)) return 'mechanic';
  if (TOPOLOGY_WORDS.test(sentence)) return 'topology';
  if (OBJECTIVE_WORDS.test(sentence)) return 'objective';
  if (PARAMETER_WORDS.test(sentence)) return 'parameter';
  if (PRESENTATION_WORDS.test(sentence)) return 'presentation';
  return 'mechanic';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

/** Volná remixová věta pro model – pro `mechanic`/`topology`/`objective` a pro `parameter`/`presentation` bez čipu. */
export function buildRemixRequest(sentence: string, parent: GameSpecV1): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: [REPAIR_RULES, REMIX_ANSWER_LINE, renderRegistry()].join('\n\n'),
    user: `SPEC:\n${JSON.stringify(parent)}\n\nREQUEST (${classifyRemix(sentence, parent)}):\n${sentence.trim()}`,
  };
}
