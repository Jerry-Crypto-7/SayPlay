/**
 * Profil kvality XR pro Quest 2 (P65 T6). Platí jen v relaci VR: mimo ni se nic nemění.
 *
 * - **Bez postprocessingu a bez stínů.** Skládač scény (`look/rig/Post.tsx`) ve VR kreslí jen naprázdno
 *   (stereo by rozbil, scénu kreslí `XrRig` napřímo) a stínový průchod kreslí kulisy ještě jednou. Oboje
 *   vypíná `XrQuality` v `XrRoot.tsx` zvenku, soubory P62 se nemění.
 * - **Pevná foveace 1:** okraje obrazu v nižším rozlišení, tam oko stejně nevidí ostře.
 * - **72 Hz:** nejnižší obnovovací frekvence Questu 2, tedy nejvíc času na snímek (13,9 ms).
 * - **Strop částic:** jako telefon na úrovni `low` (`effects/particles.ts`).
 * - **Rozpočet snímku** (`QUEST2_BUDGET`) hlídá `evals/vr/__tests__/budget.test.ts` nad měřením
 *   `evals/vr/budget.json`. Co je nad ním, sráží `XrCull` v `XrRig.tsx` (pravidla `cutOf`, kulisy mimo desku,
 *   sloučení stejných sítí do instancí), ne data scény.
 */

export const XR_QUALITY = {
  /** Cílová obnovovací frekvence (Hz). Quest 2 umí 72, 80, 90 a 120. */
  hz: 72,
  /** Pevná foveace WebXR, 0–1. */
  foveation: 1,
  /**
   * `framebufferScaleFactor` relace. Emulátor IWER ho nečte (kreslí do plátna stránky), takže v něm změřit nejde:
   * 1 je výchozí rozlišení prohlížeče Questu, po vypnutí skládače a stínů zbývá jen kresba scény. Ruční brána T8
   * porovná na brýlích s 0,8 přes `?vrscale=0.8` (`framebufferScaleOf`).
   */
  scale: 1,
  /** Strop živých částic celé scény ve VR (`PARTICLE_CAP.low`). */
  particles: 500,
} as const;

/**
 * Rozpočet jednoho snímku na Questu 2 (inference z doporučení Mety, upřesní ruční brána T8). Počítá se jako
 * `renderer.info` ve VR, tedy obě oči dohromady: three kreslí každou síť jednou za oko.
 */
export const QUEST2_BUDGET = { calls: 150, triangles: 300_000 } as const;

/** Proč VR uzel nekreslí (`cutOf`). */
export type XrCut = 'vegetation' | 'ink' | 'ring';

/**
 * Srážení profilu podle značek scény (měření T6, `evals/vr/README.md`); co leží mimo desku dioramy, sráží
 * `XrCull` zvlášť podle polohy.
 *
 * - `vegetation` – skupina rostlin (`look/Vegetation.tsx`). Svůj výběr rostlin počítá z kamery hry ve 2D; ve VR
 *   bez stínového průchodu kreslí každou rostlinu svého okna: 0,74–1,37 milionu trojúhelníků za snímek, víc
 *   než čtyřnásobek rozpočtu. Oprava patří do `Vegetation.tsx` (P62).
 * - `ink` – obrys nepřátel (`userData.ink = 'foe'`): každý díl postavy kreslí podruhé, střílečka tak měla
 *   přes 100 volání jen na obrysy. Obrys hrdiny zůstává – na desce je hrdina velký 3–8 cm.
 * - `ring` – prstenec rostlin za stěnami arény (`terrain = 'arena-ring'`): na desce dioramy leží celý za
 *   rovinami řezu, takže není vidět, ale stál 175–213 tisíc trojúhelníků.
 */
export function cutOf(node: { readonly name: string; readonly userData: Readonly<Record<string, unknown>> }, diorama: boolean): XrCut | null {
  if (node.name === 'vegetation') return 'vegetation';
  if (node.userData.ink === 'foe') return 'ink';
  if (diorama && node.userData.terrain === 'arena-ring') return 'ring';
  return null;
}

/** Nejbližší podporovaná frekvence k cíli; bez seznamu (`false`) nechá relaci výchozí. */
export function nearestRate(rates: ArrayLike<number>): number | false {
  let best: number | false = false;
  for (const rate of Array.from(rates)) {
    if (best === false || Math.abs(rate - XR_QUALITY.hz) < Math.abs(best - XR_QUALITY.hz)) best = rate;
  }
  return best;
}

/** Rozsah `?vrscale=`: pod 0,8 je text panelů v brýlích rozmazaný, nad 1 už jen dráž. */
const SCALE_RANGE = [0.8, 1] as const;

/** `framebufferScaleFactor` pro adresu: `?vrscale=0.8` (T8 měří na brýlích), jinak profil. Mimo rozsah se ořízne. */
export function framebufferScaleOf(url: string | URL): number {
  const raw = new URL(url, 'http://play.invalid/').searchParams.get('vrscale');
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return XR_QUALITY.scale;
  return Math.min(Math.max(value, SCALE_RANGE[0]), SCALE_RANGE[1]);
}

/** Co ukazuje panel FPS (`?vrhud=1`) za poslední sekundu. */
export interface FrameReading {
  /** Snímky relace za poslední sekundu. */
  readonly fps: number;
  /** Nejdelší mezera mezi dvěma snímky (ms): propad, který je v brýlích cítit jako cuknutí. */
  readonly worstMs: number;
  /** Medián práce CPU na snímek (ms); nad 13,9 ms Quest 2 na 72 Hz nestačí sám procesor. */
  readonly cpuMs: number;
}

export interface FrameMeter {
  /** Snímek začal v `start` (ms, `performance.now()`) a jeho práce na CPU trvala `cpuMs`. */
  record(start: number, cpuMs: number): void;
  /** Čtení za sekundu před `now`; bez snímků nuly. */
  read(now: number): FrameReading;
}

const WINDOW_MS = 1000;

export function createFrameMeter(): FrameMeter {
  const starts: number[] = [];
  const work: number[] = [];
  return {
    record(start, cpuMs) {
      starts.push(start);
      work.push(cpuMs);
      // Jeden snímek před oknem zůstává: první mezera v okně se měří od něj.
      while (starts.length > 2 && starts[1]! <= start - WINDOW_MS) {
        starts.shift();
        work.shift();
      }
    },
    read(now) {
      const from = starts.findIndex((start) => start > now - WINDOW_MS);
      if (from === -1) return { fps: 0, worstMs: 0, cpuMs: 0 };
      let worstMs = 0;
      for (let index = Math.max(from, 1); index < starts.length; index += 1) worstMs = Math.max(worstMs, starts[index]! - starts[index - 1]!);
      const cpu = work.slice(from).sort((a, b) => a - b);
      return { fps: starts.length - from, worstMs, cpuMs: cpu[cpu.length >> 1]! };
    },
  };
}
