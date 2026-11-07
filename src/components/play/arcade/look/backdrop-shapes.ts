/**
 * Kulisa za mlhou (P46G T6). Cesta dřív mizela do prázdné mlhy. Teď za scénou
 * stojí 2–3 prstence siluet kolem kamery podle sady (`Look.skyline`): hory se
 * špičkami, oblé kopce, duny, linie jehličnanů nebo korun, stolové hory,
 * panorama domů, pobřeží s mysy, od P61 T7 stěny haly.
 *
 * Barvy jsou z mlhy: barva mlhy (`horizon`, i po náladě a v noci) vynásobená
 * odstínem sady, takže silueta je vždy tmavší než mlha a „temný les“ má temnou
 * kulisu. Pata je světlejší (opar u země). Prstence stojí uvnitř mlhy
 * (`FAR`/`NEAR` na stupnici začátek–konec mlhy): vzdálená vrstva v ní mizí víc
 * než bližší. Nejbližší vrstva má nad cestou (+z) průsek, ať cesta nevede do zdi.
 *
 * Obrys je jedna výšková křivka kolem dokola (úhel od +z k +x, výška v m) a
 * vrstva jedna síť: kulisa přidá nejvýš tři volání kreslení. Paralaxa
 * (`layerAt`): vrstva jde s kamerou do strany jen z části (`follow`, bližší
 * míň) a za celou trať se přiblíží o `approach` metrů.
 *
 * Tvar je čistá funkce sady a semínka hry z vlastního streamu `pure-rand`
 * (jako vegetace): tatáž hra má tytéž hory a z běhových streamů jádra se nic
 * neodebere – hash se nehne. Kreslí `Backdrop.tsx`.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

import type { Look, Mark, Silhouette } from '@/play/arcade/look';

/** Sůl semínka – stream kulisy je jiný než stream jádra, výzdoby arény i vegetace. */
const SALT = 0x2b1d6e5f;
/** Znaky místa mají vlastní stream: obrysy vrstev zůstanou, jaké byly před P73D. */
const MARK_SALT = 0x5e7a19c3;
const TAU = 2 * Math.PI;

/**
 * Nejvzdálenější a nejbližší vrstva, mezi nimi se prokládá: kde v mlze stojí
 * (0 = začátek mlhy, 1 = konec), jakou část pohybu kamery do strany udělá s ní
 * a jak daleko je její barva od mlhy k barvě siluety.
 */
const FAR = { fog: 0.8, follow: 0.9, strength: 0.5 } as const;
const NEAR = { fog: 0.52, follow: 0.6, strength: 0.9 } as const;
/** Přiblížení za celou trať: podíl mezery mezi vrstvou a začátkem mlhy krát podíl, o který vrstva nejde s kamerou. */
const APPROACH = 0.6;
/** Pata: podíl cesty od barvy mlhy k barvě obrysu. */
const FOOT = 0.45;
/** Průsek nad cestou v nejbližší vrstvě: o kolik výšky ubere a do kolikanásobku `clear` náběh trvá. */
const NOTCH = { depth: 0.9, ramp: 1.8 } as const;
/** Body hladkých obrysů (kopce, hory, duny) na obvod: krok 1,5°. */
const SAMPLES = 240;

/** Bod obrysu: úhel od +z k +x (rad, 0–2π) a výška nad patou (m). */
export type ProfilePoint = readonly [angle: number, height: number];

export interface BackdropLayer {
  readonly kind: Silhouette;
  /** Poloměr prstence kolem kamery (m). */
  readonly radius: number;
  /** Jakou část pohybu kamery do strany vrstva udělá s ní (1 = stojí vůči kameře jako obloha). */
  readonly follow: number;
  /** O kolik metrů se vrstva za celou trať přiblíží. */
  readonly approach: number;
  /** Barva obrysu a paty (`#rrggbb`), před mlhou. */
  readonly top: string;
  readonly foot: string;
  /** Úhel roste od 0 do 2π; první a poslední bod mají tutéž výšku, prstenec je zavřený. */
  readonly profile: readonly ProfilePoint[];
  /** Znaky místa na téhle vrstvě (P73D T5), prázdné = jen obrys. */
  readonly marks: readonly MarkPlace[];
}

/** Znak místa na prstenci: úhel (rad), výška paty (m), velikost (m) a zrcadlení. */
export interface MarkPlace {
  readonly kind: Mark;
  readonly angle: number;
  readonly base: number;
  readonly size: number;
  readonly flip: boolean;
}

/** Vrstva a její síť: komponenta z každé dělá právě jednu síť – jedno volání kreslení. */
export interface BackdropPart {
  readonly layer: BackdropLayer;
  readonly geometry: BufferGeometry;
}

export interface BackdropOptions {
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Půl šířky průseku nad cestou (m): půl cesty a kus okraje. */
  readonly clear: number;
  /** O kolik metrů pata sahá pod zem: v údolí běžce kryje kopce trati, na rovině závodu jen spáru. */
  readonly skirt: number;
  /** Nejmenší poloměr nejbližší vrstvy (m, `backdropLayers`); bez něj jen podle mlhy. */
  readonly beyond?: number;
}

type Next = () => number;

const between = (next: Next, lo: number, hi: number): number => lo + (hi - lo) * next();

/** Vlna kolem dokola s celým počtem period na obvod, ať se prstenec zavře. */
interface Wave {
  readonly k: number;
  readonly phase: number;
}
const waveOf = (next: Next, lo: number, hi: number): Wave => ({ k: lo + Math.floor(next() * (hi - lo + 1)), phase: TAU * next() });
/** 0–1, oblá. */
const sine = ({ k, phase }: Wave, angle: number): number => 0.5 + 0.5 * Math.sin(k * angle + phase);
/** 0–1, hřbet: 1 − |sin| má ostré vrcholy. */
const ridge = ({ k, phase }: Wave, angle: number): number => 1 - Math.abs(Math.sin((k * angle) / 2 + phase));
/** 0–1, duna: zešikmená vlna, dlouhá návětrná strana a prudký sesuv. */
const dune = ({ k, phase }: Wave, angle: number): number => {
  const x = k * angle + phase;
  return 0.5 + 0.5 * Math.sin(x + 0.7 * Math.sin(x));
};

const sampled = (height: (angle: number) => number): ProfilePoint[] =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const angle = (TAU * i) / SAMPLES;
    return [angle, height(angle)];
  });

/** Kusy obrysu za sebou kolem dokola: šířky (rad) se natáhnou, ať poslední končí přesně v 2π. */
function around<T extends { readonly width: number }>(make: () => T): { readonly item: T; readonly start: number; readonly width: number }[] {
  const items: T[] = [];
  let sum = 0;
  while (sum < TAU) {
    const item = make();
    items.push(item);
    sum += item.width;
  }
  let start = 0;
  return items.map((item) => {
    const width = (item.width * TAU) / sum;
    const placed = { item, start, width };
    start += width;
    return placed;
  });
}

/** Tvar `[podíl šířky, podíl výšky]` položený na kus obrysu. */
const shaped = (shape: readonly (readonly [number, number])[], start: number, width: number, height: (at: number, share: number) => number): ProfilePoint[] =>
  shape.map(([along, share]) => [start + along * width, height(start + along * width, share)]);

/** Výška stěny haly na metr poloměru: nejnižší a nejvyšší úsek. */
const WALL_TOP = [0.18, 0.22] as const;

const CROWN = [[0, 0.35], [0.1, 0.65], [0.25, 0.88], [0.5, 1], [0.75, 0.88], [0.9, 0.65]] as const;
const MESA = [[0, 0], [0.06, 0.45], [0.14, 1], [0.86, 1], [0.94, 0.45]] as const;
const HEADLAND = [[0, 0], [0.05, 0.8], [0.2, 1], [0.45, 0.85], [0.7, 0.6], [0.88, 0.25]] as const;

/** Obrys druhu kolem dokola ve výškách na metr poloměru. Úhly i výšky nezávisí na poloměru – vrstva má v každé mlze tutéž velikost v obraze. */
function shapeOf(kind: Silhouette, next: Next): ProfilePoint[] {
  switch (kind) {
    case 'peaks': {
      const [big, mid, small, range] = [waveOf(next, 3, 5), waveOf(next, 7, 11), waveOf(next, 16, 24), waveOf(next, 1, 3)];
      return sampled((a) => 0.025 + (0.55 + 0.45 * sine(range, a)) * (0.2 * ridge(big, a) ** 1.5 + 0.08 * ridge(mid, a) + 0.03 * ridge(small, a)));
    }
    case 'hills': {
      const [big, mid, small] = [waveOf(next, 3, 6), waveOf(next, 8, 14), waveOf(next, 18, 30)];
      return sampled((a) => 0.025 + 0.08 * sine(big, a) ** 1.3 + 0.035 * sine(mid, a) + 0.012 * sine(small, a));
    }
    case 'dunes': {
      const [big, small] = [waveOf(next, 6, 10), waveOf(next, 13, 21)];
      return sampled((a) => 0.012 + 0.06 * dune(big, a) ** 1.4 + 0.025 * dune(small, a));
    }
    case 'pines': {
      const [slow, fast] = [waveOf(next, 2, 4), waveOf(next, 5, 9)];
      const band = (a: number) => 0.04 + 0.025 * sine(slow, a) + 0.01 * sine(fast, a);
      // Jehličnan: pata na pásu lesa, špička v půlce šířky, vysoký asi dvakrát víc než široký; občas mýtina.
      const trees = around(() => ({ width: between(next, 0.022, 0.045), tip: next() < 0.05 ? between(next, 0.004, 0.012) : between(next, 0.045, 0.1) }));
      return [...trees.flatMap(({ item, start, width }): ProfilePoint[] => [[start, band(start)], [start + width / 2, band(start + width / 2) + item.tip]]), [TAU, band(TAU)]];
    }
    case 'crowns': {
      const [slow, fast] = [waveOf(next, 2, 4), waveOf(next, 5, 9)];
      const band = (a: number) => 0.045 + 0.025 * sine(slow, a) + 0.01 * sine(fast, a);
      // Koruna je víc široká než vysoká a sousední se překrývají: les, ne řada sloupů.
      const crowns = around(() => ({ width: between(next, 0.07, 0.14), tip: between(next, 0.03, 0.065) }));
      return [...crowns.flatMap(({ item, start, width }) => shaped(CROWN, start, width, (at, share) => band(at) + share * item.tip)), [TAU, band(TAU) + CROWN[0][1] * crowns[0]!.item.tip]];
    }
    case 'mesas': {
      const [slow, fast] = [waveOf(next, 3, 6), waveOf(next, 9, 15)];
      const plain = (a: number) => 0.012 + 0.02 * sine(slow, a) + 0.01 * sine(fast, a);
      // Střídá se rovina a stolová hora s prudkými boky a sutí u paty.
      const items = around(() => (next() < 0.45 ? { width: between(next, 0.12, 0.35), top: between(next, 0.07, 0.17) } : { width: between(next, 0.1, 0.4), top: 0 }));
      const flat = (start: number, width: number): ProfilePoint[] => {
        const steps = Math.ceil(width / 0.05);
        return Array.from({ length: steps }, (_, j) => start + (j * width) / steps).map((at) => [at, plain(at)]);
      };
      return [...items.flatMap(({ item, start, width }) => (item.top === 0 ? flat(start, width) : shaped(MESA, start, width, (at, share) => plain(at) + share * (item.top - plain(at))))), [TAU, plain(TAU)]];
    }
    case 'blocks': {
      const [district, street] = [waveOf(next, 1, 3), waveOf(next, 3, 6)];
      // Centrum: vysoké domy se shlukují, na okraji nízká zástavba.
      const town = (a: number) => 0.35 + 0.65 * sine(district, a) ** 2 * (0.6 + 0.4 * sine(street, a));
      const blocks = around(() => ({ width: between(next, 0.03, 0.09), tall: next(), spire: next() < 0.1, gap: next() < 0.2 }));
      const points = blocks.flatMap(({ item, start, width }): ProfilePoint[] => {
        const roof = 0.035 + town(start + width / 2) * (0.05 + 0.25 * item.tall ** 2);
        const end = item.gap ? start + 0.85 * width : start + width;
        const spire: ProfilePoint[] = item.spire ? [[start + 0.46 * (end - start), roof], [start + 0.5 * (end - start), roof + 0.07], [start + 0.54 * (end - start), roof]] : [];
        return [[start, roof], ...spire, [end, roof], ...(item.gap ? ([[end, 0.015], [start + width, 0.015]] as ProfilePoint[]) : [])];
      });
      return [...points, [TAU, points[0]![1]]];
    }
    case 'walls': {
      // Stěna haly (P61 T7): úseky výloh s malým schodem v římse, nahoře zhruba tam, kde je v té dálce strop
      // (`Look.ceiling`). Body hustě jako kopce, ať zůstane kulatá.
      const fronts = around(() => ({ width: between(next, 0.15, 0.35), top: between(next, WALL_TOP[0], WALL_TOP[1]) }));
      const step = TAU / SAMPLES;
      return [
        ...fronts.flatMap(({ item, start, width }) => Array.from({ length: Math.ceil(width / step) }, (_, j): ProfilePoint => [start + (j * width) / Math.ceil(width / step), item.top])),
        [TAU, fronts[0]!.item.top],
      ];
    }
    case 'coast': {
      const SEA = 0.005;
      const rough = waveOf(next, 20, 34);
      // Střídá se moře a mys, jednou prudký sráz vlevo, jindy vpravo.
      const items = around(() => (next() < 0.5 ? { width: between(next, 0.15, 0.6), top: 0, flip: false } : { width: between(next, 0.15, 0.55), top: between(next, 0.035, 0.11), flip: next() < 0.5 }));
      return [
        ...items.flatMap(({ item, start, width }): ProfilePoint[] =>
          item.top === 0 ? [[start, SEA]] : shaped(item.flip ? HEADLAND.map(([along, share]) => [1 - along, share] as const).reverse() : HEADLAND, start, width, (at, share) => SEA + share * item.top * (0.9 + 0.1 * ridge(rough, at))),
        ),
        [TAU, SEA],
      ];
    }
  }
}

/** Plynulý přechod 0 → 1 mezi `from` a `to`. */
/**
 * Znaky místa (P73D T5): ploché obrysy v rovině tečné k prstenci, v jednotkách velikosti znaku (u do strany,
 * v nahoru, pata v 0). Trojúhelník je šest čísel; kouř sopky je zvlášť, má světlejší barvu.
 */
type Tri = readonly [number, number, number, number, number, number];
type Pt = readonly [number, number];

const rect = (u0: number, v0: number, u1: number, v1: number): Tri[] => [[u0, v0, u1, v0, u1, v1], [u0, v0, u1, v1, u0, v1]];
const fan = (points: readonly Pt[], cu: number, cv: number): Tri[] => points.map((p, i) => [cu, cv, p[0], p[1], points[(i + 1) % points.length]![0], points[(i + 1) % points.length]![1]]);
const disc = (cu: number, cv: number, r: number, n = 12): Tri[] => fan(Array.from({ length: n }, (_, i): Pt => [cu + r * Math.cos((TAU * i) / n), cv + r * Math.sin((TAU * i) / n)]), cu, cv);
/** Vypouklý mnohoúhelník jako vějíř z prvního bodu. */
const convex = (points: readonly Pt[]): Tri[] => points.slice(1, -1).map((p, i) => [points[0]![0], points[0]![1], p[0], p[1], points[i + 2]![0], points[i + 2]![1]]);
/** Úzký pás z bodu do bodu (lopatka mlýna, noha vodojemu). */
function bar(u0: number, v0: number, u1: number, v1: number, width: number): Tri[] {
  const length = Math.hypot(u1 - u0, v1 - v0);
  const [nu, nv] = [((v0 - v1) / length) * (width / 2), ((u1 - u0) / length) * (width / 2)];
  return convex([[u0 + nu, v0 + nv], [u1 + nu, v1 + nv], [u1 - nu, v1 - nv], [u0 - nu, v0 - nv]]);
}
/** Půlmezikruží – oblouk od pravé paty přes vrchol k levé. */
function arch(cu: number, cv: number, outer: number, inner: number, n = 10): Tri[] {
  return Array.from({ length: n }, (_, k) => {
    const [a, b] = [(Math.PI * k) / n, (Math.PI * (k + 1)) / n];
    return convex([[cu + outer * Math.cos(a), cv + outer * Math.sin(a)], [cu + outer * Math.cos(b), cv + outer * Math.sin(b)], [cu + inner * Math.cos(b), cv + inner * Math.sin(b)], [cu + inner * Math.cos(a), cv + inner * Math.sin(a)]]);
  }).flat();
}

const BLADES = [0.25, 0.75, 1.25, 1.75].map((turn) => turn * Math.PI);

/** Obrys znaku: `solid` v barvě siluety, `smoke` v barvě oparu. */
export function markShape(kind: Mark): { readonly solid: readonly Tri[]; readonly smoke: readonly Tri[] } {
  switch (kind) {
    case 'tanks':
      return { solid: [...bar(-0.24, 0, -0.2, 0.52, 0.05), ...bar(0.24, 0, 0.2, 0.52, 0.05), ...bar(-0.22, 0.08, 0.22, 0.46, 0.04), ...rect(-0.32, 0.5, 0.32, 0.88), ...convex([[-0.36, 0.88], [0.36, 0.88], [0, 1.08]])], smoke: [] };
    case 'cone':
      return { solid: fan([[1, 0], [-1, 0], [-0.2, 0.6], [-0.08, 0.55], [0.08, 0.55], [0.2, 0.6]], 0, 0.3), smoke: [...disc(0.02, 0.72, 0.1), ...disc(-0.06, 0.86, 0.13), ...disc(0.06, 1.03, 0.16), ...disc(-0.03, 1.22, 0.19)] };
    case 'arches':
      return { solid: [...arch(0, 0.45, 0.5, 0.3), ...rect(-0.5, 0, -0.3, 0.45), ...rect(0.3, 0, 0.5, 0.45), ...disc(0, 0.95, 0.08), ...disc(-0.36, 0.8, 0.07), ...disc(0.36, 0.8, 0.06)], smoke: [] };
    case 'mills':
      return { solid: [...convex([[-0.14, 0], [0.14, 0], [0.08, 0.62], [-0.08, 0.62]]), ...convex([[-0.11, 0.62], [0.11, 0.62], [0, 0.74]]), ...BLADES.flatMap((a) => bar(0, 0.66, 0.48 * Math.cos(a), 0.66 + 0.48 * Math.sin(a), 0.07))], smoke: [] };
    case 'turrets':
      return { solid: [...rect(-0.13, 0, 0.13, 0.78), ...convex([[-0.18, 0.78], [0.18, 0.78], [0, 1.05]]), ...rect(0.13, 0, 0.24, 0.36), ...rect(0.22, 0, 0.4, 0.52), ...convex([[0.18, 0.52], [0.44, 0.52], [0.31, 0.72]])], smoke: [] };
    case 'lollipops':
      return { solid: [...rect(-0.025, 0, 0.025, 0.62), ...disc(0, 0.8, 0.2, 14)], smoke: [] };
  }
}

/**
 * Kde a kolik (P73D T5). `far` = na nejvzdálenější vrstvě (kužel sopky je obzor sám), jinak na nejbližší.
 * `size` = výška znaku jako podíl poloměru vrstvy, `rest` = kolik výšky obrysu pod znakem zůstane pod jeho patou
 * (vodojem stojí na střeše, mlýn vyrůstá z kopce). Počet na celý obvod: v záběru jsou vždy 1–2.
 */
const MARK_SPECS: Readonly<Record<Mark, { readonly far: boolean; readonly count: number; readonly size: readonly [number, number]; readonly rest: number }>> = {
  tanks: { far: false, count: 8, size: [0.05, 0.07], rest: 0.97 },
  cone: { far: true, count: 2, size: [0.42, 0.5], rest: 0.2 },
  arches: { far: false, count: 5, size: [0.11, 0.15], rest: 0.55 },
  mills: { far: false, count: 5, size: [0.09, 0.12], rest: 0.6 },
  turrets: { far: false, count: 6, size: [0.1, 0.14], rest: 0.6 },
  lollipops: { far: false, count: 9, size: [0.08, 0.12], rest: 0.6 },
};
/** První kužel stojí kousek vedle osy pohledu (+z), ať ho záběr po cestě vidí celý vedle průseku. */
const CONE_AT = 0.35;

function heightOf(profile: readonly ProfilePoint[], angle: number): number {
  const i = Math.max(1, profile.findIndex(([at]) => at >= angle));
  const [[a0, h0], [a1, h1]] = [profile[i - 1]!, profile[i] ?? profile[i - 1]!];
  return a1 === a0 ? h0 : h0 + ((angle - a0) / (a1 - a0)) * (h1 - h0);
}

function placeMarks(kind: Mark, seed: number, radius: number, profile: readonly ProfilePoint[], notch: number): MarkPlace[] {
  const spec = MARK_SPECS[kind];
  const rng = xoroshiro128plus((seed ^ MARK_SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  return Array.from({ length: spec.count }, (_, i) => {
    const size = between(next, spec.size[0], spec.size[1]) * radius;
    const jitter = (next() - 0.5) * 0.5;
    const raw = kind === 'cone' ? CONE_AT + i * Math.PI : ((i + 0.5 + jitter) * TAU) / spec.count;
    // Průsek nad cestou nechá volný: znak, který by do něj padl, se odsune k jeho kraji.
    const keep = notch * NOTCH.ramp + size / radius;
    const off = Math.min(raw % TAU, TAU - (raw % TAU));
    const angle = off >= keep ? raw % TAU : raw % TAU < Math.PI ? keep : TAU - keep;
    return { kind, angle, base: spec.rest * heightOf(profile, angle), size, flip: next() < 0.5 };
  });
}

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Barva vrstvy z mlhy: mlha vynásobená odstínem sady, `strength` = podíl cesty od mlhy k tomu součinu. */
function colorsOf(look: Look, tone: string, strength: number): { readonly top: string; readonly foot: string } {
  const fog = new Color(look.horizon);
  const top = fog.clone().lerp(fog.clone().multiply(new Color(tone)), strength);
  const foot = fog.clone().lerp(top, FOOT);
  return { top: `#${top.getHexString()}`, foot: `#${foot.getHexString()}` };
}

/** Odstup sousedních vrstev (m), když je odsune `beyond`: vzdálenější vrstva zůstane za bližší. */
const BEYOND_STEP_M = 6;

/**
 * Vrstvy kulisy sady od nejvzdálenější po nejbližší; sada bez `skyline` nemá žádnou.
 * `beyond` (m) = nejmenší poloměr nejbližší vrstvy (P46G T7): scéna s hrací plochou
 * daleko před kamerou (aréna v jeskyni, hřiště, střelnice) by jinak měla kulisu
 * v mlze krátké sady uvnitř hry. Odsunutá vrstva může skončit za koncem mlhy – pak
 * není vidět, ale nikdy nestojí před hrou.
 */
export function backdropLayers(look: Look, seed: number, clear: number, beyond = 0): BackdropLayer[] {
  const skyline = look.skyline;
  if (skyline === undefined) return [];
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  const [fogNear, fogFar] = look.fog;
  const last = skyline.layers.length - 1;
  return skyline.layers.map((kind, index) => {
    const u = last === 0 ? 1 : index / last;
    const toward = (far: number, near: number): number => far + (near - far) * u;
    const radius = Math.max(fogNear + toward(FAR.fog, NEAR.fog) * (fogFar - fogNear), beyond > 0 ? beyond + (last - index) * BEYOND_STEP_M : 0);
    const follow = toward(FAR.follow, NEAR.follow);
    // Stěna haly průsek nemá: náběh průseku ve stěně kreslil po stranách cesty svahy kopců (P61 T7).
    const notch = index === last && last > 0 && kind !== 'walls' ? clear / radius : 0;
    const profile = shapeOf(kind, next).map(([angle, height]): ProfilePoint => {
      const off = Math.min(angle, TAU - angle);
      const keep = notch === 0 ? 1 : 1 - NOTCH.depth * (1 - smoothstep(notch, notch * NOTCH.ramp, off));
      return [angle, height * radius * keep];
    });
    const mark = skyline.marks;
    const marks = mark !== undefined && index === (MARK_SPECS[mark].far ? 0 : last) ? placeMarks(mark, seed, radius, profile, notch) : [];
    return { kind, radius, follow, approach: APPROACH * (1 - follow) * (radius - fogNear), ...colorsOf(look, skyline.tone, toward(FAR.strength, NEAR.strength)), profile, marks };
  });
}

/** Pás vrstvy: pata `skirt` m pod zemí v barvě paty, obrys v barvě obrysu; trojúhelníky mezi sousedními body. */
export function backdropGeometry(layer: BackdropLayer, skirt: number): BufferGeometry {
  const { profile, radius } = layer;
  const positions = new Float32Array(profile.length * 6);
  const colors = new Float32Array(profile.length * 6);
  const [top, foot] = [new Color(layer.top), new Color(layer.foot)];
  profile.forEach(([angle, height], i) => {
    const [x, z] = [radius * Math.sin(angle), radius * Math.cos(angle)];
    positions.set([x, -skirt, z, x, height, z], i * 6);
    colors.set([foot.r, foot.g, foot.b, top.r, top.g, top.b], i * 6);
  });
  const index: number[] = [];
  for (let i = 0; i + 1 < profile.length; i += 1) {
    const [low, high, nextLow, nextHigh] = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3];
    index.push(low, high, nextHigh, low, nextHigh, nextLow);
  }
  // Znaky místa (P73D T5) jsou trojúhelníky v téže síti – kulisa nepřidá ani jedno volání kreslení.
  const smoke = foot.clone().lerp(new Color('#ffffff'), 0.25);
  const [markPositions, markColors] = [[] as number[], [] as number[]];
  for (const mark of layer.marks) {
    const shape = markShape(mark.kind);
    const ring = radius * MARK_FRONT;
    const [sin, cos] = [Math.sin(mark.angle), Math.cos(mark.angle)];
    const side = mark.flip ? -mark.size : mark.size;
    for (const [tris, color] of [[shape.solid, top], [shape.smoke, smoke]] as const) {
      for (const tri of tris) {
        for (let k = 0; k < 6; k += 2) {
          const [u, v] = [tri[k]! * side, tri[k + 1]!];
          markPositions.push(ring * sin + u * cos, mark.base + v * mark.size, ring * cos - u * sin);
          markColors.push(color.r, color.g, color.b);
        }
      }
    }
  }
  const first = profile.length * 2;
  for (let k = 0; k < markPositions.length / 3; k += 1) index.push(first + k);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([...positions, ...markPositions], 3));
  geometry.setAttribute('color', new Float32BufferAttribute([...colors, ...markColors], 3));
  geometry.setIndex(index);
  return geometry;
}

/** Znak stojí kousek před svou vrstvou, ať se s ní v hloubce nepere. */
const MARK_FRONT = 0.995;

/** Celá kulisa sady: vrstvy a jejich sítě, jedna síť na vrstvu. */
export function buildBackdrop(look: Look, { seed, clear, skirt, beyond = 0 }: BackdropOptions): BackdropPart[] {
  return backdropLayers(look, seed, clear, beyond).map((layer) => ({ layer, geometry: backdropGeometry(layer, skirt) }));
}

/**
 * Střed prstence vrstvy pro kameru v (`x`, `z`): do strany jde s kamerou z `follow`
 * (bližší vrstva ujíždí víc – paralaxa), dopředu zaostává úměrně ujeté trati až
 * o `approach` na jejím konci. `length` = délka trati (m).
 */
export function layerAt(layer: BackdropLayer, x: number, z: number, length: number): { readonly x: number; readonly z: number } {
  const progress = Math.min(1, Math.max(0, z / Math.max(1, length)));
  return { x: x * layer.follow, z: z - layer.approach * progress };
}
