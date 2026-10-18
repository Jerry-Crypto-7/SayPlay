/**
 * Souboj zblízka (P25H, T4): ovládání, vzorec soupeře a generátor.
 *
 * Soupeř útočí ve vzorci ze semínka, který se opakuje dokola: nápřah
 * (`windup` tiků – okno na úhyb), úder, pak mezera (`recover` tiků – okno
 * na úder hráče). Hráč: ťuk = úder, dolů/držení = úhyb.
 *
 * - Úder v mezeře zasáhne (jednou za mezeru): soupeř ztratí život, hráč bod.
 * - Úder mimo mezeru soupeř vykryje a hráč se zapotácí: `stagger` tiků
 *   nemůže uhnout (mačkat úder pořád se nevyplatí).
 * - Úhyb trvá `dodge` tiků, pak `cooldown` tiků nejde znovu (držet úhyb
 *   pořád taky ne). Úder soupeře, který hráče nezastihne v úhybu, bere život.
 *
 * **Hratelné z konstrukce:** nápřah i mezera jsou delší než reakce robota
 * (8 tiků) s rezervou a útok + mezera stačí na úhyb i jeho zotavení.
 * `checkDuelPattern` to samé přepočítá nad hotovým vzorcem.
 *
 * Stav: soupeř (tělo 1) má fázi v `aux0` (`DUEL_PHASE`) a zbylé tiky fáze
 * v `aux1`; hráč má výsledek tiku v `aux0` (pro `judge`) a časovač úhybu
 * v `aux1` (> 0 uhýbá, < 0 zotavení nebo potácení). Zásahy soupeře jsou `z`
 * hráče v metrech, životy soupeře a pořadí útoku jsou čítače `DUEL_COUNTER`. Šampion (`champion`,
 * P47A T6) má navíc HP těla, které ubírají efekty `hit` pravidla `judge`; po knockoutu leží s HP 0.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeLevel, type ArcadeState, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, HEADER, type RulePiece, UNIT, bodyBase, bodyHp, setBodyHp } from '../contract';
import { judgeRules } from './timing';

export const DUEL_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type DuelDifficulty = (typeof DUEL_DIFFICULTIES)[number];

export const DUEL = {
  /** Náběh před prvním útokem (1,5 s). */
  lead: 90,
  dodge: 20,
  cooldown: 12,
  stagger: 24,
  /** Reakce robota; nápřah i mezera musí být delší s rezervou. */
  reaction: 8,
  /** Kolik tiků navíc nad reakci chce kontrola u nápřahu a u mezery. */
  margin: 2,
  playerH: 1800,
  crouchH: 1000,
  /** Výchozí životy hráče, když spec žádné neurčí. */
  lives: 3,
  gap: 2200,
  /** Soupeřů za sebou nejvýš (žánr Souboj, P36A T11). */
  maxRounds: 10,
  /** O kolik tiků každý další soupeř zkrátí nápřah i mezeru. */
  rise: 3,
  /** Kratší nápřah a mezeru zrychlení neudělá: obojí nad reakcí robota a mezera + nápřah stačí na úhyb i zotavení. */
  minWindup: 18,
  minRecover: 17,
} as const;

/**
 * Rozzuření posledního soupeře pod polovinou jeho HP (finále průběhu P45C T13):
 * nápřah – varování – o `warn` tiků delší, mezera po úderu o `faster` kratší
 * (soupeř se rychleji vzpamatuje a útočí znovu), nikdy pod `minRecover`.
 * Rozzuření bez delšího varování by soupeře udělalo jen nefér. Změřeno (souboj z věty, 20 semínek,
 * agresivita nejvýš 1200): začátečník vyhrál s `faster` 0 / 3 / 4 / 5 / 6 18 / 15 / 10 / 0 / 0 her –
 * kratší mezera mu bere úder (reakce 20 tiků), delší nápřah mu úhyb nechá.
 */
export const DUEL_ENRAGE = { warn: 12, faster: 4 } as const;

/** Fáze soupeře v `aux0`; `hurl` = hozená věc letí k hráči (jen s `hurl`, P51 T6). */
export const DUEL_PHASE = { ready: 0, windup: 1, open: 2, struck: 3, hurl: 4 } as const;

/**
 * Hozená věc (P51 T6, jen nová hra `genre.v5`, parametr `hurl`): každý `every`-tý útok vzorce soupeř místo úderu
 * hodí věc. Celý nápřah ji drží v ruce nad hlavou (`hand`) – tím hráč pozná, že úder nepřijde; po švihu letí
 * `flight` tiků k hráči (`reach`) a zasáhne, až doletí: kdo v tu chvíli neuhýbá, přijde o život. Úhyb trvá
 * `DUEL.dodge` tiků, takže úhyb na švih ruky (jako před úderem) vyprší dřív, než věc doletí – uhnout se musí, až
 * je věc u hráče. Po zásahu běží mezera útoku jako po úderu, takže hratelnost z konstrukce (`checkDuelPattern`)
 * platí beze změny: hod jen posune zásah o `flight` tiků. Tělo věci je předloha za tělesy úrovně (role hrozby,
 * nic ji nesrazí); ovládání ji samo oživí v ruce, posouvá a po zásahu shodí.
 */
export const DUEL_HURL = {
  every: 3,
  flight: 30,
  body: { role: 'hazard', kind: 'ball', x: 0, y: 0, z: 0, w: 400, h: 400, d: 400, solid: false } as BodyInit,
  /** Spodní hrana a hloubka věci v ruce (nad hlavou soupeře, za ním) a u hráče (nad skrčeným hráčem, před ním). */
  hand: { y: 1800, z: 2400 },
  reach: { y: 1100, z: 400 },
} as const;
/**
 * Sloty čítačů: životy soupeře, pořadí útoku a úhyb, který v tomto tiku vyšel (P47B T8, jen s `dodges`;
 * slot sběru – duel nic nesbírá a HUD ho ukáže jen hře s cílem sběru).
 */
export const DUEL_COUNTER = { foeHealth: 2, attack: 3, dodged: 5 } as const;
/** Index soupeře. */
export const DUEL_FOE = 1;

const attack = z.object({ windup: z.int().min(0).max(ARCADE_HZ * 5), recover: z.int().min(0).max(ARCADE_HZ * 5) }).strict();
export type DuelAttack = z.infer<typeof attack>;

const controlParams = z
  .object({
    pattern: z.array(attack).min(1).max(8),
    foeHealth: z.int().min(1).max(20),
    /** Soupeřů za sebou, každý s `foeHealth` životy (žánr Souboj, P36A T11); bez toho jeden. */
    rounds: z.int().min(1).max(DUEL.maxRounds).optional(),
    /** O kolik tiků další soupeř zkrátí nápřah i mezeru (nejvýš na `minWindup` / `minRecover`). */
    rise: z.int().min(0).max(10).optional(),
    /**
     * Agresivita soupeře v promile (průběh P45C T13 ji škáluje intenzitou): nápřah i mezera
     * × 1000 / `pace`, ne pod mez. Bez hodnoty vzorec beze změny.
     */
    pace: z.int().min(100).max(5000).optional(),
    /** Rozzuření posledního soupeře pod polovinou HP (`DUEL_ENRAGE`); bez hodnoty žádné. */
    enrage: z.object({ warn: z.int().min(1).max(ARCADE_HZ), faster: z.int().min(0).max(ARCADE_HZ) }).strict().optional(),
    /**
     * Šampion (finále P47A T6, jen průběh `genre.v4`): index předlohy těla bosse. Když padne předposlední
     * soupeř, tělo soupeře převezme její model a rozměry a dostane HP = `foeHealth`; zásahy mu ubírá
     * `judge` (`champion`). Bez hodnoty tělo soupeře HP nemá.
     */
    champion: z.object({ body: z.int().min(DUEL_FOE + 1).max(ARCADE_LIMITS.maxBodies - 1) }).strict().optional(),
    /** Úhyb jako sloveso věty (P47B T8): úder, kterému hráč uhnul, zapíše `DUEL_COUNTER.dodged`. Bez hodnoty nic. */
    dodges: z.literal(true).optional(),
    /** Hozená věc (P51 T6, `DUEL_HURL`): index předlohy jejího těla, každý kolikátý útok a tiky letu. Bez hodnoty jen údery. */
    hurl: z.object({ body: z.int().min(DUEL_FOE + 1).max(ARCADE_LIMITS.maxBodies - 1), every: z.int().min(2).max(8), flight: z.int().min(DUEL.dodge + 1).max(ARCADE_HZ) }).strict().optional(),
  })
  .strict();
export type DuelControlParams = z.infer<typeof controlParams>;

const S = BODY;

/** Hází soupeř v útoku pořadí `attack` (od 0) věc? Každý `every`-tý, první až `every`-tý. */
export const hurlsAt = (hurl: DuelControlParams['hurl'], attack: number): boolean => hurl !== undefined && attack % hurl.every === hurl.every - 1;

/** Věc v ruce soupeře: tělo předlohy ožije nad jeho hlavou. */
function holdHurl(state: ArcadeState, body: number): void {
  const at = bodyBase(body);
  state[at + S.x] = 0;
  state[at + S.y] = DUEL_HURL.hand.y;
  state[at + S.z] = DUEL_HURL.hand.z;
  state[at + S.flags] = (state[at + S.flags] as number) | FLAG.alive;
}

/** Věc v letu, `left` tiků do zásahu: z ruky k hráči rovnoměrně po přímce. */
function flyHurl(state: ArcadeState, body: number, flight: number, left: number): void {
  const at = bodyBase(body);
  const done = flight - left;
  state[at + S.y] = DUEL_HURL.hand.y + Math.trunc(((DUEL_HURL.reach.y - DUEL_HURL.hand.y) * done) / flight);
  state[at + S.z] = DUEL_HURL.hand.z + Math.trunc(((DUEL_HURL.reach.z - DUEL_HURL.hand.z) * done) / flight);
}

/** Tělo soupeře se stane šampionem: model a rozměry předlohy, HP `hp`. Jednou – korunovaný šampion HP má. */
function crown(state: ArcadeState, template: number, hp: number): void {
  if (bodyHp(state, DUEL_FOE) > 0) return;
  const foe = bodyBase(DUEL_FOE);
  const from = bodyBase(template);
  for (const slot of [S.kind, S.w, S.h, S.d]) state[foe + slot] = state[from + slot] as number;
  setBodyHp(state, DUEL_FOE, hp);
}

const dodgeParams = z.object({ verb: z.enum(['dash', 'shield']) }).strict();

/** Úhyb, který v tomto tiku vyšel (`dodges`), je dash nebo štít věty (P47B T8): bod a sloveso pro důkaz. */
export const duelDodgeRule: RulePiece<z.infer<typeof dodgeParams>> = {
  id: 'duel_dodge',
  params: dodgeParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => ((state[HEADER.counters + DUEL_COUNTER.dodged] as number) === 1 ? [{ kind: 'score', amount: 1 }] : []),
};

/** Útok vzorce u soupeře `round` (od 0): o `rise` tiků za soupeře kratší, ne pod mez – co už pod ní je, zůstane. */
export function duelAttackAt(move: DuelAttack, round: number, rise: number): DuelAttack {
  const shorter = (ticks: number, floor: number): number => Math.max(Math.min(ticks, floor), ticks - round * rise);
  return { windup: shorter(move.windup, DUEL.minWindup), recover: shorter(move.recover, DUEL.minRecover) };
}

/** Útok s agresivitou `pace` (promile): delší pod 1000, kratší nad, ne pod mez – co už pod ní je, zůstane. */
export function pacedAttack(move: DuelAttack, pace: number): DuelAttack {
  const scaled = (ticks: number, floor: number): number => Math.max(Math.min(ticks, floor), Math.floor((ticks * 1000) / pace));
  return { windup: scaled(move.windup, DUEL.minWindup), recover: scaled(move.recover, DUEL.minRecover) };
}

/** Rozzuřený útok: delší nápřah (varování), kratší mezera, ne pod `minRecover`. */
export const enragedAttack = (move: DuelAttack, enrage: { readonly warn: number; readonly faster: number }): DuelAttack =>
  ({ windup: move.windup + enrage.warn, recover: Math.max(Math.min(move.recover, DUEL.minRecover), move.recover - enrage.faster) });

/** Rozzuřený je poslední soupeř, kterému po `hits` zásazích zbývá méně než polovina HP. */
export function enragedAfter(hits: number, params: DuelControlParams): boolean {
  if (params.enrage === undefined) return false;
  const rounds = params.rounds ?? 1;
  const left = params.foeHealth * rounds - hits;
  return hits >= params.foeHealth * (rounds - 1) && left > 0 && left * 2 < params.foeHealth;
}

export const duelControl: ControlPiece<DuelControlParams> = {
  id: 'duel',
  params: controlParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 2, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    const foe = bodyBase(DUEL_FOE);
    state[p + S.aux0] = 0;
    if (params.dodges) state[HEADER.counters + DUEL_COUNTER.dodged] = 0;

    // Časovač úhybu: uhýbání dojde do zotavení, zotavení a potácení dojdou k nule.
    let timer = state[p + S.aux1] as number;
    if (timer > 0) timer = timer === 1 ? -DUEL.cooldown : timer - 1;
    else if (timer < 0) timer += 1;
    if ((input.buttons & (BUTTON.DOWN | BUTTON.HOLD)) !== 0 && timer === 0) timer = DUEL.dodge;

    let phase = state[foe + S.aux0] as number;
    let left = state[foe + S.aux1] as number;
    if ((input.buttons & BUTTON.TAP) !== 0) {
      if (phase === DUEL_PHASE.open) {
        state[p + S.aux0] = 1;
        state[p + S.z] = (state[p + S.z] as number) + UNIT;
        phase = DUEL_PHASE.struck;
      } else if (phase !== DUEL_PHASE.struck) timer = -DUEL.stagger;
    }

    const hits = Math.floor((state[p + S.z] as number) / UNIT);
    // Předposlední soupeř padl (i tímhle úderem): nastupuje šampion. Úder, který ho porazil, šampiona nezasáhne (`judge`).
    if (params.champion !== undefined && hits === params.foeHealth * ((params.rounds ?? 1) - 1)) crown(state, params.champion.body, params.foeHealth);
    // Soupeř, se kterým se teď bojuje (od 0): každý další útočí rychleji.
    const round = Math.floor(hits / params.foeHealth);
    const enraged = enragedAfter(hits, params);
    const moveAt = (index: number): DuelAttack => {
      const move = duelAttackAt(params.pattern[index] as DuelAttack, round, params.rise ?? 0);
      const paced = params.pace === undefined ? move : pacedAttack(move, params.pace);
      return enraged && params.enrage !== undefined ? enragedAttack(paced, params.enrage) : paced;
    };
    if ((state[HEADER.tick] as number) >= DUEL.lead) {
      if (left > 0) left -= 1;
      const { hurl } = params;
      if (phase === DUEL_PHASE.hurl && hurl !== undefined) flyHurl(state, hurl.body, hurl.flight, left);
      if (left === 0) {
        const attack = state[HEADER.counters + DUEL_COUNTER.attack] as number;
        if (phase === DUEL_PHASE.windup && hurl !== undefined && hurlsAt(hurl, attack)) {
          // Švih s věcí v ruce: věc vyletí, zásah přijde, až doletí.
          phase = DUEL_PHASE.hurl;
          left = hurl.flight;
        } else if (phase === DUEL_PHASE.windup || phase === DUEL_PHASE.hurl) {
          // Úder (nebo doletěla věc): kdo zrovna neuhýbá, přijde o život.
          if (timer <= 0) state[p + S.aux0] = -1;
          else if (params.dodges) state[HEADER.counters + DUEL_COUNTER.dodged] = 1;
          if (phase === DUEL_PHASE.hurl && hurl !== undefined) state[bodyBase(hurl.body) + S.flags] = (state[bodyBase(hurl.body) + S.flags] as number) & ~FLAG.alive;
          const index = attack % params.pattern.length;
          phase = DUEL_PHASE.open;
          left = moveAt(index).recover;
          state[HEADER.counters + DUEL_COUNTER.attack] = attack + 1;
        }
        // Mezera (nebo start) skončila: další nápřah. Mezera 0 = nápřah hned po úderu.
        if (left === 0) {
          const next = state[HEADER.counters + DUEL_COUNTER.attack] as number;
          phase = DUEL_PHASE.windup;
          left = Math.max(1, moveAt(next % params.pattern.length).windup);
          if (hurl !== undefined && hurlsAt(hurl, next)) holdHurl(state, hurl.body);
        }
      }
    }

    state[foe + S.aux0] = phase;
    state[foe + S.aux1] = left;
    state[p + S.aux1] = timer;
    state[p + S.h] = timer > 0 ? DUEL.crouchH : DUEL.playerH;
    // Životy soupeře, se kterým se bojuje; s jedním soupeřem prostě zbylé zásahy.
    const remaining = params.foeHealth * (params.rounds ?? 1) - hits;
    state[HEADER.counters + DUEL_COUNTER.foeHealth] = remaining <= 0 ? 0 : ((remaining - 1) % params.foeHealth) + 1;
  },
};

// ---------------------------------------------------------------------------
// Generátor a vzorec

interface Tier {
  readonly windup: readonly [number, number];
  readonly recover: readonly [number, number];
  readonly foeHealth: number;
}

const TIERS: Readonly<Record<DuelDifficulty, Tier>> = {
  easy: { windup: [40, 50], recover: [36, 44], foeHealth: 4 },
  normal: { windup: [28, 38], recover: [24, 32], foeHealth: 5 },
  hard: { windup: [18, 26], recover: [16, 22], foeHealth: 6 },
};

const generatorParams = z
  .object({
    difficulty: z.enum(DUEL_DIFFICULTIES).default('normal'),
    /** Actual ticks removed from each successive opponent's windows. */
    roundRise: z.int().min(1).max(3).optional(),
    /** Žánr Souboj (P36A T11): soupeřů za sebou, každý rychlejší o `DUEL.rise`; bez toho jeden soupeř. */
    rounds: z.int().min(1).max(DUEL.maxRounds).optional(),
  })
  .strict();
export type DuelLevelParams = z.infer<typeof generatorParams>;

/** Vzorec čtyř útoků ze semínka; za běhu se jen opakuje, žádná náhoda. */
export function duelPattern(seed: number, params: DuelLevelParams): DuelAttack[] {
  const rng = createCompileRng(seed);
  const tier = TIERS[params.difficulty];
  return Array.from({ length: 4 }, () => ({ windup: rng.int(tier.windup[0], tier.windup[1]), recover: rng.int(tier.recover[0], tier.recover[1]) }));
}

export const duelArena: GeneratorPiece<DuelLevelParams> = {
  id: 'duel_arena',
  params: generatorParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 2, rules: 2 }),
  generate: (_seed, params) => {
    const bodies: BodyInit[] = [
      { role: 'player', kind: 'fighter', x: 0, y: 0, z: 0, w: 800, h: DUEL.playerH, d: 600, solid: false },
      { role: 'enemy', kind: 'foe', x: 0, y: 0, z: DUEL.gap, w: 800, h: DUEL.playerH, d: 600, solid: false },
    ];
    return { bodies, length: TIERS[params.difficulty].foeHealth * (params.rounds ?? 1) * UNIT };
  },
};

/**
 * Tvrzení „hratelné z konstrukce“ nad vzorcem; prázdné pole = hratelný. Se
 * zrychlením platí i pro posledního soupeře – tam jsou nápřah i mezera nejkratší.
 */
export function checkDuelPattern(base: readonly DuelAttack[], last = 0, rise = 0): string[] {
  const issues: string[] = [];
  const need = DUEL.reaction + DUEL.margin;
  const pattern = base.map((move) => duelAttackAt(move, last, rise));
  pattern.forEach((move, index) => {
    const next = pattern[(index + 1) % pattern.length] as DuelAttack;
    if (move.windup <= need) issues.push(`attack ${index + 1} winds up for ${move.windup} ticks – a dodge needs more than ${need}`);
    if (move.recover <= need) issues.push(`attack ${index + 1} leaves ${move.recover} ticks between attacks – a strike needs more than ${need}`);
    // Po úhybu musí úhyb i zotavení doběhnout dřív, než přijde další úder.
    if (move.recover + next.windup < DUEL.dodge + DUEL.cooldown + DUEL.margin) issues.push(`attack ${index + 2 > pattern.length ? 1 : index + 2} comes ${move.recover + next.windup} ticks after the last – too soon to dodge again`);
  });
  return issues;
}

/** Díly světa pro kompilátor. Souboj bez životů nejde: bez mechaniky `health` má hráč tři. */
export function duelParts(seed: number, raw: Readonly<Record<string, unknown>>, health: number | undefined) {
  const params = duelArena.params.parse(raw);
  const level: ArcadeLevel = duelArena.generate(seed, params);
  const pattern = duelPattern(seed, params);
  const foeHealth = TIERS[params.difficulty].foeHealth;
  const lives = health ?? DUEL.lives;
  const rounds = params.rounds ?? 1;
  const ramp = params.rounds === undefined ? {} : { rounds, rise: params.roundRise ?? DUEL.rise };
  return {
    control: { id: 'duel', params: { pattern, foeHealth, ...ramp } },
    bot: { id: 'duel_bot', params: {} },
    level,
    rules: judgeRules(foeHealth * rounds, lives),
    issues: checkDuelPattern(pattern, rounds - 1, params.rounds === undefined ? 0 : params.roundRise ?? DUEL.rise),
    health: lives,
  };
}
