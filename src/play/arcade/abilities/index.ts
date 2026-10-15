/**
 * Akce hrdiny (P46A): nejvýš dvě na hru, první na tlačítku A, druhá na B.
 * Každá akce je dílek ve vzoru doplňků (`AddonPiece`): `apply` přidá do úrovně
 * nepřátele a pravidla. Stav akcí (cooldown, aktivní okno) drží tělo-počítadlo
 * `abilityKeeper` za tělesy úrovně a píše ho obal ovládání (`state.ts`).
 * Svět bez `abilities` tělo ani obal nedostane, takže jeho hash se nepohne.
 *
 * Rozhraní (`AbilityPiece`, `applyAbilities`, `ABILITY_SLOTS`) je zmrazené
 * tagem `p46a-api`; staví na něm power-upy P46C a režisér P46E.
 */

import { type AbilityId, type BodyInit, type PieceRef, mapUnderlying, nativeRule } from '../contract';
import { type AddonContext, type ArcadeParts, baseControlOf, enemiesFor, enemyOptions, hitParamsFor, wrapBot, wrapControl } from '../addons';
import { type BossBeatParams, bossBeat, bossBeatHit } from '../pieces/boss';
import { grabRule } from './grab';
import { dashRule, fightGuardRule, shieldRule } from './guard';
import { HARMFUL_PARTS, HARMFUL_ROLES, abilityIdsOf } from './state';
import { shootAbility } from './shoot';
import { AROUND_CONTROLS, strikeRule } from './strike';

export interface AbilityContext extends AddonContext {
  /** Index těla-počítadla `abilityKeeper`. */
  readonly keeper: number;
  /** Tlačítko akce: 0 = A, 1 = B. */
  readonly slot: number;
}

export interface AbilityPiece {
  readonly id: AbilityId;
  apply(parts: ArcadeParts, context: AbilityContext): ArcadeParts;
}

/** Je v úrovni koho udeřit? Bez nepřátel a pronásledovatele je akce dá jako `+shoot`. */
function withFoes(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  return parts.level.bodies.some((body) => body.role === 'enemy' || body.role === 'chaser') ? parts : addFoes(parts, context);
}

/** Nepřátelé ovládání a jejich náraz (`hit`). */
function addFoes(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  const control = baseControlOf(parts.control).id;
  // Řízení akcí nechává cíle jako dřív; běžec ze vzorů jen bez nepřátel ve finále bosse (`finaleFrom`).
  const { finaleFrom } = enemyOptions(context.spec, control);
  const foes = enemiesFor(control, parts.level, { finaleFrom });
  if (foes.length === 0) return { ...parts, issues: [...(parts.issues ?? []), 'abilities: the level has no place for an enemy to strike'] };
  return {
    ...parts,
    level: { ...parts.level, bodies: [...parts.level.bodies, ...foes] },
    rules: [...parts.rules, { id: 'hit', params: hitParamsFor('enemy', context.health) }],
  };
}

/** Pohled shora: úder a krádež sahají kolem hrdiny (`AROUND_CONTROLS`). */
const aroundOf = (parts: ArcadeParts): { around?: true } => (AROUND_CONTROLS.includes(baseControlOf(parts.control).id) ? { around: true } : {});

/** Boss finále (P46B): parametry jeho pravidla pádu (kořist), jinak jen předloha těla `boss`. */
function bossOf(parts: ArcadeParts): { boss?: BossBeatParams } {
  const beat = parts.rules.find((rule) => rule.id === bossBeat.id || rule.id === bossBeatHit.id);
  if (beat !== undefined) return { boss: beat.params as BossBeatParams };
  const template = parts.level.bodies.findIndex((body) => body.kind === 'boss' && body.template === true);
  return template < 0 ? {} : { boss: { boss: template } };
}

export const strikeAbility: AbilityPiece = {
  id: 'strike',
  apply: (parts, context) => {
    const armed = withFoes(parts, context);
    return { ...armed, rules: [...armed.rules, { id: strikeRule.id, params: { keeper: context.keeper, slot: context.slot, verb: 'strike', ...aroundOf(parts), ...bossOf(parts) } }] };
  },
};

/** Krádež potřebuje co sebrat: věci úrovně stačí, bez nich nepřátelé jako u úderu. */
export const grabAbility: AbilityPiece = {
  id: 'grab',
  apply: (parts, context) => {
    const loot = parts.level.bodies.some((body) => body.role === 'collectible' && body.template !== true);
    const armed = loot ? parts : withFoes(parts, context);
    return { ...armed, rules: [...armed.rules, { id: grabRule.id, params: { keeper: context.keeper, slot: context.slot, verb: 'grab', ...aroundOf(parts) } }] };
  },
};

/** Tělo dílu složené hry, který hrdinovi ublíží vlastní větví `assembly_part` (`HARMFUL_PARTS`, P47B T4); jinak `undefined`. */
function partOf(rule: PieceRef): number | undefined {
  if (rule.id !== 'assembly_part') return undefined;
  const { kind, body } = rule.params.part as { readonly kind: string; readonly body: number };
  return HARMFUL_PARTS.includes(kind) ? body : undefined;
}

/** Nárazy, které hrdinovi ublíží: `hit`, náraz do svodidel řízení, chycení v aréně a díl složené hry, který zraní. */
const isCrash = (rule: PieceRef): boolean => rule.id === 'hit' || rule.id === 'steer_crash' || rule.id === 'arena_eat' || partOf(rule) !== undefined;

/** Těla dílů složené hry, které hrdinovi ublíží – role jim `harmOf` dát nemůže, mají kód role věci. */
const harmfulParts = (rules: readonly PieceRef[]): number[] => rules.flatMap((rule) => partOf(rule) ?? []);

/**
 * Role, které hrdinovi ublíží nárazem – ty dash prorazí a štít odrazí. V aréně jen pronásledovatel
 * útěku (`arena_eat` s `grace`): buňka agaru je kořist i lovec podle velikosti, štít by blokoval i kořist.
 */
export const harmOf = (parts: ArcadeParts): (typeof HARMFUL_ROLES)[number][] =>
  HARMFUL_ROLES.filter((role) =>
    parts.rules.some(
      (rule) =>
        (rule.id === 'hit' && rule.params.role === role) ||
        (rule.id === 'steer_crash' && role === 'obstacle') ||
        (rule.id === 'arena_eat' && rule.params.grace !== undefined && role === 'chaser'),
    ),
  );

/**
 * Nárazy, na které robot akcí opravdu najede: na řízení ne svodidla (`steer_crash`) – ta objíždí jako kraj
 * silnice (`abilityStep`), takže by dash ani štít v závodě nikdy nic nezastavil (P47B T5).
 */
const metHarm = (parts: ArcadeParts): (typeof HARMFUL_ROLES)[number][] =>
  harmOf(parts).filter((role) => role !== 'obstacle' || baseControlOf(parts.control).id !== 'steer');

/** Základní ovládání pod obaly (`baseControlOf`) upravené `edit`; obaly zůstanou. */
const withBaseControl = (control: PieceRef, edit: (base: PieceRef) => PieceRef): PieceRef =>
  baseControlOf(control) === control ? edit(control) : { ...control, params: { ...control.params, base: withBaseControl(control.params.base as PieceRef, edit) } };

/**
 * Souboj v aréně (P47B T6): úder soupeře rozhoduje ovládání souboje, ne náraz – ochranu (`guard`) dostane ono
 * a sloveso pravidlo odraženého úderu (`fightGuardRule`). Dash bere úder dřív než štít, proto štít zná jeho slot.
 */
function fightGuard(parts: ArcadeParts, context: AbilityContext, id: 'dash' | 'shield'): ArcadeParts {
  const known = baseControlOf(parts.control).params.guard as { readonly dash?: number } | undefined;
  const dash = id === 'dash' ? context.slot : known?.dash;
  const control = withBaseControl(parts.control, (fight) => ({
    ...fight,
    params: { ...fight.params, guard: { ...((fight.params.guard as object | undefined) ?? {}), keeper: context.keeper, ...(id === 'dash' ? { dash: context.slot } : { shield: true }) } },
  }));
  return { ...parts, control, rules: [...parts.rules, { id: fightGuardRule.id, params: { keeper: context.keeper, verb: id, ...(dash === undefined ? {} : { dash }) } }] };
}

/** Dash a štít: náraz dostane ochranu, pravidlo akce pohlcení provede. Úroveň bez nárazu, na který robot najede, dostane nepřátele jako u úderu. */
function guardAbility(id: 'dash' | 'shield'): AbilityPiece {
  return {
    id,
    apply: (start, context) => {
      if (baseControlOf(start.control).id === 'fight') return fightGuard(start, context, id);
      // Soupeři řízení jsou `enemy` bez nárazu, proto nepřátele přidat i vedle nich (jako `+shoot`); svodidla řízení je nenahradí.
      const parts = metHarm(start).length === 0 ? addFoes(start, context) : start;
      if (id === 'shield') return shieldParts(parts, context.keeper);
      const roles = harmOf(parts);
      if (roles.length === 0) return parts;
      return { ...parts, rules: [...guarded(parts.rules, context.keeper, { dash: context.slot }), { id: dashRule.id, params: { keeper: context.keeper, slot: context.slot, roles, verb: 'dash' } }] };
    },
  };
}

const guarded = (rules: readonly PieceRef[], keeper: number, guard: { dash: number } | { shield: true }): PieceRef[] =>
  rules.map((rule) => (isCrash(rule) ? { id: rule.id, params: { ...rule.params, guard: { ...((rule.params.guard as object | undefined) ?? {}), keeper, ...guard } } } : rule));

/**
 * Štít akce i power-upu štítu (P46C): nárazy dostanou ochranu nábojem počítadla `keeper` a blok
 * štítu jde před ně. Úroveň bez nárazu, nebo se štítem už zapojeným, zůstane, jak je. Sloveso
 * `shield` dostane jen akce, kterou hra slíbila; power-up ho nemá (`promised: false`).
 */
export function shieldParts(parts: ArcadeParts, keeper: number, promised = true): ArcadeParts {
  const roles = harmOf(parts);
  if (roles.length === 0 || parts.rules.some((rule) => rule.id === shieldRule.id)) return parts;
  // Blok štítu se musí použít před nárazem téhož těla, jinak by `ifAlive` nárazu viděl tělo ještě živé.
  return { ...parts, rules: [{ id: shieldRule.id, params: { keeper, roles, ...(promised ? { verb: 'shield' } : {}) } }, ...guarded(parts.rules, keeper, { shield: true })] };
}

/**
 * Robot akcí (`addon_bot` z `applyAbilities`) pod obalem složené hry dostane těla dílů, které zraní (`parts`),
 * ať jim nastaví dash a štít jako nárazu.
 */
function botWithParts(bot: PieceRef, bodies: readonly number[]): PieceRef {
  const params = bot.params as { readonly base: PieceRef; readonly abilities: object };
  if (bot.id === 'addon_bot') return { ...bot, params: { ...bot.params, abilities: { ...params.abilities, parts: [...bodies] } } };
  return bot.id === 'assembly_bot' ? { ...bot, params: { ...bot.params, base: botWithParts(params.base, bodies) } } : bot;
}

/**
 * Díly složené hry (P47B T4) se skládají až po akcích (`assemblyParts`), proto ochranu dostanou tady:
 * pravidlo dílu, který zraní, `guard` jako náraz `hit`, dash a štít jeho tělo v `parts` a robot akcí taky.
 * Hra bez akcí zůstane bajt po bajtu, jak je – i se štítem power-upu.
 */
export function guardParts(parts: ArcadeParts): ArcadeParts {
  const bodies = harmfulParts(parts.rules);
  const dash = nativeRule(parts.rules, dashRule.id);
  const shield = nativeRule(parts.rules, shieldRule.id);
  const keeper = (dash ?? shield)?.params.keeper as number | undefined;
  if (bodies.length === 0 || keeper === undefined || abilityIdsOf(parts.control).length === 0) return parts;
  const dashed = dash === undefined ? parts.rules : guarded(parts.rules, keeper, { dash: dash.params.slot as number });
  const rules = shield === undefined ? dashed : guarded(dashed, keeper, { shield: true });
  const protect = (native: PieceRef): PieceRef => (native.id === dashRule.id || native.id === shieldRule.id ? { ...native, params: { ...native.params, parts: bodies } } : native);
  return { ...parts, rules: rules.map((rule) => mapUnderlying(rule, protect)), bot: botWithParts(parts.bot, bodies) };
}

export const ABILITY_PIECES: Readonly<Record<AbilityId, AbilityPiece>> = {
  shoot: shootAbility,
  strike: strikeAbility,
  grab: grabAbility,
  dash: guardAbility('dash'),
  shield: guardAbility('shield'),
};

export const ABILITY_RULES = { [strikeRule.id]: strikeRule, [grabRule.id]: grabRule, [dashRule.id]: dashRule, [shieldRule.id]: shieldRule, [fightGuardRule.id]: fightGuardRule } as const;

/** Pořadí skládání: kdo přidává nepřátele (střelba, úder, krádež), jde před dashem a štítem, které chrání před jejich nárazy. */
const APPLY_ORDER: readonly AbilityId[] = ['shoot', 'strike', 'grab', 'dash', 'shield'];

/**
 * Aplikuje akce ze `spec.abilities`: tělo-počítadlo za tělesy úrovně, dílky
 * akcí a obal ovládání. Střelba jde první bez ohledu na pořadí tlačítek –
 * přidá nepřátele, které pak úder najde a znovu je nepřidá.
 */
export function applyAbilities(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  const ids = context.spec.abilities ?? [];
  if (ids.length === 0) return parts;
  const keeper = parts.level.bodies.length;
  const hero = parts.level.bodies[0] as BodyInit;
  // Mrtvá předloha jako počítadlo komba: nic ji nekreslí ani nesrazí.
  const counter: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  let next: ArcadeParts = { ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, counter] } };
  for (const id of APPLY_ORDER) if (ids.includes(id)) next = ABILITY_PIECES[id].apply(next, { ...context, keeper, slot: ids.indexOf(id) });
  // Robot akcí (T6) zná role, před kterými dash a štít chrání – stejné jako jejich pravidla.
  const harm = [...new Set(next.rules.flatMap((rule) => (rule.id === dashRule.id || rule.id === shieldRule.id ? (rule.params.roles as (typeof HARMFUL_ROLES)[number][]) : [])))];
  return { ...next, control: wrapControl(next, { abilities: { keeper, ids: [...ids] } }), bot: wrapBot(next, { keeper, ids: [...ids], harm }) };
}
