/**
 * **Kill switche — čtyři vrstvy provozu, každá vypnutelná zvlášť** (P15 T30).
 *
 * Design book §22.4 to vyjmenovává doslova: *„odděleně vypínatelné: textový
 * upstream · nové relace · public refine · celý provoz. Existující sdílené
 * světy musí zůstat čitelné, dokud běží storage a viewer."*
 *
 * Ta poslední věta je důvod, proč je tohle čtyři přepínače a ne jeden. Vypnout
 * všechno umí každý — stačí zastavit nasazení. Cenné je to mezi tím: účet
 * u poskytovatele utíká, tak se **vypne placený model** a demo dál ukazuje
 * světy, které už vznikly. Nebo se objeví vada v druhé větě, tak se **vypne
 * refine** a zakládání relací běží dál.
 *
 * ## Jak se to ovládá
 *
 * Jedním souborem, tím samým, kterým se ovládá strop utrácení
 * (`control-file.ts` říká proč souborem a ne routou). Klíč je `off` a je to
 * **seznam jmen**, ne čtyři booleany:
 *
 * ```json
 * { "enabled": true, "capUsd": 5, "off": ["upstream", "refine"] }
 * ```
 *
 * Seznam proto, že operátor za incidentu píše, co má stát — ne co má běžet.
 * Chybějící klíč `off` i prázdný seznam znamenají „běží všechno", takže dnešní
 * ovládací soubory stropu platí beze změny.
 *
 * ## Kam se selhává
 *
 * | Stav souboru | Co se vypne |
 * |---|---|
 * | není | nic |
 * | rozbitý, nebo `off` obsahuje neznámé jméno | **upstream, relace a refine** — snapshoty čtou dál |
 * | `off: ["all"]` | úplně všechno, i snapshoty |
 *
 * Prostřední řádek je jediné netriviální rozhodnutí tady a má dvě půlky.
 *
 * **Proč se vůbec něco vypne:** neznámé jméno je skoro vždycky překlep
 * (`"session"` místo `"sessions"`) a překlep vznikl při pokusu něco vypnout.
 * Tichý průchod by tedy nechal běžet přesně to, co měl operátor právě vypnout,
 * a v logu by to vypadalo jako splněný povel. Táž doktrína jako u rozbitého
 * vypínače stropu.
 *
 * **Proč zrovna tyhle tři a ne všechno:** vypnout na překlep i čtení snapshotů
 * znamená položit demo celé — tedy vyrobit z chyby v JSONu výpadek přesně toho,
 * co §22.4 chrání jmenovitě. Tři vypnuté dveře zastaví každé placené volání
 * (což je ta nevratná škoda) a nechají čitelné to, co už je zaplacené.
 */

import { controlFilePath, readControlFile } from './control-file';

/**
 * Jména, která smí stát v `off`. `all` je zkratka za všechna ostatní **plus
 * snapshoty** — je to „vypni provoz", ne „vypni tři věci".
 */
export const KILL_SWITCHES = ['upstream', 'sessions', 'refine', 'all'] as const;

export type KillSwitch = (typeof KILL_SWITCHES)[number];

/** Co je vypnuté. `true` znamená **vypnuto**, tedy odmítat. */
export interface KillState {
  /** Placené volání textového modelu, na kterýchkoli dveřích. */
  readonly upstream: boolean;
  /** Zakládání nových relací. */
  readonly sessions: boolean;
  /** Druhá věta, tedy preview i commit změny. */
  readonly refine: boolean;
  /** Čtení hotových sdílených světů. Vypne to jedině `all`. */
  readonly snapshots: boolean;
}

const NOTHING_OFF: KillState = {
  upstream: false,
  sessions: false,
  refine: false,
  snapshots: false,
};

/** Rozbitý vypínač: placené dveře stojí, čtení běží. Viz hlavička. */
const PAID_OFF: KillState = {
  upstream: true,
  sessions: true,
  refine: true,
  snapshots: false,
};

const EVERYTHING_OFF: KillState = {
  upstream: true,
  sessions: true,
  refine: true,
  snapshots: true,
};

function isSwitch(name: unknown): name is KillSwitch {
  return typeof name === 'string' && (KILL_SWITCHES as readonly string[]).includes(name);
}

/**
 * Přečte vypínače z obsahu ovládacího souboru. Oddělené od čtení disku, aby
 * šla pravidla soudit bez souboru.
 */
export function killStateFrom(value: Record<string, unknown>): KillState {
  const { off } = value;
  if (off === undefined) return NOTHING_OFF;
  if (!Array.isArray(off) || !off.every(isSwitch)) return PAID_OFF;

  const named = new Set<KillSwitch>(off);
  if (named.has('all')) return EVERYTHING_OFF;

  return {
    upstream: named.has('upstream'),
    sessions: named.has('sessions'),
    refine: named.has('refine'),
    snapshots: false,
  };
}

/**
 * Co je vypnuté **právě teď**. Čte se při každém rozhodnutí, ne jednou na
 * startu — vypínač, který platí až od restartu, není vypínač.
 */
export function killState(env: Record<string, string | undefined>): KillState {
  const read = readControlFile(controlFilePath(env));
  if (read.kind === 'absent') return NOTHING_OFF;
  if (read.kind === 'broken') return PAID_OFF;
  return killStateFrom(read.value);
}
