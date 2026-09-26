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
 * Jedním povelem, tím samým, kterým se ovládá strop utrácení
 * (`control-file.ts` říká proč souborem a ne routou). Napsat ho jde na dvě
 * místa a nese přesně týž JSON: **soubor na disku** (lokální provoz,
 * `next start`) a **sdílený klíč** v tomtéž obchodě, který drží účetní knihu —
 * ten je jediná páka, která na Vercelu za incidentu funguje, protože tam žádný
 * zapisovatelný disk pro celou flotilu není. Soubor má přednost; celé pravidlo
 * je u `readControlFrom()`. Klíč je `off` a je to **seznam jmen**, ne čtyři
 * booleany:
 *
 * ```json
 * { "enabled": true, "capUsd": 5, "off": ["upstream", "refine"] }
 * ```
 *
 * Seznam proto, že operátor za incidentu píše, co má stát — ne co má běžet.
 * Chybějící klíč `off` i prázdný seznam znamenají „běží všechno".
 *
 * ⚠ **Páka váže jen instance na tomhle buildu a novějším** (`T30-oldbuildlever`).
 * Starší build čte vypínače výhradně ze souboru a o sdílený klíč
 * `<předpona>:control` vůbec nezavadí, takže povel k němu **nedojde**. Týká se to
 * dvou situací, které za incidentu nastanou samy: překryvu při rolloveru, a
 * staršího preview nasazení, které zůstává dosažitelné na vlastní adrese.
 * **Peníze to nepustí** — účetní kniha je sdílená pod touž předponou, takže
 * strop platí i tam; nedojde tam **povel stop**. Kdo za incidentu vypíná, musí
 * proto stará nasazení zrušit, ne se spolehnout na to, že je povel umlčí.
 *
 * ⚠ **Přidat `off` do existujícího souboru není vždy no-op — od
 * `T30-capsilence`.** Soubor, který nese `enabled` nebo `callCap` a `capUsd` ne,
 * je pro strop rozbitý, takže `{"enabled":true}` + přidané `off` skončí
 * odmítáním placené práce, ne dokumentovaným nic-se-neděje. Vypínače samotné
 * z takového souboru **platí dál** (tahle funkce `parseControl()` nevolá), ale
 * kdo za incidentu píše `off` do souboru, který o stropu mluví, musí v něm mít
 * i `capUsd`. Nejjistější je psát celý tvar z příkladu výš.
 *
 * ## Kam se selhává
 *
 * | Stav povelu | Co se vypne |
 * |---|---|
 * | není ani soubor, ani klíč | nic |
 * | rozbitý, `off` obsahuje neznámé jméno, nebo obchod neodpověděl | **upstream, relace a refine** — snapshoty čtou dál |
 * | `off: ["all"]` | úplně všechno, i snapshoty a přehrávací dveře |
 *
 * ⚠ **„Úplně všechno" je tvrzení o dveřích, ne o téhle funkci, takže ho hlídá
 * test, ne tenhle odstavec.** `kill-switch.test.ts` vyjmenuje ze stromu **každé**
 * dveře pod `src/app/api` a žádá, aby v jejich kódu — nebo v modulu, který si
 * pod těmi dveřmi přitáhnou relativní cestou — stálo volání `killState(`, nebo
 * aby stály na jmenovaném seznamu výjimek. Sdílená brána se tak počítá:
 * `/api/emit/stream` tenhle modul neimportuje vůbec a chodí přes
 * `replayDisabled()` v sousední `../route.ts`. Ruční seznam dveří je
 * přesně to, co 4. 9. 2026 nechalo `off: ["all"]` zastavit **šest dveří
 * z deseti**, které něco obsluhují: remediace zavřela `/api/edit`, kdežto obě
 * emitovací cesty i obojí čtecí dveře relace braly požadavky dál — zatímco
 * tahle tabulka už tvrdila opak.
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

import { readControl } from './control-file';

/**
 * Jména, která smí stát v `off`. `all` je zkratka za všechna ostatní **plus
 * snapshoty** — je to „vypni provoz", ne „vypni tři věci".
 */
export const KILL_SWITCHES = ['upstream', 'sessions', 'refine', 'feed', 'env', 'all'] as const;

export type KillSwitch = (typeof KILL_SWITCHES)[number];

/** Co je vypnuté. `true` znamená **vypnuto**, tedy odmítat. */
export interface KillState {
  /** Placené volání textového modelu, na kterýchkoli dveřích. */
  readonly upstream: boolean;
  /** Zakládání nových relací. */
  readonly sessions: boolean;
  /** Druhá věta, tedy preview i commit změny. */
  readonly refine: boolean;
  /**
   * Čtení světa, který už existuje — sdílený snapshot
   * (`/api/worldstream/snapshots/:hash`) i autoritativní stav a proud běžící
   * relace (`…/sessions/:id` a `…/sessions/:id/events`). Vypne to jedině `all`.
   *
   * Ty troje dveře jsou jedna třída: nic neplatí, nic nezakládají a jen vydávají
   * to, co už vzniklo. `sessions` na ně proto **nesahá** — ten vypíná zakládání
   * nových relací a světy, které běží, mají zůstat čitelné (§22.4).
   *
   * ⚠ **U proudu to zavírá nová spojení, ne ta, která už visí.** Rámce jim
   * přestane vyrábět zbytek vypnutého provozu; existující odběr tenhle příznak
   * neruší.
   */
  readonly snapshots: boolean;
  /**
   * Feed posledních her na `/play` (`GET /api/play/games?recent`, P23-D T4).
   * Vlastní páka, protože feed je jediné místo, kde se cizí hra ukáže každému
   * návštěvníkovi – vypnout ho musí jít bez toho, aby umřely odkazy na hry
   * (`snapshots`). Rozbitý vypínač ho nechá běžet jako ostatní čtení; vypne ho `feed` nebo `all`.
   */
  readonly feed: boolean;
  /**
   * Dveře, které jen **přehrávají zmrazený korpus** — `/api/edit`,
   * `/api/emit` a `/api/emit/stream`. Neplatí se na nich nic, takže je rozbitý
   * vypínač nechává běžet ze stejného důvodu jako snapshoty; vypne je jedině
   * `all`.
   *
   * **Existuje proto, že „vypni provoz" musí dosáhnout na každé dveře.** Nezávislá
   * revize 4. 9. 2026 naměřila, že `off: ["all"]` zastavil relace, refine, upstream
   * i snapshoty, zatímco `/api/edit` bralo anonymní požadavky dál — a jeden stojí
   * medián 15,3 ms synchronního CPU na smyčce. Jediné zastavení byl redeploy.
   *
   * ⚠ **Ten nález jmenoval troje dveře a první remediace zavřela jedny.** Druhé
   * kolo revize 4. 9. 2026 to vrátilo jako `blocking`: `/api/emit` dál anonymně
   * přehrával korpus a `/api/emit/stream` k tomu otevíral nová SSE spojení
   * a držel je. Obě čtou tenhle příznak od `T28-killemit`, obě přes sdílenou
   * `replayDisabled()` v `src/app/api/emit/route.ts`.
   *
   * Vlastní pole, ne `snapshots`: to je dokumentované jako čtení hotových světů
   * a kdo by mu příště měnil pravidlo, změnil by mlčky i tyhle dveře.
   */
  readonly replay: boolean;
  /**
   * Generování vlastních panoramat na lokální kartě (`/api/play/games/:id/env`
   * a založení úlohy při publikaci, P29C). Vypnuté = každá hra má panorama
   * z knihovny, služba se nevolá. Neplatí se penězi, jen sdílenou GPU, takže
   * rozbitý vypínač ho nechá běžet jako čtení; vypne ho `env` nebo `all`.
   */
  readonly env: boolean;
}

const NOTHING_OFF: KillState = {
  upstream: false,
  sessions: false,
  refine: false,
  snapshots: false,
  feed: false,
  replay: false,
  env: false,
};

/** Rozbitý vypínač: placené dveře stojí, čtení běží. Viz hlavička. */
const PAID_OFF: KillState = {
  upstream: true,
  sessions: true,
  refine: true,
  snapshots: false,
  feed: false,
  replay: false,
  env: false,
};

const EVERYTHING_OFF: KillState = {
  upstream: true,
  sessions: true,
  refine: true,
  snapshots: true,
  feed: true,
  replay: true,
  env: true,
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
    feed: named.has('feed'),
    replay: false,
    env: named.has('env'),
  };
}

/**
 * Co je vypnuté **právě teď**. Čte se při každém rozhodnutí, ne jednou na
 * startu — vypínač, který platí až od restartu, není vypínač.
 *
 * ⚠ **Od `T30-controllever` je to `async`, a je to cena za páku na nasazení.**
 * Zdroje jsou dva — soubor na disku a sdílený klíč (`readControl()` říká, který
 * vyhrává a proč) — a ten druhý je síťový let, protože na Vercelu žádný
 * zapisovatelný disk pro celou flotilu není. Volajícím to nepřidalo nic než
 * `await`: všech deset dveří, které vypínač čtou, už v `async` funkcích bylo.
 *
 * **Bez sdíleného obchodu se nic nezmění a žádný let neproběhne** — lokální
 * provoz i `next start` čtou dál jen soubor.
 */
export function killState(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<KillState> {
  return readControl(env, fetchImpl).then((read) => {
    if (read.kind === 'absent') return NOTHING_OFF;
    if (read.kind === 'broken') return PAID_OFF;
    return killStateFrom(read.value);
  });
}
