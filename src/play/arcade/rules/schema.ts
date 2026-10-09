/**
 * Jazyk pravidel arkády (P29A, T1): spouštěč → podmínky → efekty.
 *
 * Pravidla stojí **vedle** knihovny dílků: ovládání a generátor dál vybírá
 * návrh ze slov nebo režisér, pravidlo dopíše jen sloveso, které žádný dílek
 * neumí („nes klíč ke dveřím“, „hoď kámen do terče“). Pravidlo je data, ne
 * kód: jen celá čísla, žádné výrazy, žádné smyčky. Na tělesa odkazuje **jménem
 * role ze specu** (`player` nebo `roles[].id`), protože model indexy těl nezná.
 * Každé pravidlo nese `verb` – sloveso z věty, které robot musí během vítězného
 * běhu uvidět vystřelit (T4), jinak hra neprojde.
 *
 * `things` doplňuje k roli, co z pravidel nevyčte: začíná tělo skryté (most,
 * který se objeví až po páce)?
 */

import { z } from 'zod';

import { ARCADE_LIMITS, LOGIC_LIMITS } from '../contract';
import { interactWhen } from './interact';

/** Nejvýš tolik pravidel ve specu – tentýž strop jako instance pravidel v jádře. */
export const RULES_MAX = ARCADE_LIMITS.maxRules;
/** Nejvýš tolik doplňků rolí (`things`). */
export const THINGS_MAX = 12;

/** Tentýž vzor jako `gameId` ve `spec.ts` (`ID_PATTERN` z `src/ir/types.ts`). */
const roleRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/, 'role: an id from roles[] or player');

/** Čítače, které pravidlo smí číst a měnit; `trigger` a `cooldown` patří zbraním. */
export const RULE_COUNTERS = ['score', 'items', 'health'] as const;
export type RuleCounter = (typeof RULE_COUNTERS)[number];

/** Sloveso z věty, malými písmeny anglicky („carry“, „throw“, „push“). */
export const verbSchema = z.string().regex(/^[a-z][a-z-]{1,23}$/, 'verb: one lowercase English word');

/**
 * Blok `logic` (P45B): stav, který hra nese mezi tiky – proměnné, časovače, fáze
 * a události. Jen deklarace se jmény; čte a mění je pravidlo. Fáze tu je stavový
 * automat hry („klid → vlna → finále“), ne prostorové tempo trati
 * (`GameSpecV1.phases`, `compose/progression.ts`) – proto v kódu „logic phase“.
 */
const logicId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, 'logic id: lowercase letters, digits and _');
const varLiteral = z.int().min(-LOGIC_LIMITS.varLiteral).max(LOGIC_LIMITS.varLiteral);
export const logicSchema = z
  .object({
    vars: z.array(z.object({ id: logicId, start: varLiteral.optional() }).strict()).max(LOGIC_LIMITS.maxVars).optional(),
    timers: z.array(z.object({ id: logicId }).strict()).max(LOGIC_LIMITS.maxTimers).optional(),
    /** První fáze je počáteční. */
    phases: z.array(z.object({ id: logicId }).strict()).min(LOGIC_LIMITS.minPhases).max(LOGIC_LIMITS.maxPhases).optional(),
    events: z.array(logicId).max(LOGIC_LIMITS.maxEvents).optional(),
  })
  .strict();
export type Logic = z.infer<typeof logicSchema>;

/** Mez proměnné; `ruleIssues` hlídá právě jednu z `atLeast`/`below`. */
const varBound = z.object({ name: logicId, atLeast: varLiteral.optional(), below: varLiteral.optional() }).strict();

/**
 * Spouštěč. `contact` = dvě role se dotknou (jedna smí být `player`), `press` =
 * hráč stiskne akci (`action` = ťuk / mezerník, `alt` = druhé tlačítko), `every`
 * = každých n tiků (60 Hz), `counter` = čítač dosáhl hodnoty, `hit` = projektil
 * zasáhl roli, `interact` = hráč u cíle drží „Use“ (P32, `interact.ts`).
 */
const liveWhens = [
  z.object({ contact: z.tuple([roleRef, roleRef]) }).strict(),
  z.object({ press: z.enum(['action', 'alt']) }).strict(),
  z.object({ every: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict(),
  z.object({ counter: z.object({ name: z.enum(RULE_COUNTERS), atLeast: z.int().min(0).max(1000) }).strict() }).strict(),
  z.object({ hit: roleRef }).strict(),
] as const;
/**
 * Spouštěče logiky (P45B): `timer` = časovač doběhl, `phase` = hra do fáze vstoupila,
 * `phaseExit` = z fáze odešla, `var` = proměnná překročila mez (jednou za přechod,
 * znovu až po návratu), `event` = někdo vyslal událost.
 */
const logicWhens = [
  z.object({ timer: logicId }).strict(),
  z.object({ phase: logicId }).strict(),
  z.object({ phaseExit: logicId }).strict(),
  z.object({ var: varBound }).strict(),
  z.object({ event: logicId }).strict(),
] as const;
export const ruleWhenSchema = z.union([...liveWhens, ...logicWhens, interactWhen(roleRef)]);
export type RuleWhen = z.infer<typeof ruleWhenSchema>;

/**
 * Podmínka; všechny musí platit. `near` zároveň vybere tělo, na které míří
 * efekt s `other`, když spouštěč žádné tělo nemá (`press`, `every`, `counter`).
 * `within` je v celých metrech.
 */
const liveIfs = [
  z.object({ holding: roleRef }).strict(),
  z.object({ notHolding: z.literal(true) }).strict(),
  z
    .object({
      counter: z.object({ name: z.enum(RULE_COUNTERS), atLeast: z.int().min(0).max(1000).optional(), below: z.int().min(0).max(1000).optional() }).strict(),
    })
    .strict(),
  z.object({ near: z.object({ role: roleRef, within: z.int().min(1).max(20) }).strict() }).strict(),
] as const;
export const ruleIfSchema = z.union([
  ...liveIfs,
  // Logika (P45B): proměnná v mezi, hra ve fázi, časovač běží / stojí.
  z.object({ var: varBound }).strict(),
  z.object({ inPhase: logicId }).strict(),
  z.object({ timerRunning: logicId }).strict(),
  z.object({ timerStopped: logicId }).strict(),
]);
export type RuleIf = z.infer<typeof ruleIfSchema>;

/** Na které tělo efekt míří: `other` = druhá role kontaktu / zasažené / blízké tělo, `self` = první role kontaktu, `held` = co hráč drží. */
const bodyRef = z.enum(['other', 'self', 'held']);

/**
 * Efekt. Dnešní efekty jádra přes jména rolí (`score`, `damage`, `win`, `lose`,
 * `despawn`, `spawn`, `count`, `respawn`, `checkpoint`) a nové slovesné:
 * `grab` (hráč tělo zvedne a nese), `release` (položí ho), `throwHeld` (hodí
 * ho před sebe), `push` (strčí do těla, to po zemi dojede), `toggle` (tělesa
 * role se jednou přepnou – dveře zmizí, skrytý most se objeví).
 */
const liveDos = [
  z.object({ score: z.int().min(-100).max(100) }).strict(),
  z.object({ damage: z.int().min(1).max(10) }).strict(),
  z.object({ win: z.literal(true) }).strict(),
  z.object({ lose: z.literal(true) }).strict(),
  z.object({ despawn: bodyRef }).strict(),
  z.object({ spawn: z.object({ role: roleRef, at: z.enum(['player', 'other']) }).strict() }).strict(),
  z.object({ count: z.object({ counter: z.enum(RULE_COUNTERS), amount: z.int().min(-100).max(100) }).strict() }).strict(),
  z.object({ respawn: z.literal(true) }).strict(),
  z.object({ checkpoint: z.enum(['other', 'self']) }).strict(),
  z.object({ grab: z.enum(['other', 'self']) }).strict(),
  z.object({ release: z.literal(true) }).strict(),
  z.object({ throwHeld: z.literal(true) }).strict(),
  z.object({ push: z.enum(['other', 'self']) }).strict(),
  z.object({ toggle: roleRef }).strict(),
] as const;
export const ruleDoSchema = z.union([
  ...liveDos,
  // Logika (P45B): nastav / přičti proměnnou, přepni fázi, spusť / zastav časovač, vyšli
  // událost; `wave` pustí `count` těl role najednou – po obvodu (`edge`), kolem hráče
  // (`player`) nebo kolem těla, kterého se spouštěč týká (`other`).
  z.object({ set: z.object({ var: logicId, value: varLiteral }).strict() }).strict(),
  z.object({ add: z.object({ var: logicId, amount: z.int().min(-LOGIC_LIMITS.maxAdd).max(LOGIC_LIMITS.maxAdd) }).strict() }).strict(),
  z.object({ goPhase: logicId }).strict(),
  z.object({ startTimer: z.object({ timer: logicId, ticks: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict() }).strict(),
  z.object({ stopTimer: logicId }).strict(),
  z.object({ emit: logicId }).strict(),
  z.object({ wave: z.object({ role: roleRef, count: z.int().min(1).max(LOGIC_LIMITS.maxWave), at: z.enum(['edge', 'player', 'other']) }).strict() }).strict(),
]);
export type RuleDo = z.infer<typeof ruleDoSchema>;

export const ruleSchema = z
  .object({
    id: roleRef,
    verb: verbSchema,
    when: ruleWhenSchema,
    if: z.array(ruleIfSchema).max(4).optional(),
    do: z.array(ruleDoSchema).min(1).max(6),
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const rulesSchema = z.array(ruleSchema).max(RULES_MAX);

/**
 * Pravidla, jak je smí psát model (`director/compact.ts`, `answer-schema.ts`) – od P45B T10
 * i s kostkami logiky. `interact` je zpět od `p32-modules` (B-R8, pravidlo P32G T1 hraje);
 * jeho meze – jedno na hru, ne s `+shoot`/`+chaser` – hlídá `ruleIssues`.
 */
export const modelWhenSchema = ruleWhenSchema;
export const modelRulesSchema = z.array(ruleSchema.extend({ when: modelWhenSchema })).max(RULES_MAX);

/**
 * Doplněk role pro pravidla: `start: 'hidden'` = tělo ve hře je, ale ukáže se
 * až po `toggle`; `physics: true` = hýbe s ním Rapier (padá, klouže, převrací
 * se, strčení a hod letí fyzikou).
 */
export const thingSchema = z.object({ role: roleRef, start: z.enum(['present', 'hidden']).optional(), physics: z.boolean().optional() }).strict();
export type Thing = z.infer<typeof thingSchema>;

export const thingsSchema = z.array(thingSchema).max(THINGS_MAX);

/** Role, na které pravidlo odkazuje, s cestou pole (pro hlášku). */
function roleRefsOf(rule: Rule): [string, string][] {
  const refs: [string, string][] = [];
  if ('contact' in rule.when) rule.when.contact.forEach((role, i) => refs.push([`when/contact/${i}`, role]));
  if ('hit' in rule.when) refs.push(['when/hit', rule.when.hit]);
  if ('interact' in rule.when) refs.push(['when/interact/role', rule.when.interact.role]);
  (rule.if ?? []).forEach((cond, i) => {
    if ('holding' in cond) refs.push([`if/${i}/holding`, cond.holding]);
    if ('near' in cond) refs.push([`if/${i}/near/role`, cond.near.role]);
  });
  rule.do.forEach((effect, i) => {
    if ('spawn' in effect) refs.push([`do/${i}/spawn/role`, effect.spawn.role]);
    if ('toggle' in effect) refs.push([`do/${i}/toggle`, effect.toggle]);
    if ('wave' in effect) refs.push([`do/${i}/wave/role`, effect.wave.role]);
  });
  return refs;
}

type LogicKind = 'var' | 'timer' | 'phase' | 'event';

/** Jména logiky, na která pravidlo odkazuje: druh, cesta pole, jméno a jestli ho čte, nebo mění. */
function logicRefsOf(rule: Rule): { kind: LogicKind; path: string; name: string; use: 'read' | 'write' }[] {
  const refs: ReturnType<typeof logicRefsOf> = [];
  const when = rule.when;
  if ('timer' in when) refs.push({ kind: 'timer', path: 'when/timer', name: when.timer, use: 'read' });
  if ('phase' in when) refs.push({ kind: 'phase', path: 'when/phase', name: when.phase, use: 'read' });
  if ('phaseExit' in when) refs.push({ kind: 'phase', path: 'when/phaseExit', name: when.phaseExit, use: 'read' });
  if ('var' in when) refs.push({ kind: 'var', path: 'when/var/name', name: when.var.name, use: 'read' });
  if ('event' in when) refs.push({ kind: 'event', path: 'when/event', name: when.event, use: 'read' });
  (rule.if ?? []).forEach((cond, i) => {
    if ('var' in cond) refs.push({ kind: 'var', path: `if/${i}/var/name`, name: cond.var.name, use: 'read' });
    if ('inPhase' in cond) refs.push({ kind: 'phase', path: `if/${i}/inPhase`, name: cond.inPhase, use: 'read' });
    if ('timerRunning' in cond) refs.push({ kind: 'timer', path: `if/${i}/timerRunning`, name: cond.timerRunning, use: 'read' });
    if ('timerStopped' in cond) refs.push({ kind: 'timer', path: `if/${i}/timerStopped`, name: cond.timerStopped, use: 'read' });
  });
  rule.do.forEach((effect, i) => {
    if ('set' in effect) refs.push({ kind: 'var', path: `do/${i}/set/var`, name: effect.set.var, use: 'write' });
    if ('add' in effect) refs.push({ kind: 'var', path: `do/${i}/add/var`, name: effect.add.var, use: 'write' });
    if ('goPhase' in effect) refs.push({ kind: 'phase', path: `do/${i}/goPhase`, name: effect.goPhase, use: 'write' });
    if ('startTimer' in effect) refs.push({ kind: 'timer', path: `do/${i}/startTimer/timer`, name: effect.startTimer.timer, use: 'write' });
    if ('stopTimer' in effect) refs.push({ kind: 'timer', path: `do/${i}/stopTimer`, name: effect.stopTimer, use: 'write' });
    if ('emit' in effect) refs.push({ kind: 'event', path: `do/${i}/emit`, name: effect.emit, use: 'write' });
  });
  return refs;
}

/** Čte nebo mění pravidlo jméno z bloku `logic`? Bez takového pravidla hra blok nepotřebuje (vlna ho nechce). */
export const readsLogic = (rule: Rule): boolean => logicRefsOf(rule).length > 0;

/** Pravidla, která sahají na kostku logiky `kind`/`id` z nálezu ověření; vlnu nese pravidlo s tím `id`. */
export function rulesTouching(rules: readonly Rule[], kind: LogicKind | 'wave', id: string): number[] {
  return rules.flatMap((rule, index) => (kind === 'wave' ? rule.id === id : logicRefsOf(rule).some((ref) => ref.kind === kind && ref.name === id)) ? [index] : []);
}

/** Jména deklarovaná blokem `logic` podle druhu, s cestou deklarace. */
function declaredOf(logic: Logic): Record<LogicKind, { name: string; path: string }[]> {
  return {
    var: (logic.vars ?? []).map((entry, i) => ({ name: entry.id, path: `/logic/vars/${i}` })),
    timer: (logic.timers ?? []).map((entry, i) => ({ name: entry.id, path: `/logic/timers/${i}` })),
    phase: (logic.phases ?? []).map((entry, i) => ({ name: entry.id, path: `/logic/phases/${i}` })),
    event: (logic.events ?? []).map((name, i) => ({ name, path: `/logic/events/${i}` })),
  };
}

/**
 * Logika proti pravidlům: každé jméno deklarované, žádná deklarace mrtvá. Fáze, do
 * které nic nevede, časovač, který nikdo nespustí, a událost bez vysílače nebo
 * posluchače by se rozbalily bez chyby a robot by je nikdy neuviděl.
 */
function logicIssues(rules: readonly Rule[], logic: Logic | undefined): string[] {
  const issues: string[] = [];
  const declared = logic === undefined ? null : declaredOf(logic);
  const uses = rules.flatMap((rule, index) => logicRefsOf(rule).map((ref) => ({ ...ref, at: `/rules/${index}/${ref.path}` })));
  for (const ref of uses) {
    if (declared === null) issues.push(`${ref.at}: ${ref.kind} ${ref.name} used, but the game declares no logic block`);
    else if (!declared[ref.kind].some((entry) => entry.name === ref.name)) issues.push(`${ref.at}: unknown ${ref.kind} ${ref.name}`);
  }
  if (declared === null) return issues;
  for (const kind of ['var', 'timer', 'phase', 'event'] as const) {
    const seen = new Set<string>();
    for (const entry of declared[kind]) {
      if (seen.has(entry.name)) issues.push(`${entry.path}: ${kind} ${entry.name} declared twice`);
      seen.add(entry.name);
    }
  }
  const used = (kind: LogicKind, name: string, use: 'read' | 'write') => uses.some((ref) => ref.kind === kind && ref.name === name && ref.use === use);
  declared.phase.slice(1).forEach((entry) => {
    if (!used('phase', entry.name, 'write')) issues.push(`${entry.path}: no rule enters phase ${entry.name} – add a rule with {"goPhase":"${entry.name}"}`);
  });
  for (const entry of declared.timer) {
    if (!uses.some((ref) => ref.kind === 'timer' && ref.name === entry.name && ref.path.endsWith('/startTimer/timer'))) {
      issues.push(`${entry.path}: no rule starts timer ${entry.name} – add a rule with {"startTimer":{"timer":"${entry.name}","ticks":…}}`);
    }
  }
  for (const entry of declared.event) {
    if (!used('event', entry.name, 'write')) issues.push(`${entry.path}: no rule emits event ${entry.name}`);
    if (!used('event', entry.name, 'read')) issues.push(`${entry.path}: no rule listens to event ${entry.name} – add a rule with {"when":{"event":"${entry.name}"}}`);
  }
  return issues;
}

/** Po kolika ticích přijde doplněná fáze po té před ní – jako `LOGIC EXAMPLE` promptu režiséra z T10 a šablona `break`. */
export const PHASE_ENTRY_TICKS = 240;

/**
 * Deterministická oprava odpovědi režiséra (P45B T11): fáze, na kterou pravidlo reaguje
 * (`when.phase`, `when.phaseExit`, `if.inPhase`), ale žádné do ní nepřepne, dostane vstupní
 * pravidlo – každých `PHASE_ENTRY_TICKS` tiků z fáze, která je v deklaraci před ní. Jen
 * tenhle tvar: fázi, kterou nikdo nečte, nechá být a `logicIssues` ji dál odmítne. Bez místa
 * v rozpočtu pravidel nebo s obsazeným `id` se fáze nedoplní. Vstupy jdou na konec v obráceném
 * pořadí, ať dvě doplněné fáze za sebou nepřeskočí v jednom tiku obě.
 */
export function withPhaseEntries(rules: readonly Rule[], logic: Logic | undefined): readonly Rule[] {
  const phases = logic?.phases ?? [];
  const uses = rules.flatMap(logicRefsOf).filter((ref) => ref.kind === 'phase');
  const added: Rule[] = [];
  phases.forEach((phase, index) => {
    const id = `enter_${phase.id}`;
    const read = uses.some((ref) => ref.name === phase.id && ref.use === 'read');
    const entered = uses.some((ref) => ref.name === phase.id && ref.use === 'write');
    if (index === 0 || !read || entered || rules.length + added.length >= RULES_MAX || rules.some((rule) => rule.id === id)) return;
    added.unshift({ id, verb: 'advance', when: { every: PHASE_ENTRY_TICKS }, if: [{ inPhase: phases[index - 1]!.id }], do: [{ goPhase: phase.id }] });
  });
  return added.length === 0 ? rules : [...rules, ...added];
}

/**
 * Soudí pravidla proti rolím specu – co schéma jednoho pole neunese: odkazy na
 * role, jednoznačnost id, čítač s právě jednou mezí a efekty mířící na tělo,
 * které spouštěč opravdu má. Prázdné pole = v pořádku.
 *
 * `interact` (B-R8): jádro drží jen jednu rozdělanou práci, takže smí být
 * jedno na hru – generátor úkolu (`game.generator` `quest_*`) si svoje staví
 * sám – a ne spolu s `+shoot`/`+chaser`. Pravidlo vyhraje, jakmile jsou hotové
 * všechny jeho cíle, a Use drží jen robot pravidel dvorku (`game.yard`: volný
 * pohyb a pravidlo, které vyhrává) – `interact` proto musí být to vítězné.
 */
export function ruleIssues(
  rules: readonly Rule[],
  things: readonly Thing[],
  roleIds: ReadonlySet<string>,
  game: { readonly addons?: readonly string[]; readonly generator?: unknown; readonly yard?: boolean; readonly logic?: Logic } = {},
): string[] {
  const issues: string[] = logicIssues(rules, game.logic);
  const interacts = rules.flatMap((rule, index) => ('interact' in rule.when ? [`/rules/${index}/when/interact`] : []));
  rules.forEach((rule, index) => {
    if ('interact' in rule.when && (game.yard !== true || !rule.do.some((effect) => 'win' in effect))) {
      issues.push(`/rules/${index}/when/interact: interact wins once its targets are done – make it the winning rule (do {"win":true}), on free movement only`);
    }
  });
  const own = typeof game.generator === 'string' && game.generator.startsWith('quest_') ? 1 : 0;
  for (const at of interacts.slice(own === 0 ? 1 : 0)) issues.push(`${at}: one interact per game – the core keeps no slot for a second job in progress${own === 1 ? ', and the quest already has its own' : ''}`);
  const clash = (game.addons ?? []).filter((addon) => addon === 'shoot' || addon === 'chaser');
  if (interacts.length > 0 && clash.length > 0) issues.push(`${interacts[0]}: interact does not combine with +${clash.join(' or +')}`);
  const known = (role: string): boolean => role === 'player' || roleIds.has(role);
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    const at = `/rules/${index}`;
    if (ids.has(rule.id)) issues.push(`${at}/id: rule ${rule.id} declared twice`);
    ids.add(rule.id);
    for (const [path, role] of roleRefsOf(rule)) if (!known(role)) issues.push(`${at}/${path}: unknown role ${role}`);
    if ('hit' in rule.when && rule.when.hit === 'player') issues.push(`${at}/when/hit: a projectile hits a role, not the player`);
    (rule.if ?? []).forEach((cond, i) => {
      if ('counter' in cond && (cond.counter.atLeast === undefined) === (cond.counter.below === undefined)) {
        issues.push(`${at}/if/${i}/counter: give exactly one of atLeast or below`);
      }
      if ('var' in cond && (cond.var.atLeast === undefined) === (cond.var.below === undefined)) issues.push(`${at}/if/${i}/var: give exactly one of atLeast or below`);
    });
    if ('var' in rule.when && (rule.when.var.atLeast === undefined) === (rule.when.var.below === undefined)) issues.push(`${at}/when/var: give exactly one of atLeast or below`);
    const contact = 'contact' in rule.when ? rule.when.contact : null;
    if ('interact' in rule.when && rule.when.interact.role === 'player') issues.push(`${at}/when/interact/role: the player interacts with a role, not with itself`);
    const hasOther = contact !== null || 'hit' in rule.when || 'interact' in rule.when || (rule.if ?? []).some((cond) => 'near' in cond);
    rule.do.forEach((effect, i) => {
      const target = 'despawn' in effect ? effect.despawn : 'checkpoint' in effect ? effect.checkpoint : 'grab' in effect ? effect.grab : 'push' in effect ? effect.push : null;
      if (target === 'other' && !hasOther) issues.push(`${at}/do/${i}: "other" needs a contact, a hit or a near condition`);
      if (target === 'self' && (contact === null || contact[0] === 'player')) issues.push(`${at}/do/${i}: "self" is the first role of a contact that is not the player`);
      if ('spawn' in effect && effect.spawn.at === 'other' && !hasOther) issues.push(`${at}/do/${i}/spawn/at: "other" needs a contact, a hit or a near condition`);
      if ('toggle' in effect && effect.toggle === 'player') issues.push(`${at}/do/${i}/toggle: the player cannot be toggled`);
      if ('spawn' in effect && effect.spawn.role === 'player') issues.push(`${at}/do/${i}/spawn/role: the player cannot be spawned`);
      if ('wave' in effect && effect.wave.role === 'player') issues.push(`${at}/do/${i}/wave/role: the player cannot come in a wave`);
      if ('wave' in effect && effect.wave.at === 'other' && !hasOther) issues.push(`${at}/do/${i}/wave/at: "other" needs a contact, a hit or a near condition`);
    });
  });
  const thingRoles = new Set<string>();
  things.forEach((thing, index) => {
    if (thing.role === 'player' || !roleIds.has(thing.role)) issues.push(`/things/${index}/role: unknown role ${thing.role}`);
    if (thingRoles.has(thing.role)) issues.push(`/things/${index}/role: ${thing.role} listed twice`);
    thingRoles.add(thing.role);
  });
  return issues;
}
