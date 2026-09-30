/**
 * Deterministický kritik nad `GameSpecV1` (P23-B T5) s kódy z balíčku GPT
 * (`docs/play/pack/critic.md`). Žádný model, žádné skóre zábavy – jen
 * kontroly, které jdou přečíst ze specu, každá s cestou, důkazem a nápovědou
 * pro opravu (`repair.ts` z ní čte deterministicky).
 *
 * `severity: 'block'` zastaví přijetí specu a spustí opravné kolo; `'warn'`
 * se přenese ven jako `warnings`. Blokuje jen to, co hru rozbije (nic na
 * hraní, žádná výhra, čísla proti sobě, nefér honička, přeplněný spec).
 *
 * `ASSET_BLOCKING` a `NO_RECOVERY` z balíčku se **nevydávají**: kritik nezná
 * assety ani checkpointy runtimu, a kód, který by vydával naslepo, by byl
 * horší než žádný. Test to pinuje.
 */

import { controlOf, unreadItems } from '../capabilities';
import { draftGenreFor } from '../draft/draft';
import { NUMBER_WORDS, toolOf } from '../draft/lexicon';
import { type GenreModules, type GenreRanking, classifyGenre } from '../genre/classify';
import type { GenreModule, GenreSpec } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import { defaultEnemy, heroFits } from '../genre/roles';
import type { Reading } from '../read/schema';
import { ARCHETYPES, type MechanicId, estimateCost } from '../registry';
import type { GameSpecV1 } from '../spec';

export const CRITIC_CODES = [
  'NO_AGENCY',
  'GOAL_UNCLEAR',
  'NO_TERMINATION',
  'CONTRADICTION',
  'UNSUPPORTED',
  'DEAD_TIME',
  'TOO_COMPLEX',
  'UNFAIR_SPAWN',
  'UNVERIFIABLE',
  'BUDGET',
  'RULE_INVALID',
  'VERB_UNPROVED',
] as const;
export type CriticCode = (typeof CRITIC_CODES)[number];

/** Kódy balíčku, které tenhle kritik nikdy nevydá – viz hlavičku. */
export const UNISSUED_PACK_CODES = ['ASSET_BLOCKING', 'NO_RECOVERY'] as const;

export interface CriticIssue {
  readonly code: CriticCode;
  readonly severity: 'block' | 'warn';
  /** JSON pointer do specu (`/mechanics/1/params/speed`). */
  readonly path: string;
  readonly evidence: string;
  readonly repairHint: string;
}

/** Mechaniky, na které hráč sáhne, nebo před kterými uhýbá – bez nich není co hrát. */
const AGENCY_MECHANICS: readonly MechanicId[] = ['collectible', 'switch', 'carry', 'stun', 'defeat', 'checkpoint', 'zone_trigger', 'hazard_zone', 'chaser', 'patrol'];
/** Mechaniky, které samy dovedou hru k výhře. */
const WIN_MECHANICS: readonly MechanicId[] = ['checkpoint', 'defeat', 'carry'];
/** Mechaniky, které hráče tlačí – bez nich je dlouhá hra prázdný čas. */
const PRESSURE_MECHANICS: readonly MechanicId[] = ['chaser', 'hazard_zone', 'spawn_wave', 'timer'];
const UNSUPPORTED_WORDS = /\b(jump|jumps|jumping|projectile|projectiles|shoot|shoots|shooting|fly|flies|flying|swim|swims|swimming|climb|climbs|climbing|physics)\b/i;
const MAX_MECHANICS = 4;
const MAX_ROLES = 12;
const DEAD_TIME_SECONDS = 120;
const BUDGET_HEADROOM = 0.8;

const NUMBER_IN_TEXT = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'i');

function params<P>(spec: GameSpecV1, id: MechanicId): P | null {
  const found = spec.mechanics.find((mechanic) => mechanic.id === id);
  return found === undefined ? null : (found.params as P);
}

function indexOf(spec: GameSpecV1, id: MechanicId): number {
  return spec.mechanics.findIndex((mechanic) => mechanic.id === id);
}

/**
 * Co ovládání z tabulky schopností nepoužije (P26 T5). Mechanika, kterou
 * kompilátor nečte, blokuje a deterministická oprava ji ze specu vyjme – spec
 * pak netvrdí nic, co hra nehraje. Popisek, který vykreslení nečte, je
 * varování: zůstává v obálce a sada věrnosti ho počítá jako „not built“.
 */
function unread(spec: GameSpecV1): CriticIssue[] {
  const control = controlOf(spec);
  return unreadItems(spec).map((item) =>
    item.kind === 'mechanic'
      ? { code: 'UNSUPPORTED', severity: 'block', path: item.path, evidence: `control ${control} does not play mechanic ${item.what}`, repairHint: `remove it, or pick a control that plays it` }
      : { code: 'UNSUPPORTED', severity: 'warn', path: item.path, evidence: `control ${control} never shows "${item.what}"`, repairHint: 'keep only roles the control shows' },
  );
}

export function critique(spec: GameSpecV1): CriticIssue[] {
  const issues: CriticIssue[] = unread(spec);
  const ids = spec.mechanics.map((mechanic) => mechanic.id);
  const has = (id: MechanicId): boolean => ids.includes(id);
  // Kontroly hratelnosti mřížky; arkádu místo nich ověřuje robot nad tratí z generátoru.
  const grid = controlOf(spec) === 'tap_go';

  if (grid && !ids.some((id) => AGENCY_MECHANICS.includes(id))) {
    issues.push({
      code: 'NO_AGENCY',
      severity: 'block',
      path: '/mechanics',
      evidence: `mechanics ${ids.join(', ')} give the player nothing to touch or dodge`,
      repairHint: `add one of ${AGENCY_MECHANICS.join(', ')} with a matching role`,
    });
  }

  const zoneWin = spec.mechanics.some((m) => m.id === 'zone_trigger' && (m.params as { effect?: string }).effect === 'win');
  const timerWin = spec.mechanics.some((m) => m.id === 'timer' && (m.params as { onEnd?: string }).onEnd === 'win');
  // Aréna (P25F) vyhrává v jádře růstem nebo přežitím (`arenaWinOf`, pravidla `grow_to` /
  // `survive_time`) – časovač končící prohrou je tam limit na růst, ne chybějící výhra.
  const arenaWin = spec.control === 'move_free';
  if (grid && !zoneWin && !timerWin && !arenaWin && !ids.some((id) => WIN_MECHANICS.includes(id))) {
    issues.push({
      code: 'NO_TERMINATION',
      severity: 'block',
      path: '/mechanics',
      evidence: 'no zone_trigger with effect win, no timer with onEnd win, no checkpoint, defeat or carry',
      repairHint: 'add zone_trigger {role: exit, when: enter, effect: win} and an exit role',
    });
  }

  const objective = spec.objective;
  if ((objective.count !== undefined || objective.seconds !== undefined) && !NUMBER_IN_TEXT.test(objective.description)) {
    issues.push({
      code: 'GOAL_UNCLEAR',
      severity: 'warn',
      path: '/objective/description',
      evidence: `objective needs ${objective.count !== undefined ? `count ${String(objective.count)}` : `seconds ${String(objective.seconds)}`} but the description names no number`,
      repairHint: 'put the number into objective.description',
    });
  }
  if (spec.tutorial.goalLine.trim().toLowerCase() === spec.title.trim().toLowerCase()) {
    issues.push({
      code: 'GOAL_UNCLEAR',
      severity: 'warn',
      path: '/tutorial/goalLine',
      evidence: 'goalLine repeats the title instead of saying what to do',
      repairHint: 'write goalLine as one imperative sentence',
    });
  }

  const countMechanics: readonly MechanicId[] = ['collectible', 'defeat', 'checkpoint'];
  for (const id of countMechanics) {
    const mechanic = params<{ count: number }>(spec, id);
    if (mechanic !== null && objective.count !== undefined && objective.count !== mechanic.count) {
      issues.push({
        code: 'CONTRADICTION',
        severity: 'block',
        path: `/mechanics/${String(indexOf(spec, id))}/params/count`,
        evidence: `objective.count ${String(objective.count)} but ${id}.count ${String(mechanic.count)}`,
        repairHint: `set objective.count to ${String(mechanic.count)}`,
      });
    }
  }
  const timer = params<{ seconds: number }>(spec, 'timer');
  if (timer !== null && objective.seconds !== undefined && objective.seconds !== timer.seconds) {
    issues.push({
      code: 'CONTRADICTION',
      severity: 'block',
      path: `/mechanics/${String(indexOf(spec, 'timer'))}/params/seconds`,
      evidence: `objective.seconds ${String(objective.seconds)} but timer.seconds ${String(timer.seconds)}`,
      repairHint: `set objective.seconds to ${String(timer.seconds)}`,
    });
  }
  const sw = params<{ switchRoles: string[]; required: string[] }>(spec, 'switch');
  if (sw !== null) {
    const outside = sw.required.filter((role) => !sw.switchRoles.includes(role));
    if (outside.length > 0) {
      issues.push({
        code: 'CONTRADICTION',
        severity: 'block',
        path: `/mechanics/${String(indexOf(spec, 'switch'))}/params/required`,
        evidence: `required switches ${outside.join(', ')} are not in switchRoles`,
        repairHint: 'keep required a subset of switchRoles',
      });
    }
  }

  const texts: readonly (readonly [string, string])[] = [
    ['/theme/setting', spec.theme.setting],
    ['/objective/description', objective.description],
    ...spec.roles.map((role, index) => [`/roles/${String(index)}/label`, role.label] as const),
  ];
  for (const [path, text] of grid ? texts : []) {
    const word = UNSUPPORTED_WORDS.exec(text);
    if (word !== null) {
      issues.push({
        code: 'UNSUPPORTED',
        severity: 'warn',
        path,
        evidence: `"${word[1]}" describes something the tap-to-move runtime cannot do`,
        repairHint: 'keep the fantasy in words; the mechanics stay registered ones',
      });
    }
  }

  if (grid && spec.targetDurationSec > DEAD_TIME_SECONDS && !ids.some((id) => PRESSURE_MECHANICS.includes(id))) {
    issues.push({
      code: 'DEAD_TIME',
      severity: 'warn',
      path: '/targetDurationSec',
      evidence: `${String(spec.targetDurationSec)} s with nothing pushing the player (no ${PRESSURE_MECHANICS.join(', ')})`,
      repairHint: 'shorten targetDurationSec or add a timer or hazard',
    });
  }

  if (spec.mechanics.length > MAX_MECHANICS || spec.roles.length > MAX_ROLES) {
    issues.push({
      code: 'TOO_COMPLEX',
      severity: 'block',
      path: spec.mechanics.length > MAX_MECHANICS ? '/mechanics' : '/roles',
      evidence: `${String(spec.mechanics.length)} mechanics, ${String(spec.roles.length)} roles (max ${String(MAX_MECHANICS)} and ${String(MAX_ROLES)})`,
      repairHint: `drop mechanics outside ${ARCHETYPES[spec.archetype].requiredMechanics.join(', ')} from the end, merge prop roles`,
    });
  }

  const chaser = params<{ speed: string }>(spec, 'chaser');
  if (chaser !== null && chaser.speed === 'fast' && !has('stun') && !has('checkpoint')) {
    issues.push({
      code: 'UNFAIR_SPAWN',
      severity: 'block',
      path: `/mechanics/${String(indexOf(spec, 'chaser'))}/params/speed`,
      evidence: 'a fast chaser with no stun and no checkpoint leaves the player no answer',
      repairHint: 'set speed to normal, or add stun',
    });
  }

  const verified = new Set(spec.verification.map((assertion) => assertion.mechanic).filter((id): id is string => id !== undefined));
  spec.mechanics.forEach((mechanic, index) => {
    if (grid && !verified.has(mechanic.id)) {
      issues.push({
        code: 'UNVERIFIABLE',
        severity: 'warn',
        path: `/mechanics/${String(index)}`,
        evidence: `no verification assertion names mechanic ${mechanic.id}`,
        repairHint: `add a keypoint with mechanic ${mechanic.id}`,
      });
    }
  });

  const cost = estimateCost(spec.mechanics, spec.roles);
  const overEntities = cost.entities > spec.budgets.maxEntities * BUDGET_HEADROOM;
  const overRules = cost.rules > spec.budgets.maxRules * BUDGET_HEADROOM;
  if (grid && (overEntities || overRules)) {
    issues.push({
      code: 'BUDGET',
      severity: 'warn',
      path: overEntities ? '/budgets/maxEntities' : '/budgets/maxRules',
      evidence: `estimate ${String(cost.entities)} entities / ${String(cost.rules)} rules against ${String(spec.budgets.maxEntities)} / ${String(spec.budgets.maxRules)} (over 80 %)`,
      repairHint: 'lower role counts or mechanic counts proportionally',
    });
  }

  return issues;
}

const RULE_HINT = 'fix the rule with operations on /rules (roles are "player" or a role id; effects only from the rules language), or remove it';

/**
 * Pravidla, pro která se odpověď nedala složit (P29A T8): `detail` jsou hlášky
 * `readGameSpec` spojené „; “. Každá hláška pod `/rules` nebo `/things` je nález;
 * když žádná pod ně nemíří, jeden nález na celé pole. Model dostane i pravidla,
 * jak je napsal – spec, nad kterým opravuje, je nemá.
 */
export function ruleInvalidIssues(detail: string, written: unknown): CriticIssue[] {
  const asWritten = `rules as written: ${JSON.stringify(written)}`.slice(0, 400);
  const parts = detail.split('; ').filter((part) => /^\/(rules|things)\b/.test(part));
  const found = parts.length === 0 ? [`/rules: ${detail}`] : parts;
  return found.map((part) => ({
    code: 'RULE_INVALID',
    severity: 'block',
    path: part.slice(0, Math.max(part.indexOf(':'), 0)) || '/rules',
    evidence: `${part.slice(0, 200)}; ${asWritten}`,
    repairHint: RULE_HINT,
  }));
}

const VERB_UNPROVED_MARK = /VERB_UNPROVED:([a-z][a-z-]*)/g;
const VERB_NO_EFFECT_MARK = /VERB_NO_EFFECT:([a-z][a-z-]*)/g;

/**
 * Ověření robotem hlásí neprokázané sloveso uvnitř nálezu keypointu
 * (`VERB_UNPROVED:<sloveso>`, `arcade/verify.ts`). Kritik z něj udělá nález na
 * pravidlo toho slovesa, aby model věděl, které pravidlo se ve hře nestalo;
 * ostatní nálezy jdou dál beze změny.
 */
export function verbIssues<T extends Pick<CriticIssue, 'path' | 'evidence' | 'repairHint'> & { readonly code: string }>(checked: readonly T[], spec: GameSpecV1): (T | CriticIssue)[] {
  const out: (T | CriticIssue)[] = [];
  for (const issue of checked) {
    const verbs = [...issue.evidence.matchAll(VERB_UNPROVED_MARK)].map((match) => match[1] as string);
    const idle = [...issue.evidence.matchAll(VERB_NO_EFFECT_MARK)].map((match) => match[1] as string);
    if (verbs.length === 0 && idle.length === 0) {
      out.push(issue);
      continue;
    }
    const pathOf = (verb: string): string => {
      const index = (spec.rules ?? []).findIndex((rule) => rule.verb === verb);
      return index < 0 ? '/rules' : `/rules/${String(index)}`;
    };
    for (const verb of verbs) {
      out.push({
        code: 'VERB_UNPROVED',
        severity: 'block',
        path: pathOf(verb),
        evidence: `the robot won without the rule for "${verb}" ever firing`,
        repairHint: `make the "${verb}" rule fire on the way to the win (a trigger the player meets, conditions that hold), or remove it`,
      });
    }
    // Pravidlo, které vystřelí naprázdno (P30B T2), jde do opravy i do vyřazení stejnou cestou jako nevystřelené.
    for (const verb of idle) {
      out.push({
        code: 'VERB_UNPROVED',
        severity: 'block',
        path: pathOf(verb),
        evidence: `"${verb}" VERB_NO_EFFECT: the rule fired, but nothing in the game changed (a zero score or count, nothing moved, removed or switched)`,
        repairHint: `make the "${verb}" rule change the game when it fires – a nonzero score or count, a body it removes, grabs, moves or reveals – or remove it`,
      });
    }
  }
  return out;
}

/** Slovesa z nálezů `VERB_UNPROVED`. */
export function unprovedVerbs(issues: readonly { readonly code: string; readonly evidence: string }[]): string[] {
  return issues.filter((issue) => issue.code === 'VERB_UNPROVED').map((issue) => /"([a-z-]+)"/.exec(issue.evidence)?.[1] ?? '').filter((verb) => verb !== '');
}

// ---------------------------------------------------------------------------
// Kontrola věrnosti žánrové odpovědi (P32B T5)

/**
 * Odpověď na novou hru je `GenreSpec` a kombinaci ovládání × mechanika za ni
 * volí modul žánru – co může být špatně, je výběr: jiný hrdina, než věta říká,
 * hrdina, kterého žánr neumí, nepřítel mimo větu i prostředí nebo nepřítel, kterého
 * hráč ve větě drží (T7), žánr, který hlavní
 * sloveso nehraje, režim, který hraje jen náhradu. Kódy nejsou kódy balíčku
 * (`CRITIC_CODES`): nález nejde modelu, řeší ho přepnutí žánru (`switchGenre`).
 */
export const FIDELITY_CODES = ['HERO_NOT_SAID', 'HERO_UNFIT', 'ENEMY_NOT_SAID', 'ENEMY_IS_TOOL', 'VERB_OUTSIDE_MODE', 'MODE_NOT_READY'] as const;
export type FidelityCode = (typeof FIDELITY_CODES)[number];

export interface FidelityIssue {
  readonly code: FidelityCode;
  /** Pole `GenreSpec`, které nesedí (`/hero`, `/enemy`, `/mode`). */
  readonly path: string;
  readonly evidence: string;
}

export interface FidelityOptions {
  readonly reading?: Reading | null;
  /** Moduly žánrů; testy sem dávají dvojníky (`genre/__tests__/doubles.ts`). */
  readonly modules?: GenreModules;
}

/** Slova popisku malými písmeny a v jednotném čísle („ghosts“ → „ghost“, „puppies“ → „puppy“). */
const wordsOf = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map((word) => word.replace(/ies$/, 'y').replace(/(?<!s)s$/, ''));

/** Stejná role, když se shoduje poslední slovo: „pirate ship“ = „ship“, „race car“ ≠ „pirate ship“. */
export function sameRole(a: string, b: string): boolean {
  const head = wordsOf(a).at(-1);
  return head !== undefined && head === wordsOf(b).at(-1);
}

/** Popisek je z věty, když v ní je každé jeho slovo – jinak ho dala výchozí role prostředí. */
function saidIn(label: string, sentence: string): boolean {
  const said = new Set(wordsOf(sentence));
  const words = wordsOf(label);
  return words.length > 0 && words.every((word) => said.has(word));
}

/**
 * Hraje žánr a režim hlavní sloveso věty? Režim slovesa dává tabulka sloves
 * klasifikátoru (`ranking.pick`). Hraje-li ten režim jen náhradu, věrný je
 * nejlepší `ready` režim, který klasifikátor dá místo něj; věta bez slovesa
 * z tabulky nedokazuje nic jiného než první režim pořadí – žánr draftu.
 */
function verbFits(genre: GenreSpec, ranking: GenreRanking, modules: GenreModules): boolean {
  const is = (pair: { readonly genre: string; readonly mode: string } | undefined): boolean => pair !== undefined && pair.genre === genre.genre && pair.mode === genre.mode;
  const { pick } = ranking;
  if (pick === null) return is(ranking.ranked[0]);
  return is(pick) || ((modules[pick.genre] as GenreModule).availability(pick.mode as never) === 'fallback' && is(ranking.ranked[0]));
}

/**
 * Kontrola věrnosti `GenreSpec` odpovědi proti větě. Hrdinu a nepřítele věty
 * čte draft téhož režimu (`draftGenreFor`): popisek, který v něm je a zazní ve
 * větě, je role věty; jinak je nepřítel výchozí z prostředí odpovědi nebo draftu.
 */
export function fidelity(genre: GenreSpec, sentence: string, options: FidelityOptions = {}): FidelityIssue[] {
  const reading = options.reading ?? null;
  const modules = options.modules ?? GENRE_MODULES;
  const ranking = classifyGenre(sentence, reading, modules);
  const words = draftGenreFor(sentence, genre.genre, genre.mode, { reading, modules });
  const issues: FidelityIssue[] = [];

  if (words !== null && saidIn(words.hero, sentence) && !sameRole(genre.hero, words.hero)) {
    issues.push({ code: 'HERO_NOT_SAID', path: '/hero', evidence: `the sentence's hero is "${words.hero}", the answer plays "${genre.hero}"` });
  }
  if (!heroFits(genre.genre, genre.hero, modules)) {
    issues.push({ code: 'HERO_UNFIT', path: '/hero', evidence: `"${genre.hero}" cannot play the hero of ${genre.genre}` });
  }

  const saidEnemy = words?.enemy !== undefined && saidIn(words.enemy, sentence) ? words.enemy : null;
  if (saidEnemy !== null && (genre.enemy === undefined || !sameRole(genre.enemy, saidEnemy))) {
    issues.push({ code: 'ENEMY_NOT_SAID', path: '/enemy', evidence: `the sentence's enemy is "${saidEnemy}", the answer has ${genre.enemy === undefined ? 'none' : `"${genre.enemy}"`}` });
  }
  const settingEnemies = [defaultEnemy(genre.setting, genre.genre), ...(words?.enemy === undefined ? [] : [words.enemy])];
  if (saidEnemy === null && genre.enemy !== undefined && !settingEnemies.some((label) => sameRole(genre.enemy!, label))) {
    issues.push({ code: 'ENEMY_NOT_SAID', path: '/enemy', evidence: `"${genre.enemy}" is neither in the sentence nor the default of the setting (${settingEnemies.join(', ')})` });
  }
  // T7: co hráč stříká nebo hází, ho nehoní („sprays water“ → „before the water catch you“).
  // Hráčem je hrdina odpovědi: co hází obr, vesničana honit smí (B-R12).
  const tool = toolOf(sentence, genre.hero);
  if (tool !== null && genre.enemy !== undefined && sameRole(genre.enemy, tool)) {
    issues.push({ code: 'ENEMY_IS_TOOL', path: '/enemy', evidence: `the player uses the "${tool}" in the sentence, so it cannot be the enemy` });
  }

  if (!verbFits(genre, ranking, modules)) {
    const first = ranking.ranked[0];
    const evidence =
      ranking.pick === null
        ? `the sentence names no verb the genres know, so only its first genre ${first?.genre}.${first?.mode} is proved`
        : `main verb "${ranking.verb}" plays ${ranking.pick.genre}.${ranking.pick.mode}, not ${genre.genre}.${genre.mode}`;
    issues.push({ code: 'VERB_OUTSIDE_MODE', path: '/mode', evidence });
  }
  if ((modules[genre.genre] as GenreModule).availability(genre.mode as never) !== 'ready') {
    issues.push({ code: 'MODE_NOT_READY', path: '/mode', evidence: `${genre.genre}.${genre.mode} only plays a stand-in` });
  }
  return issues;
}

/** Jen blokující nálezy – to, co opravné kolo musí odstranit. */
export function blockingIssues(issues: readonly CriticIssue[]): CriticIssue[] {
  return issues.filter((issue) => issue.severity === 'block');
}
