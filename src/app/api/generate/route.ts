/**
 * `POST /api/generate` — volný text od uživatele skrz řetěz moderace → strop →
 * generování.
 *
 * Je to **jediný endpoint** pro obě větve. Která pojede, rozhoduje prostředí, ne
 * volající: klient, který si smí vybrat mezi placenou a neplacenou cestou, si
 * vybere placenou. `WORLDSMITH_BRANCH=live` zapne živou, cokoli jiného (a
 * hlavně chybějící hodnota) nechává offline.
 *
 * ## Čím se liší od `/api/emit`
 *
 * `/api/emit` bere `promptId` ze zmrazeného korpusu a je to **měřicí** cesta —
 * validuje, snižuje do IR a certifikuje svědka. Tenhle endpoint bere text a
 * vrací **emisi tak, jak přišla**. Validaci a certifikaci dělá až vrstva nad
 * ním; kdyby ji dělal tady, měřicí a produktová cesta by se rozešly a P1 by
 * měřil něco jiného, než co pojede na demu.
 *
 * ## Mapování na stavové kódy
 *
 * | Výsledek | Kód | Proč |
 * |---|---|---|
 * | emise | 200 | |
 * | moderace odmítla | 400 | vada dotazu, ne serveru |
 * | tělo se nedalo přečíst | 400 | spojení, ne server |
 * Text odmítnutí stropem se ven posílá **oříznutý** — viz `PUBLIC_REFUSAL` níž.
 *
 * | rozpočet vyčerpán | 429 | dočasné, dá se zopakovat později |
 * | vyčerpaný počet volání | 429 | týž tvar, jen to nedrží ceník, ale počítadlo |
 * | vypínač rozbitý, špatný odhad | 503 | provozní stav, ne dotaz |
 * | větev nemá zdroj (`NO_SOURCE`) | 404 | poctivé „na tohle odpověď nemám" |
 * | větev nenakonfigurovaná | 503 | |
 * | poskytovatel spadl nebo mluví nesmysly | 502 | |
 *
 * `NO_SOURCE` je schválně 404, ne chyba: u offline větve je to normální
 * odpověď na prompt mimo zmrazený korpus. Fallback z P2 se na něj věší o patro
 * výš, ne uvnitř generování.
 *
 * Bez přihlašování a bez databáze — AC úlohy T301 to zakazuje obojí. Strop se
 * proto ovládá souborem na disku, ne administrátorskou routou; odůvodnění je
 * v hlavičce `src/server/spend-cap.ts`.
 */

import { randomUUID } from 'node:crypto';

import { bodyRefusalResponse, readBody } from '../../../http/body';
import { frozenGrammar } from '../../../model/client';
import { withRequest } from '../../../obs/trace';
import { mockBranch } from '../../../server/mock';
import { MAX_PROMPT_CHARS, type ModerationCategory } from '../../../server/moderation';
import {
  runPipeline,
  type GenerationBranch,
  type GenerationFailureReason,
} from '../../../server/pipeline';
import {
  PUBLIC_CORPUS_FAULT,
  logForOperator as logForRoute,
  logRateLimited,
  logStickyFault as logStickyForRoute,
} from '../../../server/public-faults';
import { killState } from '../../../server/kill-switch';
import { callerKey, rateLimitCode, rateLimitedResponse, takeRateSlot } from '../../../server/rate-limit';
import { DEFAULT_CAP_USD, processSpendCap, type RefusalReason } from '../../../server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../../../server/upstream';
import { acquireSlot, releaseSlot, slotsDetail } from '../worldstream/sessions/route';

/** Strop je stav procesu, ne požadavku — jedna instance na celý běh serveru. */
const CAP = processSpendCap();

export const runtime = 'nodejs';

/**
 * Která větev pojede. Ptá se na **objednávku**, ne na dostupnost, a ten rozdíl
 * je naměřený: `cloudBranchAvailable()` (viz `src/server/upstream.ts`) odpovídá
 * `false`, když je objednaná živá větev bez klíče — a kdyby se routa řídila jím,
 * takový server by tiše sjel na offline větev a **vydával mock za model**.
 * Operátor s překlepem v klíči by se to nedozvěděl nikdy.
 *
 * Tady se proto selhává nahlas: objednal jsi živou větev bez klíče, dostaneš
 * 503 `BRANCH_UNCONFIGURED`. Táž doktrína jako u rozbitého vypínače stropu
 * (`src/server/spend-cap.ts`) — vadné nastavení nikdy neznamená tichý průchod.
 */
async function branchFor(env: NodeJS.ProcessEnv): Promise<GenerationBranch> {
  if (env.WORLDSMITH_BRANCH !== 'live') return mockBranch();
  // **Vypnutý upstream se chová jako živá větev bez klíče**, tedy 503, ne tichý
  // sjezd na mock. Doktrína o řádek výš platí i pro vypínač: kdyby se vypnutý
  // model nahradil mockem, vydával by tenhle server mock za model a operátor,
  // který sáhl na vypínač kvůli účtu, by se to nedozvěděl.
  if ((await killState(env)).upstream) return upstreamBranch(null);
  return upstreamBranch(upstreamConfigFromEnv(env));
}

/**
 * Co se o odmítnutí stropem řekne **ven**.
 *
 * Text ze `spend-cap.ts` je pro operátora a nese čísla i cestu k ovládacímu
 * souboru. `/api/generate` nechce přihlášení (AC T301), takže „ven" znamená
 * komukoli na internetu — a tomu se přesný zbytek rozpočtu ani absolutní cesta
 * na disku serveru neposílají. První umožňuje načasovat zneužití, druhá
 * prozradí rozvržení souborů včetně jména účtu.
 *
 * Dělí se to tady, a ne ve stropu, schválně: „co se stalo" je věc stropu, „co
 * řekneme internetu" je věc téhle vrstvy. Kdyby si text ořezával strop sám,
 * přišel by operátor o diagnostiku úplně — žádný logovací kanál pod tím není.
 *
 * `Record<RefusalReason, string>` je tu kvůli **úplnosti**: nová příčina bez
 * veřejného textu neprojde překladem. Bez toho by stačilo příčinu přidat a
 * detail by tiše odešel ven i s čísly.
 */
const PUBLIC_REFUSAL: Record<RefusalReason, string> = {
  CAP_EXHAUSTED: 'the spend cap is used up; no further calls will be made',
  CALL_CAP_EXHAUSTED: 'the call cap is used up; no further calls will be made',
  CONTROL_UNREADABLE: 'the spend cap is misconfigured; no calls will be made until it is fixed',
  INVALID_ESTIMATE: 'the spend cap could not price this call; it was not made',
  // Dvě příčiny knihy (P15 T29) — obě jsou o **účetním úložišti**, ne o
  // zůstatku, a ven o něm nesmí odejít nic bližšího: existence sdíleného
  // úložiště je informace o infrastruktuře, ne o téhle žádosti.
  LEDGER_UNAVAILABLE: 'the spend cap could not be checked right now; this call was not made',
  STORE_UNCONFIGURED: 'the spend cap is misconfigured; no calls will be made until it is fixed',
};

/**
 * Totéž pro **selhání generování**, a je to druhá polovina téže doktríny.
 *
 * ⚠ **Naměřeno 31. 8. 2026, ne odhadnuto.** Do té doby se sem předával
 * `result.detail` doslova. Koncový bod bez schématu v `.env` (`api.example.com/v1`
 * místo `https://api.example.com/v1`) — běžný překlep při kopírování
 * z `.env.example`, tedy spouštěč dosažitelný bez útočníka — dá hlášku
 * `Failed to parse URL from <celá adresa včetně query>`, a ta odešla
 * neověřenému volajícímu. Kdyby brána poskytovatele nesla klíč v query,
 * odešel by s ní; naše hlavičková varianta ho tam nemá, takže leak zůstal
 * u adresy. To je rozdíl mezi „vážné" a „katastrofa", ne mezi „vada" a „nic".
 *
 * `Record<GenerationFailureReason, string>` znovu kvůli **úplnosti**: nový
 * důvod bez veřejného textu neprojde přes `tsc`. Detail zůstává operátorovi
 * ve stopě požadavku, ven jde jen tohle.
 */
const PUBLIC_FAILURE: Record<GenerationFailureReason, string> = {
  UPSTREAM_UNAVAILABLE: 'the model could not be reached; nothing was generated',
  UPSTREAM_REJECTED: 'the model provider rejected the request; nothing was generated',
  MALFORMED_RESPONSE: 'the model answered with something this server cannot read',
  NO_SOURCE: 'this deployment has no answer for that prompt',
  // **Doslova týž text jako `NO_SOURCE`, a je to celý smysl toho rozdělení.**
  // Uvnitř je to porucha korpusu a operátor se o ní dozvědět má; ven se nesmí
  // dát poznat, protože „mám rozbitý korpus" je stav serveru. Odlišný text by
  // z toho udělal ukazatel, kterým jde korpus obcházet po záznamech.
  NO_FROZEN_ANSWER: 'this deployment has no answer for that prompt',
  BRANCH_UNCONFIGURED: 'this deployment is not configured to generate; no call was made',
};

/**
 * **Stavový kód na důvod, tabulkou a ne řetězem `if`ů.**
 *
 * Táž doktrína jako u `BILLED_ON_FAILURE` (`src/server/pipeline.ts`): dokud to
 * byl ternární výraz, propadl nový důvod tiše do 502. `NO_FROZEN_ANSWER` by tak
 * dostal jiný kód než `NO_SOURCE` — a rozdíl, který se schválně nesmí poznat
 * z textu, by šel přečíst ze stavu.
 */
const FAILURE_STATUS: Record<GenerationFailureReason, number> = {
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_REJECTED: 502,
  MALFORMED_RESPONSE: 502,
  NO_SOURCE: 404,
  NO_FROZEN_ANSWER: 404,
  BRANCH_UNCONFIGURED: 503,
};

/**
 * **Co z toho dostane operátor — podle příčiny, ne podle kódu.**
 *
 * `NO_SOURCE` mlčí schválně: u offline větve je to normální odpověď na prompt
 * mimo zmrazený korpus, takže by každý pokus porotce o vlastní větu zapsal
 * chybový řádek (`RULES.md` §3.3 mu ty pokusy výslovně dovoluje). Log operátora
 * by tím zaplnila nejběžnější odpověď dema a skutečné `UPSTREAM_*` by se v ní
 * ztratilo přesně ve chvíli, kdy je někdo hledá.
 *
 * ⚠ **Do 1. 9. 2026 tohle mlčení pohlcovalo i poruchu.** Chybějící odpověď na
 * prompt, který v korpusu **je**, nesla týž důvod, takže filtr neměl jak ty dvě
 * věci rozlišit. Nález nezávislé revize; oprava je vlastní důvod, ne výjimka ve
 * filtru — filtr se od té doby ptá na příčinu.
 *
 * `once` je bound, ne opatrnost: endpoint nechce přihlášení (AC T301) a vada
 * korpusu je **lepivá** — jednou rozbitý záznam je rozbitý napořád, takže řádek
 * na požadavek znamená log, který si kdokoli natáhne donekonečna. Klíčem je
 * `detail`, ne důvod: ten jmenuje **konkrétní záznam**, takže tři rozbité
 * záznamy dají tři řádky, ale tisíc požadavků na jeden dá pořád jeden. Počet je
 * tím shora omezený velikostí korpusu, tedy commitnutého artefaktu, který
 * volající nafouknout nemůže.
 *
 * ## Co rozhoduje mezi `rate-limited` a `once`: co ten bound doopravdy drží
 *
 * **Žádná hodnota téhle tabulky už neznamená „řádek na požadavek".** Do
 * 1. 9. 2026 znamenala — jmenovala se `always` a stála na pravidle, které bylo
 * **nepravdivé**: „patří jen selháním, která vyrobila placená větev, a ta je
 * omezená stropem na počet volání". Dvě nezávislé revize téhož dne to vyvrátily
 * a shodly se na tomtéž protipříkladu:
 *
 * - `UPSTREAM_UNAVAILABLE` vyrábí i **větev zdarma** (`src/server/mock/index.ts`
 *   ho vrací u rozbitého korpusu) a `src/server/pipeline.ts` na něj překládá
 *   **jakoukoli** výjimku z generování. `worstCaseUsd()` je tam nula a `SpendCap`
 *   **nulové rezervace do počtu volání nepočítá**, takže se strop nezapojí.
 *   Naměřeno: chybějící `responses/index.jsonl` na jinak zdravém nasazení,
 *   **20 požadavků = 20 řádků**, každý s absolutní cestou na disku serveru.
 * - I u opravdu placených důvodů (`UPSTREAM_REJECTED`, `MALFORMED_RESPONSE`)
 *   ten bound zmizí, jakmile je strop vypnutý řídicím souborem
 *   (`spend-cap.ts`: obě meze visí na `control.enabled`). „Strop to omezí za nás"
 *   tedy neplatilo ani tam, kde vypadalo, že platí.
 *
 * Stejnou vadu měl `BRANCH_UNCONFIGURED` a opravila se den předtím — jenže jako
 * výjimka pro jeden důvod, ne jako pravidlo. Proto se tahle hodnota přejmenovala:
 * **jméno musí říkat, čím je řádek omezený**, aby další důvod nedostal `always`
 * na základě věty, kterou nikdo nezměřil.
 *
 * Zbývají tedy dvě meze a liší se tím, **čí je to stav**:
 * `rate-limited` je porucha, která se může rozjet a zase přestat (milníky 1.,
 * 10., 100. výskyt, aby se ozvala znovu), `once` je stav, který je od první
 * chvíle napořád stejný (jeden řádek za konkrétní vadu).
 */
const OPERATOR_LOG: Record<GenerationFailureReason, 'rate-limited' | 'once' | 'never'> = {
  UPSTREAM_UNAVAILABLE: 'rate-limited',
  UPSTREAM_REJECTED: 'rate-limited',
  MALFORMED_RESPONSE: 'rate-limited',
  BRANCH_UNCONFIGURED: 'once',
  NO_SOURCE: 'never',
  NO_FROZEN_ANSWER: 'once',
};

/**
 * `once` z tabulky výš, na jednom místě.
 *
 * Volají to dvě cesty a **žádná z nich není ta z potrubí**: rozbitý korpus se
 * pozná ještě před `runPipeline()`, takže by jinak zůstal jediným řádkem
 * v souboru, který bound nemá — a je to zároveň nejlepivější stav, jaký tahle
 * routa umí. Selže před moderací i před stropem, tedy na **každém** požadavku,
 * a varianta `CORPUS_UNREADABLE` nese absolutní cestu na disku serveru včetně
 * jména účtu. Naměřeno nezávislou revizí: 20 požadavků = 20 řádků.
 *
 * ⚠ **Od 1. 9. 2026 to bydlí v `src/server/public-faults.ts`**, protože táž mez
 * má platit na všech čtverých dveřích. Dokud byla soukromá tady, `/api/emit`,
 * `/api/emit/stream` i `/api/edit` psaly řádek na požadavek — nález dvou
 * nezávislých revizí téhož dne, obou nezávisle na sobě.
 */
function logStickyFault(requestId: string, code: string, detail: string): void {
  logStickyForRoute('generate', requestId, code, detail);
}

/**
 * A totéž pro **moderaci** — poslední místo, kde `detail` z řetězu tekl ven.
 *
 * Dnešní čtyři texty jsou konstanty z našich vlastních pravidel, takže tenhle
 * překlad zatím nic neubírá. Je tu kvůli **zítřku**: `DeniedTopic.detail` je
 * volný text v konfiguraci a `TOO_LONG` už dnes skládá větu z čísel. Jakmile
 * někdo do pravidla napíše, čím přesně prompt sedl, odešla by ta věta
 * neověřenému volajícímu — a poznalo by se to až na nasazeném serveru.
 *
 * Strop délky se ven **říct smí a má**: je to konstanta serveru, ne stav, a bez
 * něj nemá volající jak prompt zkrátit. Číslo se proto bere z `MAX_PROMPT_CHARS`,
 * ne z odpovědi moderace, aby ven nešlo nic naměřeného na tom, co poslal.
 *
 * `Record<ModerationCategory, string>` znovu kvůli **úplnosti**: nová kategorie
 * bez veřejného textu neprojde přes `tsc`.
 */
const PUBLIC_MODERATION: Record<ModerationCategory, string> = {
  NOT_TEXT: 'the request carries no prompt text',
  EMPTY: 'the prompt is empty',
  TOO_LONG: `the prompt is longer than the limit of ${MAX_PROMPT_CHARS} characters`,
  DISALLOWED: 'the prompt asks for something this deployment will not generate',
};

/**
 * **Co z `provenance` smí ven — jmenovitě, ne co nesmí.**
 *
 * `provenance` je v odpovědi kvůli auditovatelnosti běhu (RUN-01): porotce má
 * mít v ruce doklad, že svět je odtud, odkud tvrdíme. Jenže ho obě větve
 * skládají samy a jeho typ je otevřený `Record<string, string | boolean>`.
 * Kdo do něj příště přidá klíč, přidá ho **rovnou na veřejnou cestu** a nikdo
 * to nepozná — úplnost překladačem, na které stojí tabulky výš, se u otevřeného
 * záznamu postavit nedá.
 *
 * ⚠ **Naměřeno 31. 8. 2026 nezávislou revizí, ne odhadnuto.** Živá větev
 * takový klíč už měla: `provenance.model` je doslova hodnota `WORLDSMITH_MODEL`
 * (`src/server/upstream.ts:184`). Nejde o to, že by jméno modelu bylo tajné —
 * odevzdání ho podle `RULES.md` §2 stejně zveřejňuje. Jde o to, že je to
 * **živá hodnota proměnné prostředí tohohle nasazení**, kterou si kdokoli na
 * internetu přečte zpátky: překlep, upgrade i dočasně přepnutý model jsou
 * vidět zvenčí dřív než v logu, a to je nastavení serveru, ne vlastnost světa.
 *
 * Dveře se proto zavírají **výčtem toho, co projde**. Nový klíč tudy neprojde,
 * dokud ho sem někdo vědomě nedopíše, a do té doby jde operátorovi do logu.
 * Dnešní sedmička jsou vlastnosti **commitnutých veřejných artefaktů** —
 * který soubor zmrazeného korpusu, jeho hash, jeho deklarovaný verdikt — ne
 * nastavení běhu.
 */
const PUBLIC_PROVENANCE: ReadonlySet<string> = new Set([
  'branch',
  'source',
  'synthetic',
  'promptId',
  'file',
  'bodySha256',
  'declaredVerdict',
]);

/** Rozdělí `provenance` na to, co jde ven, a na to, co jde operátorovi. */
function splitProvenance(provenance: Readonly<Record<string, string | boolean>>): {
  readonly shown: Record<string, string | boolean>;
  readonly withheld: readonly string[];
} {
  const shown: Record<string, string | boolean> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(provenance))
    if (PUBLIC_PROVENANCE.has(key)) shown[key] = value;
    else withheld.push(`${key}=${String(value)}`);
  return { shown, withheld };
}

/**
 * **Příčiny odmítnutí, které už tenhle proces operátorovi zapsal.**
 *
 * Endpoint je bez přihlašování (AC T301), takže rychlost zápisu na stderr řídí
 * kdokoli na internetu — a odmítnutí stropem je **lepivý stav**: jakmile
 * `CAP_EXHAUSTED` jednou padne, padá na každý další požadavek už napořád.
 * Naměřeno nezávislou revizí 1. 9. 2026: 25 požadavků proti rozbitému
 * ovládacímu souboru = 25 řádků, každý s absolutní cestou k němu. To je táž
 * vada, kvůli které se o pár řádků níž neloguje `NO_SOURCE`, jen z druhé strany.
 *
 * Bound je proto **na tom, co to vyrobí**, ne na tom, kdo to volá: čtyři příčiny
 * odmítnutí = nejvýš čtyři řádky za celý život procesu. Diagnostika se tím
 * neztrácí, protože první výskyt nese všechno, co operátor potřebuje.
 *
 * ⚠ **Co to vědomě nedělá:** není to sledování přechodů. Když se vypínač opraví
 * a **v témž procesu** rozbije znovu, druhé rozbití se nezapíše. Vědět to by
 * znamenalo zapisovat i každý úspěch, tedy práci navíc na horké cestě za stav,
 * který se na serverless nasazení stejně resetuje s každým chladným startem.
 */
const REFUSALS_LOGGED = new Set<RefusalReason>();

/**
 * **Účetní řádek je omezený v dolarech, ne v počtu požadavků.**
 *
 * První pokus o tuhle mez byly milníky (1., 10., 100. volání) a **byl špatně** —
 * nález nezávislé revize 1. 9. 2026. Milníky omezují, jak často se píše, ale ne,
 * o kolik peněz může log zaostat: 250 zaplacených volání v jednom procesu
 * nechalo poslední řádek stát na 0,33 USD proti skutečně utraceným 0,825 USD
 * (**40 %**), a při 25 chladných startech po devíti voláních dal součet všech
 * řádků 0,0825 proti 0,7425 USD (**11 %**). Komentář u toho tvrdil, že se
 * „účetnictví neztrácí". Neplatilo to.
 *
 * Krok v dolarech drží obojí naráz: **zaostat smí nejvýš o `ACCOUNTING_STEP_USD`**,
 * ať přijde kolik požadavků chce, a **počet řádků je pořád omezený**, protože
 * peníze omezuje `SpendCap` — nejvýš `capUsd / krok` řádků za proces.
 *
 * Krok je **procento skutečného stropu**, ne setina toho výchozího — oprava
 * podle kontrolní revize 1. 9. 2026, která tu naměřila 200násobek. Do té chvíle
 * tu stálo `DEFAULT_CAP_USD / 100`, tedy pevných 5 centů odvozených z literálu
 * v `spend-cap.ts`, zatímco skutečný strop nese `WORLDSMITH_SPEND_CAP_USD`,
 * případně utažený řídicím souborem — od `T30-capfloor` je to
 * `min(soubor, proměnná)`, ne „jedno nebo druhé": soubor umí částku jen
 * snížit a nad proměnnou nevydá nikdy. Nad `WORLDSMITH_SPEND_CAP_USD=1000` — což je
 * prostředí, ve kterém tohle testujeme — to dávalo `1000 / 0,05` = **20 000
 * řádků za proces** proti slíbené stovce, a komentář u toho tvrdil „když se
 * strop zvedne, zvedne se s ním". Teď se zvedne doopravdy.
 *
 * Setina stropu drží tu větu na obou koncích: **nejvýš sto řádků za proces**
 * při jakémkoli stropu, a přesnost je úměrná sázce — nad stropem 1000 USD nikdo
 * nechce vědět o pěti centech, nad stropem 1 USD ano. Vypnutý nebo nečitelný
 * strop je nula, a ta by znamenala řádek na požadavek; proto se v tom případě
 * vrací setina výchozího stropu, tedy dnešní chování.
 *
 * ⚠ **Pořád je to stav procesu, ne nasazení** — táž výhrada jako u
 * `logRateLimited()` (`src/server/public-faults.ts`). Chladný start obojí
 * vynuluje, takže skutečná mez je `instance × 100` řádků. Zavře to teprve
 * sdílený stav z vlny 7 (T29), tentýž, který potřebuje i strop utrácení.
 */
function accountingStepUsd(): number {
  const { capUsd } = CAP.snapshot();
  return (capUsd > 0 ? capUsd : DEFAULT_CAP_USD) / 100;
}

/** Utracené dolary za tenhle proces. Roste u **každého** placeného volání. */
let accountedUsd = 0;

/** `accountedUsd` tak, jak ho naposledy viděl operátor v logu. */
let reportedUsd = 0;

/**
 * Zapíše účetní řádek, když od posledního zápisu přibyl aspoň krok.
 *
 * Součet roste vždycky, i když se řádek nenapíše — jinak by z účetnictví byl
 * náhodný vzorek. **První zaplacené volání se zapíše vždycky**: že nasazení
 * začalo utrácet, je jediná zpráva, kterou operátor nesmí propásnout, a čekat
 * na první celý krok by ji o ten krok opozdilo.
 *
 * Není to druhý strop a nic neomezuje — skutečný zůstává `SpendCap`. Tohle je
 * jen to, co se o něm dá přečíst z logu.
 *
 * ⚠ **Účtenka, která není konečné číslo, se do součtu nepustí** — nález
 * kontrolní revize 1. 9. 2026. `usageOf()` (`src/server/upstream.ts`) pouští
 * `Infinity` i záporná čísla od poskytovatele dál schválně, protože je zahodí
 * `release()` ve stropu; jenže tohle je **druhý** konzument téhož čísla a
 * takovou pojistku neměl. Jediné `{"input_tokens":1e999}` by udělalo
 * z `accountedUsd` `Infinity`, načež `Infinity - Infinity` je `NaN`, porovnání
 * s krokem je napořád nepravda a **každý další placený požadavek napíše řádek**
 * — naměřeno 6 požadavků, 6 řádků, s nečitelným součtem. Mez by tím zmizela
 * přesně u toho poskytovatele, kvůli kterému se log čte.
 *
 * Součet proto zůstane stát a operátor dostane **jeden** řádek za proces
 * o tom, že od téhle chvíle je součet spodní odhad, ne částka. Peníze si
 * poradily samy: `release()` v takovém případě strhne celou rezervaci, takže
 * strop drží dál. Srovnat to, co hlásí výsledek, s tím, co strop doopravdy
 * strhl, je úloha `T9-costreport` — tady se zavírá jen ta mez.
 */
function logAccounting(requestId: string, costUsd: number): void {
  // **Tady stávala pojistka proti záporné a nekonečné částce a je pryč
  // schválně.** Byla to oprava u konzumenta místo u zdroje: `costUsd` z
  // `runPipeline` je od 1. 9. 2026 to, co `settle()` doopravdy strhlo, a to je
  // buď použitelná účtenka, nebo rezervace — obojí konečné a nezáporné, obojí
  // ověřené v `reserve()`. Kontrola, která nemůže spadnout, jen tvrdí, že něco
  // hlídá. Drží to test „hlášená cena se rovná strženému" v `pipeline.test.ts`.
  //
  // Nula zůstává normální stav (offline větev, neúčtované selhání) a mlčí.
  if (costUsd === 0) return;
  accountedUsd += costUsd;
  if (reportedUsd > 0 && accountedUsd - reportedUsd < accountingStepUsd()) return;
  reportedUsd = accountedUsd;
  logForOperator(
    requestId,
    'ACCOUNTING',
    `costUsd=${costUsd} totalUsd=${accountedUsd.toFixed(6)}`,
  );
}

function error(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

/**
 * Diagnostika, která nesmí ven — ale nesmí ani zmizet.
 *
 * Bez tohohle řádku by ořezání textů výš vyměnilo jednu vadu za druhou:
 * operátor s překlepem v adrese by dostal „the model could not be reached" a
 * **žádný způsob, jak zjistit proč**. `withRequest()` nese jen korelační ID,
 * nic neloguje, takže pod tím doopravdy nebyl žádný kanál (viz hlavička
 * `PUBLIC_REFUSAL`). Tenhle je: stderr procesu vidí ten, kdo server provozuje,
 * a nikdo jiný. `requestId` je stejné jako v odpovědi, takže se dvojice spáruje.
 *
 * ⚠ **„Operátorův stderr" není tak úzký kanál, jak to zní** — nález nezávislé
 * revize 31. 8. 2026. Na cílové platformě jdou runtime logy každému členovi
 * projektu a do všech nastavených odtoků, takže adresa s přihlašovacími údaji
 * (`https://user:heslo@host/...`) by se v nich objevila v čitelné podobě.
 * Heslo se proto **před zápisem odstraní**. Zbytek adresy zůstává, protože bez
 * něj tenhle řádek nediagnostikuje nic.
 */
function logForOperator(requestId: string, code: string, detail: string): void {
  logForRoute('generate', requestId, code, detail);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    /**
     * **Strop na frekvenci je první brána, ještě před čtením těla.** Jsou to
     * **placené** dveře, takže čítač volání v letu níž zůstává — ten hlídá
     * peníze a souběh, tenhle hlídá smyčku instance a jsou to dvě různé věci.
     * Odůvodnění čísel i toho, proč je mez na proces, je
     * v `src/server/rate-limit.ts`.
     */
    const slot = takeRateSlot('generate', callerKey(request));
    if (!slot.allowed) {
      logRateLimited('generate', requestId, rateLimitCode(slot), `${String(slot.count)} in window`);
      return rateLimitedResponse(requestId, slot);
    }

    /**
     * **Čtení těla je uvnitř `try`, a je to jediný důvod, proč tenhle handler
     * odpoví vždycky.** `readBody()` vrací meze jako hodnotu, ale samo
     * `reader.read()` se **odmítnout** může — přerušené spojení, vadná
     * komprese — a to odmítnutí by proletělo z `POST` ven. Odpověď by pak
     * složil Next.js: pětistovka bez `requestId`, tedy jediný požadavek
     * v celém provozu, který se nedá spárovat s řádkem v logu. Naměřeno
     * nezávislou revizí 31. 8. 2026.
     */
    let raw;
    try {
      raw = await readBody(request);
    } catch (thrown) {
      // Omezená rychlost, ne lepivý bound: přerušit vlastní spojení umí
      // volající kolikrát chce, ale „těla přestala chodit" je porucha, která se
      // musí ozvat i podesáté. Táž cesta jako u tří sesterských rout.
      logRateLimited(
        'generate',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return error(requestId, 400, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    // Třetí důvod (`BUSY`) a jeden překlad pro všechny dveře — viz
    // `bodyRefusalResponse()` v `src/http/body.ts`. Kódy i hlášky beze změny.
    if (!raw.ok) return bodyRefusalResponse(requestId, raw);

    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return error(requestId, 400, 'MALFORMED_BODY', 'request body is not JSON');
    }

    /**
     * **Strop na placená volání v letu, sdílený se worldstreamovými dveřmi**
     * (P15 T28).
     *
     * Tady stála do 3. 9. 2026 brána na promlčeném rozpočtu (`admit()`) a
     * **nezávislá revize ji vyvrátila měřením:** odmítne až požadavek, který
     * čekal přes 12 s, jenže jediný interval, který se odsud dá změřit, je
     * čtení těla — a to má vlastní strop `BODY_DEADLINE_MS = 5 000`
     * (`src/http/body.ts:43`). Brána tedy byla o sedm vteřin mimo dosah a
     * nemohla odmítnout nikdy nikoho. `maxQueued` navrch `admit()` vůbec
     * nečte — je to pole fronty, ne té čisté funkce.
     *
     * Zůstává proto mechanismus, který pod náporem doopravdy kousne: **čítač
     * souběžných generací**. Je to schválně **týž čítač**, jaký drží
     * `POST /api/worldstream/sessions` a preview druhé věty — tři dveře
     * k témuž modelu a k témuž účtu, takže tři oddělené stropy po čtyřech by
     * nebyly strop čtyř, jen návod, jak se střídat.
     *
     * **Tyhle dveře jsou `'world'`, ne `'refine'`.** Drží slot po celý
     * `runPipeline`, tedy dvě až čtyři volání modelu uvnitř jednoho požadavku —
     * táž doba držení jako u zakládání relace. Zastaví se proto o slot dřív
     * (`MAX_WORLD_GENERATIONS`), aby preview druhé věty nezůstalo bez místa;
     * naměřené odůvodnění je u té konstanty.
     *
     * **Slot se bere PŘED čtením protokolu, protože odmítnutí musí být levné.**
     * Druhé kolo revize 3. 9. 2026 našlo obrácené pořadí: `frozenGrammar()`
     * není memoizované a každé volání blokuje smyčku dvěma `readFileSync`,
     * sha256 a `JSON.parse`, takže požadavek odsouzený k `503` platil ~2 ms
     * úplně zablokovaného Node — tisíc odmítnutí 2,2 s, po které stojí i SSE
     * proudy, snapshoty a zdravotní sonda na téže instanci. Sesterské dveře
     * (`worldstream/sessions/route.ts:241`) mají to pořadí naměřené od rána;
     * tohle je jenom jejich přenos.
     *
     * ⚠ **Od `f5b1b49` je `frozenGrammar()` memoizované, takže to číslo platí
     * jen pro PRVNÍ požadavek na instanci** — dál je čtení ~0 ms. Pořadí se
     * přesto nemění a nesmí: cenu prvního požadavku platí každá nová instance
     * a na Vercelu jich naskakuje tolik, kolik jich zrovna běží. Kdo tohle
     * půjde přeměřit, naměří nulu a bude v pokušení bránu vrátit za čtení.
     *
     * Jediný odchod mezi vzetím slotu a `finally` níž je nečitelný protokol —
     * a ten slot vrací sám, o dva řádky níž. **Přibude-li sem další `return`,
     * musí vrátit taky.**
     */
    if (!acquireSlot('generate')) {
      // **Odmítnutí musí být vidět v operátorském logu.** Bez toho řádku
      // neodliší nikdo „strop nás ochránil" od „nikdo nepřišel" — a orákulum
      // téhle brány je na nasazené adrese nepozorovatelné. `logRateLimited`
      // klíčuje `(dveře, kód)` a text je schválně konstantní, takže z něj
      // nápor nevyrobí víc než logaritmus řádků; objem nese `(occurrence N)`.
      // **„on this instance" tam je schválně:** `running` je stav modulu, takže na
      // Vercelu má každá instance vlastní čítač a nasazení jich má tolik, kolik
      // jich zrovna běží. Věta bez té výhrady by operátorovi tvrdila globální
      // číslo, které nikdo nedrží; sdílený stav je `T29`.
      logRateLimited(
        'generate',
        requestId,
        'TOO_MANY_GENERATIONS',
        // **Řádek jmenuje dveře, které sloty drží.** Do `T22-doorcounters`
        // uměl čítač říct jen souhrn, takže operátor nepoznal, jestli tyhle
        // dveře zavřely světy, nebo preview druhé věty. Celé odůvodnění je
        // u `slotsDetail` ve worldstream/sessions/route.ts.
        slotsDetail('generate'),
      );
      return error(
        requestId,
        503,
        'TOO_MANY_GENERATIONS',
        'too many worlds are being built right now',
      );
    }

    const grammar = frozenGrammar();
    if (!grammar.ok) {
      releaseSlot('generate');
      logStickyFault(requestId, grammar.reason, grammar.detail);
      return error(requestId, 503, grammar.reason, PUBLIC_CORPUS_FAULT[grammar.reason]);
    }

    let result;
    try {
      result = await runPipeline((body as { prompt?: unknown } | null)?.prompt, {
        branch: await branchFor(process.env),
        cap: CAP,
        grammar: grammar.value,
      });
    } finally {
      // **Uvolnit se musí i po výjimce.** Slot, který zůstane zabraný po pádu,
      // je strop, který se s každou chybou o jedna sníží — a po čtyřech
      // pádech dveře zavře natrvalo.
      releaseSlot('generate');
    }

    /**
     * **Úspěch neúčtuje ven.**
     *
     * Do 1. 9. 2026 nesla odpověď 200 `usage` i `costUsd` naráz, a to jsou
     * **dvě rovnice o dvou neznámých**: dva prompty s různým poměrem vstupu
     * a výstupu z nich dají `usdPerMTokIn` i `usdPerMTokOut` přesně, protože
     * `costUsd()` (`src/server/spend-cap.ts:65`) je lineární a její tvar je
     * veřejný. Ceník nasazení je přitom smlouva s poskytovatelem, ne vlastnost
     * světa, který porotce dostal.
     *
     * **Zůstává `usage`, mizí `costUsd`**, a ta volba není libovolná: `costUsd`
     * je vlastnost **ceníku** — sám o sobě neříká nic o světě a zároveň je to
     * jediná polovina dvojice, bez které se ceník dopočítat nedá. Počet tokenů
     * je proti tomu vlastnost **toho volání**.
     *
     * ⚠ **Není to ale spálená spotřeba, a od 1. 9. 2026 se to tak nesmí
     * popisovat.** Do té doby se tohle pole odůvodňovalo jako poctivá vlastnost
     * volání, a to přestalo platit o tři úlohy dřív. `usage` je **účetní
     * základ** — číslo, ze kterého se počítal účet — a od účtenky poskytovatele
     * se liší třemi způsoby:
     *
     * - **Zvedá se na hranici.** Podhlášený výstup se přepočítá z délky textu,
     *   který odpověď nese (`readableUsage()` v `src/server/upstream.ts`).
     *   Naměřeno: poskytovatel pošle `{0, 1}`, ven jde `outputTokens: 250`.
     * - **Nečitelná účtenka jde ven jako `{0, 0}`.** Záporná složka, chybějící
     *   `usage` i dvojitá nula znamenají „účet se přečíst nedal, strhla se
     *   rezervace". `{0, 0}` je tenhle stav, ne nula spálených tokenů.
     * - **Nekonečná se vrací syrová.** Je čitelná, jen nesmyslná: strop ji
     *   odmítne a naúčtuje rezervaci, hlášené číslo se přitom nemění.
     *
     * **Rozhodnuto: přepsat tuhle větu, ne rozdělit pole.** Oddělit účetní
     * základ od hlášené účtenky znamená druhé pole v `GenerationOutcome` a sáhnout
     * na `pipeline.ts`. Koupilo by se za to jediné: ven by šla čísla, kterým
     * server sám nevěří — přesně ty tvary (`{0, 1}`, záporné složky), kvůli
     * kterým hranice a znaménkové pravidlo vznikly. Publikovat účtenku, kterou
     * si server odmítl nechat pro účet, je horší odpověď než popsat, co to číslo
     * je. **Únik to není ani takhle:** `costUsd` ven pořád nejde a jediné, co
     * z čísla jde dopočítat, je dělitel hranice (`outputTokens === ceil(délka
     * emise / 12)`), tedy konstanta ve veřejném zdrojáku.
     *
     * ⚠ **Do 1. 9. 2026 tady stálo, že řádek omezuje „to, co ho vyrábí" — a to
     * bylo nepravdivé.** Argument zněl: účtovat je co jen u placeného volání
     * a ta omezuje strop počtu volání, tedy týž mechanismus, který omezuje
     * peníze. Vyvrátila ho kontrolní revize `cdf2c06`, tedy commitu, který
     * tutéž větu vyvracel o dvě stě řádků výš u `OPERATOR_LOG` a **tady se o ni
     * opřel dál**. Dvě měření:
     *
     * - **Strop je na proces, ne na nasazení.** `#callsMade`
     *   (`src/server/spend-cap.ts`) je paměť procesu a chladný start ji vynuluje,
     *   takže na serverless dostane volající celý strop řádků **za každý studený
     *   proces**. Naměřeno nad `WORLDSMITH_CALL_CAP=2`.
     * - **A když je strop vypnutý, není žádný.** Obě meze visí na
     *   `control.enabled`, takže nad `{"enabled":false,"capUsd":0}` dá **250 požadavků 250
     *   řádků**, každý se jménem modelu z prostředí.
     *
     * Bound je proto **krok v dolarech**, ne milníky — viz `logAccounting()`.
     * Milníky tu stály první a byly druhá špatná odpověď na tutéž otázku:
     * omezily, jak často se píše, ale ne, o kolik peněz smí log zaostat.
     * **Účetnictví se tím neztrácí** — sampling by sám o sobě zahodil cenu
     * devíti volání z deseti, takže řádek nese vedle ceny toho volání i
     * **průběžný součet za proces**, který roste u každého placeného volání.
     * Z jednoho řádku se tak přečte utracená částka, a to s chybou nejvýš
     * o jeden krok. **Počet volání z něj přečíst nejde** a je to vědomé:
     * `logForOperator` nemá počítadlo `(occurrence N)`, které měl `logRateLimited`.
     *
     * Offline větev má `costUsd` nulové a v `provenance` nezadržuje nic, takže
     * nezapíše nikdy — to platí dál.
     *
     * ⚠ **Jméno modelu sem patří a ven nesmí.** Nabízelo se dopsat `model` do
     * `PUBLIC_PROVENANCE`, čímž by `withheld` zůstalo prázdné — jenže to ten
     * řádek nezavře (`costUsd > 0` ho vyrobí stejně) a zároveň by to zrušilo
     * rozhodnutí, které stojí o kus výš a má vlastní test: `WORLDSMITH_MODEL` je
     * **živá hodnota prostředí tohohle nasazení**, ne vlastnost světa.
     */
    if (result.outcome === 'GENERATED') {
      const { shown, withheld } = splitProvenance(result.provenance);
      // Dvě půlky jednoho řádku, každá s mezí podle toho, čí je to stav.
      // Zadržený klíč provenience je **nastavení nasazení** — u každého
      // požadavku týž, takže lepivě. Peníze jsou stav, který roste, takže
      // krokem v dolarech.
      if (withheld.length > 0) logStickyFault(requestId, 'PROVENANCE_WITHHELD', withheld.join(' '));
      logAccounting(requestId, result.costUsd);
      return Response.json({
        requestId,
        branch: result.branch,
        emission: result.body,
        usage: result.usage,
        provenance: shown,
      });
    }

    /**
     * **Odmítnutí se logují taky, a u stropu je to celý rozdíl mezi provozem
     * a hádáním.** `CONTROL_UNREADABLE` znamená rozbitý ovládací soubor —
     * server odmítá všechno a operátor se z odpovědi dozví jen „the spend cap
     * is misconfigured", protože cesta k souboru se ven ořezává. Do 1. 9. 2026
     * se přitom nikam nezapisovala, takže ten jediný text, který říká **který
     * soubor a proč**, nedošel nikomu.
     */
    if (result.outcome === 'REFUSED') {
      if (result.stage === 'moderation') {
        // **Jen `DISALLOWED`.** Zbylé tři kategorie jsou vady dotazu —
        // chybějící pole, prázdný text, přes strop délky — a odpověď je
        // popisuje celé, takže operátorovi neříkají nic, co by neviděl
        // volající sám. Zapisovat je znamená pustit anonymního volajícího
        // k neomezenému psaní na stderr za cenu jednoho prázdného těla.
        // `DISALLOWED` zůstává: je to jediné, co znamená, že někdo zkouší,
        // kam až smí.
        //
        // **Ale s omezenou rychlostí** — nález dvou nezávislých revizí
        // 1. 9. 2026, obou `blocking`. Rozhoduje o tom **text od volajícího**,
        // odmítnutí je zadarmo a padne před stropem, takže tenhle řádek byl
        // ze všech čtverých dveří ten nejlevnější na zesílení: žádný stav
        // korpusu, žádný platný `worldDoc`, jen prompt v cyklu. Komentář nad
        // tím přitom o dva odstavce výš argumentuje přesně proti tomu, čemu
        // sám podlehl. Klíč je `route + code`, takže se milníky počítají zvlášť
        // pro každou kategorii pravidla.
        if (result.category === 'DISALLOWED')
          logRateLimited(
            'generate',
            requestId,
            `PROMPT_REFUSED ${result.category}`,
            result.ruleId ?? 'structural',
          );
        return Response.json(
          {
            requestId,
            error: {
              code: 'PROMPT_REFUSED',
              message: PUBLIC_MODERATION[result.category],
              category: result.category,
            },
          },
          { status: 400 },
        );
      }
      if (!REFUSALS_LOGGED.has(result.reason)) {
        REFUSALS_LOGGED.add(result.reason);
        logForOperator(requestId, result.reason, result.detail);
      }
      return error(
        requestId,
        result.reason === 'CAP_EXHAUSTED' || result.reason === 'CALL_CAP_EXHAUSTED' ? 429 : 503,
        result.reason,
        PUBLIC_REFUSAL[result.reason],
      );
    }

    // **Účtuje se i selhání, které stálo peníze.** `BILLED_ON_FAILURE`
    // (`src/server/pipeline.ts`) účtuje `UPSTREAM_UNAVAILABLE` a
    // `MALFORMED_RESPONSE` rezervací, protože poskytovatel odpověděl a to se
    // platí. Kdyby se sem přičítalo jen z úspěchů, `totalUsd` by podhlašovalo
    // právě ve chvíli, kdy poskytovatel zlobí — tedy směrem, který peníze
    // schovává. Nález nezávislé revize 1. 9. 2026.
    logAccounting(requestId, result.costUsd);

    // Kdo co dostane, rozhodují `OPERATOR_LOG` a `FAILURE_STATUS` výš — obě
    // tabulky nad `GenerationFailureReason`, takže nový důvod bez rozhodnutí
    // neprojde přes `tsc`.
    if (OPERATOR_LOG[result.reason] === 'rate-limited')
      logRateLimited('generate', requestId, result.reason, result.detail);
    else if (OPERATOR_LOG[result.reason] === 'once') {
      logStickyFault(requestId, result.reason, result.detail);
    }

    return Response.json(
      {
        requestId,
        // **Kód důvodu jde ven schválně** — je to kontrakt klienta, který na
        // 404 staví svět v prohlížeči. `NO_FROZEN_ANSWER` sem proto NESMÍ:
        // rozdíl by se dal přečíst odsud místo z textu. Překládá se na
        // `NO_SOURCE`, protože zvenku to jedna a táž odpověď je.
        error: {
          code: result.reason === 'NO_FROZEN_ANSWER' ? 'NO_SOURCE' : result.reason,
          message: PUBLIC_FAILURE[result.reason],
        },
        branch: result.branch,
      },
      { status: FAILURE_STATUS[result.reason] },
    );
  });
}
