/**
 * Okamžitý návrh ze slov (P23-B T2): věta → `GameSpecV1`, vždy, za milisekundy.
 *
 * Model (`src/play/director`) potom návrh **opravuje**, ne píše od nuly –
 * proto musí být návrh vždy validní. Postup: lexikon dá archetyp, čísla a
 * role; šablonou je fixtura téhož archetypu (`src/play/__fixtures__`), ve
 * které se přepíší popisky rolí, počty a sekundy. ID rolí se z fixtury
 * nemění, takže odkazy v `mechanics` i `verification` zůstávají platné a
 * jen se posunou počty v keypointech (`collected: 4 → N − 1`).
 *
 * Kdyby výsledek přesto neprošel `readGameSpec`, funkce spadne na fixturu
 * archetypu s přepsaným `title` a `fellBack: true` – test nad zlatým korpusem
 * drží, že se to nestane ani jednou. Jediný losovač je `pure-rand`: vybírá
 * výchozí popisek hráče, když ho věta nedává; stejný seed = stejné bajty.
 */

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { ARCHETYPE_IDS, type ArchetypeId } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';
import chaseEscape from '../__fixtures__/chase_escape.json';
import checkpointRace from '../__fixtures__/checkpoint_race.json';
import collectExit from '../__fixtures__/collect_exit.json';
import combatLite from '../__fixtures__/combat_lite.json';
import delivery from '../__fixtures__/delivery.json';
import hazardCrossing from '../__fixtures__/hazard_crossing.json';
import survivalTimer from '../__fixtures__/survival_timer.json';
import switchPuzzle from '../__fixtures__/switch_puzzle.json';

import { plural, readNumbers, readRoles, scoreArchetypes, singular, type SentenceRoles } from './lexicon';

const TEMPLATES: Readonly<Record<ArchetypeId, unknown>> = {
  collect_exit: collectExit,
  chase_escape: chaseEscape,
  survival_timer: survivalTimer,
  checkpoint_race: checkpointRace,
  delivery,
  switch_puzzle: switchPuzzle,
  hazard_crossing: hazardCrossing,
  combat_lite: combatLite,
};

const PLAYER_LABELS = ['explorer', 'robot', 'fox', 'kid', 'raccoon', 'astronaut', 'knight', 'penguin'] as const;

export interface DraftMeta {
  readonly spec: GameSpecV1;
  readonly archetype: ArchetypeId;
  readonly scores: Readonly<Record<ArchetypeId, number>>;
  /** Návrh neprošel `readGameSpec` a vrátila se fixtura archetypu. Korpus drží nulu. */
  readonly fellBack: boolean;
}

/** Nejvyšší skóre; remíza jde pořadím `ARCHETYPE_IDS`, nic → `collect_exit`. */
export function pickArchetype(scores: Readonly<Record<ArchetypeId, number>>): ArchetypeId {
  let best: ArchetypeId = ARCHETYPE_IDS[0];
  for (const id of ARCHETYPE_IDS) if (scores[id] > scores[best]) best = id;
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function template(archetype: ArchetypeId): GameSpecV1 {
  return JSON.parse(JSON.stringify(TEMPLATES[archetype])) as GameSpecV1;
}

function role(spec: GameSpecV1, id: string): GameSpecV1['roles'][number] {
  const found = spec.roles.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`template ${spec.archetype} has no role ${id}`);
  return found;
}

function mechanic(spec: GameSpecV1, id: string): Record<string, unknown> {
  const found = spec.mechanics.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`template ${spec.archetype} has no mechanic ${id}`);
  return found.params as Record<string, unknown>;
}

function titleCase(words: readonly string[]): string {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const TITLE_SKIP = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'to', 'of', 'in', 'on', 'at', 'it', 'its', 'you', 'while', 'then', 'with', 'from', 'through', 'across', 'before', 'make', 'something']);

/** Do čtyř nosných slov věty; bez nich titul fixtury. */
function titleFrom(sentence: string, fallback: string): string {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !TITLE_SKIP.has(word))
    .slice(0, 4);
  const title = words.length === 0 ? fallback : titleCase(words);
  return title.slice(0, 80);
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function label(text: string | null, fallback: string): string {
  return cap(text ?? fallback, 60);
}

/** Číslo se čte slovem, pokud je do dvanácti – tak to píše i balíček. */
function spell(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return n < words.length ? words[n] : String(n);
}

function rewriteCounters(spec: GameSpecV1, counter: string, before: number, after: number): void {
  for (const assertion of spec.verification) {
    const setup = assertion.setup?.counters;
    if (setup !== undefined && setup[counter] !== undefined) setup[counter] = before;
    const expected = assertion.assert.counters;
    if (expected !== undefined && expected[counter] !== undefined) expected[counter] = after;
  }
}

interface Read {
  readonly roles: SentenceRoles;
  readonly seconds: number | null;
  readonly counts: readonly number[];
  readonly playerLabel: string;
  readonly text: string;
}

const FILLERS: Record<ArchetypeId, (spec: GameSpecV1, read: Read) => void> = {
  collect_exit(spec, read) {
    const count = clamp(read.counts[0] ?? 5, 1, 20);
    const item = role(spec, 'mushroom');
    item.label = label(read.roles.collectible, item.label);
    item.count = count;
    mechanic(spec, 'collectible').count = count;
    spec.objective.count = count;
    spec.objective.description = cap(`Collect ${spell(count)} ${plural(item.label, count)}, then reach the ${role(spec, 'portal').label}.`, 120);
    rewriteCounters(spec, 'collected', count - 1, count);
    spec.tutorial.goalLine = cap(`Collect ${count} ${plural(item.label, count)}, then reach the exit.`, 80);
    spec.tutorial.controlsHint = cap(`Tap a ${item.label} to walk to it. Tap again to pick it up.`, 80);
  },
  chase_escape(spec, read) {
    const chaser = role(spec, 'roomba');
    chaser.label = label(read.roles.chaser, chaser.label);
    const speed = /\b(fast|quick|speedy|twice as fast)\b/.test(read.text) ? 'fast' : /\b(slow|sluggish)\b/.test(read.text) ? 'slow' : 'normal';
    mechanic(spec, 'chaser').speed = speed;
    spec.objective.description = cap(`Reach the exit before the ${chaser.label} catches you.`, 120);
    spec.tutorial.goalLine = cap(`Escape through the exit. The ${chaser.label} hunts you.`, 80);
    spec.tutorial.controlsHint = cap(`Tap where to run. Use a cart to stun the ${chaser.label}.`, 80);
  },
  survival_timer(spec, read) {
    const seconds = clamp(read.seconds ?? 60, 5, 180);
    mechanic(spec, 'timer').seconds = seconds;
    spec.objective.seconds = seconds;
    spec.targetDurationSec = clamp(seconds, 30, 180);
    const hazard = role(spec, 'tile');
    hazard.label = label(read.roles.hazard === null ? null : singular(read.roles.hazard), hazard.label);
    spec.objective.description = cap(`Survive ${seconds} seconds while ${plural(hazard.label, 2)} pulse.`, 120);
    spec.tutorial.goalLine = cap(`Stay off the ${plural(hazard.label, 2)} for ${seconds} seconds.`, 80);
  },
  checkpoint_race(spec, read) {
    const count = clamp(read.counts[0] ?? 5, 2, 8);
    const gate = role(spec, 'gate');
    gate.label = label(read.roles.checkpoint, gate.label);
    gate.count = count;
    mechanic(spec, 'checkpoint').count = count;
    mechanic(spec, 'checkpoint').ordered = !/\bany order\b/.test(read.text);
    spec.objective.count = count;
    const seconds = clamp(read.seconds ?? 90, 1, 180);
    mechanic(spec, 'timer').seconds = seconds;
    spec.targetDurationSec = clamp(seconds, 30, 180);
    spec.objective.description = cap(`Pass ${spell(count)} ${plural(gate.label, count)} in order.`, 120);
    spec.tutorial.goalLine = cap(`Pass all ${count} ${plural(gate.label, count)} in order before time runs out.`, 80);
    spec.tutorial.controlsHint = cap(`Tap the next ${gate.label} to race to it.`, 80);
  },
  delivery(spec, read) {
    const item = role(spec, 'cake');
    const destination = role(spec, 'table');
    item.label = label(read.roles.item, item.label);
    destination.label = label(read.roles.destination, destination.label);
    mechanic(spec, 'carry').fragile = /\b(fragile|egg|glass|cake|vase|without (?:breaking|dropping|cracking|spilling))\b/.test(read.text);
    spec.objective.description = cap(`Carry the ${item.label} to the ${destination.label}.`, 120);
    spec.tutorial.goalLine = cap(`Bring the ${item.label} to the ${destination.label}.`, 80);
    spec.tutorial.controlsHint = cap(`Tap the ${item.label}, pick it up, then tap the ${destination.label}.`, 80);
  },
  switch_puzzle(spec, read) {
    const switches = read.roles.switches;
    if (switches !== null) {
      const ids = switches.all.slice(0, 6);
      const keep = spec.roles.filter((entry) => entry.kind !== 'switch');
      spec.roles = [...keep, ...ids.map((colour) => ({ id: colour, kind: 'switch' as const, label: `${colour} button`, count: 1 }))];
      const params = mechanic(spec, 'switch');
      params.switchRoles = ids;
      params.required = switches.required.filter((colour) => ids.includes(colour)).slice(0, 6);
      const required = params.required as string[];
      const wrong = ids.find((colour) => !required.includes(colour));
      spec.verification = spec.verification.filter((assertion) => assertion.mechanic !== 'switch');
      spec.verification.unshift({
        id: 'right_combination_opens',
        kind: 'keypoint',
        mechanic: 'switch',
        setup: { entityStates: Object.fromEntries(required.slice(0, -1).map((colour) => [colour, 'on'])) },
        actions: [{ actionId: 'use', target: required[required.length - 1] }],
        assert: { locked: { door: false } },
      });
      if (wrong !== undefined) {
        spec.verification.splice(1, 0, {
          id: 'wrong_switch_blocks',
          kind: 'keypoint',
          mechanic: 'switch',
          setup: { entityStates: Object.fromEntries(required.map((colour) => [colour, 'on'])) },
          actions: [{ actionId: 'use', target: wrong }],
          assert: { locked: { door: true } },
        });
      }
      const not = ids.filter((colour) => !required.includes(colour));
      spec.objective.description = cap(`Press ${required.join(' and ')}${not.length > 0 ? `, but not ${not.join(' or ')},` : ''} to open the door.`, 120);
    }
    spec.tutorial.goalLine = cap('Open the door with the right switches.', 80);
  },
  hazard_crossing(spec, read) {
    const hazard = role(spec, 'lava');
    hazard.label = label(read.roles.hazard === null ? null : singular(read.roles.hazard), hazard.label);
    const stone = role(spec, 'stone');
    if (read.roles.checkpoint !== null && read.roles.checkpoint !== hazard.label) stone.label = label(read.roles.checkpoint, stone.label);
    spec.objective.description = cap(`Cross the ${hazard.label} field to the far side.`, 120);
    spec.tutorial.goalLine = cap(`Reach the far side. The ${hazard.label} pulses.`, 80);
    spec.tutorial.controlsHint = cap(`Tap a ${stone.label} when the ${hazard.label} is calm.`, 80);
  },
  combat_lite(spec, read) {
    const count = clamp(read.counts[0] ?? 5, 1, 12);
    const target = role(spec, 'slime');
    target.label = label(read.roles.target, target.label);
    target.count = count;
    mechanic(spec, 'defeat').count = count;
    spec.objective.count = count;
    spec.objective.description = cap(`Knock out all ${spell(count)} ${plural(target.label, count)}.`, 120);
    rewriteCounters(spec, 'defeated', count - 1, count);
    spec.tutorial.goalLine = cap(`Knock out all ${count} ${plural(target.label, count)}.`, 80);
    spec.tutorial.controlsHint = cap(`Tap a ${target.label} to approach, tap again to hit it.`, 80);
  },
};

export function draftGameSpecWithMeta(sentence: string, seed = 1): DraftMeta {
  const scores = scoreArchetypes(sentence);
  const archetype = pickArchetype(scores);
  const spec = template(archetype);
  const roles = readRoles(sentence);
  const numbers = readNumbers(sentence);
  const rng = xoroshiro128plus(seed);
  const playerLabel = roles.player ?? PLAYER_LABELS[uniformInt(rng, 0, PLAYER_LABELS.length - 1)];

  spec.title = titleFrom(sentence, spec.title);
  role(spec, 'player').label = cap(playerLabel, 60);
  if (roles.setting !== null) spec.theme.setting = cap(roles.setting, 80);
  FILLERS[archetype](spec, { roles, seconds: numbers.seconds, counts: numbers.counts, playerLabel, text: sentence.toLowerCase() });

  const result = readGameSpec(spec);
  if (result.ok) return { spec: result.value, archetype, scores, fellBack: false };
  const fallback = template(archetype);
  fallback.title = titleFrom(sentence, fallback.title);
  const normalized = readGameSpec(fallback);
  return { spec: normalized.ok ? normalized.value : fallback, archetype, scores, fellBack: true };
}

/** Věta → validní `GameSpecV1`, nikdy `null`, nikdy výjimka. */
export function draftGameSpec(sentence: string, seed = 1): GameSpecV1 {
  return draftGameSpecWithMeta(sentence, seed).spec;
}
