/**
 * Jak se hra prohrává (P70C T1): krátká věta pro kartu před startem, HUD a výsledek – „Lose all 3 lives or run out
 * of time.“ Skládá se z pravidel, která ve světě opravdu končí prohrou (životy, hodiny, pád, munice, …), ne ručně po
 * žánrech: nový žánr ji dostane sám a věta nemůže slíbit prohru, kterou hra nemá. Kompilátory ji do specu nepíší
 * (`tutorial.loseLine` je volitelné), takže hash i otisky her stojí. Hlídá `__tests__/lose-line.test.ts` přes registr.
 */

import { type ArcadeWorld, COUNTER, HEADER, type PieceRef, underlyingRule } from './arcade/contract';
import type { GameSpecV1 } from './spec';

/** Co hru ukončí prohrou – výsledek podle toho volí větu po prohře („You lost all 3 lives.“). */
export type LoseCause = 'lives' | 'time' | 'fall' | 'shots' | 'strokes' | 'touch' | 'idle' | 'crowd' | 'caught' | 'obstacle' | 'hazard' | 'miss' | 'knockout' | 'boil' | 'rival' | 'crash' | 'rule';

export interface LoseClause {
  readonly cause: LoseCause;
  /** Malým písmenem jako doplnění „You lose if you …“: „run out of time“. */
  readonly text: string;
}

/** Strop řádku – stejný jako `tutorial.goalLine` ve schématu. */
const MAX_LINE = 80;
/** Sloveso, které druhá příčina po první neopakuje. */
const SHARED_VERBS = ['run out of ', 'lose '] as const;

const clause = (cause: LoseCause, text: string): LoseClause => ({ cause, text });
const TIME = clause('time', 'run out of time');
const CAUGHT = clause('caught', 'get caught');
const RIVAL = clause('rival', 'let a rival finish first');
const FALL = clause('fall', 'fall');
/** Role, se kterou náraz s `effect: 'lose'` končí hru. */
const HIT_BY_ROLE: Readonly<Record<string, LoseClause>> = { chaser: CAUGHT, enemy: CAUGHT, obstacle: clause('obstacle', 'hit an obstacle'), hazard: clause('hazard', 'touch a hazard') };

const livesClause = (lives: number): LoseClause => clause('lives', lives === 1 ? 'lose your only life' : lives === 2 ? 'lose both lives' : `lose all ${String(lives)} lives`);

const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

/** Hrozba kreslené ochrany se dotkne hrdiny: „let a bomb touch the cat“; dlouhé popisky obecně. */
function touchClause(spec: GameSpecV1): LoseClause {
  const hero = spec.roles.find((role) => role.kind === 'player')?.label;
  const threat = spec.roles.find((role) => role.id === 'threat')?.label;
  const named = hero === undefined || threat === undefined ? null : `let ${article(threat)} ${threat} touch the ${hero}`;
  return clause('touch', named !== null && named.length <= MAX_LINE / 2 ? named : 'let anything touch you');
}

/** Pravidlo světa → proč končí prohrou; pravidlo, které jen ubírá život (to řekne `lives`) nebo nic, `null`. */
function ruleClause(ref: PieceRef, spec: GameSpecV1): LoseClause | null {
  const params = ref.params;
  switch (ref.id) {
    case 'time_limit':
    case 'hole_round':
    case 'steal_clock':
    case 'sort_tap':
      return TIME;
    case 'out_of_ammo':
      return clause('shots', 'run out of shots');
    case 'minigolf_hole':
      return clause('strokes', 'run out of strokes');
    case 'crowd_hit':
    case 'crowd_fight':
      return clause('crowd', 'lose your whole crowd');
    case 'drawsave_hit':
      return touchClause(spec);
    case 'fall_out':
      return params.effect === 'lose' ? FALL : null;
    case 'hit':
    case 'arena_eat':
      return params.effect === 'lose' ? (HIT_BY_ROLE[String(params.role)] ?? CAUGHT) : null;
    case 'hop_cross':
      return params.eagle === undefined ? null : clause('idle', 'stand still too long');
    case 'judge':
      return params.miss === 'lose' ? clause('miss', 'miss once') : null;
    case 'fight_end':
      return params.knockout === undefined ? clause('knockout', 'get knocked out') : null;
    case 'boil_over':
      return params.effect === 'lose' ? clause('boil', 'let it boil over') : null;
    case 'rival_finish':
      return !('land' in params) ? RIVAL : params.retry === true ? null : clause('crash', 'crash the landing');
    case 'glide_finish':
      return params.race === true ? RIVAL : FALL;
    case 'assembly_part':
      return (params.part as { readonly kind?: string } | undefined)?.kind === 'rival' ? RIVAL : null;
    default:
      return null;
  }
}

/** Popisek role mechaniky („giant Roomba“), dost krátký do řádku; jinak `null`. */
const roleLabel = (spec: GameSpecV1, id: unknown): string | null => {
  const label = spec.roles.find((role) => role.id === id)?.label;
  return label !== undefined && label.length <= MAX_LINE / 4 ? label : null;
};

/** Mřížková hra (`tap_go`) světa arkády nemá – prohru čte z mechanik specu: „get caught by the giant Roomba“. */
function mechanicClauses(spec: GameSpecV1): LoseClause[] {
  return spec.mechanics.flatMap((mechanic) => {
    const params = mechanic.params as Readonly<Record<string, unknown>>;
    const label = roleLabel(spec, params.role);
    if (mechanic.id === 'health') return [livesClause(Number(params.max))];
    if (mechanic.id === 'timer') return params.onEnd === 'lose' ? [TIME] : [];
    if (mechanic.id === 'hazard_zone' && params.effect === 'lose') return [label === null ? (HIT_BY_ROLE.hazard as LoseClause) : clause('hazard', `touch the ${label}`)];
    if ((mechanic.id === 'chaser' && params.catchEffect === 'lose') || (mechanic.id === 'patrol' && params.touchEffect === 'lose')) {
      return [label === null ? CAUGHT : clause('caught', `get caught by the ${label}`)];
    }
    return [];
  });
}

/** Pravidlo specu, které prohrává (P29A): sloveso věty a popisek role – „touch the lava“. Bez role nic neřekne. */
function specRuleClauses(spec: GameSpecV1): LoseClause[] {
  return (spec.rules ?? []).flatMap((rule) => {
    if (!rule.do.some((effect) => 'lose' in effect)) return [];
    const refs = 'contact' in rule.when ? rule.when.contact : 'hit' in rule.when ? [rule.when.hit] : [];
    const object = spec.roles.find((role) => role.id === [...refs].reverse().find((id) => id !== 'player'))?.label;
    return object === undefined ? [] : [clause('rule', `${rule.verb} the ${object}`)];
  });
}

/**
 * Všechny příčiny prohry, životy první, každá jednou (dvoje hodiny jsou jedno „run out of time“). Svět arkády je
 * pravda – časový limit plošinovky nebo přetečení specu nejsou vidět; bez světa (mřížka) mechaniky specu.
 * `livesAdded` = životy přidané živou změnou během běhu (R1 P70C): po prohře „You lost all 5 lives.“, ne 3.
 */
export function loseClausesOf(spec: GameSpecV1, world: ArcadeWorld | null, livesAdded = 0): readonly LoseClause[] {
  const lives = (world?.initial[HEADER.counters + COUNTER.health] ?? 0) + livesAdded;
  const found =
    world === null
      ? mechanicClauses(spec)
      : [...(lives > 0 ? [livesClause(lives)] : []), ...world.rules.flatMap((ref) => ruleClause(underlyingRule(ref), spec) ?? [])];
  const all = [...found, ...specRuleClauses(spec)];
  const unique = all.filter((entry, index) => all.findIndex((other) => other.cause === entry.cause) === index);
  return [...unique.filter((entry) => entry.cause === 'lives'), ...unique.filter((entry) => entry.cause !== 'lives')];
}

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** „run out of shots“ + „run out of time“ → „run out of shots or time“; „lose all 3 lives or your whole crowd“. */
function joined(first: LoseClause, second: LoseClause): string {
  const shared = SHARED_VERBS.find((verb) => first.text.startsWith(verb) && second.text.startsWith(verb));
  return `${first.text} or ${shared === undefined ? second.text : second.text.slice(shared.length)}`;
}

/**
 * Řádek „jak prohraješ“: vlastní `tutorial.loseLine` specu, jinak nejvýš dvě příčiny z pravidel („Lose all 3 lives
 * or run out of time.“), nad 80 znaků jen první. Hra, která prohrát nejde, `null` – karta řádek vynechá.
 */
export function loseLineOf(spec: GameSpecV1, world: ArcadeWorld | null): string | null {
  if (spec.tutorial.loseLine !== undefined) return spec.tutorial.loseLine;
  const [first, second] = loseClausesOf(spec, world);
  if (first === undefined) return null;
  const both = second === undefined ? null : sentence(joined(first, second));
  return both !== null && both.length <= MAX_LINE ? both : sentence(first.text);
}

/** Minulý čas prvního slova příčiny („lose all 3 lives“ → „lost all 3 lives“); slovesa pravidel mimo seznam nejsou. */
const PAST: Readonly<Record<string, string>> = { run: 'ran', get: 'got', let: 'let', fall: 'fell', hit: 'hit', touch: 'touched', lose: 'lost', stand: 'stood', miss: 'missed', crash: 'crashed' };

/** Čím běh skončil: došly životy, došel čas. */
export interface RunEnd {
  readonly livesOut: boolean;
  readonly timeOut: boolean;
}

/**
 * Věta po prohře (P70C T2, „You lost all 3 lives.“): příčina, která běh opravdu ukončila – došlé životy, došlý
 * čas, jinak jediná zbývající příčina pravidel. Víc možných příčin nebo sloveso mimo `PAST` → `null`: věta, která
 * by hádala, je horší než žádná.
 */
export function lostLineOf(clauses: readonly LoseClause[], end: RunEnd): string | null {
  const known = clauses.find((entry) => (entry.cause === 'lives' && end.livesOut) || (entry.cause === 'time' && end.timeOut));
  const rest = clauses.filter((entry) => entry.cause !== 'lives' && entry.cause !== 'time');
  const cause = known ?? (rest.length === 1 ? rest[0] : undefined);
  if (cause === undefined) return null;
  const [verb = '', ...words] = cause.text.split(' ');
  const past = PAST[verb];
  return past === undefined ? null : `You ${[past, ...words].join(' ')}.`;
}
