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

import { ARCADE_LIMITS } from '../contract';
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
export const ruleWhenSchema = z.union([...liveWhens, interactWhen(roleRef)]);
export type RuleWhen = z.infer<typeof ruleWhenSchema>;

/**
 * Podmínka; všechny musí platit. `near` zároveň vybere tělo, na které míří
 * efekt s `other`, když spouštěč žádné tělo nemá (`press`, `every`, `counter`).
 * `within` je v celých metrech.
 */
export const ruleIfSchema = z.union([
  z.object({ holding: roleRef }).strict(),
  z.object({ notHolding: z.literal(true) }).strict(),
  z
    .object({
      counter: z.object({ name: z.enum(RULE_COUNTERS), atLeast: z.int().min(0).max(1000).optional(), below: z.int().min(0).max(1000).optional() }).strict(),
    })
    .strict(),
  z.object({ near: z.object({ role: roleRef, within: z.int().min(1).max(20) }).strict() }).strict(),
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
export const ruleDoSchema = z.union([
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
 * Pravidla, jak je smí psát model (`director/compact.ts`, `answer-schema.ts`).
 * `interact` je zpět od `p32-modules` (B-R8, pravidlo P32G T1 hraje); jeho meze
 * – jedno na hru, ne s `+shoot`/`+chaser` – hlídá `ruleIssues`.
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
  });
  return refs;
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
  game: { readonly addons?: readonly string[]; readonly generator?: unknown; readonly yard?: boolean } = {},
): string[] {
  const issues: string[] = [];
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
    });
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
