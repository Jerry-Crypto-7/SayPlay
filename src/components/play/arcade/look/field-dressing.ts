/**
 * Kulisy uvnitř hrací plochy (P62 T4) – čistá část `FieldDressing` ve `Scenery.tsx`.
 *
 * Do P62 stály kulisy sady jen za hranou hrací plochy (řady `Scenery`, orientační bod, rámující
 * kusy) a slepý soudce o aréně psal „řídké béžové prostředí, kulisy jen daleko na okraji“. Teď
 * dostane plocha arény (útěk, sběr, souboj, úkol) a kužel míření střelnice 4–10 kusů ze sady
 * místa, které vybral look (`fieldPool`: kit místa z věty a rekvizity sady; sada, jejíž věci
 * jsou orientační body, i drobnosti své vegetace).
 *
 * Jen vzhled: kus nemá tělo, jádro o něm neví a hash stavu se nehne. Rozmístění bere vlastní
 * stream `pure-rand` nasolený semínkem hry, z běhových streamů jádra se neodebere ani jedna hodnota.
 *
 * Kus se nedotkne ničeho, co se hraje (`FieldJob` spočítá z běhu robota `field-dressing-worker.ts`):
 * hrdiny na cestě robota, spawnu žádného kresleného těla a u střelnice dráhy nepřítele či terče –
 * odstup je půlka těla z `bodies.ts`, rezerva `KEEP_M` na model větší než tělo a půdorys kusu.
 * A kus nikdy není vyšší než nejnižší paprsek herní kamery, který nad ním jde k něčemu z toho:
 * hrdinu ani nepřítele nezakryje. Polovina kusů stojí kousek od cesty robota, ať jsou v záběru.
 *
 * Aréna, kde hrdina chodí volně (kamera `follow`, P71E T3), smí jen kusy pod koleno: hráč nejde cestou
 * robota a vysokým kusem bez těla projde (QA 5. 11.: čaroděj kamennou zdí). Dnes tam nestojí žádný.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { isSceneryModel, landmarks, type Look, modelHeight, type SceneryModel } from '@/play/arcade/look';

import { landmarkPicks } from './landmark-places';
import { DECOR_TALLEST } from './rig/terrain/arenaDecor';
import { reachOf } from './vegetation-places';

/** Nejméně a nejvýš kusů v hrací ploše; počet dává její plocha (`M2_PER_PIECE`). */
export const FIELD_LEAST = 4;
export const FIELD_MOST = 10;
/** Kus na tolik m² plochy: aréna 40 × 40 m jich má 10, souboj 18 × 18 m 4. */
const M2_PER_PIECE = 150;
/** Nejvyšší kus (m): asi 1,7 výšky hrdiny arény (1,3 m), přes vyšší by kamera pod 40° hrdinu za ním neviděla. */
export const FIELD_TALLEST_M = 2.2;
/** Nižší kus (m) v ploše zanikne; menší modely sady (účtenka, bageta) se do výběru nedostanou. */
const FIELD_LOWEST_M = 0.5;
const FIELD_SMALLEST_M = 0.6;
/** Nejširší půdorys kusu (poloměr, m): pult přes půl arény by byl zeď, ne kulisa. */
const FIELD_REACH_M = 1.2;
/** Rezerva k půlce těla (m): kreslený model je větší než tělo jádra (hrdina 1 × 0,6 m se kreslí 1,3 m). */
const KEEP_M = 0.5;
/**
 * Volný kruh kolem místa, kde hrdina začíná (m od středu k půdorysu kusu): první snímek hry ukazuje
 * hrdinu, ne trůn přilepený k jeho kroužku (snímek P62 T4 hradu před touhle mezí).
 */
export const START_CLEAR_M = 2.5;
/** Mezera mezi půdorysy dvou kusů (m), v malé ploše nejvýš osmina její šířky: kuchyň stanoviště má 9 × 9 m a pult ji půlí. */
const PIECE_GAP_M = 1.5;
/**
 * Kus se nezmenší pod tenhle podíl své velikosti v sadě (strop výšky a půdorysu v `fieldPool`)
 * ani pod tenhle podíl kvůli paprsku kamery (`roofOf`): eskalátor na čtvrtinu je hračka, ne kulisa.
 */
const LEAST_SCALE = 0.5;
const LEAST_ROOF = 0.7;
/** Podíl pokusů, které hledají místo kousek od cesty robota, a jak daleko od ní (m). */
const NEAR_SHARE = 0.6;
const NEAR_M = [2.5, 7] as const;
/** Pokusů na chtěný kus; kde se plocha zaplní, kusů je méně. */
const TRIES = 80;
/** Sůl semínka – stream výzdoby plochy je jiný než každý stream jádra, výzdoby podlahy i orientačního bodu. */
const SALT = 0x2f1e1d4b;

/**
 * Tělo, kterého se kus nedotkne: střed (m ve scéně), půlky jeho kvádru jako v jádře (AABB, `bodies.ts`)
 * a výška (kamera míří do jeho půlky). Pult stanoviště je 10 m dlouhý: kruh kolem něj by zabral celou kuchyň.
 */
export interface FieldSpot {
  readonly x: number;
  readonly z: number;
  readonly hx: number;
  readonly hz: number;
  readonly h: number;
}

/** Odstup kruhu (střed `x`, `z`) od kvádru těla na zemi (m); uvnitř 0. */
const gapTo = (spot: FieldSpot, x: number, z: number): number => Math.hypot(Math.max(0, Math.abs(x - spot.x) - spot.hx), Math.max(0, Math.abs(z - spot.z) - spot.hz));

/** Kde smí stát kus (m ve scéně): obdélník a u střelnice ještě kužel míření z místa hráče do dostřelu. */
export interface FieldArea {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly cone?: { readonly x: number; readonly z: number; readonly tan: number; readonly range: number };
}

/**
 * Herní kamera, které kus nesmí nic zakrýt: `follow` = jede za hrdinou ze strany −z se sklonem
 * (tangens nad vodorovnou), `eyes` = pevná místa kamery (m ve scéně).
 */
export type FieldView = { readonly follow: number } | { readonly eyes: readonly (readonly [x: number, y: number, z: number])[] };

/** Co worker spočte z běhu robota: plocha, kamera, kde hrdina začíná, hrdina na cestě a ostatní těla. */
export interface FieldJob {
  readonly area: FieldArea;
  readonly view: FieldView;
  readonly start: { readonly x: number; readonly z: number };
  readonly path: readonly FieldSpot[];
  readonly bodies: readonly FieldSpot[];
}

/** Model sady (`plant: false`), nebo druh její vegetace (`plant: true`, kreslí se v barvách sady). */
export type FieldKind = { readonly plant: false; readonly kind: SceneryModel } | { readonly plant: true; readonly kind: string };

/** Kus v hrací ploše: pata (m), výška (m), natočení a poloměr půdorysu (m). */
export type FieldPiece = FieldKind & {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly turn: number;
  readonly reach: number;
};

/** Kus pro plochu: výška v sadě (m) a poloměr půdorysu na metr výšky. */
export type Pooled = FieldKind & {
  readonly height: number;
  readonly ratio: number;
};

/** Méně modelů mimo kandidáty orientačního bodu: plocha si vezme i vegetaci sady a kandidáty, které semínko nepostavilo. */
const POOL_LEAST = 2;

/** Kus se pod strop výšky `FIELD_TALLEST_M` a půdorysu `FIELD_REACH_M` vejde aspoň v polovině své velikosti. */
const fits = ({ height, ratio }: { readonly height: number; readonly ratio: number }): boolean =>
  Number.isFinite(ratio) && height >= FIELD_SMALLEST_M && Math.min(FIELD_TALLEST_M, FIELD_REACH_M / ratio) >= LEAST_SCALE * height;

/**
 * Z čeho plocha vybírá: modely sady mimo rostliny vegetace (`landmarks`), které se do plochy vejdou
 * (dům ani padací most se nezmenší na hračku), a bez kandidátů orientačního bodu. Sada, které pak
 * skoro nic nezbude (les, džungle, poušť – jejich věci jsou orientační body), dostane i drobnosti
 * a střed své vegetace (kapradí, balvany, banánovník) a kandidáty bodu – nikdy ten, kterého semínko
 * staví za hru (`landmarkPicks`): malá kašna pod velkou by vypadala jako omyl.
 */
export function fieldPool(look: Look, seed: number): Pooled[] {
  const models = [...new Set(landmarks(look))]
    .filter((kind): kind is SceneryModel => isSceneryModel(kind))
    .map((kind): Pooled => ({ plant: false, kind, height: modelHeight(kind), ratio: reachOf(kind) }))
    .filter(fits);
  const own = models.filter(({ kind }) => !(look.landmark as readonly string[]).includes(kind));
  if (own.length >= POOL_LEAST) return own;
  const placed = landmarkPicks(look, seed).landmark;
  const species = look.flora === undefined ? [] : [...new Map([...look.flora.near, ...look.flora.mid].map((plant) => [plant.id, plant.height])).entries()];
  const plants = species.map(([kind, height]): Pooled => ({ plant: true, kind, height, ratio: reachOf(kind) })).filter(fits);
  return [...models.filter(({ kind }) => kind !== placed), ...plants];
}

/** Celý půdorys v hrací ploše. */
function inside(area: FieldArea, x: number, z: number, reach: number): boolean {
  if (x - reach < area.x0 || x + reach > area.x1 || z - reach < area.z0 || z + reach > area.z1) return false;
  const cone = area.cone;
  return cone === undefined || (Math.abs(x - cone.x) + reach <= (z - cone.z) * cone.tan && Math.hypot(x - cone.x, z - cone.z) + reach <= cone.range);
}

/** Plocha (m²): obdélník, u kuželu jeho výseč mezi `z0` a `z1`. */
function areaM2(area: FieldArea): number {
  const cone = area.cone;
  if (cone === undefined) return (area.x1 - area.x0) * (area.z1 - area.z0);
  return cone.tan * ((area.z1 - cone.z) ** 2 - (area.z0 - cone.z) ** 2);
}

/**
 * Nejnižší paprsek herní kamery nad půdorysem kusu k něčemu, co se hraje (m nad zemí);
 * kus pod ním nic nezakryje. Paprsek míří do půlky těla a stoupá ke kameře; nad kusem se
 * měří v jeho nejbližším kraji k tělu. simplified: všechna místa × oči pro každý pokus
 * (~1–3 tisíce míst, stovky pokusů ve workeru); mřížka by pomohla až u ploch s desítkami tisíc míst.
 */
function roofOf(view: FieldView, spots: readonly FieldSpot[], x: number, z: number, reach: number): number {
  let roof = Infinity;
  for (const spot of spots) {
    const centre = spot.h / 2;
    if ('follow' in view) {
      // Kamera za hrdinou z −z: paprsky jdou od přední stěny kvádru k −z, kus za ní nic nezakryje.
      const along = spot.z - spot.hz - z;
      if (Math.abs(x - spot.x) >= reach + spot.hx || along < -reach) continue;
      roof = Math.min(roof, centre + Math.max(0, along - reach) * view.follow);
      continue;
    }
    // Pevná kamera střelnice: nepřítel a terč jsou malé, kvádr stačí opsat kruhem.
    const clear = reach + Math.max(spot.hx, spot.hz);
    for (const [ex, ey, ez] of view.eyes) {
      const dx = ex - spot.x;
      const dz = ez - spot.z;
      const length = Math.hypot(dx, dz);
      const along = ((x - spot.x) * dx + (z - spot.z) * dz) / length;
      if (along < -clear || along > length) continue;
      if (Math.abs((x - spot.x) * dz - (z - spot.z) * dx) / length >= clear) continue;
      roof = Math.min(roof, centre + (Math.max(0, along - reach) * (ey - centre)) / length);
    }
  }
  return roof;
}

/** 4–10 kusů sady v hrací ploše ze semínka hry; prázdné = sada žádný vhodný model nemá. */
export function fieldDressing({ look, seed, area, view, start, path, bodies }: FieldJob & { readonly look: Look; readonly seed: number }): FieldPiece[] {
  const pool = fieldPool(look, seed);
  if (pool.length === 0) return [];
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  // První výstup xoroshiro nasoleného blízkými semínky je skoro stejný: dva se zahodí.
  next();
  next();
  const wanted = Math.min(FIELD_MOST, Math.max(FIELD_LEAST, Math.round(areaM2(area) / M2_PER_PIECE)));
  const spots = [...path, ...bodies];
  const gap = Math.min(PIECE_GAP_M, (area.x1 - area.x0) / 8);
  // Volná aréna: strop výzdoby podlahy (`DECOR_TALLEST` 0,45 m) je pod `FIELD_LOWEST_M`, takže kus neprojde – plocha zůstane bez kulis.
  const tallest = 'follow' in view ? DECOR_TALLEST : FIELD_TALLEST_M;
  const pieces: FieldPiece[] = [];
  for (let tries = 0; pieces.length < wanted && tries < wanted * TRIES; tries += 1) {
    // Každý pokus odebere stejně hodnot, ať jeden zamítnutý neposune ostatní.
    const [near, a, b, c, pick, size, turn] = [next(), next(), next(), next(), next(), next(), next()];
    let x: number;
    let z: number;
    if (path.length > 0 && near < NEAR_SHARE) {
      const from = path[Math.floor(a * path.length)]!;
      const angle = b * 2 * Math.PI;
      const distance = NEAR_M[0] + c * (NEAR_M[1] - NEAR_M[0]);
      x = from.x + Math.cos(angle) * distance;
      z = from.z + Math.sin(angle) * distance;
    } else {
      x = area.x0 + a * (area.x1 - area.x0);
      z = area.z0 + b * (area.z1 - area.z0);
    }
    const species = pool[Math.floor(pick * pool.length)]!;
    let height = Math.min(species.height * (0.85 + 0.3 * size), tallest, FIELD_REACH_M / species.ratio);
    const reach = species.ratio * height;
    if (!inside(area, x, z, reach) || Math.hypot(x - start.x, z - start.z) < START_CLEAR_M + reach) continue;
    if (pieces.some((piece) => Math.hypot(piece.x - x, piece.z - z) < piece.reach + reach + gap)) continue;
    if (spots.some((spot) => gapTo(spot, x, z) < KEEP_M + reach)) continue;
    const roof = roofOf(view, spots, x, z, reach);
    if (roof < LEAST_ROOF * height) continue;
    height = Math.min(height, roof);
    if (height < FIELD_LOWEST_M) continue;
    const kind: FieldKind = species.plant ? { plant: true, kind: species.kind } : { plant: false, kind: species.kind };
    pieces.push({ ...kind, x, z, height, turn: turn * 2 * Math.PI, reach: species.ratio * height });
  }
  return pieces;
}
