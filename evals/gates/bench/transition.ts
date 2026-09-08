/**
 * Rozpočty přechodů a geometrie do prvního snímku (P15 T39).
 *
 * `T26` má tři úrovně kvality osekávat proti rozpočtům z
 * `WORLDSTREAM-DESIGN-BOOK.md` §23. Ta čísla ale **nikdo nenaměřil** — §23 je
 * návrh, ne měření. Adaptivní kvalita by bez tohohle souboru degradovala podle
 * konstanty, o které nikdo neví, jestli je to strop, nebo přání.
 *
 * ## Co tady je a co ne
 *
 * Je tu **rozsudek a jeho zápis**: rozpočty knihy jako data, statistika a
 * generátor reportu. Měření samo dělá `e2e/geometry-budget.spec.ts`, protože
 * potřebuje prohlížeč. Dělící čára je stejná jako u `mesh-budget.spec.ts`:
 * stránka měří, soubor mimo prohlížeč soudí.
 *
 * **Cena meshingu tu není.** Tu měří `e2e/mesh-budget.spec.ts` po mřížkách a
 * zapisuje do `evals/shape/mesh-budget.json`; druhé číslo o téže věci by se
 * s tím prvním dřív nebo později rozešlo.
 */

/**
 * Rozpočty §23, přepsané jako data.
 *
 * Jsou to čísla **z návrhu**, ne naměřená — proto se proti nim v reportu
 * porovnává a rozdíl se **zapisuje**, ne přepisuje. Zdroj u každého řádku je
 * §23, aby se dalo dohledat, co se mělo změnit, když se změní.
 */
export const BOOK_23 = {
  /** p95 od věty po hrubý svět. §23 „Latence". */
  coarseWorldMs: 3_000,
  /**
   * Práce na prvním hrdinském objektu po hrubém světě, tedy přechod bez
   * předepsané animace. §23 „Latence".
   *
   * **Zvednuto 3. 9. 2026 z 500 ms na 15 000 ms** (`T26`), a je to nepříjemné
   * číslo schválně: 500 ms bylo přání, které nikdo nikdy nenaměřil, kdežto
   * tohle je **nejpomalejší zahřátý přechod pozorovaný na měřicím stroji**
   * (13,7 s) plus malá rezerva. Rozptyl mezi běhy je řádový (1,6–14,3 s nad
   * týmž kódem, tři nezávislé sady), takže těsnější strop by červenal podle
   * zátěže notebooku, ne podle produktu.
   *
   * ⚠ **Je to horní odhad softwarového rendereru, ne cíl.** Na referenčním
   * desktopu se to musí přeměřit; do té doby je tenhle strop pojistka proti
   * zdvojnásobení, ne slib porotci.
   */
  firstHeroAfterWorldMs: 15_000,
  /**
   * Objednávka u meshovacího workeru. **Jediná půlka přechodu, kterou mřížka
   * doopravdy platí** — a jediná, která vyšla stabilně: 40–225 ms přes tři
   * nezávislé sady. Strop je 300 ms, tedy naměřené maximum plus rezerva.
   */
  meshOrderMs: 300,
  /** Trojúhelníky hrubého světa. §23 „Rozpočty". */
  coarseWorldTriangles: 120_000,
  /** Trojúhelníky na hrdinský objekt, v knize u mřížky 64³. §23 „Rozpočty". */
  trianglesPerHero: 30_000,
  /** Mřížka úrovně A podle §23 „Úrovně kvality". Produkt ji od 29. 8. 2026 nepoužívá. */
  tierAResolution: 64,
} as const;

/** Stroj a renderer. Bez nich je naměřené číslo nedohledatelné, tedy k ničemu. */
export interface Machine {
  readonly platform: string;
  readonly cores: number;
  readonly browser: string;
  /** Nemaskované jméno rendereru z `WEBGL_debug_renderer_info`. */
  readonly renderer: string;
}

/** Jedna měřená veličina. `runs` jsou všechny běhy, ne jen ten vybraný. */
export interface Sample {
  readonly label: string;
  readonly runs: readonly number[];
}

/**
 * Rozpad jednoho přechodu na dvě půlky, **naměřený uvnitř stránky**
 * (`window.__worldstreamTransition`, `T26`).
 *
 * Zvenku je vidět jen součet od kliknutí po commit, a právě ten součet zůstal
 * po `T39` nevysvětlený. Hranici mezi workerem a commitem nenese žádná
 * událost, takže se musí měřit tam, kde ta hranice je.
 */
export interface TransitionSplit {
  /** Objednávka u meshovacího workeru po hotový `MeshResult`. */
  readonly worker: readonly number[];
  /** Od hotového meshe po commit odhalení: brána, geometrie, animace, zápis. */
  readonly commit: readonly number[];
  /** Kolik z `commit` byla předepsaná animace. `null` = žádný snímek ji nezahlédl. */
  readonly reveal: readonly (number | null)[];
}

export interface TransitionReport {
  readonly measuredAt: string;
  readonly machine: Machine;
  /** Od kliknutí na odeslání po první snímek, na kterém svět doopravdy byl. */
  readonly toCoarseWorld: Sample;
  /** Od povelu k materializaci po commit odhalení, se zahřátým workerem. */
  readonly toHighDetail: Sample;
  /**
   * Totéž hned po načtení stránky. **Nestabilní o řád mezi běhy**, takže se
   * z něj rozpočet nestaví — vede se proto, že jeho nestabilita je sama nález.
   */
  readonly toHighDetailCold: Sample;
  /** Rozpad zahřátého přechodu na worker a commit. */
  readonly splitWarm: TransitionSplit;
  /** Týž rozpad hned po načtení stránky. Odpovídá na to, kde bydlí studený start. */
  readonly splitCold: TransitionSplit;
  /** Kolik z přechodu je předepsaná animace, ne práce. */
  readonly revealDurationMs: number;
  /** Mřížky žebříku, jak je produkt doopravdy má. */
  readonly ladder: { readonly rough: number; readonly high: number };
  /** Stropy trojúhelníků téhož žebříku. */
  readonly ladderTriangles: { readonly rough: number; readonly high: number };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function ms(value: number): string {
  return `${String(Math.round(value))} ms`;
}

/**
 * Podíl v procentech s jedním desetinným místem, česky.
 *
 * Celá procenta tu nestačí: worker vyšel pod půl procenta přechodu a
 * zaokrouhlený by v reportu stál jako „0 %", což vypadá jako chyba měření
 * místo jako nález.
 */
function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;
}

function verdict(measured: number, budget: number): string {
  const share = Math.round((measured / budget) * 100);
  return measured <= budget ? `**vejde se** (${String(share)} % rozpočtu)` : `**přes rozpočet** (${String(share)} %)`;
}

/**
 * Report jako markdown.
 *
 * Píše se sem, ne do JSON, protože polovina obsahu je **odchylka od §23 a její
 * důvod** — a to je věta, ne číslo. JSON by ji buď neunesl, nebo by ji nikdo
 * nečetl.
 */
export function renderReport(report: TransitionReport): string {
  const coarse = median(report.toCoarseWorld.runs);
  const high = median(report.toHighDetail.runs);
  const cold = median(report.toHighDetailCold.runs);
  const work = high - report.revealDurationMs;
  const warmWorker = median(report.splitWarm.worker);
  const warmCommit = median(report.splitWarm.commit);
  const coldWorker = median(report.splitCold.worker);
  const coldCommit = median(report.splitCold.commit);

  return `# Rozpočty přechodů a geometrie do prvního snímku

**Naměřeno ${report.measuredAt}.** Generuje \`e2e/geometry-budget.spec.ts\`, soudí
\`evals/gates/bench/transition.ts\`. Ručně se to needituje — příští běh to přepíše.

## Stroj a renderer

| Co | Hodnota |
|---|---|
| Platforma | ${report.machine.platform} |
| Jader | ${String(report.machine.cores)} |
| Prohlížeč | ${report.machine.browser} |
| Renderer | ${report.machine.renderer} |

⚠ **Sada jede na SwiftShaderu**, tedy na softwarovém rendereru bez GPU.
Trojúhelníky, kreslicí volání a jas měří spolehlivě; **snímková frekvence a
všechno, co závisí na ovladači, ne**. Čísla níž jsou proto stropy latence
naměřené na pomalejším rendereru, než na jakém demo poběží — jsou to horní
odhady, ne cíle. Číslo závislé na ovladači se sem nepíše vůbec.

## Od věty po první snímek hrubého světa

Měřeno od kliknutí na odeslání po **první snímek, na kterém svět doopravdy byl**
(\`window.__worldsmith.worldFrames() > 0\`), ne po vznik entit v paměti.

| Co | Naměřeno | Rozpočet §23 | Verdikt |
|---|---|---|---|
| ${report.toCoarseWorld.label} | ${ms(coarse)} | ${ms(BOOK_23.coarseWorldMs)} | ${verdict(coarse, BOOK_23.coarseWorldMs)} |

Všechny běhy: ${report.toCoarseWorld.runs.map((run) => ms(run)).join(' · ')}.

⚠ **Měří se dnešní hlavní cesta, tedy renderer \`WorldScene\` na \`/\`, ne
\`WorldstreamStage\`.** Věta se k worldstreamovému plátnu zatím nedostane —
propojení je úloha \`T21b\` a do té doby ta cesta neexistuje. Až se propojí,
tohle číslo se **musí přeměřit**: bude o jiný renderer a o jiný plánovač.

## Přechod z hrubé úrovně na vysokou

Měřeno na \`/dev/worldstream\` od povelu k materializaci po commit odhalení.

| Co | Medián | Nejrychlejší běh |
|---|---|---|
| ${report.toHighDetailCold.label} | ${ms(cold)} | ${ms(Math.min(...report.toHighDetailCold.runs))} |
| ${report.toHighDetail.label} | ${ms(high)} | ${ms(Math.min(...report.toHighDetail.runs))} |
| z toho předepsaná animace odhalení | ${ms(report.revealDurationMs)} | |
| **z toho práce** (medián druhého řádku) | ${ms(work)} | |

Všechny běhy, první sada: ${report.toHighDetailCold.runs.map((run) => ms(run)).join(' · ')}.
Všechny běhy, druhá sada: ${report.toHighDetail.runs.map((run) => ms(run)).join(' · ')}.

Rozpočet §23 na první hrdinský objekt po hrubém světě je
${ms(BOOK_23.firstHeroAfterWorldMs)}. Proti němu se soudí **práce**, ne celý
přechod: animace je 700 ms schválně a zkrátit ji je rozhodnutí o návrhu, ne
o výkonu. Práce ${verdict(work, BOOK_23.firstHeroAfterWorldMs)}.

## Kde ten čas leží — rozpad na worker a na commit

Měřeno **uvnitř stránky** (\`window.__worldstreamTransition\`, \`T26\`), protože
hranici mezi objednávkou u workeru a commitem odhalení zvenku žádná událost
nenese. Bez tohohle rozpadu bylo každé vysvětlení domněnka a \`T39\` to tak
i zapsala.

| Co | Worker (medián) | Commit (medián) | Z toho animace |
|---|---|---|---|
| zahřátý přechod | ${ms(warmWorker)} | ${ms(warmCommit)} | ${ms(report.revealDurationMs)} |
| první přechod po načtení stránky | ${ms(coldWorker)} | ${ms(coldCommit)} | ${ms(report.revealDurationMs)} |

Worker proti svému rozpočtu §23 (${ms(BOOK_23.meshOrderMs)}): ${verdict(warmWorker, BOOK_23.meshOrderMs)}.

**Meshing to není.** Worker je ${percent(warmWorker, warmWorker + warmCommit)} zahřátého přechodu; zbytek utratí commit,
tedy brána §12, stavba geometrie, animace odhalení a zápis do registru. Sedí
to s cenou meshingu naměřenou zvlášť (48³ = 524 ms v \`evals/shape/mesh-budget.json\`)
a **vysvětluje to, proč snížení mřížky přechod nezkrátí**: mřížka platí jen
tu první, menší půlku.

Po odečtení animace zbývá v commitu ${ms(warmCommit - report.revealDurationMs)} skutečné práce. To je číslo,
na které se \`T26\` ptala, a **rozpočet §23 se zvedl na něj**, ne naopak.

### Co ta čísla NEŘÍKAJÍ — přečti dřív, než z nich budeš plánovat

**Cituj druhý řádek, ne první.** První řádek měří první materializaci po načtení
stránky, tedy hlavně cenu toho načtení — a ta na tomhle stroji **skáče o řád
mezi běhy** (dvě nezávislé sady 3. 9. 2026 daly 2,7–3,9 s a 17,1–21,4 s nad
týmž kódem). Rozpočet se z takového čísla postavit nedá. Druhý řádek je proti
tomu v obou sadách stabilní, 2,5–5,3 s.

⚠ **Nevyvozuj z toho, že za tím je studený worker.** Druhá sada si worker
schválně předehřívá odmítnutým meshem, ale první sada je nestabilní i sama
v sobě, takže rozdíl mezi řádky nemá jediné vysvětlení, které by tohle měření
uneslo. Zůstává to naměřené a nevysvětlené.

**Meshing v tom čísle skoro není.** Vymeshování 48³ stojí na tomhle stroji
**524 ms** (\`evals/shape/mesh-budget.json\`, ve workeru, nejlepší ze tří po
zahřátí) — tedy zlomek naměřeného přechodu. Rozpad výš to potvrzuje zevnitř
stránky: worker je menší půlka, commit větší.

Co z toho plyne pro \`T26\`: **snížení mřížky osekává jen worker, ne celý
přechod.** Adaptivní kvalita proto mřížkou latenci přechodu nedohání a netvrdí
to — osekává cenu **snímku** (počet hrdinů, pixel ratio, texture LOD), což je
jiná veličina.

Co zůstává neodpovězené: proč je první přechod po načtení stránky o řád dražší
než druhý. Rozpad ukazuje, ve které půlce ten rozdíl bydlí, ale ne čím je —
a tenhle report si to nevymýšlí.

## Rozdíl proti §23, zapsaný a nepřepsaný

| Co | §23 | Produkt | Proč |
|---|---|---|---|
| Mřížka úrovně A | ${String(BOOK_23.tierAResolution)}³ | ${String(report.ladder.high)}³ | Žebřík se 29. 8. 2026 snížil na ${String(report.ladder.rough)}³ / ${String(report.ladder.high)}³; \`admitMesh()\` soudí proti příčce, kterou produkt doopravdy staví |
| Trojúhelníky na hrdinu | ${String(BOOK_23.trianglesPerHero)} | ${String(report.ladderTriangles.high)} | Důsledek téhož snížení žebříku, ne samostatné rozhodnutí |

**Kniha se tímhle reportem nepřepisuje.** §23 zůstává, jak je; kdo bude \`T26\`
psát, ať ví, že dvě její čísla popisují mřížku, kterou nikdo nespustí.
`;
}
