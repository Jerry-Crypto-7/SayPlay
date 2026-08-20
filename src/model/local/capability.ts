/**
 * Rozhodnutí o běhovém prostředí modelu — **dřív, než se stáhne jediný bajt vah**.
 *
 * Váhy `Qwen3-1.7B-q4f16_1-MLC` mají 979 MB. Stáhnout je a teprve pak zjistit,
 * že je stroj neunese, je nejdražší možné pořadí kroků: porotce zaplatí minutu
 * čekání za odpověď „nejde to". Proto je tenhle modul **bez jediné závislosti**
 * — neimportuje `@mlc-ai/web-llm` ani nic, co by síť sáhlo — a rozhoduje jen
 * z toho, co prohlížeč o sobě řekne zadarmo.
 *
 * `e2e/webgpu-detect.spec.ts` na to má aserci: při vypnuté akceleraci nesmí
 * odejít jediný požadavek na doménu vah.
 *
 * ## Čtyři odpovědi a co znamenají
 *
 *   large   WebGPU je a paměti je dost -> Qwen3-1.7B běží v prohlížeči
 *   small   WebGPU je, ale paměti je málo -> menší model (0.6B)
 *   cloud   WebGPU není, ale serverová cesta je nakonfigurovaná
 *   none    ani jedno -> jede se na deterministických tvarech vět (T7)
 *
 * `none` **není chyba a nikdy nesmí skončit prázdnou obrazovkou.** Je to plně
 * hratelná větev: svět se postaví z deterministických tvarů. Proto je taky
 * výchozí odpovědí ve chvíli, kdy si modul není jistý.
 */

/** Odpověď je uzavřená množina. Nic jiného tenhle modul nikdy nevrátí. */
export type Runtime = 'large' | 'small' | 'cloud' | 'none';

/**
 * Kolik paměti chce která větev, v gigabajtech tak, jak je hlásí
 * `navigator.deviceMemory`. To API vrací hodnoty ze schodů 0.25, 0.5, 1, 2, 4, 8
 * a **výš než 8 nejde** — je to schválně hrubé, aby se z něj nedal poskládat
 * otisk stroje. Prahy jsou proto taky hrubé; jemnější by předstíraly přesnost,
 * kterou vstup nemá.
 *
 * 8 GB pro `large`: samotné váhy jsou 979 MB, ale WebGPU buffery, mezipaměť
 * shaderů a zbytek stránky si vezmou násobek. 4 GB pro `small` je nejnižší
 * schod, na kterém se ještě vejde 0.6B model vedle scény.
 */
export const LARGE_MIN_MEMORY_GB = 8;
export const SMALL_MIN_MEMORY_GB = 4;

/**
 * Domény, ze kterých se stahují váhy a WASM runtime WebLLM. Seznam je tady, a ne
 * v testu, protože ho čte víc míst (detekce, e2e aserce o nulovém provozu,
 * pozdější service worker) a dvě kopie by se rozešly.
 */
export const WEIGHT_HOSTS: readonly string[] = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'raw.githubusercontent.com',
];

/** Míří URL na doménu, ze které se tahají váhy? */
export function isWeightRequest(url: string): boolean {
  try {
    return WEIGHT_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Co se o prostředí ptáme. Je to vstup funkce, ne globální stav, protože jinak
 * by čtyři větve nešly otestovat jinak než čtyřmi prohlížeči.
 */
export interface RuntimeEnvironment {
  /**
   * Je WebGPU **použitelné**? Ne „existuje `navigator.gpu`" — to je slabší
   * tvrzení a naměřeně nepravdivé: Chromium spuštěné s `--disable-gpu
   * --disable-features=WebGPU` objekt `navigator.gpu` pořád vystavuje a jen
   * `requestAdapter()` vrátí `null`. Kdyby se rozhodovalo podle přítomnosti,
   * takový stroj by dostal `large` a čekal minutu na váhy, které nemá čím
   * spustit. Naměřeno v `e2e/webgpu-detect.spec.ts` 20. 8. 2026.
   */
  readonly hasWebGpu: boolean;
  /** `navigator.deviceMemory` v GB. `undefined` znamená, že to prohlížeč nehlásí. */
  readonly deviceMemoryGb: number | undefined;
  /** Je serverová cesta nakonfigurovaná? Bez klíče se podle AC T24 vůbec nenabízí. */
  readonly cloudConfigured: boolean;
}

/** Minimum z `navigator`, které tenhle modul potřebuje. Injektuje se, aby šly větve otestovat. */
export interface NavigatorLike {
  readonly gpu?: { requestAdapter(): Promise<unknown | null> } | null;
  readonly deviceMemory?: number;
}

function readMemory(nav: NavigatorLike): number | undefined {
  return typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
}

function readCloudFlag(): boolean {
  return (globalThis as { __worldsmithCloud?: boolean }).__worldsmithCloud === true;
}

/**
 * Levné, synchronní přečtení prostředí. **Věř mu jen v záporu.**
 *
 * Chybějící `navigator.gpu` znamená, že WebGPU opravdu není. Přítomnost
 * neznamená nic — viz `hasWebGpu` výš. Používej to jen tam, kde potřebuješ
 * odpověď dřív, než doběhne `await` (první snímek), a počítej s tím, že
 * `probeEnvironment()` může kladnou odpověď vzít zpátky.
 *
 * Mimo prohlížeč (Node, build, prerender) vrátí tvar, ze kterého vyjde `none` —
 * build nesmí rozhodovat za stroj návštěvníka.
 */
export function readEnvironment(nav: NavigatorLike | undefined = globalThisNavigator()): RuntimeEnvironment {
  if (!nav) return { hasWebGpu: false, deviceMemoryGb: undefined, cloudConfigured: false };
  return {
    hasWebGpu: nav.gpu !== undefined && nav.gpu !== null,
    deviceMemoryGb: readMemory(nav),
    cloudConfigured: readCloudFlag(),
  };
}

/**
 * Pravdivé přečtení prostředí: zeptá se o adaptér. **Tohle je to, co má
 * produkční cesta volat**, protože jen návrat adaptéru dokazuje, že WebGPU jede.
 *
 * `requestAdapter()` **nestahuje váhy ani nic jiného** — mluví s ovladačem, ne
 * se sítí. Výjimku z něj bereme jako „nejede": ovladač, který na dotaz spadne,
 * model neutáhne.
 */
export async function probeEnvironment(
  nav: NavigatorLike | undefined = globalThisNavigator(),
): Promise<RuntimeEnvironment> {
  if (!nav?.gpu) return readEnvironment(nav);
  let adapter: unknown | null = null;
  try {
    adapter = await nav.gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  return { hasWebGpu: adapter !== null && adapter !== undefined, deviceMemoryGb: readMemory(nav), cloudConfigured: readCloudFlag() };
}

function globalThisNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorLike);
}

/**
 * Vybere větev. Čistá funkce nad prostředím — žádná síť, žádný `await`, žádný
 * vedlejší účinek.
 *
 * **Neohlášená paměť se počítá jako málo.** `navigator.deviceMemory` chybí ve
 * Firefoxu i v Safari, a předpokládat tam osm gigabajtů znamená poslat největší
 * model na stroj, o kterém nevíme nic. Chyba tímhle směrem stojí menší model;
 * opačným směrem stojí minutu stahování a pak pád.
 */
export function detectRuntime(env: RuntimeEnvironment = readEnvironment()): Runtime {
  if (env.hasWebGpu) {
    const memory = env.deviceMemoryGb ?? 0;
    if (memory >= LARGE_MIN_MEMORY_GB) return 'large';
    if (memory >= SMALL_MIN_MEMORY_GB) return 'small';
  }
  return env.cloudConfigured ? 'cloud' : 'none';
}
