/**
 * Plošinovka (P25C, T2): ovládání, generátor úrovně a pravidla.
 *
 * Boční pohled: úroveň běží po +z (vpravo), `x` je hloubka a zůstává 0.
 * Vlevo/vpravo (osa nebo tlačítka) = zrychlení a tření, ťuk/nahoru = skok
 * ze země, volitelně jeden dvojskok ve vzduchu. Generátor staví řadu plošin
 * nad propastí a zná konstanty ovládání, takže úroveň je **hratelná
 * z konstrukce**: každá mezera je v dosahu jednoho skoku i se zpožděním
 * reakce, výškový rozdíl jde vyskočit a hrot má před sebou i za sebou místo
 * na rozběh a dopad. `checkPlatformLevel` to samé tvrzení přepočítá nad
 * hotovou úrovní – test i ověření ho čtou.
 *
 * Se `sections: 3` (P36A T4, žánr Skákačka) je úroveň ze tří úseků s rostoucí
 * obtížností a checkpointy, délkou podle obsahu a hodinami (`PLATFORM_SECTIONS`).
 *
 * Pocit skoku `feel: 2` (P32F T2) odpouští: skok ještě 100 ms po sběhnutí
 * z hrany (coyote time), stisk až 120 ms před dopadem skočí při dopadu
 * (buffer) a držení po odrazu skok prodlouží. Ťuk skočí přesně jako dřív,
 * takže dosah, ze kterého generátor počítá mezery, platí dál – i pro vstup,
 * který držení neposílá.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeLevel, AXIS_MAX, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, HIT_GRACE, type PieceRef, UNIT, bodyBase } from '../contract';
import { GRAVITY } from '../kernel';
import { type ChunkStep, PLATFORM_STYLES, PLATFORM_STYLE_LIBRARY, type PlatformChunk, type PlatformChunkId, type PlatformStyleId, REST_CHUNK, pickPlatformChunk, styledChunks } from './platform-chunks';

export const PLATFORM_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PlatformDifficulty = (typeof PLATFORM_DIFFICULTIES)[number];

export const PLATFORM = {
  /** Nejvyšší rychlost do strany (6,6 m/s). */
  maxRun: 110,
  groundAccel: 12,
  airAccel: 8,
  groundFriction: 14,
  airDrag: 3,
  jumpVy: 180,
  doubleJumpVy: 160,
  playerW: 600,
  playerH: 1600,
  playerD: 500,
  /** Tloušťka a hloubka desky plošiny. */
  slabH: 800,
  slabW: 3000,
  /** Horní hrana startovní plošiny; ostatní se od ní liší o nejvýš `maxRise` na krok. */
  baseTop: 4000,
  minTop: 2500,
  maxTop: 6500,
  maxRise: 1000,
  /** Spodní stěna hráče pod touhle výškou = spadl do propasti. */
  fallBelowY: 1000,
  spikeH: 500,
  spikeD: 800,
  /** Volno před hrotem i za ním (rozběh a dopad). */
  spikeMargin: 1800,
  /** Kolik z dosahu skoku smí mezera využít – zbytek je rezerva na pozdní odraz. */
  jumpSafety: 0.65,
} as const;

/** Výška spodní stěny po `k` ticích skoku z rovné země (jádro: nejdřív `vy −= g`, pak `y += vy`). */
const jumpY = (k: number): number => PLATFORM.jumpVy * k - (GRAVITY * k * (k + 1)) / 2;

/** Nejvýš dosažená výška skoku. */
export const PLATFORM_JUMP_PEAK = (() => {
  let peak = 0;
  for (let k = 1; jumpY(k) > peak; k += 1) peak = jumpY(k);
  return peak;
})();

/** Poslední tik skoku, kdy je hráč ještě aspoň ve výšce `dh` (na sestupu). */
function airTicks(dh: number): number {
  let last = 0;
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) last = k;
  return last;
}

/** První tik skoku, kdy hráč dosáhne výšky `dh` (na výstupu). */
export function riseTicks(dh: number): number {
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) return k;
  return Number.POSITIVE_INFINITY;
}

/**
 * Nejširší mezera (hrana–hrana), kterou úroveň smí mít při výškovém rozdílu
 * `dh` (nahoru kladně): podíl dosahu jednoho skoku plnou rychlostí plus půl
 * hráče, o kterou smí přečnívat hranu při odrazu.
 */
export function maxGap(dh: number): number {
  return Math.floor(PLATFORM.jumpSafety * PLATFORM.maxRun * airTicks(dh)) + PLATFORM.playerD / 2;
}

/**
 * Dosah ťuku plnou rychlostí hrana–hrana při výškovém rozdílu `dh`: střed
 * hráče letí `airTicks` tiků a na obou hranách smí přečnívat o půl hráče.
 * `maxGap` z něj bere nejvýš dvě třetiny, rezerva je tedy víc než 20 %.
 */
export const jumpReach = (dh: number): number => PLATFORM.maxRun * airTicks(dh) + PLATFORM.playerD;

/** Pocit skoku `feel: 2` v ticích (60 Hz): coyote 100 ms, buffer 120 ms, prodloužení skoku držením. */
export const PLATFORM_FEEL = {
  coyoteTicks: 6,
  bufferTicks: 7,
  /** Tolik tiků po odrazu držení ubírá gravitaci o `lift` za tik. */
  liftTicks: 12,
  lift: 4,
} as const;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/**
 * `speed` = nejvyšší rychlost běhu za tik (P46B T6): fáze průběhu (`phase_control`) ji škálují podle úseku
 * a robot ji dostane taky. Bez ní `PLATFORM.maxRun` – uložená úroveň jezdí jako dřív.
 */
const controlParams = z.object({ doubleJump: z.boolean().default(false), feel: z.literal(2).optional(), speed: z.int().min(1).max(2 * PLATFORM.maxRun).optional() }).strict();

const JUMP = BUTTON.TAP | BUTTON.UP;

/**
 * Skok s pocitem `feel: 2`. V `aux1` hráče (jinak ho plošinovka nepoužívá)
 * tři čítače: bity 0–2 zbývající coyote tiky, 3–6 zbývající tiky bufferu
 * (stisk platí v tiku stisku a dalších `bufferTicks`), 7–10 zbývající tiky
 * prodloužení. `aux0` je dál příznak spotřebovaného dvojskoku.
 */
function feelJump(state: Int32Array, base: number, grounded: boolean, input: ArcadeInput, doubleJump: boolean): void {
  const packed = state[base + BODY.aux1] as number;
  let coyote = grounded ? PLATFORM_FEEL.coyoteTicks : packed & 0x7;
  let buffer = (packed >> 3) & 0xf;
  let lift = (packed >> 7) & 0xf;
  const pressed = (input.buttons & JUMP) !== 0;
  if (pressed) buffer = PLATFORM_FEEL.bufferTicks + 1;

  if (buffer > 0 && (grounded || coyote > 0)) {
    state[base + BODY.vy] = PLATFORM.jumpVy;
    coyote = 0;
    buffer = 0;
    lift = PLATFORM_FEEL.liftTicks;
  } else if (pressed && !grounded && doubleJump && state[base + BODY.aux0] === 0) {
    state[base + BODY.vy] = PLATFORM.doubleJumpVy;
    state[base + BODY.aux0] = 1;
    buffer = 0;
    lift = PLATFORM_FEEL.liftTicks;
  } else if (lift > 0 && (input.buttons & BUTTON.HOLD) !== 0 && (state[base + BODY.vy] as number) > 0) {
    state[base + BODY.vy] = (state[base + BODY.vy] as number) + PLATFORM_FEEL.lift;
    lift -= 1;
  } else lift = 0;

  if (buffer > 0) buffer -= 1;
  if (!grounded && coyote > 0) coyote -= 1;
  state[base + BODY.aux1] = coyote | (buffer << 3) | (lift << 7);
}

/** Ovládání plošinovky. `aux0` = 1, když je dvojskok v tomhle letu spotřebovaný. */
export const platformControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'platform',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const grounded = ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0;
    const run = params.speed ?? PLATFORM.maxRun;
    let target = Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis)) * run) / AXIS_MAX);
    if ((input.buttons & BUTTON.LEFT) !== 0) target = -run;
    if ((input.buttons & BUTTON.RIGHT) !== 0) target = run;
    const vz = state[base + BODY.vz] as number;
    const rate = target !== 0 ? (grounded ? PLATFORM.groundAccel : PLATFORM.airAccel) : grounded ? PLATFORM.groundFriction : PLATFORM.airDrag;
    state[base + BODY.vz] = toward(vz, target, rate);
    state[base + BODY.vx] = 0;

    if (grounded) state[base + BODY.aux0] = 0;
    if (params.feel === 2) {
      feelJump(state, base, grounded, input, params.doubleJump);
      return;
    }
    if ((input.buttons & JUMP) !== 0) {
      if (grounded) state[base + BODY.vy] = PLATFORM.jumpVy;
      else if (params.doubleJump && state[base + BODY.aux0] === 0) {
        state[base + BODY.vy] = PLATFORM.doubleJumpVy;
        state[base + BODY.aux0] = 1;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly gap: readonly [number, number];
  readonly rise: number;
  readonly slab: readonly [number, number];
  /** Hrot na každé n-té plošině. */
  readonly spikeEvery: number;
}

const TIERS: Readonly<Record<PlatformDifficulty, Tier>> = {
  easy: { gap: [1500, 2000], rise: 400, slab: [5000, 8000], spikeEvery: 4 },
  normal: { gap: [1600, 2600], rise: 700, slab: [4500, 7000], spikeEvery: 2 },
  hard: { gap: [2000, 3400], rise: PLATFORM.maxRise, slab: [4500, 6500], spikeEvery: 1 },
};

export const PLATFORM_LEVEL = {
  minLengthM: 60,
  /** Robot na „hard“ dojde 250 m za ~75 s; delší úroveň se do 90 s nevejde. */
  maxLengthM: 250,
  /** Čekání na pohyblivé plošiny stojí čas: s nimi nejvýš 180 m. */
  maxMovingLengthM: 180,
  startSlab: 8000,
  finalSlab: 6000,
  /** Mezera s pohyblivou plošinou a její deska. */
  shuttleGap: [7000, 9000] as const,
  shuttleSlab: 2500,
  shuttleSpeed: 30,
  /** Nejmenší mezera mezi pohyblivou plošinou a hranou v krajní poloze. */
  shuttleClear: 250,
  maxCoins: 60,
  /** Kolik věcí sebrat, když věta počet neřekne (P35 T3), a nejvýš kolik – tolik míst na zemi má i nejkratší úroveň. */
  collectCount: 5,
  maxCollect: 8,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(PLATFORM_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(PLATFORM_LEVEL.minLengthM).max(PLATFORM_LEVEL.maxLengthM).default(120),
    movingPlatforms: z.boolean().default(false),
    checkpoints: z.boolean().default(false),
    coins: z.boolean().default(true),
    doubleJump: z.boolean().default(false),
    /** Přesný počet mincí z počtu rolí (P26D T9); bez hodnoty co místo dá. */
    coinCount: z.int().min(1).max(PLATFORM_LEVEL.maxCoins).optional(),
    /**
     * Výhra až po sebrání všech věcí (P35 T3, „collect carrots“): `coinCount` věcí
     * jen tam, kudy se po zemi běží, a cíl bez nich nevyhraje (`finish` s `allItems`).
     */
    collectAll: z.boolean().optional(),
    /** Nový pocit skoku (P32-0 T4 šev, naplní P32F T2); přijde z `controlParams.tuning`. Bez něj úroveň beze změny. */
    feel: z.literal(2).optional(),
    /**
     * Úroveň ze tří úseků s rostoucí obtížností, délka podle obsahu a časový limit
     * (P36A T4, `PLATFORM_SECTIONS`); žánr Skákačka ho píše do `tuning`. Bez něj úroveň jako dřív.
     */
    sections: z.literal(3).optional(),
    /**
     * Úroveň z úseků průběhu (P46B T6, `PLATFORM_SEGMENTS`): rozjezd, úsek 2 s pastí a pohyblivou plošinou,
     * úsek 3 a na konci aréna bosse. Značka nové hry – žánr Skákačka ji píše do `tuning`; jen s ní dostane
     * úroveň průběh (`GENRE_PACING.platform_level`), uložená hra bez ní staví tentýž svět. Jen se `sections`.
     * S `chunks` staví úseky průběhu úroveň ze vzorů (`chunkedLayout`).
     */
    segments: z.literal(true).optional(),
    /**
     * Úseky ze vzorů (P46D T5, `platform-chunks.ts`): schody, mezery, výstup, propadající se
     * plošiny, chodba s ostny, voda… Jen se `sections`; žánr Skákačka ho píše do `tuning`. Bez něj úroveň jako dřív.
     */
    chunks: z.literal(1).optional(),
    /** Styl úrovně ze vzorů (P46D R2, `PLATFORM_STYLE_LIBRARY`); žánr ho píše podle prostředí, bez něj ho vybere semínko. */
    style: z.enum(PLATFORM_STYLES).optional(),
  })
  .strict();
export type PlatformLevelParams = z.infer<typeof generatorParams>;

/**
 * Úroveň z úseků (P36A T4). Každý úsek je o stupeň obtížnosti těžší
 * (`PLATFORM_DIFFICULTIES` od `difficulty` − 1 po `difficulty` + 1: širší mezery,
 * vyšší schody, hustší hroty), druhý a třetí začínají checkpointem na plošině bez
 * hrotu a ve třetím (s `movingPlatforms` i ve druhém) jezdí pohyblivá plošina.
 *
 * Délka podle obsahu: plošin náhodně z `platforms` podle semínka věty, věc ke
 * sběru nad výchozí počet přidá `perItem` plošin (pod ním ubere). Pak se úroveň
 * natáhne nebo zkrátí po plošinách, aby ji robot podle odhadu (`platformPaceTicks`)
 * doběhl za `minTicks`..`maxTicks` a byla aspoň `lengthM` dlouhá.
 *
 * Nečinný hráč na startu nic neriskuje, proto má úroveň hodiny
 * (`platformSeconds`): odhad robota × `limitPct` + `limitSlackS`, nejvýš `maxLimitS`.
 */
export const PLATFORM_SECTIONS = {
  /** Plošin za startovní, když věta věci nepočítá: náhodně z rozsahu. */
  platforms: [16, 22],
  /** Plošin navíc za každou věc ke sběru nad `PLATFORM_LEVEL.collectCount`. */
  perItem: 2,
  /** Úroveň ze vzorů (P46D R2): každá věc nad výchozí počet zvedne i nejkratší odhad robota o tolik. */
  perItemTicks: 3 * ARCADE_HZ,
  maxPlatforms: 40,
  /** Podíl plošin v úsecích, procenta. */
  share: [30, 33, 37],
  /**
   * Tempo robota v procentech běhu plnou rychlostí (`PLATFORM.maxRun`) podle obtížnosti úseku –
   * sonda 20 semínek × 120–250 m (2. 10. 2026): easy 148–154 %, normal 158–167 %, hard 171–184 %.
   */
  pace: { easy: 155, normal: 167, hard: 184 } satisfies Readonly<Record<PlatformDifficulty, number>>,
  /**
   * Robot podle odhadu doběhne nejdřív za 36 s a nejpozději za 62 s; hodiny pak nejvýš 88 s.
   * Skutečný čas robota je 0,86–1,15 × odhad (sonda 30 semínek × 3 obtížnosti × 5 variant).
   */
  minTicks: 36 * ARCADE_HZ,
  maxTicks: 62 * ARCADE_HZ,
  limitPct: 160,
  limitSlackS: 10,
  /** Pod horizontem jádra (90 s): nečinný hráč prohraje dřív, než ověření skončí. */
  maxLimitS: 88,
} as const;

/**
 * Úroveň z úseků průběhu (P46B T6, `segments`): části podle úseků `PACING.segments` (rozjezd 0–200 ‰,
 * úsek 2 200–650, úsek 3 650–850, finále 850–1000), ne po třetinách.
 * - Rozjezd o stupeň lehčí než `difficulty`, úsek 2 a 3 v ní – úsek 3 přidá jen rychlost (fáze průběhu).
 * - Úsek 2 od `trapFrom` ‰ přinese past (hrot, který vyjíždí ze země a zajíždí, `piston`) a pohyblivou
 *   plošinu: obojí až za 40 m zorného pole měřidla T1 od konce rozjezdu, takže je hráč poprvé vidí v úseku 2.
 * - Konec je aréna bosse `arena` (R5): schod a římsa o `pit` nad dnem jámy, za římsou jáma s cílem na konci. Boss
 *   je dvakrát vyšší než hrdina, ze dna ani ze schodu mu na hlavu nikdo nedoskočí – jen z římsy (checkpoint).
 *   Aréna je dlouhá jako dřív rovná deska, takže úroveň i hranice úseků v ‰ zůstaly, kde byly.
 * `share` = podíl plošin bez arény v rozjezdu, úseku 2 a úseku 3; `shuttleAt` = kde v úseku 2 (podíl jeho plošin)
 * jezdí pohyblivá plošina. `bossTicks` = co boss přidá k odhadu robota (hodiny úrovně).
 */
export const PLATFORM_SEGMENTS = {
  share: [24, 52, 24],
  shuttleAt: 0.7,
  /**
   * Úroveň ze vzorů (P46D): vzory mají různě dlouhé desky, takže podíl plošin místo v ‰ nedrží – pohyblivá plošina
   * vjede před první krok za tolika ‰ délky úrovně postavené bez ní (střed okna `trapFrom`–`buildUp`).
   */
  shuttlePermille: 550,
  trapFrom: 450,
  trapUntil: 650,
  /** Dno jámy pod římsou; schod je v půlce. Oba kroky nahoru ≤ `PLATFORM.maxRise`. */
  pit: 1800,
  /** Mezera mezi schodem a římsou, délka schodu a římsy; jáma začíná hned za římsou a vyplní zbytek arény. */
  stairs: { gap: 1500, step: 2500, ledge: 4000 },
  arena: 20 * UNIT,
  /** Checkpoint i na každé tolikáté plošině úseku 2 a 3 (lichá – bez hrotu). */
  checkpointEvery: 4,
  /** Mezera s pohyblivou plošinou: kratší než bez průběhu – cyklus plošiny 2,8–3,9 s, čekání na ni není mrtvý čas. */
  shuttleGap: [5500, 6500] as const,
  /** Past: hrot vyjede nejvýš `PLATFORM.spikeH` nad desku, polovinu cyklu je celý v ní; rychlost za tik. */
  piston: { speed: 25, hidden: PLATFORM.spikeH },
  bossTicks: 12 * ARCADE_HZ,
} as const;

/** Past úseku 2: hrot kyvadlem nahoru a dolů – nejníž `hidden` pod deskou, nejvýš `spikeH` nad ní. */
const pistonBody = (z: number, top: number): BodyInit => {
  const travel = PLATFORM_SEGMENTS.piston.hidden + PLATFORM.spikeH;
  return { ...spikeBody(z, top - PLATFORM.spikeH - PLATFORM_SEGMENTS.piston.hidden), kinematic: true, vy: PLATFORM_SEGMENTS.piston.speed, period: Math.floor(travel / PLATFORM_SEGMENTS.piston.speed) };
};

const slab = (near: number, far: number, top: number): BodyInit => ({
  role: 'platform',
  kind: 'platform',
  x: 0,
  y: top - PLATFORM.slabH,
  z: (near + far) / 2,
  w: PLATFORM.slabW,
  h: PLATFORM.slabH,
  d: far - near,
  solid: true,
});

const coin = (z: number, y: number): BodyInit => ({ role: 'collectible', kind: 'coin', x: 0, y, z, w: 500, h: 500, d: 500, solid: false });

const playerBody = (): BodyInit => ({ role: 'player', kind: 'player', x: 0, y: PLATFORM.baseTop, z: 0, w: PLATFORM.playerW, h: PLATFORM.playerH, d: PLATFORM.playerD, solid: false });

const spikeBody = (z: number, top: number): BodyInit => ({ role: 'hazard', kind: 'spikes', x: 0, y: top, z, w: 1200, h: PLATFORM.spikeH, d: PLATFORM.spikeD, solid: false });

const checkpointBody = (z: number, top: number): BodyInit => ({ role: 'checkpoint', kind: 'checkpoint', x: 0, y: top, z, w: 400, h: 2000, d: 400, solid: false });

/** Pohyblivá plošina kyvadlem mezi hranami mezery `gap` za hranou `far`. */
function shuttleBody(far: number, gap: number, top: number): BodyInit {
  const half = PLATFORM_LEVEL.shuttleSlab / 2;
  const from = far + PLATFORM_LEVEL.shuttleClear + half;
  const period = Math.floor((gap - 2 * PLATFORM_LEVEL.shuttleClear - PLATFORM_LEVEL.shuttleSlab) / PLATFORM_LEVEL.shuttleSpeed);
  return { ...slab(from - half, from + half, top), kind: 'platform-moving', kinematic: true, vz: PLATFORM_LEVEL.shuttleSpeed, period };
}

/** Věci ke sběru na hotové úrovni: se sbíráním všeho jen na zemi rozložené po trati, jinak co místo dá. */
function placeCoins(bodies: BodyInit[], params: PlatformLevelParams, spots: { readonly coinSpots: readonly Spot[]; readonly runMids: readonly Spot[]; readonly runSides: readonly Spot[] }): void {
  if (params.collectAll === true) {
    // Mince nad hrotem robot mine, když skočí jinde – musí se sebrat všechno, takže jen zem, rozložená po trati.
    const want = Math.min(params.coinCount ?? PLATFORM_LEVEL.collectCount, ARCADE_LIMITS.maxBodies - bodies.length - 1);
    const pool = spots.runMids.length >= want ? spots.runMids : [...spots.runMids, ...spots.runSides].sort((a, b) => a.z - b.z);
    const take = Math.min(want, pool.length);
    for (let i = 0; i < take; i += 1) {
      const spot = pool[Math.floor(((i + 0.5) * pool.length) / take)]!;
      bodies.push(coin(spot.z, spot.y));
    }
  } else if (params.coins) {
    const budget = Math.min(params.coinCount ?? PLATFORM_LEVEL.maxCoins, ARCADE_LIMITS.maxBodies - bodies.length - 1);
    // S úseky průběhu (P46B T6) rozložené po celé trati: první místa by rozpočet vyčerpala dřív, než hra dojde k pasti a aréně.
    const take = Math.max(0, Math.min(budget, spots.coinSpots.length));
    const picked = params.segments === true ? Array.from({ length: take }, (_, i) => spots.coinSpots[Math.floor(((i + 0.5) * spots.coinSpots.length) / take)] as Spot) : spots.coinSpots.slice(0, take);
    for (const spot of picked) bodies.push(coin(spot.z, spot.y));
  }
}

interface Spot {
  readonly z: number;
  readonly y: number;
}

/** Obtížnost úseku `section` (0–2): o stupeň pod `difficulty`, ona, o stupeň nad ní – v mezích. */
const sectionDifficulty = (difficulty: PlatformDifficulty, section: number): PlatformDifficulty =>
  PLATFORM_DIFFICULTIES[Math.max(0, Math.min(PLATFORM_DIFFICULTIES.length - 1, PLATFORM_DIFFICULTIES.indexOf(difficulty) + section - 1))] as PlatformDifficulty;

/**
 * Odhad, za kolik tiků úroveň z úseků doběhne robot: dráha každého úseku plnou
 * rychlostí × tempo jeho obtížnosti (`PLATFORM_SECTIONS.pace`) a na každé
 * pohyblivé plošině jedna perioda čekání.
 */
export function platformPaceTicks(level: ArcadeLevel, difficulty: PlatformDifficulty, segments = false): number {
  const bounds = [0, ...(level.sectionStarts ?? []), level.length];
  let ticks = 0;
  for (let section = 0; section + 1 < bounds.length; section += 1) {
    const span = (bounds[section + 1] as number) - (bounds[section] as number);
    ticks += (span * PLATFORM_SECTIONS.pace[segments ? sectionDifficulty(difficulty, Math.min(1, section)) : sectionDifficulty(difficulty, section)]) / (100 * PLATFORM.maxRun);
  }
  // Čekání na pohyblivou plošinu; past (kinematický hrot) se jen přeskočí.
  for (const body of level.bodies) if (body.kinematic === true && body.role === 'platform') ticks += body.period ?? 0;
  return Math.ceil(ticks + (segments ? PLATFORM_SEGMENTS.bossTicks : 0));
}

/** Hodiny úrovně z úseků v sekundách: odhad robota × `limitPct` + `limitSlackS`, nejvýš `maxLimitS`. */
export const platformSeconds = (level: ArcadeLevel, difficulty: PlatformDifficulty, segments = false): number =>
  Math.min(PLATFORM_SECTIONS.maxLimitS, Math.ceil((platformPaceTicks(level, difficulty, segments) * PLATFORM_SECTIONS.limitPct) / 100 / ARCADE_HZ) + PLATFORM_SECTIONS.limitSlackS);

/** Plošin v úsecích podle podílů `share`, v každém aspoň jedna. */
function sectionPlatforms(count: number, share: readonly number[]): readonly [number, number, number] {
  const [first, second] = share.map((pct) => Math.max(1, Math.round((count * pct) / 100))) as [number, number];
  return [first, second, Math.max(1, count - first - second)];
}

/** Věcí ke sběru nad výchozí počet (pod ním záporně). */
const extraItems = (params: PlatformLevelParams): number => (params.collectAll === true ? (params.coinCount ?? PLATFORM_LEVEL.collectCount) - PLATFORM_LEVEL.collectCount : 0);

/** Plošin úrovně z úseků: los z rozsahu, věci ke sběru nad výchozí počet a `extra` z natahování. */
function platformCount(rng: ReturnType<typeof createCompileRng>, params: PlatformLevelParams, extra: number): number {
  // Los plošin jde vždy první: proud je stejný s počtem z věty i bez něj.
  const drawn = rng.int(PLATFORM_SECTIONS.platforms[0], PLATFORM_SECTIONS.platforms[1]);
  return Math.max(3, Math.min(PLATFORM_SECTIONS.maxPlatforms, drawn + PLATFORM_SECTIONS.perItem * extraItems(params) + extra));
}

/** Úroveň z úseků s `extra` plošinami navíc (záporné = méně) proti obsahu věty. */
function sectionedLayout(seed: number, params: PlatformLevelParams, extra: number): { readonly level: ArcadeLevel; readonly platforms: number } {
  const rng = createCompileRng(seed);
  const platforms = platformCount(rng, params, extra);
  const { startSlab, finalSlab } = PLATFORM_LEVEL;
  // Úseky průběhu (P46B T6): úsek 3 v obtížnosti úseku 2 (přidá rychlost), pohyblivá plošina v úseku 2, na konci aréna.
  const paced = params.segments === true;

  const slabs: BodyInit[] = [slab(-2000, startSlab - 2000, PLATFORM.baseTop)];
  const extras: BodyInit[] = [];
  const spots = { coinSpots: [] as Spot[], runMids: [] as Spot[], runSides: [] as Spot[] };
  const starts: number[] = [];
  let far = startSlab - 2000;
  let top: number = PLATFORM.baseTop;
  const counts = sectionPlatforms(platforms, paced ? PLATFORM_SEGMENTS.share : PLATFORM_SECTIONS.share);
  counts.forEach((count, section) => {
    const tier = TIERS[sectionDifficulty(params.difficulty, paced ? Math.min(1, section) : section)];
    // Pohyblivá plošina uprostřed třetího úseku, s `movingPlatforms` i druhého; nikdy na checkpointu ani v cíli.
    // S úseky průběhu jen v úseku 2 za jeho `shuttleAt` – v úseku 3 by čekání vzalo rychlosti úseku smysl.
    const shuttleAt = paced ? (section === 1 ? Math.floor(count * PLATFORM_SEGMENTS.shuttleAt) : -1) : section === 2 || (section === 1 && params.movingPlatforms) ? Math.floor(count / 2) : -1;
    for (let i = 0; i < count; i += 1) {
      const last = section === counts.length - 1 && i === count - 1;
      const shuttle = i === shuttleAt && i > 0 && !last;
      const rise = shuttle ? 0 : rng.int(-tier.rise, tier.rise);
      const nextTop = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop, top + rise));
      if (shuttle) {
        const [shortest, longest] = paced ? PLATFORM_SEGMENTS.shuttleGap : PLATFORM_LEVEL.shuttleGap;
        const gap = rng.int(shortest, longest);
        const ride = shuttleBody(far, gap, top);
        extras.push(ride);
        // Úseky průběhu: mince u hrany, kde se na plošinu čeká, a mince, která jede s ní – čekání není mrtvý čas.
        if (paced && params.coins && params.collectAll !== true) extras.push(coin(far - 600, top + 300), { ...coin(ride.z, top + 300), kinematic: true, vz: ride.vz, period: ride.period });
        far += gap;
      }
      const from = far;
      if (!shuttle) far += Math.min(rng.int(tier.gap[0], tier.gap[1]), maxGap(nextTop - top));

      if (last && paced) {
        // Aréna bosse: schod a římsa (checkpoint – zásah bosse vrátí hráče sem, ne na začátek úseku 3), pak jáma o
        // `pit` níž. Schod stojí ve výšce, kterou by měla rovná deska (`nextTop`), takže skok do arény je stejný jako
        // před R5; dno drží celou jámu v mezích výšek. Konec arény je tam, kde byl konec rovné desky: délka úrovně a
        // hranice úseků se nehnou.
        const { pit, stairs } = PLATFORM_SEGMENTS;
        const floor = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop - pit, nextTop - pit / 2));
        const step = { near: from + Math.min(far - from, maxGap(floor + pit / 2 - top)), top: floor + pit / 2 };
        const ledge = { near: step.near + stairs.step + stairs.gap, top: floor + pit };
        slabs.push(slab(step.near, step.near + stairs.step, step.top), slab(ledge.near, ledge.near + stairs.ledge, ledge.top));
        const near = ledge.near + stairs.ledge;
        far += PLATFORM_SEGMENTS.arena;
        top = floor;
        slabs.push(slab(near, far, top));
        if (params.checkpoints) extras.push(checkpointBody(ledge.near + 800, ledge.top));
        // Mince na schodu a římse; poslední na dně jámy za dosahem bosse, 3 m před cílem.
        if (params.coins && params.collectAll !== true) extras.push(coin(step.near + stairs.step / 2, step.top + 300), coin(ledge.near + 1800, ledge.top + 300), coin(ledge.near + 3000, ledge.top + 300), coin(far - 3000, top + 300));
        break;
      }
      const near = far;
      far = near + (last ? finalSlab : rng.int(tier.slab[0], tier.slab[1]));
      top = nextTop;
      slabs.push(slab(near, far, top));
      if (last) break;

      const mid = Math.floor((near + far) / 2);
      // Úsek začíná checkpointem na plošině bez hrotu – po návratu se nezačíná skokem přes hrot.
      if (i === 0 && section > 0) {
        starts.push(near);
        if (params.checkpoints) extras.push(checkpointBody(near + 800, top));
      }
      // S úseky průběhu i uprostřed úseků 2 a 3 (každá `checkpointEvery`. plošina, ta je vždy bez hrotu): pád nevrací na začátek dlouhého úseku 2.
      if (paced && params.checkpoints && section > 0 && i % PLATFORM_SEGMENTS.checkpointEvery === PLATFORM_SEGMENTS.checkpointEvery - 1 && i % tier.spikeEvery !== 0) extras.push(checkpointBody(near + 800, top));
      if (i > 0 && i % tier.spikeEvery === 0) {
        extras.push(spikeBody(mid, top));
        // Mince nad hrotem odmění skok přes něj.
        spots.coinSpots.push({ z: mid, y: top + 1400 });
      } else {
        // S úseky průběhu má rozjezd jen prostřední minci: hra pak k finále houstne, místo aby řídla.
        for (let c = -1; c <= 1; c += 1) if (!paced || section > 0 || c === 0) spots.coinSpots.push({ z: mid + c * 1000, y: top + 300 });
        spots.runMids.push({ z: mid, y: top + 300 });
        spots.runSides.push({ z: mid - 1000, y: top + 300 }, { z: mid + 1000, y: top + 300 });
      }
    }
  });

  const lastSlab = slabs[slabs.length - 1] as BodyInit;
  const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
  // Past úseku 2: hroty od `trapFrom` do `trapUntil` ‰ trati vyjíždějí a zajíždějí (stejné místo, stejný počet těl).
  const trapped = paced ? extras.map((body) => (body.kind === 'spikes' && body.z * 1000 >= goalZ * PLATFORM_SEGMENTS.trapFrom && body.z * 1000 < goalZ * PLATFORM_SEGMENTS.trapUntil ? pistonBody(body.z, body.y) : body)) : extras;
  const bodies = [playerBody(), ...slabs, ...trapped];
  placeCoins(bodies, params, spots);
  bodies.push({ role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false });
  return { level: { bodies, length: goalZ, sectionStarts: starts }, platforms };
}

/** Bod v rozsahu: 0 = začátek, 100 = konec. */
const within = (range: readonly [number, number], pct: number): number => range[0] + Math.floor(((range[1] - range[0]) * pct) / 100);

type Spots = { coinSpots: Spot[]; runMids: Spot[]; runSides: Spot[] };

/**
 * Hrot v úseku `inside`, když tam vzory žádný nepoložily (styly bez chodby s ostny – lekníny, koruny): dostane ho
 * nejdelší pevná deska úseku, na kterou se vejde s rozběhem i dopadem; mince nad ní se přesunou nad hrot. Jako
 * pravidlo P46D „hrot dostane poslední deska“, jen pro úsek. Mění `extras` a `spots` na místě.
 */
function spikeIn(slabs: readonly BodyInit[], extras: BodyInit[], spots: Spots, inside: (z: number) => boolean): void {
  if (extras.some((body) => body.kind === 'spikes' && inside(body.z))) return;
  const room = 2 * PLATFORM.spikeMargin + PLATFORM.spikeD;
  const host = slabs.filter((body) => inside(body.z) && body.d >= room).reduce<BodyInit | undefined>((best, body) => (best === undefined || body.d > best.d ? body : best), undefined);
  if (host === undefined) return;
  const z = Math.floor(host.z);
  const top = host.y + host.h;
  const off = (spot: Spot): boolean => spot.z < host.z - host.d / 2 || spot.z > host.z + host.d / 2;
  spots.coinSpots = [...spots.coinSpots.filter(off), { z, y: top + 1400 }];
  spots.runMids = spots.runMids.filter(off);
  spots.runSides = spots.runSides.filter(off);
  extras.push(spikeBody(z, top));
}

/**
 * Past úseku 2 na úrovni ze vzorů (P46B T6 × P46D): hroty od `trapFrom` do `trapUntil` ‰ trati vyjíždějí a
 * zajíždějí jako v `sectionedLayout`; okno bez hrotu ho dostane (`spikeIn`).
 */
function trapSegment(slabs: readonly BodyInit[], extras: BodyInit[], spots: Spots, inside: (z: number) => boolean): void {
  spikeIn(slabs, extras, spots, inside);
  const pistons = extras.flatMap((body) => (body.kind === 'spikes' && inside(body.z) ? [pistonBody(body.z, body.y)] : []));
  // Pasti až za pevné hroty: vazba nebezpečí z věty bere první hrot a sonda ho musí umět zasáhnout (jako voda P46D).
  const rest = extras.filter((body) => !(body.kind === 'spikes' && inside(body.z)));
  extras.splice(0, extras.length, ...rest, ...pistons);
}

/**
 * Úroveň z úseků ze vzorů (P46D T5): úsek bere vzory podle semínka a své obtížnosti,
 * dokud nemá své plošiny; druhý a třetí začíná odpočinkem s checkpointem (končí-li
 * předchozí úsek odpočinkem, začne na něm). Krok vzoru se ořízne do dosahu skoku.
 *
 * Styl (R2): bez vlastní knihovny (testy jednotlivých vzorů) bere úroveň vzory svého
 * stylu a první úsek otevírá vzor stylu. Styl bez parametru losuje semínko hned po počtu plošin.
 */
function chunkedLayout(seed: number, params: PlatformLevelParams, extra: number, own: readonly PlatformChunk[] | undefined, shuttleZ?: number): { readonly level: ArcadeLevel; readonly platforms: number; readonly chunks: readonly PlatformChunkId[]; readonly style: PlatformStyleId | undefined } {
  const rng = createCompileRng(seed);
  const platforms = platformCount(rng, params, extra);
  const style = own === undefined ? PLATFORM_STYLE_LIBRARY[params.style ?? (PLATFORM_STYLES[rng.int(0, PLATFORM_STYLES.length - 1)] as PlatformStyleId)] : undefined;
  // Úseky průběhu (P46B T6) na úrovni ze vzorů: podíly a obtížnost úseků, jediná pohyblivá plošina v úseku 2
  // (`shuttleZ`, vzor pohyblivé plošiny se proto nelosuje), checkpointy uprostřed úseků, past a aréna bosse.
  const paced = params.segments === true;
  const styled = own ?? styledChunks(style!);
  const library = paced && own === undefined ? styled.filter((chunk) => chunk.id !== 'shuttle') : styled;
  const opener = style === undefined ? undefined : library.find((chunk) => chunk.id === style.signature);
  const slabs: BodyInit[] = [slab(-2000, PLATFORM_LEVEL.startSlab - 2000, PLATFORM.baseTop)];
  const extras: BodyInit[] = [];
  const pools: BodyInit[] = [];
  const spots = { coinSpots: [] as Spot[], runMids: [] as Spot[], runSides: [] as Spot[] };
  const starts: number[] = [];
  const chunks: PlatformChunkId[] = [];
  let far = PLATFORM_LEVEL.startSlab - 2000;
  let top: number = PLATFORM.baseTop;
  let lastNear = far;
  let section = 0;
  let lastSpikes = 0;
  let shuttled = shuttleZ === undefined;

  const lay = (step: ChunkStep, tier: Tier, index: number): number => {
    const want = step.motion === 'shuttle' ? top : top + step.rise;
    const nextTop = Math.max(PLATFORM.minTop, top - PLATFORM.maxRise, Math.min(PLATFORM.maxTop, top + PLATFORM.maxRise, want));
    const start = far;
    if (step.motion === 'shuttle') {
      const [shortest, longest] = paced ? PLATFORM_SEGMENTS.shuttleGap : PLATFORM_LEVEL.shuttleGap;
      const gap = rng.int(shortest, longest);
      const ride = shuttleBody(far, gap, top);
      extras.push(ride);
      // Úseky průběhu: mince u hrany, kde se na plošinu čeká, a mince, která jede s ní – čekání není mrtvý čas.
      if (paced && params.coins && params.collectAll !== true) extras.push(coin(far - 600, top + 300), { ...coin(ride.z, top + 300), kinematic: true, vz: ride.vz, period: ride.period });
      far += gap;
    } else far += Math.min(typeof step.gap === 'number' ? within(tier.gap, step.gap) : step.gap.fixed, maxGap(nextTop - top));
    if (step.water === true) pools.push({ role: 'obstacle', kind: 'pool', x: 0, y: 0, z: Math.floor((start + far) / 2), w: PLATFORM.slabW, h: PLATFORM.fallBelowY - 200, d: far - start, solid: false });

    const near = far;
    const length = typeof step.slab === 'number' ? within(tier.slab, step.slab) : step.slab.fixed;
    far = near + length;
    top = nextTop;
    slabs.push(slab(near, far, top));
    const spikes = step.spikes ?? (index > 0 && index % tier.spikeEvery === 0 ? 1 : 0);
    lastSpikes = spikes;
    for (let k = 1; k <= spikes; k += 1) {
      const z = Math.floor(near + (length * k) / (spikes + 1));
      extras.push(spikeBody(z, top));
      spots.coinSpots.push({ z, y: top + 1400 });
    }
    if (spikes === 0) {
      const mid = Math.floor((near + far) / 2);
      // S úseky průběhu má rozjezd jen prostřední minci: hra pak k finále houstne, místo aby řídla.
      for (let c = -1; c <= 1; c += 1) if (!paced || section > 0 || c === 0) spots.coinSpots.push({ z: mid + c * 1000, y: top + 300 });
      spots.runMids.push({ z: mid, y: top + 300 });
      spots.runSides.push({ z: mid - 1000, y: top + 300 }, { z: mid + 1000, y: top + 300 });
    }
    return near;
  };

  /** Úsek začíná na odpočinku; checkpoint jen tady, ne na odpočinku uprostřed úseku. */
  const open = (near: number): void => {
    starts.push(near);
    if (params.checkpoints) extras.push(checkpointBody(near + 800, top));
  };
  sectionPlatforms(platforms, paced ? PLATFORM_SEGMENTS.share : PLATFORM_SECTIONS.share).forEach((count, at) => {
    section = at;
    // Úseky průběhu: úsek 3 v obtížnosti úseku 2 (přidá jen rychlost fází), jako `sectionedLayout`.
    const difficulty = sectionDifficulty(params.difficulty, paced ? Math.min(1, section) : section);
    const tier = TIERS[difficulty];
    let index = 0;
    if (section > 0 && chunks[chunks.length - 1] === REST_CHUNK.id) {
      open(lastNear);
      index = 1;
    }
    while (index < count) {
      const chunk = section > 0 && index === 0 ? REST_CHUNK : chunks.length === 0 && opener !== undefined ? opener : pickPlatformChunk(rng, library, PLATFORM_DIFFICULTIES.indexOf(difficulty), chunks[chunks.length - 1]);
      chunks.push(chunk.id);
      for (const step of chunk.build(rng, { top, minTop: PLATFORM.minTop, maxTop: PLATFORM.maxTop, rise: tier.rise, gap: tier.gap })) {
        // Pohyblivá plošina úseku 2 vjede před první krok vzoru za `shuttleZ` (ve stejné výšce, vzor pokračuje za ní).
        // Před odpočinkem, který úsek otevírá, patří plošina ještě předchozímu úseku: úsek pak dál začíná odpočinkem.
        if (!shuttled && far >= (shuttleZ as number)) {
          shuttled = true;
          lastNear = lay({ gap: 0, rise: 0, slab: 50, spikes: 0, motion: 'shuttle' }, tier, index);
          if (!(section > 0 && index === 0)) index += 1;
        }
        lastNear = lay(step, tier, index);
        if (section > 0 && index === 0) open(lastNear);
        // S úseky průběhu checkpoint i uprostřed úseků 2 a 3 (každá `checkpointEvery`. deska bez hrotu).
        if (paced && params.checkpoints && section > 0 && index % PLATFORM_SEGMENTS.checkpointEvery === PLATFORM_SEGMENTS.checkpointEvery - 1 && lastSpikes === 0) extras.push(checkpointBody(lastNear + 800, top));
        index += 1;
      }
    }
  });
  const finalTier = TIERS[sectionDifficulty(params.difficulty, paced ? 1 : 2)];
  if (paced) {
    // Aréna bosse (P46B R5) místo poslední desky: schod a římsa (checkpoint), pak jáma o `pit` níž s cílem.
    const { pit, stairs } = PLATFORM_SEGMENTS;
    const from = far;
    far += Math.min(within(finalTier.gap, rng.int(0, 100)), maxGap(0));
    const floor = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop - pit, top - pit / 2));
    const step = { near: from + Math.min(far - from, maxGap(floor + pit / 2 - top)), top: floor + pit / 2 };
    const ledge = { near: step.near + stairs.step + stairs.gap, top: floor + pit };
    slabs.push(slab(step.near, step.near + stairs.step, step.top), slab(ledge.near, ledge.near + stairs.ledge, ledge.top));
    const near = ledge.near + stairs.ledge;
    far += PLATFORM_SEGMENTS.arena;
    top = floor;
    slabs.push(slab(near, far, top));
    if (params.checkpoints) extras.push(checkpointBody(ledge.near + 800, ledge.top));
    if (params.coins && params.collectAll !== true) extras.push(coin(step.near + stairs.step / 2, step.top + 300), coin(ledge.near + 1800, ledge.top + 300), coin(ledge.near + 3000, ledge.top + 300), coin(far - 3000, top + 300));
  } else {
    // Styl bez chodby s ostny (koruny, lekníny) může vylosovat úroveň bez hrotu; nebezpečí z věty pak nemá tělo. Hrot dostane poslední deska.
    const spiked = extras.some((body) => body.kind === 'spikes');
    lay({ gap: rng.int(0, 100), rise: 0, slab: { fixed: PLATFORM_LEVEL.finalSlab }, spikes: spiked ? 0 : 1 }, finalTier, 0);
  }

  const lastSlab = slabs[slabs.length - 1] as BodyInit;
  const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
  if (paced) {
    // Úsek 3 bez hrotu by nebezpečí neměl vůbec – aréna (poslední tři desky) nahradila desku, která ho dřív dostala.
    const third = starts[1];
    if (third !== undefined) spikeIn(slabs.slice(0, -3), extras, spots, (z) => z >= third);
    // Pevný hrot mimo past: sonda hrozby z věty (první hrot) zasáhne jen ten, který z desky nezajíždí.
    const trap = (z: number): boolean => z * 1000 >= goalZ * PLATFORM_SEGMENTS.trapFrom && z * 1000 < goalZ * PLATFORM_SEGMENTS.trapUntil;
    spikeIn(slabs.slice(1, -3), extras, spots, (z) => !trap(z));
    trapSegment(slabs, extras, spots, trap);
  }
  const bodies = [playerBody(), ...slabs, ...extras];
  placeCoins(bodies, params, spots);
  bodies.push({ role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false });
  // Voda až za hroty: vazba nebezpečí z věty bere první překážku a sonda ji musí umět zasáhnout.
  bodies.push(...pools);
  return { level: { bodies, length: goalZ, sectionStarts: starts }, platforms, chunks, style: style?.id };
}

/** Úroveň z úseků natažená nebo zkrácená po plošinách do `minTicks`..`maxTicks` odhadu robota a aspoň na `lengthM`. */
function fitted<T extends { readonly level: ArcadeLevel; readonly platforms: number }>(params: PlatformLevelParams, layout: (extra: number) => T, minTicks: number = PLATFORM_SECTIONS.minTicks): T {
  const ticks = (level: ArcadeLevel): number => platformPaceTicks(level, params.difficulty, params.segments === true);
  const short = (level: ArcadeLevel): boolean => ticks(level) < minTicks || level.length < params.lengthM * UNIT;
  let extra = 0;
  let built = layout(extra);
  while (short(built.level) && built.platforms < PLATFORM_SECTIONS.maxPlatforms) built = layout((extra += 1));
  while (ticks(built.level) > PLATFORM_SECTIONS.maxTicks && built.platforms > 3) built = layout((extra -= 1));
  return built;
}

function sectionedLevel(seed: number, params: PlatformLevelParams): ArcadeLevel {
  return params.chunks === 1 ? platformChunkLevel(seed, params).level : fitted(params, (extra) => sectionedLayout(seed, params, extra)).level;
}

/** Úroveň ze vzorů, jejich pořadí a styl; vlastní `library` (testy jednotlivých vzorů) styl vypne. */
export function platformChunkLevel(seed: number, params: PlatformLevelParams, library?: readonly PlatformChunk[]): { readonly level: ArcadeLevel; readonly chunks: readonly PlatformChunkId[]; readonly style: PlatformStyleId | undefined } {
  // Lekníny jsou krátké desky: úroveň s věcmi navíc by natahování dorovnalo na stejné minimum jako bez nich. Věc navíc proto přidá i čas.
  // S úseky průběhu dvakrát: první stavba bez pohyblivé plošiny dá délku, druhá ji vloží na `shuttlePermille` té délky.
  const layout = (extra: number) => {
    const first = chunkedLayout(seed, params, extra, library);
    return params.segments === true ? chunkedLayout(seed, params, extra, library, Math.floor((first.level.length * PLATFORM_SEGMENTS.shuttlePermille) / 1000)) : first;
  };
  return fitted(params, layout, PLATFORM_SECTIONS.minTicks + Math.max(0, extraItems(params)) * PLATFORM_SECTIONS.perItemTicks);
}

export const platformLevel: GeneratorPiece<PlatformLevelParams> = {
  id: 'platform_level',
  params: generatorParams,
  roles: ['player', 'platform', 'hazard', 'collectible', 'checkpoint', 'goal'],
  cost: (params) => {
    const slabs = params.sections === undefined ? Math.ceil((params.lengthM * UNIT) / (TIERS[params.difficulty].slab[0] + TIERS[params.difficulty].gap[0])) + 2 : PLATFORM_SECTIONS.maxPlatforms + 1;
    return { bodies: 2 + slabs * 3 + PLATFORM_LEVEL.maxCoins, rules: (params.checkpoints ? 5 : 4) + (params.sections === undefined ? 0 : 1) };
  },
  generate: (seed, params) => {
    if (params.sections !== undefined) return sectionedLevel(seed, params);
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const length = (params.movingPlatforms ? Math.min(params.lengthM, PLATFORM_LEVEL.maxMovingLengthM) : params.lengthM) * UNIT;
    const { startSlab, finalSlab } = PLATFORM_LEVEL;

    const slabs: BodyInit[] = [slab(-2000, startSlab - 2000, PLATFORM.baseTop)];
    const extras: BodyInit[] = [];
    /** Místa na zemi plošin bez hrotu: středy napřed, pak po stranách – sbírání všeho na ně spoléhá. */
    const spots = { coinSpots: [] as Spot[], runMids: [] as Spot[], runSides: [] as Spot[] };
    const { coinSpots, runMids, runSides } = spots;

    let far = startSlab - 2000;
    let top: number = PLATFORM.baseTop;
    for (let index = 1; far < length - finalSlab; index += 1) {
      const shuttle = params.movingPlatforms && index % 5 === 3;
      const rise = shuttle ? 0 : rng.int(-tier.rise, tier.rise);
      const nextTop = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop, top + rise));
      const dh = nextTop - top;

      if (shuttle) {
        // Pohyblivá plošina kyvadlem mezi hranami široké mezery.
        const gap = rng.int(PLATFORM_LEVEL.shuttleGap[0], PLATFORM_LEVEL.shuttleGap[1]);
        extras.push(shuttleBody(far, gap, top));
        far += gap;
      } else {
        const gap = Math.min(rng.int(tier.gap[0], tier.gap[1]), maxGap(dh));
        far += gap;
      }

      const last = far + tier.slab[0] + finalSlab >= length;
      const len = last ? finalSlab : rng.int(tier.slab[0], tier.slab[1]);
      const near = far;
      far = near + len;
      top = nextTop;
      slabs.push(slab(near, far, top));
      if (last) break;

      const mid = Math.floor((near + far) / 2);
      if (index % tier.spikeEvery === 0) {
        extras.push(spikeBody(mid, top));
        // Mince nad hrotem odmění skok přes něj.
        coinSpots.push({ z: mid, y: top + 1400 });
      } else {
        for (let c = -1; c <= 1; c += 1) coinSpots.push({ z: mid + c * 1000, y: top + 300 });
        runMids.push({ z: mid, y: top + 300 });
        runSides.push({ z: mid - 1000, y: top + 300 }, { z: mid + 1000, y: top + 300 });
      }
      if (params.checkpoints && index % 4 === 0) extras.push(checkpointBody(near + 800, top));
    }

    const lastSlab = slabs[slabs.length - 1] as BodyInit;
    const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
    const bodies = [playerBody(), ...slabs, ...extras];
    placeCoins(bodies, params, spots);
    bodies.push({ role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false });
    return { bodies, length: goalZ };
  },
};

/** Ovládání plošinovky z parametrů úrovně; `feel` jen, když ho úroveň nese – svět bez něj je dnešní. */
export function platformControlRef(params: Pick<PlatformLevelParams, 'doubleJump' | 'feel'>): PieceRef {
  return { id: 'platform', params: params.feel === undefined ? { doubleJump: params.doubleJump } : { doubleJump: params.doubleJump, feel: params.feel } };
}

/**
 * Pravidla plošinovky: hrot, mince, cíl, pád; s checkpointy pád vrací místo prohry, se sběrem cíl čeká na všechny věci.
 * Se životy (P36A T2) hrot ubere život a vrátí hráče na poslední checkpoint (bez něj na start); hrot zůstává a vteřinu
 * milosti jím hráč projde. Úroveň z úseků (P36A T4) má hodiny `seconds` (`platformSeconds`).
 */
export function platformRules(params: Pick<PlatformLevelParams, 'checkpoints' | 'collectAll'>, health?: number, seconds?: number): PieceRef[] {
  const rules: PieceRef[] = [
    { id: 'hit', params: health === undefined ? { role: 'hazard', effect: 'lose' } : { role: 'hazard', effect: 'damage', grace: HIT_GRACE, after: 'respawn' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: params.collectAll === true ? { allItems: true } : {} },
    { id: 'fall_out', params: { belowY: PLATFORM.fallBelowY, effect: params.checkpoints ? 'respawn' : 'lose' } },
  ];
  if (params.checkpoints) rules.push({ id: 'checkpoint', params: {} });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  if (seconds !== undefined) rules.push({ id: 'time_limit', params: { seconds } });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

interface Span {
  readonly near: number;
  readonly far: number;
  readonly top: number;
}

/** Kam až deska sahá po trati – u pohyblivé obě krajní polohy. */
function spanOf(body: BodyInit): Span {
  const shift = body.kinematic === true ? (body.vz ?? 0) * (body.period ?? 0) : 0;
  const lo = body.z + Math.min(0, shift);
  const hi = body.z + Math.max(0, shift);
  return { near: lo - body.d / 2, far: hi + body.d / 2, top: body.y + body.h };
}

/**
 * Tvrzení „hratelné z konstrukce“ nad hotovou úrovní: vrací porušení, prázdné
 * pole = hratelná. U pohyblivé plošiny se mezera měří k její bližší krajní
 * poloze (hráč na ni počká).
 */
export function checkPlatformLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const platforms = level.bodies.filter((body) => body.role === 'platform');
  const path = platforms.map((body) => ({ body, span: spanOf(body) })).sort((a, b) => a.span.near - b.span.near);

  path.forEach(({ body, span }, index) => {
    const next = path[index + 1];
    if (next === undefined) return;
    // Z pohyblivé plošiny se skáče, když je u další hrany; na ni, když je u předchozí.
    const from = span.far;
    const to = next.span.near;
    const gap = to - from;
    const dh = next.span.top - span.top;
    // Seskok smí být hlubší – do jámy bosse (R5) se z římsy padá o `pit`.
    if (dh > PLATFORM.maxRise || -dh > Math.max(PLATFORM.maxRise, PLATFORM_SEGMENTS.pit)) issues.push(`step of ${m(dh)} at ${m(to)} is higher than a jump allows`);
    if (gap > maxGap(dh)) issues.push(`gap of ${m(gap)} at ${m(from)} is wider than a jump (${m(maxGap(dh))})`);
    if (dh > 0 && gap >= PLATFORM.playerD && riseTicks(dh) * PLATFORM.maxRun > gap - PLATFORM.playerD) issues.push(`ledge at ${m(to)} is too high to clear over a ${m(gap)} gap`);
  });

  for (const spike of level.bodies.filter((body) => body.role === 'hazard')) {
    // Past (P46B T6) jezdí kyvadlem nahoru a dolů: deska je tam, kde ji past v nejvyšší poloze přečnívá.
    const rise = spike.kinematic === true ? Math.max(0, (spike.vy ?? 0) * (spike.period ?? 0)) : 0;
    const host = path.find(({ span }) => spike.z > span.near && spike.z < span.far && (rise === 0 ? spike.y === span.top : spike.y + spike.h <= span.top && spike.y + spike.h + rise > span.top));
    if (host === undefined) {
      issues.push(`spikes at ${m(spike.z)} do not sit on a platform`);
      continue;
    }
    if (spike.y + spike.h + rise - host.span.top > PLATFORM_JUMP_PEAK / 2) issues.push(`spikes at ${m(spike.z)} are too tall to jump`);
    const before = spike.z - spike.d / 2 - host.span.near;
    const after = host.span.far - (spike.z + spike.d / 2);
    if (before < PLATFORM.spikeMargin || after < PLATFORM.spikeMargin) issues.push(`spikes at ${m(spike.z)} leave no room to run up or land`);
  }

  const player = level.bodies[0];
  const first = path[0];
  if (player === undefined || first === undefined || player.z <= first.span.near || player.z >= first.span.far || player.y !== first.span.top) issues.push('the player does not start on the first platform');
  const goal = level.bodies.find((body) => body.role === 'goal');
  const last = path[path.length - 1];
  if (goal === undefined || last === undefined || goal.z <= last.span.near || goal.z >= last.span.far || goal.y !== last.span.top) issues.push('no goal on the last platform');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
