/**
 * Výzdoba vnitřku arény (P36C T5): trsy trávy, květy, kamínky, louže, závěje,
 * krystaly, koberečky a drobnosti podle povrchu sady. Do P36C byl vnitřek
 * arény jednolitá plocha – kulisy stály jen za stěnami.
 *
 * Celá výzdoba je jedna síť (barvy ve vrcholech, flat shading): kusy se nehýbou,
 * takže slitá síť stojí jedno kreslicí volání – míň než instancing po druzích.
 * Žádné fyzikální tělo, jádro o ní neví; leží mimo hrdinu a věci na startu
 * (`keep`) a je tak nízká (`DECOR_TALLEST`), že nic nezakryje.
 *
 * Rozmístění je z vlastního streamu `pure-rand` nasoleného semínkem hry:
 * tatáž hra má tutéž výzdobu, jiná hra jinou, a z běhových streamů jádra se
 * neodebere ani jedna hodnota – hash replaye se nehne.
 *
 * Za hranou (P54B T9) stojí kusy sady 0,5–2 m z její vegetace (`arenaRingPlaces`):
 * prstenec v mezeře mezi hranou a stěnou po stranách a vzadu a 2–4 shluky
 * u předních rohů, blíž kameře. Strana kamery (−z) prstenec nemá: co by bylo nižší
 * než přední stěna, ta zakryje, a co vyšší, zakrylo by paty hrdiny u přední hrany.
 * Druh je jedna instancovaná síť bez stínu (`ringMesh`), druhů nejvýš `RING_KINDS`.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { type BufferGeometry, Color, InstancedMesh, type Material, Matrix4, Vector3 } from 'three';

import { color as brand } from '@/brand/tokens';
import type { Look } from '@/play/arcade/look';

import { reachOf } from '../../vegetation-places';
import { ARENA_WALL_GAP, arenaPalette } from './arenaFloor';
import { Faces, type Vertex } from './islands';
import { hash, mix, noise } from './valley';

export type DecorKind = 'tuft' | 'flower' | 'pebble' | 'puddle' | 'drift' | 'shard' | 'rug' | 'bit';

export interface DecorKeep {
  /** Střed místa, kam výzdoba nesmí (m ve scéně). */
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

export interface DecorPiece {
  readonly kind: DecorKind;
  readonly x: number;
  readonly z: number;
  /** Násobek základní velikosti druhu. */
  readonly size: number;
  readonly turn: number;
}

export interface ArenaDecorOptions {
  readonly look: Look;
  /** Půl strany hrací plochy (m). */
  readonly half: number;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  readonly keep: readonly DecorKeep[];
}

/** Nejvyšší bod výzdoby (m): pod kolenem hrdiny 1,3 m, nezakryje věc 0,7 m ani hrdinu. */
export const DECOR_TALLEST = 0.45;

/** Sůl semínka – stream výzdoby je jiný než každý stream jádra. */
const SALT = 0x6dec0a7e;
/** Kusů na m² hrací plochy (ve skvrnách hustěji) a horní mez. */
const DENSITY = 0.3;
const MOST = 480;
/** Odstup kusu od hrany arény (m). */
const EDGE = 0.4;
/** Poloměr kusu při velikosti 1 (m) – s ním se hlídá hrana a místa věcí. */
const REACH: Readonly<Record<DecorKind, number>> = { tuft: 0.3, flower: 0.12, pebble: 0.18, puddle: 0.6, drift: 0.55, shard: 0.16, rug: 0.65, bit: 0.12 };

/** Druhy podle povrchu s vahou; vnitřek (sada bez slunce) má koberečky a drobnosti, ne trávu a louže. */
function kindsOf(look: Look): readonly (readonly [DecorKind, number])[] {
  switch (look.cover) {
    case 'grass':
      return [['tuft', 6], ['flower', 2], ['pebble', 2]];
    case 'snow':
      return [['drift', 4], ['pebble', 2], ['shard', 1]];
    case 'sand':
      return [['pebble', 4], ['tuft', 3]];
    case 'rock':
      return [['pebble', 5], ['shard', 2]];
    case 'paving':
      return look.glow === 0 ? [['rug', 2], ['bit', 4]] : [['pebble', 4], ['tuft', 3], ['puddle', 1]];
  }
}

export function arenaDecorPlaces({ look, half, seed, keep }: ArenaDecorOptions): DecorPiece[] {
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  const kinds = kindsOf(look);
  const total = kinds.reduce((sum, [, weight]) => sum + weight, 0);
  const wanted = Math.min(MOST, Math.round((2 * half) ** 2 * DENSITY));
  const patch = next() * 100;
  const pieces: DecorPiece[] = [];
  for (let tries = 0; pieces.length < wanted && tries < wanted * 8; tries += 1) {
    const x = (next() * 2 - 1) * (half - EDGE);
    const z = (next() * 2 - 1) * (half - EDGE);
    // Ve skvrnách: kde šum vyšel vysoko, hustě, jinde řídce – rovnoměrný posyp vypadá jako vzorník.
    if (noise(x * 0.22 + patch, z * 0.22) < next() * 0.9) continue;
    let pick = next() * total;
    const kind = kinds.find(([, weight]) => (pick -= weight) < 0)?.[0] ?? kinds[0]![0];
    const size = 0.75 + next() * 0.5;
    const turn = next() * Math.PI * 2;
    const r = REACH[kind] * size;
    if (Math.max(Math.abs(x), Math.abs(z)) + r > half - EDGE) continue;
    if (keep.some((spot) => Math.hypot(x - spot.x, z - spot.z) < spot.r + r)) continue;
    pieces.push({ kind, x, z, size, turn });
  }
  return pieces;
}

/** Kus sady za hranou arény (P54B T9): model katalogu z vegetace sady. */
export interface RingPiece {
  readonly id: string;
  /** Pata ve scéně (m). */
  readonly x: number;
  readonly z: number;
  /** Výška kusu (m), `RING_LOWEST`–`RING_TALLEST`. */
  readonly height: number;
  readonly turn: number;
  /** Násobek barvy po složkách, každá 0,92–1,08 – jako vegetace. */
  readonly shade: readonly [r: number, g: number, b: number];
  /** Poloměr půdorysu (m): kružnice opsaná modelu z rozměrů v katalogu. */
  readonly reach: number;
  /** Rohový shluk, do kterého kus patří; `null` = prstenec. */
  readonly cluster: number | null;
}

/** Nejvýš tolik druhů v prstenci a shlucích: druh = instancovaná síť = kreslicí volání. */
export const RING_KINDS = 6;
/** Výška kusu (m): nižší by za hranou zanikl, vyšší by přerostl stěnu i hrdinu. */
export const RING_LOWEST = 0.5;
export const RING_TALLEST = 2;
/** Sůl prstence – stream jiný než výzdoba podlahy, vegetace i orientační bod. */
const RING_SALT = 0x3a9c51e7;
/** Nejširší půdorys kusu (m): kus stojí těsně za hranou a zády se nejvýš opře o stěnu. */
const RING_REACH = 0.9;
/** Strom nebo balvan středu vegetace se do prstence vejde stažený pod tuhle výšku (m), pak ± náhoda. */
const RING_NATURAL = 1.6;
/** Mezera mezi kusy prstence (m): nejmenší a rozpětí; druhá mocnina náhody kusy shlukuje do dvojic. */
const RING_SPACING = [0.2, 2.8] as const;
/** Střed rohového shluku za hranou (m): před nejširší rohovou věží (hrad sahá 3,1 m) – a rozptyl kusů kolem něj. */
const CLUSTER_AT = 3.6;
const CLUSTER_SPREAD = [0.7, 1.4] as const;

interface RingSpecies {
  readonly id: string;
  /** Výška druhu v sadě (m). */
  readonly height: number;
  /** Poloměr půdorysu na metr výšky. */
  readonly ratio: number;
  /** Druh středu vegetace (strom, balvan, keř v květináči) – dává prstenci výšku. */
  readonly tall: boolean;
}

function ringSpecies(look: Look): RingSpecies[] {
  if (look.flora === undefined) return [];
  const seen = new Set<string>();
  const pool: RingSpecies[] = [];
  for (const layer of ['near', 'mid'] as const) {
    for (const { id, height } of look.flora[layer]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ratio = reachOf(id);
      // Plochý široký kus (palouk květin) by se do mezery nevešel ani v nejmenší výšce.
      if (ratio * RING_LOWEST <= RING_REACH) pool.push({ id, height, ratio, tall: layer === 'mid' });
    }
  }
  return pool;
}

/** Modely, ze kterých prstenec sady vybírá: drobnosti a střed její vegetace. */
export const arenaRingPool = (look: Look): string[] => ringSpecies(look).map((species) => species.id);

/** Vzdálenost bodu od hrací plochy (čtverec ±`half`); na ploše 0. */
const offFloor = (half: number, x: number, z: number): number => Math.hypot(Math.max(0, Math.abs(x) - half), Math.max(0, Math.abs(z) - half));
const tone = (value: number): number => Math.min(1.08, Math.max(0.92, value));

function shuffled<T>(list: readonly T[], next: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Výška kusu: druh ve své velikosti v sadě × náhoda × `boost`, v mezích a s půdorysem nejvýš `RING_REACH`. */
const heightOf = (species: RingSpecies, boost: number, u: number): number =>
  Math.min(RING_TALLEST, RING_REACH / species.ratio, Math.max(RING_LOWEST, Math.min(species.height, RING_NATURAL) * (0.8 + 0.5 * u) * boost));

/**
 * Prstenec a rohové shluky (P54B T9). Půdorys žádného kusu nesahá na hrací plochu
 * ani do `keep` – jádro o kusech neví, kus v cestě by hráč viděl jako překážku, kterou projde.
 */
export function arenaRingPlaces({ look, half, seed, keep }: ArenaDecorOptions): RingPiece[] {
  const rng = xoroshiro128plus((seed ^ RING_SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  // První výstupy xoroshiro nasoleného blízkými semínky jsou skoro stejné: dva se zahodí (jako u orientačního bodu).
  next();
  next();
  const pool = ringSpecies(look);
  // Většinou drobnosti, k nim dva druhy středu pro výšku; chybí-li jedny, doplní je druhé.
  const low = shuffled(pool.filter((species) => !species.tall), next);
  const high = shuffled(pool.filter((species) => species.tall), next);
  const kinds = [...low.slice(0, RING_KINDS - 2), ...high.slice(0, 2)];
  kinds.push(...[...low.slice(RING_KINDS - 2), ...high.slice(2)].slice(0, RING_KINDS - kinds.length));
  if (kinds.length === 0) return [];
  // Druhy jdou z balíčku: každý se ukáže, než se některý zopakuje, a pořadí přesto nemá periodu.
  let deck: RingSpecies[] = [];
  const draw = (): RingSpecies => {
    if (deck.length === 0) deck = shuffled(kinds, next);
    return deck[deck.length - 1]!;
  };
  const pieces: RingPiece[] = [];
  /** Postaví kus, pokud jeho půdorys nesahá na plochu ani do `keep`; jinak druh zůstane v balíčku na příště. */
  const put = (species: RingSpecies, x: number, z: number, height: number, cluster: number | null): void => {
    const reach = species.ratio * height;
    const turn = next() * Math.PI * 2;
    const light = 0.92 + 0.16 * next();
    const hue = (next() - 0.5) * 0.04;
    // Kus u hrany stojí přesně `reach` od ní – bez tolerance by ho zaokrouhlení odmítlo pořád znovu.
    if (offFloor(half, x, z) < reach - 1e-9 || keep.some((spot) => Math.hypot(x - spot.x, z - spot.z) < spot.r + reach)) return;
    deck.pop();
    pieces.push({ id: species.id, x, z, height, turn, shade: [tone(light + hue), light, tone(light - hue)], reach, cluster });
  };

  // Prstenec po stranách (±x) a vzadu (+z): kus těsně za hranou, střed nejdál v mezeře před stěnou.
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1]] as const) {
    for (let t = -half; ; ) {
      const species = draw();
      const height = heightOf(species, 1, next());
      const reach = species.ratio * height;
      const along = t + reach;
      if (along + reach > half) break;
      const out = half + reach + next() * Math.max(0, ARENA_WALL_GAP - reach);
      put(species, nx === 0 ? along : nx * out, nz === 0 ? along : out, height, null);
      t = along + reach + RING_SPACING[0] + RING_SPACING[1] * next() ** 2;
    }
  }

  // Rohové shluky u předních rohů (blíž kameře): před přední stěnou vždy, vedle boční se semínkem – celkem 2–4.
  let cluster = 0;
  for (const sx of [-1, 1]) {
    const centres: (readonly [number, number])[] = [[sx * (half - 0.5 + 2.5 * next()), -(half + CLUSTER_AT + 0.8 * next())]];
    if (next() < 0.5) centres.push([sx * (half + CLUSTER_AT + 0.8 * next()), -(half - 0.5 + 2.5 * next())]);
    for (const [cx, cz] of centres) {
      const count = 3 + Math.floor(next() * 3);
      const spin = next() * Math.PI * 2;
      for (let k = 0; k < count; k += 1) {
        const species = draw();
        // Prostřední kus je největší, kolem něj menší: shluk má vršek, ne řadu stejných.
        const height = heightOf(species, k === 0 ? 1.3 : 0.85, next());
        const angle = spin + (k * Math.PI * 2) / (count - 1) + (next() - 0.5) * 0.6;
        const r = k === 0 ? 0 : CLUSTER_SPREAD[0] + (CLUSTER_SPREAD[1] - CLUSTER_SPREAD[0]) * next();
        put(species, cx + Math.cos(angle) * r, cz + Math.sin(angle) * r, height, cluster);
      }
      cluster += 1;
    }
  }
  return pieces;
}

/** Kusy po druzích: scéna kreslí každý druh jednou instancovanou sítí. */
export function ringKindsOf(pieces: readonly RingPiece[]): Map<string, RingPiece[]> {
  const kinds = new Map<string, RingPiece[]>();
  for (const piece of pieces) {
    const list = kinds.get(piece.id);
    if (list === undefined) kinds.set(piece.id, [piece]);
    else list.push(piece);
  }
  return kinds;
}

/**
 * Síť jednoho druhu: geometrie vysoká 1 s patou v počátku (`paintedPlant`), instance
 * natočená, ve výšce kusu a s jeho odstínem. Stín jen přijímá – vrhání by stálo další
 * volání ve stínovém průchodu; značka rigu (`rigShadow`) to drží.
 */
export function ringMesh(pieces: readonly RingPiece[], geometry: BufferGeometry, material: Material): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, pieces.length);
  const matrix = new Matrix4();
  const scale = new Vector3();
  const color = new Color();
  pieces.forEach((piece, i) => {
    mesh.setMatrixAt(i, matrix.makeRotationY(piece.turn).scale(scale.setScalar(piece.height)).setPosition(piece.x, 0, piece.z));
    mesh.setColorAt(i, color.setRGB(piece.shade[0], piece.shade[1], piece.shade[2]));
  });
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData = { rigShadow: 'receive', terrain: 'arena-ring' };
  mesh.computeBoundingSphere();
  return mesh;
}

/** Trojúhelník s normálou od `inside` ven – kus se pak dá skládat bez hlídání pořadí vrcholů. */
function outward(faces: Faces, a: Vertex, b: Vertex, c: Vertex, inside: Vertex, color: Color): void {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const out = [(a[0] + b[0] + c[0]) / 3 - inside[0], (a[1] + b[1] + c[1]) / 3 - inside[1], (a[2] + b[2] + c[2]) / 3 - inside[2]];
  if (n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]! >= 0) faces.tri(a, b, c, color);
  else faces.tri(a, c, b, color);
}

/** Prstenec `count` bodů elipsy kolem (x, z) ve výšce `y`, otočené o `turn`; `jitter` mění poloměr bod od bodu. */
function ring(x: number, z: number, y: number, rx: number, rz: number, count: number, turn: number, salt: number, jitter: number): Vertex[] {
  return Array.from({ length: count }, (_, i): Vertex => {
    const angle = (i / count) * Math.PI * 2;
    const k = 1 + (hash(salt, i) - 0.5) * jitter;
    const [u, v] = [Math.cos(angle) * rx * k, Math.sin(angle) * rz * k];
    return [x + u * Math.cos(turn) - v * Math.sin(turn), y, z + u * Math.sin(turn) + v * Math.cos(turn)];
  });
}

/** Hrbol: spodní prstenec na zemi, horní zúžený, vršek. Kamínek, závěj. */
function mound(faces: Faces, base: Vertex[], top: Vertex[], apex: Vertex, color: Color, side: Color): void {
  const inside: Vertex = [apex[0], 0, apex[2]];
  for (let i = 0; i < base.length; i += 1) {
    const j = (i + 1) % base.length;
    outward(faces, base[i]!, base[j]!, top[i]!, inside, side);
    outward(faces, base[j]!, top[j]!, top[i]!, inside, side);
    outward(faces, top[i]!, top[j]!, apex, [apex[0], -1, apex[2]], color);
  }
}

/** Trojboký jehlan se špičkou nakloněnou o `lean` ve směru `angle`: stéblo, krystal. */
function spike(faces: Faces, x: number, z: number, h: number, w: number, lean: number, angle: number, color: Color): void {
  const base = ring(x, z, 0, w, w, 3, angle, Math.round(x * 97 + z * 31), 0);
  const tip: Vertex = [x + Math.cos(angle) * lean, h, z + Math.sin(angle) * lean];
  const inside: Vertex = [x, h / 3, z];
  for (let i = 0; i < 3; i += 1) outward(faces, base[i]!, base[(i + 1) % 3]!, tip, inside, color);
}

/** Kvádr na zemi (bez spodku), otočený o `turn`: koberec, drobnost. */
function slab(faces: Faces, x: number, z: number, w: number, d: number, h: number, turn: number, top: Color, side: Color): void {
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const at = (u: number, v: number, y: number): Vertex => [x + u * c - v * s, y, z + u * s + v * c];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const low = corners.map(([u, v]) => at((u * w) / 2, (v * d) / 2, 0));
  const high = corners.map(([u, v]) => at((u * w) / 2, (v * d) / 2, h));
  const inside: Vertex = [x, h / 2, z];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    outward(faces, low[i]!, low[j]!, high[i]!, inside, side);
    outward(faces, low[j]!, high[j]!, high[i]!, inside, side);
  }
  outward(faces, high[0]!, high[1]!, high[2]!, inside, top);
  outward(faces, high[0]!, high[2]!, high[3]!, inside, top);
}

/** Síť celé výzdoby arény – jedna, s barvami z palety sady. */
export function buildArenaDecor(options: ArenaDecorOptions): BufferGeometry {
  const { look } = options;
  const palette = arenaPalette(look);
  const tones = {
    // Stébla světlejší než zem, do žluta jako tráva na slunci – tmavá na tmavé zeleni nebyla vidět.
    blade: [mix(palette.floor, brand.sun, 0.3), mix(palette.floor, brand.sun, 0.5), mix(palette.floor, '#ffffff', 0.25)],
    sandBlade: [mix(look.tint[0], palette.floor, 0.3), mix(look.tint[0], '#000000', 0.25)],
    petal: [brand.sun, brand.tomato, brand.paper, brand.bubblegum],
    stone: [mix(palette.wall, palette.floor, 0.35), mix(palette.wall, '#ffffff', 0.15), mix(palette.wall, '#000000', 0.2)],
    // Louže odráží oblohu u obzoru, ne vodu sady: modrá vody hradu se šedou dlažbou dala fialovou.
    puddle: mix(mix(palette.floor, look.horizon, 0.35), '#000000', 0.22),
    snow: mix(palette.land, '#ffffff', 0.6),
    crystal: [look.tint[0], mix(look.tint[0], '#ffffff', 0.35)],
    rug: [mix(look.tint[0], palette.floor, 0.25), mix(look.tint[1], palette.floor, 0.25)],
    bit: [look.tint[0], look.tint[1], brand.sun],
  };
  const paint = new Color();
  const shadow = new Color();
  const tint = (hex: string, scale = 1): Color => paint.set(hex).multiplyScalar(scale);
  const side = (hex: string): Color => shadow.set(hex).multiplyScalar(0.82);
  const faces = new Faces();
  arenaDecorPlaces(options).forEach(({ kind, x, z, size, turn }, i) => {
    const salt = options.seed + i * 13;
    const tone = 0.92 + 0.16 * hash(salt, 1);
    const one = (list: readonly string[]): string => list[Math.floor(hash(salt, 2) * list.length)]!;
    switch (kind) {
      case 'tuft': {
        const hex = one(look.cover === 'sand' ? tones.sandBlade : tones.blade);
        // Pět stébel do vějíře: tři zmizela z kamery 16 m nad zemí jako tečka.
        for (let k = 0; k < 5; k += 1) {
          const angle = turn + (k * Math.PI * 2) / 5;
          const [bx, bz] = [x + Math.cos(angle) * 0.1 * size, z + Math.sin(angle) * 0.1 * size];
          spike(faces, bx, bz, (0.24 + 0.1 * hash(salt, k + 3)) * Math.min(size, 1.1), 0.06 * size, 0.14 * size, angle, tint(hex, tone));
        }
        break;
      }
      case 'flower': {
        const stem = 0.3 * Math.min(size, 1.1);
        spike(faces, x, z, stem, 0.035, 0.03, turn, tint(tones.blade[0]!, tone));
        const head = 0.06 * size;
        const centre: Vertex = [x + Math.cos(turn) * 0.03, stem, z + Math.sin(turn) * 0.03];
        const petals = ring(centre[0], centre[2], stem, head, head, 5, turn, salt, 0.2);
        const hex = one(tones.petal);
        for (let k = 0; k < 5; k += 1) {
          const [a, b] = [petals[k]!, petals[(k + 1) % 5]!];
          outward(faces, a, b, [centre[0], stem + head * 0.9, centre[2]], [centre[0], stem, centre[2]], tint(hex));
          outward(faces, a, b, [centre[0], stem - head * 0.6, centre[2]], [centre[0], stem, centre[2]], side(hex));
        }
        break;
      }
      case 'pebble': {
        const r = 0.13 * size;
        const h = r * (0.5 + 0.3 * hash(salt, 4));
        const hex = one(tones.stone);
        mound(faces, ring(x, z, 0, r, r * 0.75, 5, turn, salt, 0.35), ring(x, z, h * 0.7, r * 0.65, r * 0.5, 5, turn + 0.3, salt + 1, 0.3), [x, h, z], tint(hex, tone), side(hex));
        break;
      }
      case 'puddle': {
        const rim = ring(x, z, 0.012, 0.35 * size, 0.22 * size, 7, turn, salt, 0.35);
        for (let k = 0; k < 7; k += 1) outward(faces, rim[k]!, rim[(k + 1) % 7]!, [x, 0.012, z], [x, -1, z], tint(tones.puddle, tone));
        break;
      }
      case 'drift': {
        const h = 0.14 + 0.06 * hash(salt, 4);
        mound(faces, ring(x, z, 0, 0.45 * size, 0.28 * size, 5, turn, salt, 0.3), ring(x, z, h * 0.75, 0.25 * size, 0.15 * size, 5, turn, salt + 1, 0.3), [x, h, z], tint(tones.snow, tone), tint(tones.snow, 0.94));
        break;
      }
      case 'shard': {
        const hex = one(tones.crystal);
        for (let k = 0; k < 2 + Math.floor(hash(salt, 5) * 2); k += 1) {
          const angle = turn + k * 2.1;
          spike(faces, x + Math.cos(angle) * 0.05, z + Math.sin(angle) * 0.05, (0.2 + 0.15 * hash(salt, k + 6)) * Math.min(size, 1.1), 0.06 * size, 0.1, angle, tint(hex, tone));
        }
        break;
      }
      case 'rug': {
        const hex = one(tones.rug);
        slab(faces, x, z, 0.9 * size, 0.6 * size, 0.035, turn, tint(hex, tone), side(hex));
        break;
      }
      case 'bit': {
        const hex = one(tones.bit);
        const w = 0.14 * size;
        slab(faces, x, z, w, w * (0.7 + 0.5 * hash(salt, 4)), w * 0.8, turn, tint(hex, tone), side(hex));
        break;
      }
    }
  });
  return faces.geometry();
}
