/**
 * Hotová pravidla (P29A T10, P45B T8). Šablona je jméno + role, které doplní hra
 * (`item`, `goal`, `enemy`, …); `templateParts` z ní udělá pravidla jazyka
 * (`schema.ts`), blok `logic` a doplňky rolí (`things`) – totéž, co by napsal režisér.
 *
 * - `verbs` jsou slova věty, na která šablona sedí – podle nich měří pokrytí
 *   `evals/play/rules/coverage.ts` (`templateFor`).
 * - `axes` jsou cíle slovníku (`src/play/vocab/verbs.json` `targets`: `objective:survive`,
 *   `action:collect`, `hero:sweep` …), podle kterých šablonu vybírá okamžitý návrh
 *   (`templatesFor`).
 * - `kind`: `goal` šablona hru sama vyhrává (hraje se na dvorku, robot pravidel jde po
 *   ní); `overlay` výhru nechává hře a přidává jen průběh – vlny, odpočet, fáze.
 * - `budget` = kolik pravidel šablona hře přidá (strop 16 platí na všechna dohromady).
 *
 * Dnešních šest šablon (carry … stack) je první a po rozbalení se nemění
 * (`__tests__/__fixtures__/templates-v1.json`). Každá šablona projde ověřením ve svém
 * referenčním světě (`__tests__/templates.test.ts`): šablona, jejíž fáze nikdy nenastane,
 * se rozbalí bez chyby, a teprve robot ukáže, že je mrtvá.
 */

import type { AnchorTarget } from '@/play/vocab/anchors';

import type { Logic, Rule, Thing } from './schema';

/** Místa pro role hry, které šablona potřebuje. */
export const TEMPLATE_SLOTS = ['item', 'goal', 'target', 'lever', 'door', 'enemy', 'hazard', 'exit', 'zone'] as const;
export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

/** Osa záměru ve tvaru cíle slovníku (`move:run`, `objective:survive`, `hero:sweep`). */
export type TemplateAxis = AnchorTarget;

export type TemplateKind = 'goal' | 'overlay';

export interface RuleTemplate {
  /** Slova věty, na která šablona sedí (základní tvar, anglicky). */
  readonly verbs: readonly string[];
  readonly axes: readonly TemplateAxis[];
  readonly kind: TemplateKind;
  /** Kolik pravidel šablona stojí. */
  readonly budget: number;
  readonly slots: readonly TemplateSlot[];
  /** Deklarace logiky, kterou pravidla šablony čtou a mění. */
  readonly logic?: Logic;
  /** Doplňky rolí s `$slot` místo role (tělo z vlny, ne na startu). */
  readonly things?: readonly Thing[];
  /** Pravidla s `$slot` místo role. */
  readonly rules: readonly Rule[];
}

const S = (slot: TemplateSlot): string => `$${slot}`;

export const RULE_TEMPLATES = {
  carry: {
    verbs: ['carry', 'bring', 'deliver', 'fetch', 'haul', 'transport', 'grab'],
    axes: ['action:deliver', 'hero:carry'],
    kind: 'goal',
    budget: 2,
    slots: ['item', 'goal'],
    rules: [
      { id: 'take', verb: 'carry', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'deliver', verb: 'deliver', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { score: 1 }, { win: true }] },
    ],
  },
  throw: {
    verbs: ['throw', 'toss', 'hurl', 'lob', 'fling'],
    axes: ['action:throw', 'hero:throw'],
    kind: 'goal',
    budget: 3,
    slots: ['item', 'target'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'throw', verb: 'throw', when: { press: 'action' }, if: [{ holding: S('item') }], do: [{ throwHeld: true }] },
      { id: 'hit', verb: 'hit', when: { contact: [S('item'), S('target')] }, do: [{ score: 1 }, { win: true }] },
    ],
  },
  push: {
    verbs: ['push', 'shove', 'nudge', 'kick'],
    axes: ['action:kick'],
    kind: 'goal',
    budget: 2,
    slots: ['item', 'goal'],
    rules: [
      { id: 'push', verb: 'push', when: { contact: ['player', S('item')] }, do: [{ push: 'other' }] },
      { id: 'place', verb: 'place', when: { contact: [S('item'), S('goal')] }, do: [{ win: true }] },
    ],
  },
  open: {
    verbs: ['open', 'pull', 'unlock', 'flip'],
    axes: ['action:interact'],
    kind: 'goal',
    budget: 2,
    slots: ['lever', 'door', 'goal'],
    rules: [
      { id: 'pull', verb: 'pull', when: { contact: ['player', S('lever')] }, do: [{ toggle: S('door') }] },
      { id: 'pass', verb: 'pass', when: { contact: ['player', S('goal')] }, do: [{ win: true }] },
    ],
  },
  give: {
    verbs: ['give', 'hand', 'offer', 'feed', 'serve'],
    axes: ['action:deliver'],
    kind: 'goal',
    budget: 2,
    slots: ['item', 'goal'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'give', verb: 'give', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { score: 1 }, { win: true }] },
    ],
  },
  stack: {
    verbs: ['stack', 'pile', 'heap'],
    axes: ['action:stack', 'hero:stack'],
    kind: 'goal',
    budget: 3,
    slots: ['item', 'goal'],
    rules: [
      { id: 'pick', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'stack', verb: 'stack', when: { contact: ['player', S('goal')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { count: { counter: 'items', amount: 1 } }] },
      { id: 'tall', verb: 'finish', when: { counter: { name: 'items', atLeast: 3 } }, do: [{ win: true }] },
    ],
  },

  // -------------------------------------------------------------------------
  // S logikou (P45B T8). Mez „3“ počítá se třemi těly role (`count` 3).

  /** Sebrané počítá proměnná; třetí kus otevře bránu k východu. */
  collect_unlock: {
    verbs: ['collect', 'gather', 'loot', 'hoard'],
    axes: ['objective:collect', 'action:collect'],
    kind: 'goal',
    budget: 3,
    slots: ['item', 'door', 'exit'],
    logic: { vars: [{ id: 'found' }] },
    rules: [
      { id: 'gather', verb: 'collect', when: { contact: ['player', S('item')] }, do: [{ add: { var: 'found', amount: 1 } }, { despawn: 'other' }] },
      { id: 'unlock', verb: 'unlock', when: { var: { name: 'found', atLeast: 3 } }, do: [{ toggle: S('door') }] },
      { id: 'leave', verb: 'escape', when: { contact: ['player', S('exit')] }, do: [{ win: true }] },
    ],
  },
  /** Zásahy počítá proměnná; třetí přepne do finále a to pustí velkého nepřítele. */
  boss_finale: {
    verbs: ['defeat', 'slay', 'vanquish', 'conquer', 'fight', 'battle'],
    axes: ['objective:defeat', 'action:fight'],
    kind: 'goal',
    budget: 4,
    slots: ['enemy', 'target'],
    logic: { vars: [{ id: 'hits' }], phases: [{ id: 'brawl' }, { id: 'finale' }] },
    things: [{ role: S('target'), start: 'hidden' }],
    rules: [
      { id: 'strike', verb: 'strike', when: { press: 'action' }, if: [{ near: { role: S('enemy'), within: 1 } }], do: [{ despawn: 'other' }, { add: { var: 'hits', amount: 1 } }] },
      { id: 'rally', verb: 'rally', when: { var: { name: 'hits', atLeast: 3 } }, do: [{ goPhase: 'finale' }] },
      { id: 'summon', verb: 'summon', when: { phase: 'finale' }, do: [{ wave: { role: S('target'), count: 1, at: 'edge' } }] },
      { id: 'slay', verb: 'slay', when: { press: 'action' }, if: [{ inPhase: 'finale' }, { near: { role: S('target'), within: 1 } }], do: [{ despawn: 'other' }, { win: true }] },
    ],
  },
  /** Páka vyšle otřes, ten spustí odpočet a otevře cestu; ven před koncem odpočtu. */
  escape_countdown: {
    verbs: ['escape', 'flee', 'outrun'],
    axes: ['objective:escape'],
    kind: 'goal',
    budget: 4,
    slots: ['lever', 'door', 'exit'],
    logic: { timers: [{ id: 'collapse' }], events: ['quake'] },
    rules: [
      // Jen stojící odpočet: hráč na páce by ho jinak natahoval každý tik.
      { id: 'trip', verb: 'trigger', when: { contact: ['player', S('lever')] }, if: [{ timerStopped: 'collapse' }], do: [{ emit: 'quake' }] },
      { id: 'quake', verb: 'rumble', when: { event: 'quake' }, do: [{ startTimer: { timer: 'collapse', ticks: 900 } }, { toggle: S('door') }] },
      { id: 'flee', verb: 'escape', when: { contact: ['player', S('exit')] }, if: [{ timerRunning: 'collapse' }], do: [{ stopTimer: 'collapse' }, { win: true }] },
      { id: 'crush', verb: 'collapse', when: { timer: 'collapse' }, do: [{ lose: true }] },
    ],
  },
  /** Odpočet: každá branka (zóna) ho natáhne znovu; do cíle přes dvě, než doběhne. */
  race_clock: {
    verbs: ['race'],
    axes: ['objective:race', 'objective:reach'],
    kind: 'goal',
    budget: 3,
    slots: ['zone', 'exit'],
    logic: { vars: [{ id: 'splits' }], timers: [{ id: 'clock' }] },
    rules: [
      { id: 'split', verb: 'pass', when: { contact: ['player', S('zone')] }, do: [{ add: { var: 'splits', amount: 1 } }, { startTimer: { timer: 'clock', ticks: 600 } }, { despawn: 'other' }] },
      { id: 'finish', verb: 'finish', when: { contact: ['player', S('exit')] }, if: [{ var: { name: 'splits', atLeast: 2 } }, { timerRunning: 'clock' }], do: [{ stopTimer: 'clock' }, { win: true }] },
      { id: 'expire', verb: 'expire', when: { timer: 'clock' }, do: [{ lose: true }] },
    ],
  },
  /** Záchrana vyšle událost; ta přepne do útěku a kolem hráče pustí pronásledovatele. */
  rescue_then_flee: {
    verbs: ['rescue', 'save', 'liberate'],
    axes: ['action:interact', 'objective:escape'],
    kind: 'goal',
    budget: 4,
    slots: ['item', 'enemy', 'exit'],
    logic: { phases: [{ id: 'sneak' }, { id: 'flee' }], events: ['freed'] },
    things: [{ role: S('enemy'), start: 'hidden' }],
    rules: [
      { id: 'free', verb: 'rescue', when: { contact: ['player', S('item')] }, do: [{ emit: 'freed' }, { despawn: 'other' }] },
      { id: 'alarm', verb: 'alarm', when: { event: 'freed' }, do: [{ goPhase: 'flee' }, { wave: { role: S('enemy'), count: 3, at: 'player' } }] },
      { id: 'caught', verb: 'catch', when: { contact: ['player', S('enemy')] }, do: [{ lose: true }] },
      { id: 'home', verb: 'escape', when: { contact: ['player', S('exit')] }, if: [{ inPhase: 'flee' }], do: [{ win: true }] },
    ],
  },
  /** Obléhání (odpočet + vlna) začne hned; vyhraje, kdo základnu (zónu) obsadí, než odpočet doběhne. */
  defend_base: {
    verbs: ['defend', 'protect'],
    axes: ['objective:survive'],
    kind: 'goal',
    budget: 4,
    slots: ['zone', 'enemy'],
    logic: { vars: [{ id: 'manned' }], timers: [{ id: 'siege' }] },
    things: [{ role: S('enemy'), start: 'hidden' }],
    rules: [
      { id: 'siege', verb: 'besiege', when: { var: { name: 'manned', below: 1 } }, do: [{ startTimer: { timer: 'siege', ticks: 600 } }, { wave: { role: S('enemy'), count: 4, at: 'edge' } }] },
      { id: 'man', verb: 'defend', when: { contact: ['player', S('zone')] }, do: [{ set: { var: 'manned', value: 1 } }] },
      { id: 'hold', verb: 'hold', when: { timer: 'siege' }, if: [{ var: { name: 'manned', atLeast: 1 } }], do: [{ win: true }] },
      { id: 'fall', verb: 'fall', when: { timer: 'siege' }, if: [{ var: { name: 'manned', below: 1 } }], do: [{ lose: true }] },
    ],
  },
  /** Spínač otevře okno (časovač); jen v otevřeném okně se kombo počítá, tři v něm vyhrávají. */
  combo_window: {
    verbs: ['score'],
    axes: ['objective:score', 'action:time'],
    kind: 'goal',
    budget: 3,
    slots: ['lever', 'item'],
    logic: { vars: [{ id: 'combo' }], timers: [{ id: 'window' }] },
    rules: [
      { id: 'cue', verb: 'start', when: { contact: ['player', S('lever')] }, if: [{ timerStopped: 'window' }], do: [{ startTimer: { timer: 'window', ticks: 300 } }] },
      { id: 'chain', verb: 'combo', when: { contact: ['player', S('item')] }, if: [{ timerRunning: 'window' }], do: [{ add: { var: 'combo', amount: 1 } }, { score: 1 }, { despawn: 'other' }] },
      { id: 'bank', verb: 'score', when: { var: { name: 'combo', atLeast: 3 } }, do: [{ stopTimer: 'window' }, { win: true }] },
    ],
  },
  /** Stavba po patrech: každý dílek položený na staveniště přidá patro, fáze jdou přízemí → zdi → střecha. */
  build_floors: {
    verbs: ['build', 'construct'],
    axes: ['objective:build', 'action:stack'],
    kind: 'goal',
    budget: 5,
    slots: ['item', 'zone'],
    logic: { vars: [{ id: 'floors' }], phases: [{ id: 'ground' }, { id: 'walls' }, { id: 'roof' }] },
    rules: [
      { id: 'fetch', verb: 'pick', when: { contact: ['player', S('item')] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] },
      { id: 'lay', verb: 'build', when: { contact: ['player', S('zone')] }, if: [{ holding: S('item') }], do: [{ despawn: 'held' }, { add: { var: 'floors', amount: 1 } }] },
      { id: 'walls', verb: 'raise', when: { var: { name: 'floors', atLeast: 1 } }, do: [{ goPhase: 'walls' }] },
      { id: 'roof', verb: 'top', when: { var: { name: 'floors', atLeast: 3 } }, do: [{ goPhase: 'roof' }] },
      { id: 'done', verb: 'finish', when: { phase: 'roof' }, do: [{ win: true }] },
    ],
  },
  /** Vlna rozežene kořist po okraji hned na startu; tři chycené vyhrávají. */
  catch_count: {
    verbs: ['catch', 'chase', 'hunt', 'pursue'],
    axes: ['objective:catch'],
    kind: 'goal',
    budget: 3,
    slots: ['enemy'],
    logic: { vars: [{ id: 'caught' }] },
    things: [{ role: S('enemy'), start: 'hidden' }],
    rules: [
      { id: 'scatter', verb: 'scatter', when: { var: { name: 'caught', below: 1 } }, do: [{ wave: { role: S('enemy'), count: 3, at: 'edge' } }] },
      { id: 'nab', verb: 'catch', when: { contact: ['player', S('enemy')] }, do: [{ despawn: 'other' }, { add: { var: 'caught', amount: 1 } }] },
      { id: 'bag', verb: 'win', when: { var: { name: 'caught', atLeast: 3 } }, do: [{ win: true }] },
    ],
  },
  /** Práce hrdiny (držet Use u cíle); první hotová přepne do spěchu a ten rozlije dva cíle navíc. */
  chores_rush: {
    // Bez „paint“ a „water“: ve větách bývají podstatnými jmény (barva, voda) a pokrytí by lhalo.
    verbs: ['sweep', 'mop', 'scrub', 'wipe', 'fix', 'repair', 'dig', 'chop', 'knit', 'sew', 'stir', 'whisk', 'spray', 'hose'],
    axes: ['hero:sweep', 'hero:fix', 'hero:dig', 'hero:chop', 'hero:knit', 'hero:stir', 'hero:spray', 'hero:paint', 'hero:water'],
    kind: 'goal',
    budget: 3,
    slots: ['target'],
    logic: { vars: [{ id: 'done' }], phases: [{ id: 'tidy' }, { id: 'rush' }] },
    rules: [
      { id: 'chore', verb: 'work', when: { interact: { role: S('target'), radius: 1, hold: 45, states: 2 } }, do: [{ add: { var: 'done', amount: 1 } }, { win: true }] },
      { id: 'rush', verb: 'rush', when: { var: { name: 'done', atLeast: 1 } }, do: [{ goPhase: 'rush' }] },
      { id: 'spill', verb: 'spill', when: { phase: 'rush' }, do: [{ wave: { role: S('target'), count: 2, at: 'edge' } }] },
    ],
  },
  /**
   * Posily (P45B T9): po 10 s klidu zazní poplach a po okraji podlahy přijde další hlídka. Jen aréna
   * a úkol. Stojí před `waves_survive`: útěková aréna s lovci po vlnách „přežij“ padala 9× z 20 a
   * návrh se pak ověřoval dvakrát; jedna hlídka navíc projde (`evals/play/p45b/README.md`).
   */
  reinforcements: {
    verbs: ['infiltrate', 'rescue', 'save'],
    axes: ['action:interact', 'objective:survive'],
    kind: 'overlay',
    budget: 2,
    slots: ['enemy'],
    logic: { phases: [{ id: 'calm' }, { id: 'alarm' }] },
    rules: [
      { id: 'sound', verb: 'sound', when: { every: 600 }, if: [{ inPhase: 'calm' }], do: [{ goPhase: 'alarm' }] },
      { id: 'muster', verb: 'muster', when: { phase: 'alarm' }, do: [{ wave: { role: S('enemy'), count: 1, at: 'edge' } }] },
    ],
  },
  /**
   * Průběh přežití: klid → vlna → finále. Klid končí po 4 s, vlna trvá 8 s, každá fáze pustí
   * nepřátele po okraji podlahy – jen hra volného pohybu (aréna, úkol), jinde okraj není.
   */
  waves_survive: {
    verbs: ['survive', 'outlast'],
    axes: ['objective:survive'],
    kind: 'overlay',
    budget: 4,
    slots: ['enemy'],
    logic: { timers: [{ id: 'lull' }], phases: [{ id: 'calm' }, { id: 'wave' }, { id: 'final' }] },
    rules: [
      { id: 'break', verb: 'break', when: { every: 240 }, if: [{ inPhase: 'calm' }], do: [{ goPhase: 'wave' }] },
      { id: 'swarm', verb: 'swarm', when: { phase: 'wave' }, do: [{ wave: { role: S('enemy'), count: 3, at: 'edge' } }, { startTimer: { timer: 'lull', ticks: 480 } }] },
      { id: 'last', verb: 'hold', when: { timer: 'lull' }, do: [{ goPhase: 'final' }] },
      { id: 'surge', verb: 'surge', when: { phase: 'final' }, do: [{ wave: { role: S('enemy'), count: 4, at: 'edge' } }] },
    ],
  },

  // -------------------------------------------------------------------------
  // Průběh pro nejčastější buňky okamžitého návrhu (P45B T9, změřeno nad `p30/dev` + `p37a/dev-150`).
  // První slovo je vlastní (šablona je k nalezení `templateFor`) a v korpusu poptávky není; další
  // má šablona výš – pokrytí sloves (`evals/play/rules/coverage-p41.json`) se tím nemění.

  /** Zlatá horečka: po 5 s klidu se po okraji podlahy vysypou tři sbírané věci, za 8 s je zase klid. Jen aréna a úkol. */
  treasure_rush: {
    verbs: ['scavenge', 'collect', 'gather'],
    axes: ['objective:collect', 'action:collect'],
    kind: 'overlay',
    budget: 3,
    slots: ['item'],
    logic: { timers: [{ id: 'rush' }], phases: [{ id: 'calm' }, { id: 'rush' }] },
    rules: [
      { id: 'herald', verb: 'herald', when: { every: 300 }, if: [{ inPhase: 'calm' }], do: [{ goPhase: 'rush' }, { startTimer: { timer: 'rush', ticks: 480 } }] },
      { id: 'shower', verb: 'shower', when: { phase: 'rush' }, do: [{ wave: { role: S('item'), count: 3, at: 'edge' } }] },
      { id: 'settle', verb: 'settle', when: { timer: 'rush' }, do: [{ goPhase: 'calm' }] },
    ],
  },
  /** Spršky na trati: po 5 s se kolem hráče vysypou tři sbírané věci, za 8 s znovu klid. Hraje i bez podlahy. */
  coin_shower: {
    verbs: ['sprint', 'race', 'escape'],
    axes: ['objective:reach', 'objective:race', 'objective:escape'],
    kind: 'overlay',
    budget: 3,
    slots: ['item'],
    logic: { timers: [{ id: 'rush' }], phases: [{ id: 'calm' }, { id: 'rush' }] },
    rules: [
      { id: 'herald', verb: 'herald', when: { every: 300 }, if: [{ inPhase: 'calm' }], do: [{ goPhase: 'rush' }, { startTimer: { timer: 'rush', ticks: 480 } }] },
      { id: 'shower', verb: 'shower', when: { phase: 'rush' }, do: [{ wave: { role: S('item'), count: 3, at: 'player' } }] },
      { id: 'settle', verb: 'settle', when: { timer: 'rush' }, do: [{ goPhase: 'calm' }] },
    ],
  },
} as const satisfies Readonly<Record<string, RuleTemplate>>;

export type TemplateName = keyof typeof RULE_TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(RULE_TEMPLATES) as TemplateName[];

/** Šablona rozbalená pro hru: pravidla, doplňky rolí a blok logiky (jen šablona s logikou). */
export interface TemplateParts {
  readonly rules: Rule[];
  readonly things: Thing[];
  readonly logic?: Logic;
}

const SLOT_REF = new RegExp(`"\\$(${TEMPLATE_SLOTS.join('|')})"`, 'g');

/** Šablona s rolemi hry místo `$slot`; chybějící role = `null`. */
export function templateParts(name: TemplateName, roles: Readonly<Partial<Record<TemplateSlot, string>>>): TemplateParts | null {
  const template: RuleTemplate = RULE_TEMPLATES[name];
  if (template.slots.some((slot) => roles[slot] === undefined)) return null;
  const fill = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(SLOT_REF, (_, slot: TemplateSlot) => JSON.stringify(roles[slot]))) as T;
  return { rules: fill([...template.rules]), things: fill([...(template.things ?? [])]), ...(template.logic === undefined ? {} : { logic: fill(template.logic) }) };
}

/** Jen pravidla šablony s rolemi hry; chybějící role = `null`. */
export function expandTemplate(name: TemplateName, roles: Readonly<Partial<Record<TemplateSlot, string>>>): Rule[] | null {
  return templateParts(name, roles)?.rules ?? null;
}

/** Říkají slova věty (malá písmena) sloveso šablony v běžném tvaru (`toss`, `tosses`, `tossing`, `tossed`)? */
export function says(words: readonly string[], verb: string): boolean {
  return words.some((word) => word === verb || word === `${verb}s` || word === `${verb}es` || word === `${verb}ing` || word === `${verb.replace(/e$/, '')}ing` || word === `${verb}ed`);
}

/** Šablona, jejíž sloveso věta obsahuje (první podle pořadí `RULE_TEMPLATES`), jinak `null`. */
export function templateFor(sentence: string): TemplateName | null {
  const words = sentence.toLowerCase().match(/[a-z]+/g) ?? [];
  return TEMPLATE_NAMES.find((name) => RULE_TEMPLATES[name].verbs.some((verb) => says(words, verb))) ?? null;
}

/** Šablony s aspoň jednou z os `axes`, které se vejdou do `budget` pravidel – v pořadí `RULE_TEMPLATES`. */
export function templatesFor(axes: readonly string[], budget: number): TemplateName[] {
  const wanted = new Set(axes);
  return TEMPLATE_NAMES.filter((name) => {
    const template: RuleTemplate = RULE_TEMPLATES[name];
    return template.budget <= budget && template.axes.some((axis) => wanted.has(axis));
  });
}
