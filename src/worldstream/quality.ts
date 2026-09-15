/**
 * **Adaptivní kvalita: tři úrovně a rozpočty, které drží** (P15 T26, design
 * book §23).
 *
 * Úroveň se rozhodne **jednou, před meshing fan-outem**, a od té chvíle je to
 * konstanta celé relace. Důvod není výkon, ale identita: `contentHash` se
 * skládá z programu **a rozlišení** (`shapeContentHash()`), takže úroveň
 * změněná uprostřed by z téhož objektu udělala jiný objekt a hot-swap by
 * vyměnil podobu, o které si registry myslí, že do slotu nepatří.
 *
 * ## Tři čísla z §23, která tenhle soubor NEPŘEVZAL
 *
 * Design book psal úrovně jako 64³ / 48³ / 32³. Měření je od té doby přebilo a
 * tady je zapsané proč, ať to nikdo nemusí odvozovat podruhé:
 *
 * 1. **64³ ze žebříku vypadlo.** Tři objekty při 64³ dají 135 060 trojúhelníků
 *    proti stropu scény 120 000 (`evals/shape/mesh-budget.json`, převod
 *    u `MESH_DETAIL`). `MESH_DETAIL` proto zná jen 32³ a 48³ a **mřížkový
 *    stupínek žebříku má právě jeden krok**, ne dva.
 * 2. **Postprocess není stupínek žebříku, protože neexistuje** (`T37`,
 *    `evals/postprocess-decision.md`): GTAO zdvojí snímek (112 volání /
 *    74 905 trojúhelníků proti 55 / 37 452), composer bez GTAO stojí 11,1 kB
 *    gzip a obraz nezmění — rozhodnuto NE a soubory smazané. §23 ho měl jako
 *    první stupínek; na jeho místo jde **pixel ratio**, nejlevnější páka,
 *    kterou tenhle renderer doopravdy má: jediná, která mění počet fragmentů,
 *    aniž sáhne na geometrii, na logiku nebo na vstup.
 * 3. **Přechod na vysoký detail se mřížkou neosekává.** `T39` naměřila
 *    2,5–5,3 s proti rozpočtu 500 ms, z toho vymeshování 48³ je 524 ms
 *    (`evals/gates/geometry-budget.md`, oddíl „Co ta čísla NEŘÍKAJÍ").
 *    Adaptivní kvalita ten rozpočet **netvrdí, že opravuje** — snižuje počet
 *    hrdinů a hustotu sítě, tedy cenu snímku, ne latenci přechodu.
 *
 * ## Co se nikdy nedegraduje
 *
 * **Logika a vstup zůstávají vždy** (§23). Žádná úroveň nesahá na simulaci,
 * na pravidla ani na ovládání; nejnižší úroveň je **plně funkční svět**, jen
 * chudší na hmotu. Drží to `everyTierIsPlayable()` a test nad ním — je to
 * jediné tvrzení tohohle souboru, které by se dalo porušit tiše.
 */

import { MESH_DETAIL } from '@/shape/types';

import type { MeshResolution } from './cache';

/* ------------------------------------------------------------------ *
 * Úrovně.
 * ------------------------------------------------------------------ */

/** Úrovně od nejbohatší po nejchudší. Pořadí **je** směr degradace. */
export const QUALITY_TIERS = ['full', 'balanced', 'safe'] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Nejchudší úroveň, na kterou se dá spadnout. Konec žebříku, ne selhání. */
export const LOWEST_TIER: QualityTier = 'safe';

/**
 * Co si která úroveň smí dovolit.
 *
 * **Všechna čísla jsou buď z §23, nebo odvozená z §23 a z naměřeného** — nic
 * tu není odhad. U každého pole stojí, odkud je, protože rozpočet bez původu
 * se za měsíc přepíše na cokoli.
 */
export interface QualityBudget {
  /** Kolik objektů dostane vlastní vymeshovaný tvar. §23: 3 na relaci. */
  readonly heroes: number;
  /** Mřížka hrubého světa. Jediná, kterou `MESH_DETAIL` pod 48³ zná. */
  readonly roughResolution: MeshResolution;
  /** Mřížka materializovaného detailu. Tady se utrácí mřížkový stupínek. */
  readonly detailResolution: MeshResolution;
  /** Strop trojúhelníků na jeden hrdinský tvar. Z `MESH_DETAIL` té mřížky. */
  readonly maxTrianglesPerHero: number;
  /** Strop trojúhelníků celé scény. */
  readonly maxSceneTriangles: number;
  /** Textura: strop na osu. §23 dává 2K nejvyšší úrovni. */
  readonly textureAxis: number;
  /** Strop draw callů jednoho snímku. */
  readonly maxDrawCalls: number;
  /**
   * Strop pixel ratio plátna — **první stupínek žebříku** (§23, po `T37`).
   *
   * Je to horní mez, ne příkaz: stroj, který hlásí `devicePixelRatio` 1,
   * kreslí na 1 i na nejvyšší úrovni. Cena je kvadratická, protože ratio
   * násobí obě osy kreslicího bufferu — naměřeno
   * v `e2e/worldstream-quality.spec.ts` nad oknem s `deviceScaleFactor: 2`.
   */
  readonly pixelRatio: number;
}

/**
 * Rozpočty.
 *
 * **Odkud je které číslo:**
 *
 * - `heroes` — §23 („hrdinské objekty s G3 na relaci: 3"), níž po jednom.
 * - `roughResolution` — `MESH_DETAIL.rough` (32³) u všech tří. Pod 32³ žádná
 *   příčka není a hrubý svět je slib „hratelné do tří sekund", takže tenhle
 *   údaj **není** čím degradovat.
 * - `detailResolution` — `MESH_DETAIL.high` (48³), na `safe` spadne na 32³.
 *   To je celý mřížkový stupínek žebříku.
 * - `maxTrianglesPerHero` — `MESH_DETAIL` té mřížky, tedy 32 000 pro 48³ a
 *   16 000 pro 32³. Ne vlastní číslo: brána meshe soudí podle `MESH_DETAIL` a
 *   dvě čísla o téže věci by se rozešla.
 * - `maxSceneTriangles` — §23 dává 120 000. Nižší úrovně **odečítají hrdiny,
 *   které nekreslí**: 120 000 − 32 000 = 88 000 a 120 000 − 64 000 = 56 000.
 *   Je to odvození ze dvou čísel §23, ne třetí číslo.
 * - `textureAxis` — §23 dává 2K nejvyšší, každý krok půlí. ⚠ **Dnes to nic
 *   neomezuje**: worldstreamová scéna kreslí `MeshToonMaterial` s barvou ve
 *   vrcholech a **žádnou texturu nenese**. Rozpočet je tu, aby první textura
 *   spadla pod strop místo aby si ho vymyslela; test to soudí nad naměřeným
 *   počtem textur, a ten je dnes poctivě nula.
 * - `pixelRatio` — **stupínek naměřený, ne odhadnutý.** Soudí se podle toho,
 *   kolik fragmentů za snímek doopravdy ubude, a to je plocha kreslicího
 *   bufferu: krok 2 → 1,5 nechá 56 % plochy, krok 1,5 → 1 z toho 44 %.
 *   Plocha je jediná veličina téhle škály, která nezávisí na ovladači, takže
 *   se dá měřit i na SwiftShaderu; měří ji `e2e/worldstream-quality.spec.ts`.
 *   Strop 2 nahoře je mez, za kterou se na běžném displeji už nic nepřidá.
 * - `maxDrawCalls` — **jediné číslo, které §23 nedává, takže je zvolené a je
 *   to tady napsané.** Naměřeno `T37` (3. 9. 2026): demo svět bez
 *   postprocessu kreslí **55 volání**. `full` = 96, tedy naměřené plus ~75 %
 *   rezervy na bohatší svět; každý další krok jsou dvě třetiny toho nad ním.
 */
export const QUALITY_BUDGETS: Readonly<Record<QualityTier, QualityBudget>> = {
  full: {
    heroes: 3,
    roughResolution: MESH_DETAIL.rough.resolution,
    detailResolution: MESH_DETAIL.high.resolution,
    maxTrianglesPerHero: MESH_DETAIL.high.maxTriangles,
    maxSceneTriangles: 120_000,
    textureAxis: 2048,
    maxDrawCalls: 96,
    pixelRatio: 2,
  },
  balanced: {
    heroes: 2,
    roughResolution: MESH_DETAIL.rough.resolution,
    detailResolution: MESH_DETAIL.high.resolution,
    maxTrianglesPerHero: MESH_DETAIL.high.maxTriangles,
    maxSceneTriangles: 88_000,
    textureAxis: 1024,
    maxDrawCalls: 64,
    pixelRatio: 1.5,
  },
  safe: {
    heroes: 1,
    roughResolution: MESH_DETAIL.rough.resolution,
    detailResolution: MESH_DETAIL.rough.resolution,
    maxTrianglesPerHero: MESH_DETAIL.rough.maxTriangles,
    maxSceneTriangles: 56_000,
    textureAxis: 512,
    maxDrawCalls: 48,
    pixelRatio: 1,
  },
};

export function budgetFor(tier: QualityTier): QualityBudget {
  return QUALITY_BUDGETS[tier];
}

/**
 * Kterou příčku `MESH_DETAIL` má úroveň objednávat při materializaci.
 *
 * **Odvozené z rozlišení, ne vypsané druhou tabulkou.** Brána meshe soudí
 * trojúhelníky podle `MESH_DETAIL[level]`, takže objednat 32³ a nechat to
 * soudit stropem pro 48³ by znamenalo bránu o 16 000 trojúhelníků volnější,
 * než jakou ta mřížka doopravdy má. Dvě čísla o téže věci se rozejdou; jedno
 * odvozené ne.
 *
 * Na `safe` proto vychází `rough` a je to správně: nejnižší úroveň mřížku
 * nezvedá, protože **už na své cílové mřížce stojí od prvního snímku**.
 */
export function detailLevelFor(tier: QualityTier): keyof typeof MESH_DETAIL {
  return QUALITY_BUDGETS[tier].detailResolution === MESH_DETAIL.high.resolution ? 'high' : 'rough';
}

/** Je to jméno úrovně? Vstup zvenku (adresa, snapshot) se čte, netvrdí. */
export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Žebřík degradace — §23, v jeho pořadí.
 * ------------------------------------------------------------------ */

/**
 * Co se obětuje a v jakém pořadí. **Logika a vstup v tomhle seznamu nejsou a
 * nikdy nebudou** — to je celý smysl toho, že je uzavřený.
 */
export const DEGRADE_LADDER = ['dpr', 'texture-lod', 'grid'] as const;

export type DegradeRung = (typeof DEGRADE_LADDER)[number];

/**
 * Které stupínky se mezi dvěma úrovněmi doopravdy utratily — **spočítané
 * z rozpočtů, ne vypsané ručně.**
 *
 * Ruční seznam je přesně ta věc, která se rozejde s tabulkou při prvním ladění
 * a nikdo si toho nevšimne: žebřík by tvrdil „snížila se mřížka" o kroku, který
 * mřížkou nehnul. Tady se odpověď čte z těch samých čísel, která krok doopravdy
 * provedl.
 *
 * Prázdný seznam je platná odpověď a znamená, že se dvě úrovně liší jen počtem
 * hrdinů — což je vlastní osa a v žebříku §23 nestojí.
 */
export function spentBetween(from: QualityTier, to: QualityTier): readonly DegradeRung[] {
  const before = QUALITY_BUDGETS[from];
  const after = QUALITY_BUDGETS[to];
  const spent: DegradeRung[] = [];
  if (after.pixelRatio < before.pixelRatio) spent.push('dpr');
  if (after.textureAxis < before.textureAxis) spent.push('texture-lod');
  if (
    after.detailResolution < before.detailResolution ||
    after.roughResolution < before.roughResolution
  )
    spent.push('grid');
  return spent;
}

/** O jednu úroveň níž, nebo `null`, když je to už dno. */
export function degrade(tier: QualityTier): QualityTier | null {
  const index = QUALITY_TIERS.indexOf(tier);
  return index + 1 < QUALITY_TIERS.length ? QUALITY_TIERS[index + 1] : null;
}

/**
 * Zůstane na téhle úrovni svět hratelný?
 *
 * Jediná podmínka, kterou §23 klade nad všechny ostatní: nejnižší úroveň je
 * **plně funkční svět**, ne nouzový režim. Prakticky to znamená aspoň jeden
 * objekt s vlastním tvarem, mřížku, kterou meshovač zná, a plátno kreslené
 * aspoň v nativním rozlišení — nula hrdinů, mřížka mimo `MESH_DETAIL` nebo
 * ratio pod 1 je svět, na který se nedá ukázat druhou větou.
 */
export function everyTierIsPlayable(): boolean {
  const known: readonly number[] = [MESH_DETAIL.rough.resolution, MESH_DETAIL.high.resolution];
  return QUALITY_TIERS.every((tier) => {
    const budget = QUALITY_BUDGETS[tier];
    return (
      budget.heroes >= 1 &&
      budget.pixelRatio >= 1 &&
      known.includes(budget.roughResolution) &&
      known.includes(budget.detailResolution)
    );
  });
}

/* ------------------------------------------------------------------ *
 * Volba úrovně.
 * ------------------------------------------------------------------ */

/**
 * Co o stroji víme, **než** se začne meshovat.
 *
 * Jsou to **deklarované** vlastnosti, ne měření: prohlížeč je ohlásí zdarma a
 * hned, kdežto naměřit fps se dá teprve nad světem, který už stál nějakou
 * práci. Tahle volba je proto odhad — a proto se dá přebít adresou
 * (`?tier=safe`) a proto existuje `degrade()`.
 *
 * Každé pole je volitelné, protože každé z nich některý prohlížeč nehlásí:
 * `navigator.deviceMemory` neexistuje ve Firefoxu ani v Safari a
 * `WEBGL_debug_renderer_info` je za oprávněním. Chybějící údaj **nesnižuje
 * úroveň** — neznalost není důkaz slabého stroje.
 */
export interface QualitySignals {
  /** `navigator.deviceMemory`, v GB. Chrome hlásí, jinde chybí. */
  readonly deviceMemoryGb?: number;
  /** `navigator.hardwareConcurrency`. */
  readonly cores?: number;
  /** Řetězec rendereru z `WEBGL_debug_renderer_info`, nebo prázdno. */
  readonly renderer?: string;
}

/**
 * Řetězce rendererů, které znamenají **softwarový rasterizér**, tedy žádné
 * GPU. Uzavřený seznam malými písmeny; hledá se podřetězec, protože skutečná
 * hlášení kolem toho jména vezou ještě ovladač a verzi.
 */
const SOFTWARE_RENDERERS = ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render'];

/**
 * Úroveň před fan-outem.
 *
 * Pravidla v pořadí, ve kterém se ptají — **nejtvrdší důkaz první**:
 *
 * 1. Softwarový rasterizér → `safe`. Není to slabá GPU, je to žádná GPU.
 * 2. Méně než 4 GB nebo méně než 4 jádra → `safe`.
 * 3. Méně než 8 GB nebo méně než 8 jader → `balanced`.
 * 4. Jinak `full`, **včetně stroje, který nehlásí nic**.
 */
export function chooseQualityTier(signals: QualitySignals): QualityTier {
  const renderer = (signals.renderer ?? '').toLowerCase();
  if (SOFTWARE_RENDERERS.some((name) => renderer.includes(name))) return 'safe';

  const memory = signals.deviceMemoryGb;
  const cores = signals.cores;
  if ((memory !== undefined && memory < 4) || (cores !== undefined && cores < 4)) return 'safe';
  if ((memory !== undefined && memory < 8) || (cores !== undefined && cores < 8)) return 'balanced';
  return 'full';
}

/**
 * Úroveň, na které tenhle prohlížeč doopravdy poběží.
 *
 * `chooseQualityTier()` výš je čistá funkce nad signály; tohle je jejich
 * **čtení ze stroje** a bydlí to tady, protože obojí je jedno rozhodnutí. Do
 * 6. 9. 2026 to byla soukromá funkce `/dev/worldstream`; hlavní cesta ji
 * potřebuje taky (`T47-t21bunblock`) a druhá kopie by se s tou první časem
 * rozešla o jeden signál, aniž by o tom kdokoli věděl.
 *
 * `?tier=safe` přebíjí volbu podle stroje, a nejsou to jen testovací zadní
 * vrátka: úrovně se jinak na jednom stroji vyzkoušet nedají, takže bez toho by
 * se dvě ze tří větví adaptivní kvality nikdy nikdo nepodíval. Neznámá hodnota
 * se **ignoruje**, ne odmítá — překlep v adrese nemá shodit svět.
 *
 * Renderer se čte přes `WEBGL_debug_renderer_info`. Ta přípona bývá zakázaná;
 * když chybí, zůstane prázdný řetězec a rozhodne paměť a jádra. **Neznalost
 * úroveň nesnižuje.**
 */
export function pickQualityTier(search: string): QualityTier {
  const forced = new URLSearchParams(search).get('tier');
  if (isQualityTier(forced)) return forced;

  let renderer = '';
  const probe = document.createElement('canvas').getContext('webgl2');
  if (probe !== null) {
    const info = probe.getExtension('WEBGL_debug_renderer_info');
    if (info !== null) renderer = String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    probe.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return chooseQualityTier({
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    cores: navigator.hardwareConcurrency,
    renderer,
  });
}

/** Co `/dev/worldstream` smí stáhnout z `?blueprint=`: adresa, nebo důvod odmítnutí. */
export type StoredBlueprint = { readonly url: string } | { readonly refused: string };

/**
 * Uložený svět z `?blueprint=`, **jen ze stejného originu** (P15
 * `G1-blueprintorigin`, nezávislá revize 14. 9. 2026).
 *
 * Stránka je na nasazení veřejná (e2e na ni sahají), a do 14. 9. stáhla
 * libovolnou adresu a nakreslila ji jako svět pod doménou dema: odkaz
 * `…/dev/worldstream?blueprint=https://cizi.example/x.json` ukázal porotci cizí
 * svět jako náš. Galerie kvality podává relativní `/__quality/…`, takže jí
 * stejný origin nevadí. `//cizi.example`, `data:` i `javascript:` mají cizí
 * (nebo `null`) origin a padají stejnou větví. Chybějící parametr je `null`,
 * tedy ukázka, ne chyba.
 */
export function pickStoredBlueprint(search: string, here: string): StoredBlueprint | null {
  const raw = new URLSearchParams(search).get('blueprint');
  if (raw === null) return null;
  const origin = new URL(here).origin;
  let target: URL;
  try {
    target = new URL(raw, here);
  } catch {
    return { refused: 'blueprint address does not parse' };
  }
  if (target.origin !== origin) return { refused: `blueprint must come from ${origin}, not ${target.origin}` };
  return { url: target.href };
}
