/**
 * Kontrakt arkádového jádra (P25A, T1) – typy a konstanty, žádná implementace.
 *
 * Jádro běží **vedle** `src/sim`, ne místo něj: mřížka 20 Hz bez rychlosti a
 * s „kolizí“ jako rovností políček skok ani řízení neunese, a její přepsání by
 * pohnulo hashi všech dnešních her. Proč a jak: `docs/play/ARCADE.md`.
 *
 * Stav je jeden `Int32Array` celých čísel (1 m = 1000 jednotek), tik 60 Hz,
 * jediná náhoda `pure-rand`. Kus (ovládání, pravidlo, generátor, robot) je
 * čistá funkce v pevném rozhraní, deklaruje parametry (zod), náklady a role –
 * tak ho vybírá návrh ze slov i model a tak ho jde ověřit stejnou branou.
 */

import type { z } from 'zod';

/** Tik jádra za sekundu. */
export const ARCADE_HZ = 60;
/** Jednotek na metr – pozice, rozměry i rychlosti (za tik) jsou celá čísla. */
export const UNIT = 1000;
/**
 * Zvednout, když stejný svět a stejné vstupy dají jiný hash. `arcade-v3` (P45B) nese jen
 * svět se stavem logiky nebo s vlnou (tu starý kód nepřečte, `arcadeWorldOf`); ostatní světy
 * dál razítkují `ARCADE_RUNTIME_V2` a hrají bajt po bajtu jako dřív – uložené hry i jejich
 * hashe se nepohnou.
 */
export const ARCADE_RUNTIME_VERSION = 'arcade-v3';
export const ARCADE_RUNTIME_V2 = 'arcade-v2';
export type ArcadeRuntimeVersion = 'arcade-v1' | typeof ARCADE_RUNTIME_V2 | typeof ARCADE_RUNTIME_VERSION;

/** Meze, které drží smyčky jádra konečné a svět malý. */
export const ARCADE_LIMITS = {
  /** Těl ve světě včetně hráče. */
  maxBodies: 256,
  /** Instancí pravidel ve světě. */
  maxRules: 16,
  /** Efektů, které pravidla smí vydat za jeden tik; zbytek se zahodí. */
  maxEffectsPerTick: 64,
  /** Horizont ověření: 90 s. */
  maxTicks: 90 * ARCADE_HZ,
  /** Pojmenovaných čítačů (skóre, životy, …). */
  maxCounters: 8,
} as const;

/**
 * Meze bloku `logic` (P45B): proměnné, časovače, fáze a události hry. Stav logiky
 * žije v hashovaném stavu jádra, takže strop je strop jeho slotů, ne jen jazyka.
 */
export const LOGIC_LIMITS = {
  maxVars: 8,
  maxTimers: 4,
  /** První fáze je počáteční; jediná fáze by žádný průběh nedala. */
  minPhases: 2,
  maxPhases: 4,
  maxEvents: 8,
  /** Počáteční hodnota, `set` a mez podmínky – celá čísla v ±tolika. */
  varLiteral: 1000,
  /** `add` za jeden výstřel. */
  maxAdd: 100,
  /** Hodnota proměnné v jádře se drží v ±tolika (sčítání saturuje). */
  varSaturation: 100_000,
  /** Nejvýš tolik těl jedné vlny. */
  maxWave: 8,
} as const;

/** Životnost projektilu v ticích, když ji úroveň neuvede: 3 s. Mez je `maxTicks`. */
export const PROJECTILE_LIFETIME = 3 * ARCADE_HZ;
/** Plný odraz projektilu od země; 0 = zánik při dopadu. */
export const BOUNCE_MAX = 1000;

/** O kolik procent zrychlí běh za každou značkou rampy (P28C T6). */
export const RAMP_STEP_PCT = 10;

/**
 * Rampa uvnitř běhu: značky jsou `z` na třetině a dvou třetinách trati. Svět
 * je nese v parametrech ovládání, takže svět bez nich (každý dřív
 * zkompilovaný) jede dál stálou rychlostí a jeho hash se nepohne.
 */
export const rampMarks = (length: number): [number, number] => [Math.floor(length / 3), Math.floor((2 * length) / 3)];

/** Rychlost `speed` na místě `z` po přičtení minutých značek rampy. */
export function rampedSpeed(speed: number, z: number, ramp: readonly number[] | undefined): number {
  if (ramp === undefined) return speed;
  const passed = ramp.filter((mark) => z >= mark).length;
  return Math.floor((speed * (100 + RAMP_STEP_PCT * passed)) / 100);
}

// ---------------------------------------------------------------------------
// Stav

/** Hlavička stavu: sloty před prvním tělem. */
export const HEADER = {
  tick: 0,
  /** `RUN_STATE`. */
  runState: 1,
  bodyCount: 2,
  /** Index těla hráče. */
  player: 3,
  /** První slot pro těla z efektu `spawn` (= počet těl úrovně); sloty od něj jádro znovu použije. */
  spawnBase: 4,
  /** Kam efekt `respawn` vrátí hráče: start, po efektu `checkpoint` horní hrana checkpointu. */
  respawnX: 5,
  respawnY: 6,
  respawnZ: 7,
  /** Čítače (`COUNTER`) od tohoto slotu. Náhodu spotřebuje jen generátor, jádro žádnou. */
  counters: 8,
  /**
   * Co hráč nese (P29A): index těla + 1, 0 = nic. Je to poslední, dosud nikým
   * nepoužitý slot čítačů – nový slot hlavičky by posunul těla a pohnul hashi
   * všech dnešních her, tenhle je v nich všech 0 = „nic nenese“.
   */
  held: 15,
} as const;
export const HEADER_SIZE = HEADER.counters + ARCADE_LIMITS.maxCounters;

export const RUN_STATE = { running: 0, won: 1, lost: 2 } as const;
export type RunStateCode = (typeof RUN_STATE)[keyof typeof RUN_STATE];

/**
 * Pojmenované sloty jednoho těla. Osy: `x` do stran, `y` nahoru, `z` vpřed
 * (běžec běží po +z). `x/y/z` je střed spodní stěny AABB, `w/h/d` celé rozměry.
 * `aux0/aux1` jsou pracovní sloty ovládání (cílový pruh, časovač skluzu);
 * u projektilu `aux0` = odraz 0–`BOUNCE_MAX`, `aux1` = zbývající tiky života;
 * u neseného těla (P29A) `aux0/aux1` = poslední nenulová rychlost hráče `vx/vz` (směr hodu).
 */
export const BODY = {
  x: 0,
  y: 1,
  z: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  w: 6,
  h: 7,
  d: 8,
  flags: 9,
  role: 10,
  /** Index do `ArcadeWorld.kinds` – který model tělo kreslí. */
  kind: 11,
  aux0: 12,
  aux1: 13,
} as const;
export const BODY_STRIDE = 14;
export type BodySlot = keyof typeof BODY;

/** Bity `flags`. */
export const FLAG = {
  /** Tělo existuje; despawn bit shodí, slot zůstane (stabilní indexy pro hash i kreslení). */
  alive: 1 << 0,
  /** Hráč na něm může stát a náraz z boku je kolize. */
  solid: 1 << 1,
  grounded: 1 << 2,
  sliding: 1 << 3,
  /** Jádro na tělo působí gravitací a drží ho nad zemí (`y >= 0`). */
  gravity: 1 << 4,
  /**
   * Hýbe se jen svou rychlostí: gravitace ani země ho nezastaví a hráč, který
   * na něm stojí, se veze (pohyblivá plošina, auto, trubka).
   */
  kinematic: 1 << 5,
  /** Na zemi ho brzdí tření (P29A): tělo po `push` a `throwHeld` dojede a zastaví se. */
  friction: 1 << 6,
  /** Efekt `toggle` ho už přepnul (P29A); druhý výstřel pravidla ho nevrátí. */
  switched: 1 << 7,
  /**
   * Hýbe s ním Rapier (P29A): padá, klouže, odráží se a převrací se. Jádro ho
   * neintegruje; po každém tiku do stavu zapíše kvantovanou polohu, rychlost
   * a v `aux0/aux1` natočení (`packRotation`).
   */
  physics: 1 << 8,
  /** Jen s `physics`: koule místo kvádru. */
  ball: 1 << 9,
} as const;

/** Odraz fyzikálního tělesa v promile, uložený v bitech `flags` od tohoto bitu (10 bitů, 0–1000). */
export const RESTITUTION_SHIFT = 12;
export const RESTITUTION_MASK = 0x3ff;

/**
 * Stav cíle (P32-0 T4, úkol P32G): 0..`TARGET_STATE_MAX` ve dvou volných
 * bitech `flags`. Nový slot těla by posunul stav a pohnul hashi všech dnešních
 * her; v nich je tu všude 0 = výchozí stav.
 */
export const TARGET_STATE_SHIFT = 10;
export const TARGET_STATE_MASK = 0x3;
export const TARGET_STATE_MAX = 2;

/**
 * HP těla (P32-0 T4, souboj P32E) v bitech `flags` nad odrazem (9 bitů,
 * 0..`HP_MAX`); 0 = tělo HP nemá nebo je na nule. Bit 31 zůstává volný, `flags`
 * se nikdy nestane záporným.
 */
export const HP_SHIFT = 22;
export const HP_MASK = 0x1ff;
export const HP_MAX = HP_MASK;

const flagsAt = (body: number): number => HEADER_SIZE + body * BODY_STRIDE + BODY.flags;

export const bodyHp = (state: Int32Array, body: number): number => ((state[flagsAt(body)] as number) >> HP_SHIFT) & HP_MASK;

export function setBodyHp(state: Int32Array, body: number, hp: number): void {
  const at = flagsAt(body);
  const clamped = Math.max(0, Math.min(HP_MAX, hp));
  state[at] = ((state[at] as number) & ~(HP_MASK << HP_SHIFT)) | (clamped << HP_SHIFT);
}

/**
 * Milost po zásahu (P36A T2): tiky, kdy hráč nepřijde o život, v bitech odrazu
 * jeho `flags`. Hráč nikdy není fyzikální těleso (`buildWorld` to odmítne),
 * takže tyhle bity má ve všech dosavadních hrách 0 – jádro je odpočítává jen
 * od nuly výš a starý svět se nepohne. Nabíjí je efekt `damage` s `grace`.
 */
export const GRACE_SHIFT = RESTITUTION_SHIFT;
export const GRACE_MASK = RESTITUTION_MASK;

/** Výchozí milost po zásahu: 1 s. */
export const HIT_GRACE = ARCADE_HZ;

/** Životy, se kterými začíná hra žánru, když věta neřekne jiné číslo (P36A T2); věta smí 1–9 (`SENTENCE_LIVES`). */
export const START_LIVES = 3;

/**
 * Kombo (P36A T5): sebrání do `window` tiků po předchozím zvedne násobič o 1
 * (×2, ×3 … nejvýš `max`), mezera nebo ztráta života mezi dvěma sebráními ho
 * vrátí na ×1. Stav nese tělo-počítadlo (`comboKeeper`): mrtvá předloha za
 * tělesy úrovně, kterou nic nekreslí ani nesrazí – `aux0` = násobič,
 * `aux1` = tik posledního sebrání + 1 (0 = ještě nic), `x` = životy v tu chvíli.
 * Hlavička ani čítače volný slot nemají a uložené hry počítadlo nemají, takže
 * jejich hash se nepohne.
 */
export const COMBO = { window: 90, max: 5 } as const;

/** Bonus na konci výhry (P36A T5): za každý zbylý život, za běh bez ztráty života a za každou celou sekundu pod limitem. */
export const SCORE_BONUS = { perLife: 50, noHit: 100, perSecond: 5 } as const;

/** Co rozhoduje bonus na konci (parametry pravidla `score_bonus`): životy na startu, limit v ticích a cílové skóre (0 = bez cíle). */
export interface ScoreBonusParams {
  readonly lives: number;
  readonly limit: number;
  readonly target: number;
}

/**
 * Bonus na konci výhry v tiku `tick` se `lives` zbylými životy. Bez životů ve
 * hře (`params.lives` 0) za ně nic není, bonus za čas platí vždy.
 */
export function endBonus(params: ScoreBonusParams, lives: number, tick: number): number {
  const kept = params.lives > 0 ? SCORE_BONUS.perLife * Math.max(0, lives) + (lives >= params.lives ? SCORE_BONUS.noHit : 0) : 0;
  return kept + SCORE_BONUS.perSecond * Math.max(0, Math.floor((params.limit - tick) / ARCADE_HZ));
}

/** Násobič komba v počítadle `keeper` (1 = bez komba, i když počítadlo ještě nic nezapsalo). */
export const comboOf = (state: Int32Array, keeper: number): number => Math.max(1, state[HEADER_SIZE + keeper * BODY_STRIDE + BODY.aux0] as number);

export const graceOf = (state: Int32Array, player: number): number => ((state[flagsAt(player)] as number) >> GRACE_SHIFT) & GRACE_MASK;

export function setGrace(state: Int32Array, player: number, ticks: number): void {
  const at = flagsAt(player);
  const clamped = Math.max(0, Math.min(GRACE_MASK, ticks));
  state[at] = ((state[at] as number) & ~(GRACE_MASK << GRACE_SHIFT)) | (clamped << GRACE_SHIFT);
}

export const targetStateOf = (state: Int32Array, body: number): number => ((state[flagsAt(body)] as number) >> TARGET_STATE_SHIFT) & TARGET_STATE_MASK;

export function setTargetState(state: Int32Array, body: number, value: number): void {
  const at = flagsAt(body);
  const clamped = Math.max(0, Math.min(TARGET_STATE_MAX, value));
  state[at] = ((state[at] as number) & ~(TARGET_STATE_MASK << TARGET_STATE_SHIFT)) | (clamped << TARGET_STATE_SHIFT);
}

/**
 * Podkroky Rapieru za tik (`numSolverIterations`). Gravitace se v nich
 * přičítá po částech, takže poloha za tik klesne o `g·(k+1)/(2k)`, ne o celé
 * `g` jako v jádře – s tím počítá předpověď hodu (`throwFlight`).
 */
export const PHYSICS_SUBSTEPS = 4;

/** Kvantování natočení: složky kvaternionu × `QUAT`. */
export const QUAT = 10_000;

/**
 * Natočení fyzikálního tělesa do dvou slotů (P29A): `aux0` = qx|qy, `aux1` =
 * qz|(QUAT − qw), po 16 bitech, s `qw ≥ 0`. Bez natočení vyjdou obě nuly –
 * stejně jako pracovní sloty každého jiného těla.
 */
export function packRotation(qx: number, qy: number, qz: number, qw: number): readonly [number, number] {
  const s = qw < 0 ? -1 : 1;
  const q = (v: number): number => Math.round(v * s * QUAT);
  return [(q(qx) & 0xffff) | (q(qy) << 16), (q(qz) & 0xffff) | ((QUAT - q(qw)) << 16)];
}

/** Opak `packRotation`: kvaternion `[x, y, z, w]` (nenormalizovaný, složky × 1/`QUAT`). */
export function unpackRotation(aux0: number, aux1: number): readonly [number, number, number, number] {
  return [((aux0 << 16) >> 16) / QUAT, (aux0 >> 16) / QUAT, ((aux1 << 16) >> 16) / QUAT, (QUAT - (aux1 >> 16)) / QUAT];
}

/** Slovesné efekty (P29A), jednotky za tik: hod vpřed, zdvih hodu, impuls strčení, tření za tik. */
export const VERB_MOTION = { throwSpeed: 200, throwLift: 80, pushSpeed: 160, friction: 8 } as const;

/**
 * Pevné sloty čítačů v hlavičce (`HEADER.counters + index`). `ammo` = náboje
 * v zásobníku (u hodu zbývající hody), `reserve` = náboje mimo zásobník,
 * `cooldown` = tiky, než zbraň znovu vystřelí (rozestup ran, přebíjení),
 * `items` = sebrané předměty doplňku `+collect` (P26D; body za branky v něm nejsou),
 * `trigger` = spoušť `+shoot` v tomto tiku (zapíše ji obal ovládání `addon_control`).
 */
export const COUNTER = { score: 0, health: 1, ammo: 2, reserve: 3, cooldown: 4, items: 5, trigger: 6 } as const;
export type ArcadeCounter = keyof typeof COUNTER;

/** Role těla – co s ním pravidla dělají. Čísla jsou součást hashe, nepřečíslovat. */
export const ROLE = {
  player: 1,
  obstacle: 2,
  collectible: 3,
  goal: 4,
  chaser: 5,
  platform: 6,
  hazard: 7,
  enemy: 8,
  projectile: 9,
  target: 10,
  checkpoint: 11,
  /**
   * Věc pravidel ze specu (P29A): skutečný kód nese `BodyInit.roleCode`
   * (`THING_ROLE_BASE` a výš, jeden na roli specu), tohle jméno jen značí, že
   * tělo patří pravidlům.
   */
  thing: 12,
  /** Logické tělo (P45B): mrtvé, nulového rozměru, nese stav logiky (`LOGIC_SLOTS`). */
  logic: 13,
} as const;
export type ArcadeRole = keyof typeof ROLE;
export type ArcadeRoleCode = (typeof ROLE)[ArcadeRole];

/** Logické tělo nese jen stav logiky – scéna ho nekreslí ani k němu nestahuje model. */
export const isLogicBody = (role: number): boolean => role === ROLE.logic;

/** Role specu, jejíž `count` čte generátor ovládání (P26D T9): id role specu, role jejích těl, klíč parametru, strop generátoru. */
export interface CountedRole {
  readonly roleId: string;
  readonly role: ArcadeRole;
  readonly key: string;
  readonly max: number;
}

/** Podle `control`; `compile.ts` z nich staví parametry, sdílení živých změn (P29D T10) do nich zapisuje. `rows` počítá řady, ne těla. */
export const COUNTED_ROLES: Readonly<Record<string, readonly CountedRole[]>> = {
  runner: [
    { roleId: 'coin', role: 'collectible', key: 'coinCount', max: 60 },
    { roleId: 'obstacle', role: 'obstacle', key: 'rows', max: 60 },
  ],
  platform: [{ roleId: 'coin', role: 'collectible', key: 'coinCount', max: 60 }],
  flap: [{ roleId: 'coin', role: 'collectible', key: 'coinCount', max: 40 }],
  shooter: [
    { roleId: 'target', role: 'target', key: 'targets', max: 8 },
    { roleId: 'enemy', role: 'enemy', key: 'enemies', max: 24 },
  ],
};

/**
 * Doplňky arkády (P26D): druhá mechanika nad základním ovládáním („jump and
 * shoot“). Která ovládání který berou, říká `CAPABILITIES[control].addons`.
 * Žijí tady, ne v `spec.ts`, aby hra v prohlížeči nestavěla schémata celého
 * GameSpec kvůli jednomu seznamu (P28E T5); `spec.ts` je re-exportuje.
 */
export const ADDONS = ['shoot', 'collect', 'chaser', 'lives'] as const;
export type AddonId = (typeof ADDONS)[number];

/**
 * Akce hrdiny (P46A): nejvýš 2 na hru, první na `ACTION_A`, druhá na `ACTION_B`.
 * Která ovládání kterou berou, říká `CAPABILITIES[control].abilities`.
 */
export const ABILITIES = ['shoot', 'strike', 'dash', 'shield', 'grab'] as const;
export type AbilityId = (typeof ABILITIES)[number];

/**
 * Stav akcí (P46A T1, `.claude/debate/p46a-ability-state.md`) nese tělo-počítadlo
 * `abilityKeeper` jako kombo: mrtvá předloha za tělesy úrovně, jen ve světě
 * s `abilities`, takže hash starých her se nepohne. Cooldown a aktivní okno
 * v tikách, štít jako náboj 0/1, `held` = tlačítka minulého tiku (hrana stisku).
 * `aux0`/`aux1` zůstávají volné pro power-up (P46C).
 */
export const ABILITY_SLOTS = {
  cooldownA: BODY.x,
  cooldownB: BODY.y,
  activeA: BODY.z,
  activeB: BODY.vx,
  shield: BODY.vy,
  held: BODY.vz,
} as const;

/**
 * Celý stav instance: `HEADER_SIZE` slotů hlavičky, pak `maxBodies × BODY_STRIDE`
 * slotů těl. Nic mimo tohle pole hash nevidí a nic jiného se mezi tiky nenese.
 */
export type ArcadeState = Int32Array;

export const stateSize = (bodies: number): number => HEADER_SIZE + bodies * BODY_STRIDE;
export const bodyBase = (index: number): number => HEADER_SIZE + index * BODY_STRIDE;

// ---------------------------------------------------------------------------
// Stav logiky (P45B)

/**
 * Logických těl ve světě s blokem `logic`. Leží těsně pod `HEADER.spawnBase`, takže je spawn
 * nikdy nepřepíše, a nemění hlavičku ani výpočet kapacity – svět bez logiky je nemá vůbec.
 */
export const LOGIC_BODIES = 2;

/**
 * Sloty stavu logiky jako posun od prvního slotu prvního logického těla. Logické tělo je mrtvé
 * a nulového rozměru; logika bere jen polohu, rychlost a `aux`, které jádro u mrtvého těla
 * nečte – příznaky, rozměr, roli a model nechává jádru.
 */
export const LOGIC_SLOTS = {
  /** Index aktuální fáze (0 = počáteční). */
  phase: BODY.x,
  /** Čekající vstupy (bity 0–3) a výstupy (bity 4–7) fází pro průchod fází. */
  phasePending: BODY.y,
  /** Tik posledního vstupu do fáze. */
  phaseTick: BODY.z,
  /** Čekající události, bit na událost. */
  eventPending: BODY.vx,
  /**
   * Co vystřelilo v právě běžícím průchodu logiky: časovače bity 0–3, vstupy fází 4–7, výstupy
   * 8–11, události 12–19; bity 20–23 = časovač spuštěný v tomto tiku (průchod časovačů ho
   * ještě neodečte). Po průchodech logiky je 0.
   */
  fired: BODY.vy,
  /** Západky překročení mezí proměnných, bit na pravidlo (`latch`). */
  varLatch: BODY.vz,
  /** Zbylé tiky časovačů 0–1 a 2–3 (dolních a horních 16 bitů); 0 = stojí. */
  timers01: BODY.aux0,
  timers23: BODY.aux1,
} as const;

/** Proměnné 0–7 ve druhém logickém těle. */
export const LOGIC_VAR_SLOTS = [BODY.x, BODY.y, BODY.z, BODY.vx, BODY.vy, BODY.vz, BODY.aux0, BODY.aux1].map((slot) => BODY_STRIDE + slot);

export const FIRED = { timer: 0, phaseEnter: 4, phaseExit: 8, event: 12, freshTimer: 20 } as const;

/** Jména bloku `logic` podle druhu v pořadí deklarace – index jména je jeho index v jádře. */
export interface LogicNames {
  readonly var: readonly string[];
  readonly timer: readonly string[];
  readonly phase: readonly string[];
  readonly event: readonly string[];
}

/** První slot prvního logického těla; jen ve světě s logikou. */
export const logicBase = (state: ArcadeState): number => bodyBase((state[HEADER.spawnBase] as number) - LOGIC_BODIES);
const timerSlot = (timer: number): number => (timer < 2 ? LOGIC_SLOTS.timers01 : LOGIC_SLOTS.timers23);
const timerShift = (timer: number): number => (timer % 2) * 16;
/** Zbylé tiky časovače; 0 = stojí. */
export const timerLeft = (state: ArcadeState, base: number, timer: number): number => ((state[base + timerSlot(timer)] as number) >>> timerShift(timer)) & 0xffff;
export function setTimerLeft(state: ArcadeState, base: number, timer: number, ticks: number): void {
  const slot = base + timerSlot(timer);
  const shift = timerShift(timer);
  state[slot] = ((state[slot] as number) & ~(0xffff << shift)) | (ticks << shift);
}
export const varValue = (state: ArcadeState, base: number, index: number): number => state[base + (LOGIC_VAR_SLOTS[index] as number)] as number;
export const phaseOf = (state: ArcadeState, base: number): number => state[base + LOGIC_SLOTS.phase] as number;
/** Vystřelil v tomto průchodu logiky bit `FIRED.<druh> + index`? */
export const firedBit = (state: ArcadeState, base: number, bit: number): boolean => (((state[base + LOGIC_SLOTS.fired] as number) >>> bit) & 1) === 1;

// ---------------------------------------------------------------------------
// Vstup

/** Bitmaska tlačítek jednoho tiku. `TAP` je ťuk/mezerník, `HOLD` držení. */
export const BUTTON = {
  TAP: 1 << 0,
  LEFT: 1 << 1,
  RIGHT: 1 << 2,
  UP: 1 << 3,
  DOWN: 1 << 4,
  HOLD: 1 << 5,
  /** Střela doplňku `+shoot` (P26D) – základní ovládání ho nečtou, takže se nesrazí se skokem ani skluzem. */
  FIRE: 1 << 6,
  /** Úder (P32-0 T4, souboj P32E): klávesa J, na telefonu tlačítko „Attack“. */
  ATTACK: 1 << 7,
  /** Použít (P32-0 T4, úkol P32G): klávesa K, na telefonu „Use“; drží se jako `HOLD`. */
  INTERACT: 1 << 8,
  /** Akce hrdiny A (P46A): první ze `spec.abilities`, klávesa J, na telefonu levé tlačítko vpravo dole. */
  ACTION_A: 1 << 9,
  /** Akce hrdiny B (P46A): druhá ze `spec.abilities`, klávesa K. */
  ACTION_B: 1 << 10,
} as const;

export const AXIS_MIN = -1000;
export const AXIS_MAX = 1000;

export interface ArcadeInput {
  /** Tlačítka stisknutá **v tomto tiku** (hrany; držení nese `HOLD`). */
  readonly buttons: number;
  /** Analogová osa −1000..1000 (tah, náklon); 0 = nic. */
  readonly axis: number;
}

export const NO_INPUT: ArcadeInput = { buttons: 0, axis: 0 };

/** Záznam hry: jen tiky s nenulovým vstupem; tik bez záznamu je `NO_INPUT`. */
export interface InputEvent extends ArcadeInput {
  readonly tick: number;
}

// ---------------------------------------------------------------------------
// Kusy

/** Co kus stojí – odhad před sestavením světa, aby šel rozpočet spočítat předem. */
export interface PieceCost {
  readonly bodies: number;
  readonly rules: number;
}

interface PieceBase<P> {
  readonly id: string;
  readonly params: z.ZodType<P>;
  // Metody, ne vlastnosti s funkcí: knihovna drží kusy s různým `P` pod
  // `Piece<unknown>` a to jde jen s bivariantními parametry metod.
  cost(params: P): PieceCost;
  /** Role, které kus čte nebo vyrábí. */
  readonly roles: readonly ArcadeRole[];
}

/**
 * Ovládání: vstup → změna těla hráče (rychlost, pruh, výška AABB). Integraci,
 * gravitaci a kolize dělá jádro, ne ovládání.
 */
export interface ControlPiece<P = unknown> extends PieceBase<P> {
  step(state: ArcadeState, player: number, input: ArcadeInput, params: P): void;
}

export type ArcadeEffect =
  | { readonly kind: 'score'; readonly amount: number }
  /**
   * Ztráta života. S `grace` (P36A T2) zásah během milosti hráče (`graceOf`)
   * nebere nic a jinak milost nabije na `grace` tiků – druhý zásah téhož tiku
   * tak život už nevezme. Bez `grace` jako dřív.
   */
  | { readonly kind: 'damage'; readonly amount: number; readonly grace?: number }
  /** Odhoz (P36A T2): rychlost hráče `speed` za tik v rovině x–z, směrem od těla `body`. */
  | { readonly kind: 'knockback'; readonly body: number; readonly speed: number }
  /** HP těla `body` zpět na `hp` (P36A T2, nový život v souboji); jen nahoru – léčení nezraní. */
  | { readonly kind: 'heal'; readonly body: number; readonly hp: number }
  | { readonly kind: 'lose' }
  | { readonly kind: 'win' }
  | { readonly kind: 'despawn'; readonly body: number }
  /**
   * Nové tělo jako kopie předlohy `template` (tvar, role, model, příznaky) na
   * pozici s rychlostí. Jde do mrtvého slotu od `HEADER.spawnBase`, nebo do
   * volné rezervy světa; když není kam, efekt se zahodí.
   */
  | {
      readonly kind: 'spawn';
      readonly template: number;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly vx: number;
      readonly vy: number;
      readonly vz: number;
    }
  /** Přičte `amount` (i záporné) k čítači `counter`. `score` a `damage` jsou jeho zkratky. */
  | { readonly kind: 'count'; readonly counter: ArcadeCounter; readonly amount: number }
  /** Hráč zpět na místo návratu (`HEADER.respawnX..Z`), bez rychlosti. */
  | { readonly kind: 'respawn' }
  /** Místo návratu = střed horní hrany těla `body`. */
  | { readonly kind: 'checkpoint'; readonly body: number }
  /**
   * Hráč tělo zvedne (P29A): `HEADER.held`, tělo jede každý tik na hlavě
   * hráče, dokud ho nepustí. Když už něco nese, efekt se zahodí.
   */
  | { readonly kind: 'grab'; readonly body: number }
  /** Nesené tělo položí před sebe na zem. */
  | { readonly kind: 'release' }
  /** Nesené tělo hodí ve směru, kam hráč naposled šel; dopadne a třením dojede. */
  | { readonly kind: 'throwHeld' }
  /** Impuls tělu `body` po převažující ose od hráče; třením dojede. */
  | { readonly kind: 'push'; readonly body: number }
  /** Každé ještě nepřepnuté tělo role `role` se jednou přepne: živé zmizí, skryté se objeví. */
  | { readonly kind: 'toggle'; readonly role: number }
  /** Zásah (P32-0 T4): tělu `body` ubere `amount` HP (nejníž 0); `by` = kdo udeřil. */
  | { readonly kind: 'hit'; readonly body: number; readonly by: number; readonly amount: number }
  /** Stav cíle `body` na `state` (0..`TARGET_STATE_MAX`). */
  | { readonly kind: 'stateChange'; readonly body: number; readonly state: number }
  /**
   * Sebrání v kombu (P36A T5): počítadlo `body` (`COMBO`) si zapíše násobič,
   * tik a životy. Zároveň je to zpráva pro efekty scény (P36C) – „×3“.
   */
  | { readonly kind: 'combo'; readonly body: number; readonly multiplier: number }
  /**
   * Štít hrdiny (P46A T5, R2): má-li počítadlo akcí `keeper` náboj a tělo `body` žije,
   * náboj spadne na 0 a jádro efekt nahradí `despawn` těla. Rozhoduje se až při použití,
   * takže druhý náraz téhož tiku najde náboj spotřebovaný. Pravidla stav nepíšou přímo.
   */
  | { readonly kind: 'block'; readonly keeper: number; readonly body: number }
  /**
   * Efekty `effects` platí, jen když tělo `body` při použití ještě žije – náraz, který štít
   * téhož tiku pohltil, nic nevezme (P46A R2). Jádro obal nahradí vnořenými efekty, nebo ničím.
   */
  | { readonly kind: 'ifAlive'; readonly body: number; readonly effects: readonly ArcadeEffect[] }
  /**
   * Logika (P45B), indexy z deklarace `logic`: proměnná na hodnotu / o kolik (saturuje na
   * ±`LOGIC_LIMITS.varSaturation`), přechod do fáze, spuštění / zastavení časovače, vyslání
   * události. Stopu ohlásí jen skutečná změna – nastavení na tutéž hodnotu, vstup do fáze, ve
   * které hra už je, start běžícího časovače na týž zbytek ani vyslání čekající události ne.
   */
  | { readonly kind: 'setVar'; readonly var: number; readonly value: number }
  | { readonly kind: 'addVar'; readonly var: number; readonly amount: number }
  | { readonly kind: 'goPhase'; readonly phase: number }
  | { readonly kind: 'startTimer'; readonly timer: number; readonly ticks: number }
  | { readonly kind: 'stopTimer'; readonly timer: number }
  | { readonly kind: 'emit'; readonly event: number }
  /** Západka překročení meze proměnné (bit `bit` v `varLatch`); účetnictví spouštěče, stopu nehlásí. */
  | { readonly kind: 'latch'; readonly bit: number; readonly on: boolean };

/**
 * `hit` = projektil skončil: zasáhl terč, nepřítele nebo pevné tělo (`other`),
 * nebo dopadl na zem bez odrazu, dohasl či se dokutálel (`other` −1). Jádro ho
 * despawnuje samo, pravidlo jen rozhodne, co zásah znamená.
 * `press` (P29A) = hned po ovládání, s vstupem tiku: pravidlo samo pozná, zda
 * hráč stiskl, co ho zajímá.
 */
export type RuleTrigger = 'contact' | 'tick' | 'counter' | 'hit' | 'press' | LogicTrigger;
/**
 * Průchody logiky (P45B) za průchodem čítačů, jen ve světě s logikou: `timer` = některý časovač
 * doběhl, `phase` = hra vstoupila do fáze nebo z ní odešla, `event` = čekající události. Co
 * přesně vystřelilo, nese `LOGIC_SLOTS.fired` (`firedBit`).
 */
export type LogicTrigger = 'timer' | 'phase' | 'event';

/** Co pravidlo vidí: stav jen ke čtení, hráč a u `contact` těl, se kterým se dotkl. */
export interface RuleContext {
  readonly state: ArcadeState;
  readonly player: number;
  /** Tělo kontaktu nebo zásahu; u `tick`, `counter` a zásahu země −1. */
  readonly other: number;
  /** U `hit` projektil (už mrtvý, sloty čitelné), jinak −1. */
  readonly source: number;
  /** Vstup tohoto tiku (P29A, spouštěč `press`). */
  readonly input: ArcadeInput;
}

/** Pravidlo: spouštěč → efekty. Stav nemění samo, efekty aplikuje jádro. */
export interface RulePiece<P = unknown> extends PieceBase<P> {
  readonly trigger: RuleTrigger;
  fire(ctx: RuleContext, params: P): readonly ArcadeEffect[];
}

/** Počáteční tělo, jak ho vydá generátor. */
export interface BodyInit {
  readonly role: ArcadeRole;
  /** Jen role `thing` (P29A): kód role pravidla, který jádro zapíše místo `ROLE.thing`. */
  readonly roleCode?: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly solid: boolean;
  /** Počáteční rychlost v jednotkách za tik. */
  readonly vx?: number;
  readonly vy?: number;
  readonly vz?: number;
  /** Padá a drží se nad zemí (`FLAG.gravity`); hráč ji má vždy. */
  readonly gravity?: boolean;
  /** `FLAG.kinematic`: jede svou rychlostí, nic ho nezastaví, hráč se na něm veze. */
  readonly kinematic?: boolean;
  /**
   * Jen s `kinematic`: po tolika ticích se rychlost otočí (kyvadlo tam a zpět).
   * Jádro ho drží v `aux1`, uběhlé tiky úseku v `aux0`.
   */
  readonly period?: number;
  /** Předloha pro efekt `spawn`: ve světě je, ale není živá. */
  readonly template?: boolean;
  /** Jen role `projectile`: tiky života 1..`maxTicks` (výchozí `PROJECTILE_LIFETIME`), pak zánik. */
  readonly lifetime?: number;
  /** Jen role `projectile` s gravitací: odraz od země 0..`BOUNCE_MAX` (rychlost × bounce / 1000). */
  readonly bounce?: number;
  /** `FLAG.physics` (P29A): hýbe s ním Rapier. Ne hráč, ne projektil, ne kinematické. */
  readonly physics?: boolean;
  /** Jen s `physics`: tvar koule (průměr = nejmenší rozměr). */
  readonly ball?: boolean;
  /** Jen s `physics`: odraz v promile 0–1000 (výchozí 0). */
  readonly restitution?: number;
  /** Počáteční HP 1..`HP_MAX` (P32-0 T4); bez něj 0 = tělo HP nemá. */
  readonly hp?: number;
}

export interface ArcadeLevel {
  /** První tělo je hráč. */
  readonly bodies: readonly BodyInit[];
  /** Délka trati v jednotkách (konec = cíl), nebo 0, když úroveň konec nemá. */
  readonly length: number;
  /** Volné sloty pro těla z efektu `spawn` (součet s `bodies` nejvýš `maxBodies`). */
  readonly spawnSlots?: number;
  /** Počáteční čítače úrovně (zásobník, rezerva); `health` nastavuje svět, ne úroveň. */
  readonly counters?: Readonly<Partial<Record<Exclude<ArcadeCounter, 'health'>, number>>>;
  /**
   * Trať z úseků (P36A T4): `z`, kde začíná druhý, třetí… úsek; první začíná na startu.
   * Běžec na nich zrychlí (značky rampy), plošinovka na nich má checkpoint. Bez pole úroveň úseky nemá.
   */
  readonly sectionStarts?: readonly number[];
}

/** Stavba úrovně: seed + parametry → těla. Hratelnost z konstrukce je jeho povinnost. */
export interface GeneratorPiece<P = unknown> extends PieceBase<P> {
  generate(seed: number, params: P): ArcadeLevel;
}

/** Co generátor režimu vydá: ovládání, robot, úroveň a pravidla patří k sobě. */
export interface ModeParts {
  readonly control: PieceRef;
  readonly bot: PieceRef;
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  /** Režim úroveň nepostaví – svět se nestaví (pahýl, nebo hratelnost z konstrukce neprošla). */
  readonly issues?: readonly string[];
  /** Životy, které režim sám určí. */
  readonly health?: number;
}

/**
 * Generátor režimu žánru (P32-0 T4). Vybírá ho `controlParams.generator`,
 * `params` validuje parametry ovládání spolu s `controlParams.tuning`, takže
 * nový parametr režimu nemusí do `spec.ts`. Ovládání, robota a pravidla vydá
 * sám (`parts`), `arcade/compile.ts` je jen předá jádru.
 */
export interface ModeGeneratorPiece<P = unknown> extends GeneratorPiece<P> {
  parts(seed: number, params: P, health: number | undefined): ModeParts;
}

/** Co robot vidí: stav z doby před `reactionTicks` (věrohodný hráč nereaguje hned). */
export interface ArcadeObservation {
  readonly state: ArcadeState;
  readonly player: number;
  /** Tik, ze kterého je `state` – o `reactionTicks` starší než tik, pro který robot volí. */
  readonly tick: number;
  /**
   * Vstupy, které robot vydal za posledních `reactionTicks` tiků a které v
   * `state` ještě nejsou vidět. Zpoždění je ve vnímání, ne v paměti: hráč ví,
   * co zmáčkl, a nezmáčkne „vlevo“ osmkrát, jen protože to ještě nevidí.
   */
  readonly recent: readonly ArcadeInput[];
}

export interface BotPiece<P = unknown> extends PieceBase<P> {
  readonly reactionTicks: number;
  decide(observation: ArcadeObservation, params: P): ArcadeInput;
}

/** Instance kusu ve světě: id z knihovny a už přečtené parametry. */
export interface PieceRef {
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Nativní pravidlo pod obalem `assembly_gate_<trigger>` (P42, `assembly-parts.ts`) – hledání
 * pravidla podle id (`blaster`, `time_limit`, `interact`) ho musí najít i ve složené hře.
 * Žije tady, ne v `addons.ts`: čte ho i jádro (`kernel.ts`), které `addons.ts` samo importuje.
 */
export const underlyingRule = (ref: PieceRef): PieceRef =>
  ref.id.startsWith('assembly_gate_') ? underlyingRule((ref.params as { base: PieceRef }).base) : ref;

/** Nativní pravidla s některým z `ids`, i pod obalem složené hry, v pořadí pravidel světa. */
export const nativeRules = (rules: readonly PieceRef[], ...ids: readonly string[]): PieceRef[] => rules.map(underlyingRule).filter((ref) => ids.includes(ref.id));

/** První nativní pravidlo s některým z `ids` (`blaster`, `time_limit`, `interact`) – render i HUD hledají jen tudy. */
export const nativeRule = (rules: readonly PieceRef[], ...ids: readonly string[]): PieceRef | undefined => nativeRules(rules, ...ids)[0];

/** Pravidlo s upraveným nativním jádrem; obaly `assembly_gate_*` kolem něj zůstanou. */
export const mapUnderlying = (ref: PieceRef, edit: (native: PieceRef) => PieceRef): PieceRef =>
  ref.id.startsWith('assembly_gate_') ? { ...ref, params: { ...ref.params, base: mapUnderlying((ref.params as { base: PieceRef }).base, edit) } } : edit(ref);

/**
 * Hratelná instance: vše, z čeho jádro spočítá každý tik. `initial` je stav
 * v tiku 0; `kinds` převádí `BODY.kind` na id modelu z katalogu.
 */
export interface ArcadeWorld {
  readonly runtimeVersion: ArcadeRuntimeVersion;
  /**
   * Logická těla (P45B), jen ve světě s blokem `logic` (`arcade-v3`). `names` = jména deklarace
   * ze specu (T7): ověření jimi pojmenuje kostku, kterou robot nedokázal; svět postavený bez specu je nemá.
   */
  readonly logic?: { readonly bodies: readonly number[]; readonly names?: LogicNames };
  readonly seed: number;
  readonly control: PieceRef;
  readonly rules: readonly PieceRef[];
  readonly bot: PieceRef;
  readonly kinds: readonly string[];
  /** Délka trati v jednotkách. */
  readonly length: number;
  readonly initial: readonly number[];
}

/**
 * Mřížka zamčeného cíle chování (`aux1`, P45C): `x` po 16, `z` po 64 jednotkách. Chování, které podle cíle
 * staví (shazovač P46B T5 – osa silnice v místě shozu), počítá s cílem už zarovnaným na ni.
 */
export const AIM_GRID = { x: 16, z: 64 } as const;
