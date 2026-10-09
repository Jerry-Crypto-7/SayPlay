/**
 * Průběh hry ve skládání světa (P45C T10): za `progressionParts` obalí
 * ovládání a robota křivkou napětí (`pacing_control`, `pacing_bot`), přidá
 * předlohy chování a bosse, pravidlo `pacing` a pravidlo `boss_beat` podle
 * tabulky žánrů `GENRE_PACING`.
 *
 * Jen nové hry: spec bez `genre` (hry uložené před žánry, fixtury přehrání),
 * spec žánru uložený před průběhem (`genre.v1`) i generátor bez záznamu
 * v tabulce staví tentýž svět jako dřív.
 */

import { type Phase, phasesFromCurve } from '../../compose/progression';
import type { GameSpecV1 } from '../../spec';
import type { ArcadeParts } from '../addons';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, type BodyInit, type PieceRef, RAMP_STEP_PCT } from '../contract';
import { BEHAVIOURS, type BehaviourId, type BehaviourRef } from './behaviours';
import { type PacingActor, type PacingSetup, TENSION_CURVE, withPacing } from './pacing';
import { progressionParts } from './progression-parts';
import type { WaveParams } from './waves';

/** Co žánr dá průběhu: nastavení `withPacing` bez semínka; boss navíc s věcmi, které nese, a body za pád. */
export interface GenrePacingSetup extends Omit<PacingSetup, 'seed' | 'boss'> {
  readonly boss?: NonNullable<PacingSetup['boss']> & {
    /** Věci úrovně (indexy těl), které boss nese: do jeho pádu jsou jen předlohy, padlý boss vydá jejich kopie. */
    readonly carries?: readonly number[];
    /** Bez `carries`: padlý boss vydá `count` kopií těla `template` (věci, které by jinak přinesla vlna). */
    readonly drop?: { readonly template: number; readonly count: number };
    readonly score?: number;
    /** S příchodem bosse odejdou živá těla té role (pronásledovatelé arény); bez bosse nic. */
    readonly clears?: BodyInit['role'];
  };
  /**
   * Části generátoru pro hru s průběhem (např. poslední vlna bez věcí, které nese
   * boss); `boss` = index předlohy bosse, nebo `undefined`, když ho rozpočet
   * pravidel vzal. Nesmí měnit počet ani pořadí těl úrovně.
   */
  readonly adjust?: (parts: ArcadeParts, boss: number | undefined) => ArcadeParts;
  /** Výchozí fáze (`progressionParts`), když spec nenese vlastní `phases` ani `dependsOn`. */
  readonly phases?: readonly Phase[];
  /** Fáze běží nad prostřední úrovní rampy žánru (+10 %), ne nad její první třetinou: křivka vezme rampě jen růst. */
  readonly rampLevel?: boolean;
}

/** Záznam žánru: z hotových částí a specu nastavení průběhu; `null` = tahle hra průběh nedostane. */
export type GenrePacing = (parts: ArcadeParts, spec: GameSpecV1) => GenrePacingSetup | null;

/** Fáze z křivky; `rows` = finále přidá tolik překážek vedle bezpečné cesty (hustší řady sprintu). */
const curvePhases = (rows: number): Phase[] => phasesFromCurve(TENSION_CURVE).map((phase, index, all) => (rows > 0 && index === all.length - 1 ? { ...phase, add: [{ role: 'obstacle', count: rows }] } : phase));

/**
 * Dráhový žánr (P45C T11): postup = ujetá trať, fáze z křivky a finále
 * závěrečný sprint. Bez chování: robot běžce s nimi na trati s překážkami
 * prohrává (nález pod plánem), ostatní dráhy pruhy nemají.
 */
const track = (rows: number, rampLevel = false): GenrePacing => (parts) => ({
  goal: { by: 'distance', need: parts.level.length, limit: ARCADE_LIMITS.maxTicks },
  space: 'track',
  spots: [0, 0],
  behaviours: [],
  budget: 0,
  finale: 'sprint',
  phases: curvePhases(rows),
  ...(rampLevel ? { rampLevel: true } : {}),
});

/** Nová chování otevřeného pole: z kterých se losuje, kolik jich hra dostane a kolik spawnů rozvrh rozdá. */
interface FieldFoes {
  readonly pool: readonly BehaviourId[];
  readonly pick: number;
  readonly budget: number;
  /** Kolik % zrychlení po vlnách zůstane vedle křivky (`flatten`). */
  readonly step: number;
  /** Nová chování odejdou se začátkem poslední vlny a pak už nepřijdou (přežití, souboj). */
  readonly leave?: boolean;
  /** Rychlost pronásledovatelů křivka neškáluje (`PacingSetup.steady`): vlny si drží své zrychlení. */
  readonly steady?: boolean;
}

/**
 * Otevřené pole (P45C T12): vlny arény a souboje zůstávají, křivka jim dává
 * rychlost (zrychlení po vlnách jen na `step` %) a od druhé vlny nová chování.
 *
 * Výběr chování je změřený robotem (8 semínek, rozpočet 4, odchylka T12):
 * flanker, ostřelovač a hejno shodí robota intermediate v aréně s
 * pronásledovateli na 0–4/8, v souboji na 0–1/8 – zůstaly jen tam, kde je
 * unese. Strážce a přepadník robotovi neublíží, obtížnost dává boss a křivka.
 *
 * Přežití a souboj (odchylka T12, robot bez profilu = brána publikace, 19
 * sestav arény × 20 semínek): chování v poslední vlně (pronásledovatelé na
 * vrcholu, resp. boss) shodila robota v 11/80 her přežití a 3/10 soubojů, proto
 * odejdou s jejím začátkem (`leave`). Přežití navíc bez křivky na rychlosti
 * (`steady`): pomalejší úvod (70 %) dal buňce s jedním životem začátečníka
 * 0,9, rychlejší vrchol (90) prohry robota bez profilu ve 30. s; s vlnami jako
 * dřív sedí na 40 semínkách jako bez průběhu (37 / 33 / 23 ze 40 – bez profilu,
 * intermediate, novice). Souboj s flankerem ve dvou spawnech prohrál 7/180,
 * v jednom 0/180. `difficulty.json` (semínka 1–20, intermediate / novice):
 * přežití 0,9 / 0,5, sběr 1,0 / 0,6, útěk s věcmi 1,0 / 0,55, souboj 0,95 / 0,45.
 */
export const FIELD = {
  collect: { pool: ['guardian', 'ambusher'], pick: 2, budget: 4, step: 0 } as FieldFoes,
  escape: { pool: ['guardian', 'ambusher'], pick: 2, budget: 4, step: 0 } as FieldFoes,
  survival: { pool: ['sniper', 'ambusher'], pick: 1, budget: 2, step: 100, leave: true, steady: true } as FieldFoes,
  fight: { pool: ['ambusher', 'flanker'], pick: 1, budget: 1, step: 0, leave: true } as FieldFoes,
  /**
   * Souboj: ležící soupeři poslední vlny vstanou nejvýš s tolika HP a noví se
   * nepřidají – boss je hlavní soupeř vlny. Se slabšími (1–2 HP) stojí poslední
   * třetina a tlak neroste (stoupá 0–6/8 her). Na 30 semínkách × 6 sestav
   * (bez profilu / buňka intermediate / novice): 4 HP 0/180 proher, 0,93 / 0,6;
   * 6 HP 0/180, 0,9 / 0,43 – a poslední vlna má víc HP k vyřazení než předchozí
   * (3 × 6 + boss 4 > 3 × 6); plné HP 2/180 a novice 0,23.
   */
  lastHp: 6,
  /** Boss nese nejvýš tolik věcí poslední vlny (`boss_beat.drop.count`). */
  carry: 8,
};

const ruleOf = (parts: ArcadeParts, id: string): PieceRef | undefined => parts.rules.find((rule) => rule.id === id);
const withRule = (parts: ArcadeParts, id: string, change: (params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>): ArcadeParts =>
  ({ ...parts, rules: parts.rules.map((rule) => (rule.id === id ? { ...rule, params: change(rule.params) } : rule)) });
const actorsOf = (foes: FieldFoes): PacingActor[] => foes.pool.map((id) => ({ body: BEHAVIOURS[id].body, behaviour: id }));
/** Chování odejdou na `at` ‰ (těla chování a jejich výstřely jsou `hazard`); rozvrh je vysadí jen před `until` ‰. */
const leaving = (foes: FieldFoes, at: number, until = at): Pick<GenrePacingSetup, 'until' | 'clear'> => (foes.leave === true ? { until, clear: [{ role: 'hazard', at }] } : {});

/**
 * Zrychlení po vlnách (`step` pronásledovatelů a soupeřů) jen na `pct` %, nejméně 1:
 * rychlost dává křivka. `step` zůstane – svět s ním je svět vln (odstup pronásledovatelů u hráče).
 */
function flatten(parts: ArcadeParts, pct: number): ArcadeParts {
  if (pct >= 100) return parts;
  const scale = (step: unknown): unknown => (typeof step === 'number' ? Math.max(1, Math.round((step * pct) / 100)) : step);
  const flat = (ref: PieceRef): PieceRef => {
    const chase = ref.params.chase as Readonly<Record<string, unknown>> | undefined;
    if (chase !== undefined) return chase.step === undefined ? ref : { ...ref, params: { ...ref.params, chase: { ...chase, step: scale(chase.step) } } };
    return ref.id === 'fight' && ref.params.step !== undefined ? { ...ref, params: { ...ref.params, step: scale(ref.params.step) } } : ref;
  };
  return { ...parts, control: flat(parts.control), bot: flat(parts.bot) };
}

/** Postup v promile, kde začíná vlna `index` (0 = první) z `count`. */
const waveStart = (index: number, count: number): number => Math.floor((index * 1000) / count);

/**
 * Sběr a útěk s věcmi: postup = sebrané věci (skóre), nová chování od druhé
 * vlny, finále boss se začátkem poslední vlny – nese její věci (nejvýš
 * `carry`), `arena_waves` je pak nepřinese. S bossem pronásledovatelé odejdou
 * a poslední vlna žádné nepřivede: boss spolu s pronásledovatelem robot
 * nepřemohl v žádné z ~15 zkoušených variant robota a bosse (0–1/8, odchylka
 * T12; když zůstanou, 0/20). Únik z nich dokáže svědek i tak (`witness.ts`:
 * lovec odvolaný pravidlem `pacing` je přečkaný). `limit` = hodiny sběru, bez
 * nich horizont.
 */
const itemField = (foes: FieldFoes): GenrePacing => (parts) => {
  const waves = ruleOf(parts, 'arena_waves')?.params as WaveParams | undefined;
  const points = (ruleOf(parts, 'grow_to')?.params as { readonly points: number } | undefined)?.points;
  if (waves === undefined || points === undefined || waves.until !== 'items') return null;
  const count = waves.waves.length + 1;
  const clock = (ruleOf(parts, 'time_limit')?.params as { readonly seconds: number } | undefined)?.seconds;
  const lastItems = waves.waves.at(-1)?.items ?? [];
  const carried = Math.min(FIELD.carry, lastItems.length / 2);
  const boss = carried > 0 && waves.item !== undefined ? { body: BEHAVIOURS.boss.body, at: waveStart(count - 1, count), drop: { template: waves.item, count: carried }, clears: 'chaser' as const } : undefined;
  return {
    goal: { by: 'score', need: points, limit: clock === undefined ? ARCADE_LIMITS.maxTicks : Math.min(ARCADE_LIMITS.maxTicks, clock * ARCADE_HZ) },
    space: 'plane',
    spots: waves.spots,
    behaviours: actorsOf(foes),
    pick: foes.pick,
    budget: foes.budget,
    from: waveStart(1, count),
    finale: boss === undefined ? 'wave' : 'boss',
    ...(boss === undefined ? {} : { boss }),
    adjust: (own, template) => {
      const flat = flatten(own, foes.step);
      if (template === undefined) return flat;
      // Poslední vlna bez věcí, které nese boss (zbytek nad `carry` přinese dál).
      return withRule(flat, 'arena_waves', (params) => {
        const later = (params as WaveParams).waves;
        return { ...params, waves: later.map((wave, index) => {
          if (index < later.length - 1) return wave;
          const { items: _items, ...own } = wave;
          // S bossem nepřiběhnou noví pronásledovatelé – ti dřívější s ním odejdou (`clears`).
          const rest = { ...own, chasers: 0 };
          const kept = lastItems.slice(0, lastItems.length - 2 * carried);
          return kept.length === 0 ? rest : { ...rest, items: kept };
        }) };
      });
    },
  };
};

/** Přežití: postup = čas, nová chování od druhé vlny, finále = poslední vlna ve vrcholu křivky. */
const survivalField = (foes: FieldFoes): GenrePacing => (parts) => {
  const waves = ruleOf(parts, 'arena_waves')?.params as WaveParams | undefined;
  const seconds = (ruleOf(parts, 'survive_time')?.params as { readonly seconds: number } | undefined)?.seconds;
  if (waves === undefined || seconds === undefined || waves.until !== 'ticks') return null;
  const ticks = Math.min(ARCADE_LIMITS.maxTicks, seconds * ARCADE_HZ);
  const count = waves.waves.length + 1;
  return {
    goal: { by: 'time', need: ticks, limit: ticks },
    space: 'plane',
    spots: waves.spots,
    behaviours: actorsOf(foes),
    pick: foes.pick,
    budget: foes.budget,
    from: waveStart(1, count),
    ...leaving(foes, waveStart(count - 1, count)),
    finale: 'wave',
    ...(foes.steady === true ? { steady: true } : {}),
    adjust: (own) => flatten(own, foes.step),
  };
};

/**
 * Souboj: postup = vlny, nová chování od druhé, poslední vlna je boss – přijde
 * s ní, ležící soupeři vstanou slabí (`lastHp`) a `fight_end` čeká na jeho pád.
 */
const fightField = (foes: FieldFoes): GenrePacing => (parts) => {
  const waves = ruleOf(parts, 'arena_waves')?.params as WaveParams | undefined;
  if (waves === undefined || waves.until !== 'enemies' || ruleOf(parts, 'fight_end') === undefined) return null;
  const count = waves.waves.length + 1;
  // Postup po vlnách skáče na jejich začátky: spawn před začátkem předposlední vlny přijde nejpozději s ní,
  // pozdější by přišel až s bossem – s odchodem chování (`leave`) tedy jen do ní, a bez ní (dvě vlny) žádný.
  const until = foes.leave === true ? waveStart(count - 2, count) + 1 : 1000;
  const from = waveStart(1, count);
  const room = until > from;
  return {
    goal: { by: 'wave', need: count, limit: ARCADE_LIMITS.maxTicks },
    space: 'plane',
    spots: waves.spots,
    behaviours: room ? actorsOf(foes) : [],
    pick: foes.pick,
    budget: room ? foes.budget : 0,
    from,
    ...leaving(foes, waveStart(count - 1, count), until),
    finale: 'boss',
    boss: { body: BEHAVIOURS.boss.body, at: waveStart(count - 1, count) },
    adjust: (own, template) => {
      const flat = flatten(own, foes.step);
      if (template === undefined) return flat;
      const gated = withRule(flat, 'fight_end', (params) => ({ ...params, boss: template }));
      return withRule(gated, 'arena_waves', (params) => {
        const later = (params as WaveParams).waves;
        return { ...params, waves: later.map((wave, index) => (index < later.length - 1 ? wave : { ...wave, enemies: 0, hp: Math.min(FIELD.lastHp, wave.hp ?? FIELD.lastHp) })) };
      });
    },
  };
};

/**
 * Hra otevřeného pole, jejíž tvar průběh neunese, ho nedostane (odchylka T12):
 * - pravidla či věci specu (`rules`, `things`, např. „touch lava“): plánovač cílů i obcházení prohry
 *   (`rules/bot.ts`) hrají jen svět, jehož ovládání je přímo `move_free` (pod `pacing_control` robot do
 *   lávy vlezl na semínkách 1–6), a role věcí (`roleCodes`) se přikloní k tělům chování (`hazard`) – láva
 *   se nepostaví. Obojí je mimo P45C (`rules/**`);
 * - složená hra (díly P42, `assemblyParts`): pronásledovatel či překážka dílu u bosse, který nese poslední
 *   věci, robota shodili (aréna + díl `chaser` semínka 1–3 prohrál) – jako boss s pronásledovatelem.
 */
const ownShape = (spec: GameSpecV1): boolean => (spec.rules?.length ?? 0) > 0 || (spec.things?.length ?? 0) > 0 || spec.assemblyParts !== undefined;

/**
 * Souboj s nejvýš dvěma životy a sběr s jediným průběh nedostanou (vzor závodu s jedinou havárií, T11):
 * boss poslední vlny se vstávajícími soupeři, resp. s věcmi, sebere poslední život – robot bez profilu
 * na 20 semínkách vyhrál souboj s jedním životem 4–14/20 (bez průběhu 18–20/20), se dvěma a třemi
 * soupeři 18/20 (bez průběhu 20/20), sběr s jedním životem 17/20 (bez průběhu 20/20). Útěk a přežití
 * s jedním životem průběh unesou líp než bez něj (16 proti 4, 4 proti 2 z 20).
 */
const livesAtMost = (spec: GameSpecV1, most: number): boolean => {
  const lives = (spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max?: number } | undefined)?.max;
  return lives !== undefined && lives <= most;
};

/**
 * Průběh podle generátoru světa (`generatorOf`); žánry plní T11–T14. Generátor bez záznamu hraje beze změny.
 * Plošinovka zatím ne (robot nezná rychlost běhu); `steer_track` a `glide_course` staví jen spec bez `genre`,
 * stejně jako `arena` (agar ze slovního návrhu bez žánru) a `arena_catch` (`compose/catch.ts` – spec bez `genre`):
 * žánr Aréna staví jen `arena_collect`, `arena_escape` a `fight` (`genre/arena.ts`).
 */
export const GENRE_PACING: Partial<Record<string, GenrePacing>> = {
  // Běžec bez řad navíc: obecné umístění (`progressionParts`) nezná volný pruh řady a zavřelo by ho – útěk s jedním životem vyhrál 2/8.
  // Nad úrovní rampy: se stupňováním na 100 % základu měl začátečník víc času sestřelit nepřítele v pruhu (se střelbou 0,61 → 0,81 výher
  // na 80 semínkách); nad prostřední třetinou drží běžec svou dřívější obtížnost (0,59 / 0,58 / útěk 0,35 jako bez průběhu).
  // Složená hra (díly P42) ne: robot dílu `catch` uhne do pruhu padající kořisti jen při základní rychlosti (`assembly-parts` run/1 při 110 % nevyhrál).
  runner_track: (parts, spec) => track(0, spec.assemblyParts === undefined)(parts, spec),
  // Poletování bez úrovně rampy: rychlejší let mu obtížnost nepřidá (sběr 0,7 → 0,9).
  flap_track: track(0),
  // Závod do prvního nárazu (`crashBudget` 1) si nechá rampu – odchylka P45C T11: vrchol křivky 115 % jede pod vrcholem rampy 120 %
  // a rychlejší finále bez natažení zatáček kontrola neunese; začátečník pak vyhrál 0,79 (80 semínek) proti 0,63 bez průběhu.
  voyage_race: (parts, spec) => (parts.health === 1 ? null : track(3)(parts, spec)),
  arena_collect: (parts, spec) => (ownShape(spec) || livesAtMost(spec, 1) ? null : itemField(FIELD.collect)(parts, spec)),
  arena_escape: (parts, spec) => (ownShape(spec) ? null : (ruleOf(parts, 'survive_time') === undefined ? itemField(FIELD.escape) : survivalField(FIELD.survival))(parts, spec)),
  fight: (parts, spec) => (ownShape(spec) || livesAtMost(spec, 2) ? null : fightField(FIELD.fight)(parts, spec)),
};

/** Verze překladu žánru před průběhem (`GENRE_COMPILER_VERSION` v `genre/contract.ts`): uložené hry s ní průběh nedostanou. */
export const UNPACED_GENRE_VERSION = 'genre.v1';

/** Nejvýš tolik pravidel ze stropu jádra si průběh vezme: `pacing` a `boss_beat`. */
export const PACING_RULES = 2;

/**
 * Pravidla, která hra dostane i bez průběhu, v pořadí `arcadeWorldOf`: části,
 * doplňky, díly skládání, pravidla specu, časovač s prohrou, skóre.
 * simplified: každý doplněk se počítá za jedno pravidlo, i když žádné nepřidá; přesně to ví až `applyAddons`.
 */
function rulesBesides(parts: ArcadeParts, spec: GameSpecV1): number {
  const timer = spec.mechanics.some((mechanic) => mechanic.id === 'timer' && (mechanic.params as { readonly onEnd?: string }).onEnd === 'lose') ? 1 : 0;
  const assembly = spec.assemblyParts === undefined ? 0 : spec.assemblyParts.length + 1;
  return parts.rules.length + (spec.addons?.length ?? 0) + assembly + (spec.rules?.length ?? 0) + timer + (spec.scoring === undefined ? 0 : 1);
}

/**
 * Části hry s průběhem. Rozpočet pravidel: když by `pacing` a `boss_beat`
 * se vším ostatním přetekly strop jádra, ustoupí nejdřív boss, pak chování;
 * křivka (`pacing_control`) zůstane vždy – hra kvůli průběhu nikdy neselže.
 */
export function pacingParts(parts: ArcadeParts, spec: GameSpecV1, seed: number, generator: string): ArcadeParts {
  const unpaced = spec.genre === undefined || spec.genre.compilerVersion === UNPACED_GENRE_VERSION;
  const entry = unpaced || (parts.issues?.length ?? 0) > 0 ? undefined : GENRE_PACING[generator];
  let setup = entry?.(parts, spec) ?? null;
  if (setup === null || entry === undefined) return parts;
  // Výchozí fáze jen tam, kde je spec nenese; záznam se pak přečte znovu nad nataženou tratí.
  // Fáze, které úroveň neunese (`issues`), odpadnou – hra kvůli průběhu nikdy neselže.
  if (setup.phases !== undefined && spec.phases === undefined && spec.dependsOn === undefined) {
    // Křivka nahradí rampu žánru (+10 % za třetinu): obojí naráz by finále hnalo na 150 % a útěk před pronásledovatelem prohrával.
    // `rampLevel`: z rampy zůstane jedna značka na startu (druhá leží za cílem a nepřejede se) – 100 % křivky = prostřední třetina.
    const ramp = parts.control.params.ramp;
    const marks = Array.isArray(ramp) ? ramp.length : 0;
    const kept = setup.rampLevel === true && marks > 0 ? 1 : 0;
    const flat = (ref: PieceRef): PieceRef => {
      const { ramp: _ramp, ...params } = ref.params;
      return { ...ref, params: kept === 1 && _ramp !== undefined ? { ...params, ramp: [0, 2 * parts.level.length] } : params };
    };
    // Trať rampy je postavená na její vrchol (+10 % za značku): natáhne se jen o to, co fáze přesáhnou nad něj, jinak hra ztratí třetinu tempa.
    const builtFor = ((100 + RAMP_STEP_PCT * marks) * 100) / (100 + RAMP_STEP_PCT * kept);
    const phased = progressionParts({ ...parts, control: flat(parts.control), bot: flat(parts.bot) }, { ...spec, phases: [...setup.phases] }, builtFor);
    if ((phased.issues?.length ?? 0) === 0) {
      parts = phased;
      setup = entry(parts, spec) ?? setup;
    }
  }
  const room = ARCADE_LIMITS.maxRules - rulesBesides(parts, spec);
  const boss = room >= PACING_RULES ? setup.boss : undefined;
  const moving = room >= 1;
  const finale = !moving || (setup.finale === 'boss' && boss === undefined) ? undefined : setup.finale;
  const carried = boss?.carries ?? [];
  // Boss je předloha hned za vybranými chováními (`withPacing`).
  const bossTemplate = boss === undefined ? undefined : parts.level.bodies.length + Math.min(setup.pick ?? setup.behaviours.length, setup.behaviours.length);
  const adjusted = setup.adjust?.(parts, bossTemplate) ?? parts;
  // Úklid role s bossem jen, když boss zůstal; odchod chování jen, když chování jsou.
  const clear = [...(boss?.clears === undefined ? [] : [{ role: boss.clears, at: boss.at }]), ...(moving ? (setup.clear ?? []) : [])];
  const level = carried.length === 0 ? adjusted.level : { ...adjusted.level, bodies: adjusted.level.bodies.map((body, index) => (carried.includes(index) ? { ...body, template: true } : body)) };
  const paced = withPacing({ ...adjusted, level }, {
    seed, goal: setup.goal, space: setup.space, spots: setup.spots,
    behaviours: moving ? setup.behaviours : [], budget: moving ? setup.budget : 0,
    ...(moving && setup.pick !== undefined ? { pick: setup.pick } : {}),
    ...(setup.from === undefined ? {} : { from: setup.from }),
    ...(setup.until === undefined ? {} : { until: setup.until }),
    ...(finale === undefined ? {} : { finale }),
    ...(boss === undefined ? {} : { boss: { body: boss.body, at: boss.at } }),
    ...(clear.length === 0 ? {} : { clear }),
    ...(setup.steady === true ? { steady: true } : {}),
  });
  if (boss === undefined || bossTemplate === undefined || (paced.issues?.length ?? 0) > 0) return paced;
  const dropped = carried.length > 0 ? { template: carried[0] as number, count: carried.length } : boss.drop;
  const beat: PieceRef = { id: 'boss_beat', params: { boss: bossTemplate, ...(dropped === undefined ? {} : { drop: dropped }), ...(boss.score === undefined ? {} : { score: boss.score }) } };
  return { ...paced, level: { ...paced.level, spawnSlots: (paced.level.spawnSlots ?? 0) + (dropped?.count ?? 0) }, rules: [...paced.rules, beat] };
}

/** `pacing_control` pod obaly doplňků a skládání, nebo `null`. */
function pacedControl(control: PieceRef): PieceRef | null {
  if (control.id === 'pacing_control') return control;
  const base = control.params.base as PieceRef | undefined;
  return typeof base === 'object' && base !== null && typeof base.id === 'string' ? pacedControl(base) : null;
}

/** Co sondovat (`verifyArcade`): první tělo (předloha) každého chování a bosse ve světě. */
export function pacingProbeBodies(world: ArcadeWorld): { readonly body: number; readonly behaviour: BehaviourId }[] {
  const refs = (pacedControl(world.control)?.params.behaviours ?? []) as readonly BehaviourRef[];
  const seen = new Set<BehaviourId>();
  return refs.flatMap((ref) => (seen.has(ref.id) ? [] : (seen.add(ref.id), [{ body: ref.template, behaviour: ref.id }])));
}
