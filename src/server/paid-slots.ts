/**
 * Strop placených volání v letu, sdílený všemi dveřmi, které volají model.
 *
 * Do 7. 10. 2026 (P44D T2) žil v trase `/api/worldstream/sessions`, odkud si
 * ho bral i režisér PLAY (`src/app/api/play/_director.ts`). Přesun je čistý:
 * čítač je dál stav modulu, takže jedna instance procesu drží jeden `running`
 * pro všechny dveře, ať je importuje kdokoli.
 */

/**
 * Kolik generací smí běžet naráz.
 *
 * Není to výkonnostní ladění, je to strop na **placená volání v letu**: každá
 * generace stojí dvě až čtyři volání modelu a strop utrácení je kontrola po
 * volání, ne před náporem. Je to nad tím, co porotce vyrobí sám, a pod tím,
 * co by z jednoho návštěvníka udělalo účet za den.
 *
 * ✅ **Ze čtyř na šest 4. 9. 2026, a je to rozhodnutí o penězích.** Čtyři sloty
 * na troje dveře vycházely 2 + 1 + 1, tedy **jedno** souběžné preview druhé věty
 * na celou instanci — a druhá věta je hlavní věc, kterou má porotce vidět. Šest
 * dovolí 3 + 2 + 2. Peníze to neuvolňuje: horní mez útraty drží
 * `src/server/spend-cap.ts`, tenhle strop je jen mez souběhu.
 *
 * ⚠ **Vedlejší následek, který stojí za to znát:** při 2 + 1 + 1 byl součet
 * stropů roven dnu, takže brána na součet nikdy nekousla první a nešla změřit
 * (mutant, který ji vypustil, přežil). Při 3 + 2 + 2 je součet 7 proti dnu 6,
 * takže rozhoduje a má vlastní test.
 *
 * ✅ **Ze šesti na osm 21. 9. 2026 (P23-D T1, druhé kolo revize).** Režisér
 * PLAY si bral slot dveří `generate`, takže dvě visící věty v `POST
 * /api/play/games` zavřely `/api/generate` na minuty. PLAY má proto čtvrté
 * dveře se stropem 2: 3 + 2 + 2 + 2 = 9 proti dnu 8, ostatní dveře dosáhnou
 * nejvýš na 7, rezerva platí pro všechny čtvery. Peníze dál drží strop útraty.
 *
 * ✅ **Osm potvrzeno proti živému mostu 21. 9. 2026 (P23-D R9).** Most
 * codex-shim pouští dva běhy naráz a třetí odmítne hned 429 `busy`, bez fronty
 * (`scripts/__tests__/codex-shim.test.ts`). Volání 3–8 tedy netlačí k timeoutu
 * 120 s, skončí za milisekundy: PLAY návrhem, ostatní dveře chybovou cestou.
 * Snížit dno na dva nejde – rozbilo by rezervu dveří a mez mostu platí napříč
 * instancemi, kdežto tahle jen na jednu. S API klíčem na finále platí osm celé.
 *
 * ⚠ **Jedna výjimka od 27. 9. 2026 (P30A T2b): placená záloha režiséra PLAY.**
 * Je to druhé volání věty, která tu už drží slot dveří `play`, a bere slot
 * z vlastní zásoby `MAX_PAID_FALLBACKS` v `src/app/api/play/_director.ts`, ne
 * odsud. Instance tak má v letu nejvýš osm placených volání plus dvě zálohy;
 * peníze záloh drží její vlastní strop utrácení.
 */
export const MAX_CONCURRENT_GENERATIONS = 8;

/**
 * Kolik z těch osmi smí naráz držet **zakládání relace**.
 *
 * Jeden čítač obsluhoval dvoje dveře, jejichž doba držení se liší o dva řády.
 * Zakládání drží slot po **celou** generaci na pozadí — volání na záměr plus až
 * `MAX_BLUEPRINT_ROUNDS` kol kompilace a oprav, každé `fetch` omezené jen
 * `DEFAULT_TIMEOUT_MS = 120 000` v `src/server/upstream.ts`. Preview druhé věty
 * drží slot na jedno `planChange`. Naměřený následek sdíleného stropu bez
 * rezervy: **čtyři anonymní `POST /sessions`** proti pomalému poskytovateli
 * obsadí všechny čtyři sloty na minuty a každé `POST …/changes` po tu dobu
 * vrátí `503 TOO_MANY_CHANGES`. Cena útoku jsou čtyři požadavky, a vypne to
 * druhou větu — tedy hlavní věc, kterou má porotce vidět.
 *
 * ✅ **Od 4. 9. 2026 jsou dveře troje, ne dvoje** (`T22-doorcounters`, druhé
 * kolo nezávislé revize). `POST /api/generate` je **třetí veřejné dveře na
 * placené volání** a do té doby si bral slot pod jménem `world`, tedy z týchž
 * dvou slotů jako zakládání relace: tři souběžná `POST /api/generate` (strop
 * frekvence pustí padesát za deset sekund, takže tři jsou zadarmo) obsadila
 * celý strop dveří `world` na celou dobu poskytovatele a **každé** zakládání
 * relace po tu dobu dostalo `503`. Rezerva na dveře platí jen tehdy, když má
 * vlastní čítač **každé** veřejné dveře.
 *
 * ✅ **Kapacita se 4. 9. 2026 vrátila zvednutím dna, ne zrušením rezervy.**
 * První podoba téhle opravy dělila čtyři sloty na troje dveře (2 + 1 + 1),
 * takže druhá věta směla běžet jednou naráz. Dno je od téhož dne šest a dělí se
 * 3 + 2 + 2, tedy `world` má zpátky své tři.
 */
export const MAX_WORLD_GENERATIONS = 3;

/**
 * Dveře, které si o placený slot říkají. Ne řetězec: strop se vybírá podle
 * něj, a překlep by ho tiše nastavil na `undefined`, po čemž `running >=
 * undefined` je nepravda a strop by nedržel vůbec.
 */
export type PaidDoor = 'world' | 'generate' | 'refine' | 'play';

/**
 * Strop na dveře. Jedno místo, kde ta tři čísla stojí vedle sebe.
 *
 * **Každé dveře se zastaví o slot dřív, kvůli těm ostatním.** První podoba
 * `T22-doorcounters` nechávala `refine` až na dno čítače, a nezávislá revize to
 * spustila: čtyři souběžná `POST …/changes` proti visícímu poskytovateli pak
 * zavřela **oboje** dveře na stavbu světa na celé dvě minuty, tedy přesně ten
 * útok, který ta úloha zavírala — jen za čtyři požadavky místo tří. Druhé kolo
 * revize našlo totéž potřetí: `/api/generate` sdílelo čítač s `world`.
 *
 * Strop `play` se od P53 T1 čte z `PLAY_DIRECTOR_SLOTS` (`playDirectorSlots`).
 *
 * ## Invariant, na kterém rezerva stojí
 *
 * **Součet stropů VŠECH OSTATNÍCH dveří musí být menší než
 * `MAX_CONCURRENT_GENERATIONS`.** Teprve pak platí, že dveře, které nedrží
 * nic, se dovnitř dostanou vždycky: odmítnout je umí jen jejich vlastní strop
 * (tedy jejich vlastní provoz), nebo součet — a na součet ostatní samy
 * nedosáhnou. Dnes: `world` 3 + `generate` 2 + `refine` 2 + `play` 2 = 9
 * proti dnu 8, takže pro každé dveře je součet těch zbylých nejvýš 7 — pod dnem.
 *
 * ⚠ **Ten invariant se poruší tiše.** Zvednout kterýkoli strop o jedna
 * vypadá jako uvolnění, a přitom to jiným dveřím sebere rezervu, o kterou tu
 * celou dobu jde. Pinuje ho vlastnostní test nad těmihle konstantami
 * (`src/server/__tests__/paid-slots.test.ts`, „invariant rezervy"), ne komentář.
 *
 * ⚠ **Součet stropů je NAD dnem (7 proti 6), takže brána na součet doopravdy
 * rozhoduje** — a je to tak správně: je to jediné, co drží celkový počet
 * placených volání bez ohledu na to, kolik dveří přibude (výjimka: placená
 * záloha režiséra, viz `MAX_CONCURRENT_GENERATIONS`). Do 4. 9. 2026 byl
 * součet roven dnu, brána nikdy nekousla první a mutant, který ji vypustil,
 * proto přežil. Hlídá to týž test.
 */
const STUDIO_CEILING = { world: MAX_WORLD_GENERATIONS, generate: 2, refine: 2 } as const;

/** Strop dveří `play` bez `PLAY_DIRECTOR_SLOTS`. */
export const DEFAULT_PLAY_DIRECTOR_SLOTS = 2;

/**
 * Nejvyšší strop `play`, při kterém invariant rezervy platí (P53 T1): pro
 * každé dveře studia d musí `play` + strop zbylých dvou studiových dveří
 * zůstat pod `MAX_CONCURRENT_GENERATIONS`. Nejtěsnější je d s nejmenším
 * stropem, takže dnes 8 − 1 − (3 + 2) = **2**.
 *
 * Proměnná tedy zatím jen ubírá (1 = e2e fronty režiséra). Rozhodnutí P53 T1:
 * omezit ji shora, ne zvednout `MAX_CONCURRENT_GENERATIONS` o rozdíl – to by
 * pustilo víc placených volání v letu a o penězích nerozhoduje tahle proměnná.
 * Kdo chce víc slotů režiséra, zvedne dno nebo sníží studiové dveře a mez se
 * přepočítá sama.
 */
export const MAX_PLAY_DIRECTOR_SLOTS =
  MAX_CONCURRENT_GENERATIONS -
  1 -
  (Object.values(STUDIO_CEILING).reduce((sum, ceiling) => sum + ceiling, 0) - Math.min(...Object.values(STUDIO_CEILING)));

/**
 * Strop dveří `play` z `PLAY_DIRECTOR_SLOTS`: celé číslo 1..`MAX_PLAY_DIRECTOR_SLOTS`.
 * Cokoli jiného se odmítne řádkem logu a platí výchozí 2 – strop mimo mez by
 * buď vzal rezervu dveřím studia, nebo zavřel AI verzi úplně.
 */
export function playDirectorSlots(env: Record<string, string | undefined>): number {
  const raw = env.PLAY_DIRECTOR_SLOTS?.trim() ?? '';
  if (raw === '') return DEFAULT_PLAY_DIRECTOR_SLOTS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (value >= 1 && value <= MAX_PLAY_DIRECTOR_SLOTS) return value;
  console.warn(
    `[play] PLAY_DIRECTOR_SLOTS=${JSON.stringify(raw)} ignored: must be a whole number from 1 to ${String(MAX_PLAY_DIRECTOR_SLOTS)}; ` +
      `the play door keeps ${String(DEFAULT_PLAY_DIRECTOR_SLOTS)} slots`,
  );
  return DEFAULT_PLAY_DIRECTOR_SLOTS;
}

export const DOOR_CEILING: Readonly<Record<PaidDoor, number>> = {
  ...STUDIO_CEILING,
  play: playDirectorSlots(process.env),
};

/** Kolik placených volání drží která dveře. **Čtyři čítače, jeden strop.** */
const running: Record<PaidDoor, number> = { world: 0, generate: 0, refine: 0, play: 0 };

/**
 * Věta pro operátorský log u odmítnutí: **kdo ty sloty drží a kolik jich smí
 * držet tyhle dveře.** Jedno místo pro všechny troje dveře, protože jinak by
 * se odpověď na „koho mám hledat" psala třikrát a rozešla se.
 *
 * **„on this instance" je součást pravdy:** čítač je stav modulu, takže na
 * Vercelu má vlastní každá instance a globální číslo nedrží nikdo — flotila
 * o N instancích propustí N násobek, a to zavře až sdílené úložiště (`T29`).
 *
 * **Troje dveře ale jednu instanci sdílejí — naměřeno 14. 9. 2026
 * (`T22-slotperroute`) na nasazení `dpl_CHKuAWi7exEcg1TdhJ3FdDeyKkzf`.** Výpis
 * výstupu buildu (`vercel api /v6/deployments/<id>/files`) ukazuje
 * `api/generate`, `api/worldstream/sessions`, `api/edit` i
 * `api/worldstream/source` jako odkazy na **týž** funkční balík (jedno `uid`),
 * takže v jedné instanci drží všechny troje dveře týž `running`. Platí to pro
 * tohle nasazení, ne navždy: kdyby balík přerostl limit velikosti a Vercel ho
 * rozdělil, měření se opakuje tímtéž příkazem.
 */
export function slotsDetail(door: PaidDoor): string {
  return (
    `paid slots in flight: ${running.world} world + ${running.generate} generate + ` +
    `${running.refine} refine + ${running.play} play of ${MAX_CONCURRENT_GENERATIONS} on this instance; ` +
    `the ${door} door may hold ${DOOR_CEILING[door]}`
  );
}

/**
 * Vzít slot pro jedno placené volání v letu. Vrací `false`, když je plno.
 *
 * **Jeden strop na všechny dveře** — zakládání relace, `/api/generate`,
 * preview druhé věty i režie PLAY (její placená záloha má vlastní zásobu, viz
 * `MAX_CONCURRENT_GENERATIONS`). Oddělené stropy nejsou jeden strop: kdo
 * chce platit za víc volání naráz, střídá adresy. Proto se součet všech čtyř
 * čítačů porovnává proti `MAX_CONCURRENT_GENERATIONS` **vždycky**, ať přijdou které
 * dveře chtějí. Kontrola a zvýšení jsou v jednom synchronním kroku, takže mezi
 * ně nemá co vklouznout.
 *
 * **Vlastní strop dveří je nad tím**, ne místo toho: `MAX_WORLD_GENERATIONS`
 * u drahých, dno čítače u levných. Ten drží rezervu — obojím směrem, protože
 * sytit ho umí jen ty dveře, kterých se týká. Viz `MAX_WORLD_GENERATIONS`.
 */
export function acquireSlot(door: PaidDoor): boolean {
  // Díra pod tou, kterou hlídá typ (P15 T22-doorkeyguard): pro klíč mimo
  // `PaidDoor` je `running[door]` `undefined`, obě porovnání níž jsou nepravda
  // a `+= 1` zapíše `NaN` — od té chvíle je součet `NaN` a strop neodmítne
  // nikoho do konce života procesu. Dnes sem cizí klíč nedosáhne (všichni tři
  // volající předávají literál); tohle jen zavírá cestu, kdyby typ někdo obešel.
  if (!Object.hasOwn(running, door)) return false;
  if (running.world + running.generate + running.refine + running.play >= MAX_CONCURRENT_GENERATIONS)
    return false;
  if (running[door] >= DOOR_CEILING[door]) return false;
  running[door] += 1;
  return true;
}

/**
 * Slot vrátit. Musí proběhnout na **každé** cestě ven, i na chybové.
 *
 * `door` je povinné a musí sedět s tím, čím se slot bral: vrácení pod cizími
 * dveřmi by jeden čítač poslalo do záporu a druhý natrvalo utáhlo. Typ to
 * hlídá jen zpola (obojí je `PaidDoor`), zbytek je na tom, že vzetí i vrácení
 * stojí v témž bloku.
 */
export function releaseSlot(door: PaidDoor): void {
  if (!Object.hasOwn(running, door)) return;
  running[door] -= 1;
}

/** Jen pro testy: čítač je proces-globální jako registr relací. */
export function resetConcurrency(): void {
  running.world = 0;
  running.generate = 0;
  running.refine = 0;
  running.play = 0;
}
