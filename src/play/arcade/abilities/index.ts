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
import { type AddonContext, type ArcadeParts, baseBotOf, baseControlOf, enemiesFor, enemyOptions, hitParamsFor, wrapBot, wrapControl } from '../addons';
import { ballOpenUntil } from '../pieces/ball';
import { type BossBeatParams, bossBeat, bossBeatHit } from '../pieces/boss';
import { FINALE5_GENRE_VERSION, genreAtLeast } from '../pieces/pacing-parts';
import { type MarchEntry, shooterOpenUntil } from '../pieces/shooter';
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

/** Nepřátelé ovládání a jejich náraz (`hit`); `every` = jen každý tolikátý z nich (štít poletování, P47B T9). */
function addFoes(parts: ArcadeParts, context: AddonContext, every = 1): ArcadeParts {
  const control = baseControlOf(parts.control).id;
  // Řízení akcí nechává cíle jako dřív; běžec ze vzorů jen bez nepřátel ve finále bosse (`finaleFrom`).
  const { finaleFrom } = enemyOptions(context.spec, control);
  const foes = enemiesFor(control, parts.level, { finaleFrom }).filter((_foe, index) => index % every === 0);
  if (foes.length === 0) return { ...parts, issues: [...(parts.issues ?? []), 'abilities: the level has no place for an enemy to strike'] };
  return {
    ...parts,
    level: { ...parts.level, bodies: [...parts.level.bodies, ...foes] },
    rules: [...parts.rules, { id: 'hit', params: hitParamsFor('enemy', context.health) }],
  };
}

/**
 * Míč a střelnice (P52 T7): hrdina stojí na místě, takže štít a krádež mají cíl, jen když k němu sám přiletí – střela
 * soupeře (`hazard`, náraz jako nepřítel) nebo kořist (`collectible`). Letí zepředu po ose hrdiny, první dorazí za `first`
 * tiků, další po `gap` (štít se nabije za 120), nejvýš `most`, a jen dokud hra jistě běží (`ballOpenUntil`,
 * `shooterOpenUntil`) – jinak by sloveso nebylo čím dokázat.
 */
const INCOMING = { first: 90, gap: 180, most: 3, speed: 40, size: 500, y: 600 } as const;
const STANDING: readonly string[] = ['ball', 'shooter'];

function withIncoming(parts: ArcadeParts, context: AddonContext, role: 'hazard' | 'collectible'): ArcadeParts {
  const base = baseControlOf(parts.control);
  const until = base.id === 'ball' ? ballOpenUntil(parts.level) : shooterOpenUntil(parts.level, base.params.march as readonly MarchEntry[] | undefined);
  const { first, gap, most, speed, size, y } = INCOMING;
  const bodies: BodyInit[] = [];
  for (let at = first; at <= until && bodies.length < most; at += gap) {
    bodies.push({ role, kind: role === 'hazard' ? 'sniper_shot' : 'coin', x: 0, y, z: speed * at, w: size, h: size, d: size, solid: false, kinematic: true, vz: -speed });
  }
  if (bodies.length === 0) return { ...parts, issues: [...(parts.issues ?? []), 'abilities: the game ends before anything reaches the hero'] };
  const rules = role === 'hazard' ? [...parts.rules, { id: 'hit', params: hitParamsFor('hazard', context.health) }] : parts.rules;
  return { ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, ...bodies] }, rules };
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
    const armed = STANDING.includes(baseControlOf(parts.control).id) ? withIncoming(parts, context, 'collectible') : loot ? parts : withFoes(parts, context);
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
 * silnice (`abilityStep`), takže by dash ani štít v závodě nikdy nic nezastavil (P47B T5). Let (P47B T9) proletí
 * mezerou trubek a obručí útesu, soupeř a pronásledovatel klouzání jedou vedle či za ním: platí jen role,
 * kterou nese stojící tělo úrovně – pravidlo `hit` klouzání je tam i bez těla.
 */
function metHarm(parts: ArcadeParts): (typeof HARMFUL_ROLES)[number][] {
  const control = baseControlOf(parts.control).id;
  if (control !== 'flap' && control !== 'glide') return harmOf(parts).filter((role) => role !== 'obstacle' || control !== 'steer');
  return harmOf(parts).filter((role) => role !== 'obstacle' && parts.level.bodies.some((body) => body.role === role && body.template !== true && body.kinematic !== true));
}

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
      const control = baseControlOf(start.control).id;
      if (control === 'fight') return fightGuard(start, context, id);
      // Soupeři řízení jsou `enemy` bez nárazu, proto nepřátele přidat i vedle nich (jako `+shoot`); svodidla řízení je nenahradí.
      // Let (P47B T9): nepřítel v každé druhé mezeře trubek (obruči) křižuje dráhu. Nepřátelé poletování jsou ~110 tiků
      // od sebe a štít se nabíjí 120 – dostane jen každého druhého, jinak by na dalšího nebyl nabitý (robot 0/10).
      const parts = STANDING.includes(control) ? withIncoming(start, context, 'hazard') : metHarm(start).length === 0 ? addFoes(start, context, id === 'shield' && control === 'flap' ? 2 : 1) : start;
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

/** Obal akcí (`addon_control`, `addon_bot` z `applyAbilities`) pod obalem složené hry s parametry akcí doplněnými o `extra`. */
function withAbilityParams(ref: PieceRef, extra: object): PieceRef {
  const params = ref.params as { readonly base: PieceRef; readonly abilities: object };
  if (ref.id === 'addon_control' || ref.id === 'addon_bot') return { ...ref, params: { ...ref.params, abilities: { ...params.abilities, ...extra } } };
  return ref.id === 'assembly_control' || ref.id === 'assembly_bot' ? { ...ref, params: { ...ref.params, base: withAbilityParams(params.base, extra) } } : ref;
}

/**
 * Cooldown dashe běžce se složenými díly (P47B T4-R1): 1,5 s místo 1 s. Řady trati jdou 60–100 tiků po sobě
 * (`GAP_TICKS` v `runner.ts`) a dash s cooldownem 60 prorazil každou řadu husté pasáže (~75 tiků) – „a squirrel
 * runs and dodges falling acorns“: novice 8/10 proti 5/10 bez akce. S 90 tiky dvě takové řady po sobě nevezme:
 * novice 6/10, intermediate 10/10. Běžec bez dílů zůstává na 1 s (fixtura P46A novice 1/10 proti 0/10).
 */
const RUNNER_PARTS_DASH_COOLDOWN = 90;

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
  const slow = dash !== undefined && baseControlOf(parts.control).id === 'runner' ? { dashCooldown: RUNNER_PARTS_DASH_COOLDOWN } : undefined;
  return {
    ...parts,
    rules: rules.map((rule) => mapUnderlying(rule, protect)),
    ...(slow === undefined ? {} : { control: withAbilityParams(parts.control, slow) }),
    bot: withAbilityParams(parts.bot, { parts: bodies, ...slow }),
  };
}

export const ABILITY_PIECES: Readonly<Record<AbilityId, AbilityPiece>> = {
  shoot: shootAbility,
  strike: strikeAbility,
  grab: grabAbility,
  dash: guardAbility('dash'),
  shield: guardAbility('shield'),
};

export const ABILITY_RULES = { [strikeRule.id]: strikeRule, [grabRule.id]: grabRule, [dashRule.id]: dashRule, [shieldRule.id]: shieldRule, [fightGuardRule.id]: fightGuardRule } as const;

/**
 * Duel (P47B T8) hraje úder (Tap) a úhyb (Down) vlastní mechanikou: žádné tlačítko ani tělo akcí, jen
 * sloveso – úder na zásahu soupeře (`judge`), dash a štít na úhybu, který vyšel (`duel_dodge`).
 */
function duelVerbs(parts: ArcadeParts, ids: readonly AbilityId[]): ArcadeParts {
  const dodges = ids.filter((id): id is 'dash' | 'shield' => id === 'dash' || id === 'shield');
  const rules = parts.rules.map((rule) => mapUnderlying(rule, (native) => (native.id === 'judge' && ids.includes('strike') ? { ...native, params: { ...native.params, verb: 'strike' } } : native)));
  const control = dodges.length === 0 ? parts.control : withBaseControl(parts.control, (duel) => ({ ...duel, params: { ...duel.params, dodges: true } }));
  return { ...parts, control, rules: [...rules, ...dodges.map((verb) => ({ id: 'duel_dodge', params: { verb } }))] };
}

/**
 * Pronásledovatelé pro úder (P52 T5), jen `genre.v5`: úder (a dash nebo štít) pronásledovatele zničí, takže by hru
 * začátečníkovi vyprázdnil. Zničené proto další vlna doplní (`restock`) a vlny přivedou pronásledovatele navíc:
 * - quest s úderem: druhé kolo jednoho (novice 9/10 proti 6/10 bez úderu, takhle 7/10; semínka 1–20 13/20 proti 11/20);
 * - sběr v aréně s úderem a dashem nebo štítem: každá vlna od první s pronásledovatelem jednoho. Sběr jich jinak za hru
 *   přivede jednoho (`wavesChasers`), takže druhé sloveso by se nedokázalo nikdy (novice s dashem 9/10 proti 4/10
 *   bez akcí, takhle 6/10; semínka 1–20 14/20, se štítem 13/20).
 * Útěk (živý pronásledovatel od startu) zůstane.
 */
function sharedChasers(parts: ArcadeParts, spec: AddonContext['spec'], ids: readonly AbilityId[]): ArcadeParts {
  if (!ids.includes('strike') || !genreAtLeast(spec, FINALE5_GENRE_VERSION)) return parts;
  const live = parts.level.bodies.filter((body) => body.role === 'chaser' && body.template !== true).length;
  const quest = baseBotOf(parts.bot).id === 'quest_bot';
  if (!quest && (live > 0 || !(ids.includes('dash') || ids.includes('shield')))) return parts;
  const bump = (native: PieceRef): PieceRef => {
    if (native.id !== 'arena_waves' || native.params.chaser === undefined) return native;
    const waves = native.params.waves as readonly { readonly chasers?: number }[];
    const first = waves.findIndex((wave) => (wave.chasers ?? 0) > 0);
    const extra = (k: number): boolean => (quest ? k === 0 : first >= 0 && k >= first);
    return { ...native, params: { ...native.params, restock: live, waves: waves.map((wave, k) => (extra(k) ? { ...wave, chasers: (wave.chasers ?? 0) + 1 } : wave)) } };
  };
  return { ...parts, rules: parts.rules.map((rule) => mapUnderlying(rule, bump)) };
}

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
  if (baseControlOf(parts.control).id === 'duel') return duelVerbs(parts, ids);
  const keeper = parts.level.bodies.length;
  const hero = parts.level.bodies[0] as BodyInit;
  // Mrtvá předloha jako počítadlo komba: nic ji nekreslí ani nesrazí.
  const counter: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  let next: ArcadeParts = sharedChasers({ ...parts, level: { ...parts.level, bodies: [...parts.level.bodies, counter] } }, context.spec, ids);
  for (const id of APPLY_ORDER) if (ids.includes(id)) next = ABILITY_PIECES[id].apply(next, { ...context, keeper, slot: ids.indexOf(id) });
  // Robot akcí (T6) zná role, před kterými dash a štít chrání – stejné jako jejich pravidla.
  const harm = [...new Set(next.rules.flatMap((rule) => (rule.id === dashRule.id || rule.id === shieldRule.id ? (rule.params.roles as (typeof HARMFUL_ROLES)[number][]) : [])))];
  return { ...next, control: wrapControl(next, { abilities: { keeper, ids: [...ids] } }), bot: wrapBot(next, { keeper, ids: [...ids], harm }) };
}
