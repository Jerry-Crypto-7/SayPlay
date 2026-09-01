/**
 * **Živá větev generování — HTTP volání poskytovatele.**
 *
 * Druhá implementace `GenerationBranch`. Prochází stejnou kontraktovou sadou
 * jako offline větev v `src/server/mock/`; liší se jen fixture, nikdy tvrzení.
 *
 * ## Cloud je od P13 hlavní cesta, ne zakázaná
 *
 * **Rozhodnutí ze 14. 8. 2026 („placený model se volat nebude") je od 27. 8.
 * 2026 překonané** — P13 dělá z cloudového modelu hlavní cestu, protože lokální
 * Qwen3-1.7B má medián 35–39 s na větu a to porotce nevydrží. Vypínač zůstává
 * beze změny: bez `WORLDSMITH_BRANCH=live` a bez klíče tahle větev **nikam
 * nevolá** a vrací `BRANCH_UNCONFIGURED`. Změnilo se, že ten stav už není cíl,
 * jen výchozí hodnota.
 *
 * Koncový bod nemá výchozí hodnotu schválně. Zapsaná adresa v kódu je způsob,
 * jak se jednou omylem zavolá ven. Adresa, kterou sem patří dosadit, je
 * v `.env.example` u `WORLDSMITH_MODEL_ENDPOINT`.
 *
 * ## Transport se vstřikuje
 *
 * `fetchImpl` je parametr, protože jinak by se kontrakt téhle větve nedal
 * ověřit bez sítě — a test, který sahá na síť, měří poskytovatele, ne nás.
 * Tentýž vzor jede v `evals/harness/live.ts` (`transportFor(config, fetchImpl)`),
 * odkud se ale importovat nesmí: `src/server/**` a `evals/harness/**` jsou
 * oddělené vrstvy a jejich stropy útraty o sobě nesmějí vědět.
 *
 * ## Odhad nejhoršího případu
 *
 * Rezervuje se **celý** povolený výstup za plnou cenu a vstup přepočtený
 * z počtu znaků. Dělí se třemi, ne čtyřmi: čtyři znaky na token je průměr, a
 * průměr je pro horní odhad špatná jednotka. Odhad nižší než skutečnost by
 * strop tiše prodloužil.
 */

import { EMISSION_MODEL } from '../model/prompt';

import type { GenerationBranch, GenerationCall, GenerationOutcome } from './pipeline';
import type { Pricing, Usage } from './spend-cap';

export const UPSTREAM_BRANCH_ID = 'live';

/** Konzervativní počet znaků na token pro **horní** odhad vstupu. */
const CHARS_PER_TOKEN = 3;

/**
 * Znaků na token pro **dolní** odhad výstupu — a je schválně jiný než
 * `CHARS_PER_TOKEN`.
 *
 * **Dva odhady téže veličiny nesmějí sdílet konstantu, když jejich bezpečná
 * strana míří opačně.** Horní odhad rezervace se dělí třemi, aby spíš
 * přestřelil (viz hlavička souboru). Dolní hranice účtu musí naopak spíš
 * podstřelit: kdyby vyšla nad skutečnou účtenku, přeúčtovala by **každé
 * poctivé volání**, a hlášená cena by přestala být tou, která se strhla.
 * Zdědit sem trojku by tu vadu vyrobilo systematicky, na každém požadavku.
 *
 * Dvanáct je zhruba trojnásobek běžných ~4 znaků na token. **Není to naměřené
 * a nikde to netvrď** — tokenizér poskytovatele neznáme, tohle je vědomě
 * velkorysá mez. Cena té velkorysosti je, že hranice pokryje jen asi čtvrtinu
 * skutečné útraty; to stačí, protože úkolem není účtenku zrekonstruovat, ale
 * zařídit, aby se podhlášení nevyplatilo.
 *
 * ⚠ **Neplyne z toho, že hranice zůstane pod rezervací** — první znění tady
 * tvrdilo, že text delší, než kolik `maxOutputTokens` unese, nevznikne. To je
 * předpoklad o poctivosti poskytovatele, tedy jediná věc, kterou tenhle soubor
 * jinde odmítá předpokládat. Naměřeno nezávislou revizí 1. 9. 2026: odpověď
 * 200 s textovým blokem o 2,4 MB a účtenkou `{0, 1}` strhla **celý dolarový
 * strop 5 USD** proti rezervaci 0,2195 USD, takže každý další porotce dostal
 * 429 — přeúčtovávat se začne asi od 105 kB. Hranici proto ořezává
 * `maxOutputTokens`, ne důvěra.
 */
const FLOOR_CHARS_PER_TOKEN = 12;

/**
 * Úrovně úsilí, které Messages API zná. **Zavřený seznam schválně:** neznámou
 * hodnotu odmítne poskytovatel čtyřistovkou a živá větev je mrtvá přesně v té
 * konfiguraci, kterou někdo opsal z dokumentace s překlepem. Táž vada jako
 * `{"model": ""}` naměřená 21. 8. 2026, jen o jedno pole vedle.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

export interface UpstreamConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly effort: Effort;
  readonly pricing: Pricing;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * **Proč `low` a ne výchozí hodnota poskytovatele.**
 *
 * Na `claude-opus-5` běží uvažování **zapnuté i tehdy, když se pole `thinking`
 * vůbec nepošle**, a výchozí úsilí je `high`. Tahle větev ale emituje jeden
 * JSON podle zavřené gramatiky, ne řešení úlohy — a brána K2 chce p95 do
 * hrubého světa **pod 3 sekundy**. Výchozí hodnota poskytovatele je proto pro
 * tuhle cestu špatná, i když je pro většinu volání správná.
 *
 * **Uvažování se nevypíná**, přestože by to vypadalo jako přímější páka:
 * s `thinking: {type: "disabled"}` na Opus 5 model občas napíše volání nástroje
 * do viditelného textu místo do bloku a umí protéct značkami `<thinking>` —
 * obojí je zdokumentované chování, ne dohad. Snížené úsilí dá totéž zrychlení
 * bez těch dvou.
 *
 * **Není to naměřené a nikde to netvrď.** Je to hodnota vybraná z popsaného
 * chování; jestli sedí, rozhodne T14 nad zmrazenou sadou. Proto je přebytelná
 * proměnnou prostředí — aby se dala přeměřit bez zásahu do kódu.
 */
const DEFAULT_EFFORT: Effort = 'low';

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Cena vstupu. **Nevyplněná se dopočítá z ceny výstupu, výslovná nula se
 * respektuje** — a přesně ten rozdíl je jádro vady naměřené 21. 8. 2026.
 *
 * `positiveNumber` se tu použít nedá: ta žádá `> 0`, takže by neuměla odlišit
 * „operátor napsal nulu" od „operátor nenapsal nic". Tichá výchozí nula
 * podhodnocovala rezervaci o celý vstup (~3000 tokenů na volání); nula, kterou
 * někdo napsal, je naproti tomu rozhodnutí a je vidět v konfiguraci.
 *
 * Vadná hodnota (překlep, desetinná čárka, záporné číslo) se chová jako
 * chybějící a dopočítá se — u stropu je přestřelená rezervace bezpečná strana.
 */
/**
 * Úsilí z prostředí. Neznámá i prázdná hodnota padá na `DEFAULT_EFFORT` — na
 * rozdíl od ceny se tady tichá náhrada smí: špatné úsilí stojí latenci, ne
 * peníze navíc, a odmítnout kvůli němu celou cloudovou větev by bylo dražší než
 * ta vada sama.
 */
function effortLevel(raw: string | undefined): Effort {
  const value = (raw ?? '').trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as Effort) : DEFAULT_EFFORT;
}

function inputPrice(raw: string | undefined, usdPerMTokOut: number): number {
  if (raw === undefined || raw.trim() === '') return usdPerMTokOut;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : usdPerMTokOut;
}

/**
 * Konfigurace z prostředí, nebo `null`, když chybí klíč, koncový bod **nebo
 * cena výstupu**.
 *
 * `env` je parametr, ne `process.env` uvnitř — testovat globální čtení jde jen
 * saháním na proces.
 *
 * ## Chybějící cena výstupu je nekonfigurace, ne nula
 *
 * **Naměřeno 21. 8. 2026 nezávislou revizí a je to nejhorší nález téhle úlohy.**
 * Bez ceny vyjde `worstCaseUsd()` nula, `SpendCap.reserve(0)` projde i při
 * stropu nula (`0 > 0` je nepravda) a strop tím **nedrží vůbec nic**: 25 z 25
 * požadavků odešlo k poskytovateli, každý s 8000 výstupními tokeny, zůstatek se
 * ani nehnul a žádný nedostal 429. `/api/generate` přitom nechce přihlášení, tak
 * účet omezuje jen návštěvnost. Vzniklo to zkopírováním `.env.example`, kde ceny
 * schválně prázdné jsou — tedy přesně tou cestou, kterou dokumentace předepisuje.
 *
 * Odmítnutí je proto tady, na úrovni konfigurace, a ne ve stropu: `reserve(0)`
 * je legitimní pro offline větev, která nic nestojí, takže nula sama o sobě
 * vadná není. Vadná je **placená** větev bez ceny. `cloudBranchAvailable()` tím
 * odpoví `false`, což je poctivá odpověď: takhle nastavený cloud nemá jak jet.
 *
 * Táž doktrína jako u dvojčete pro měřicí běhy: `.env.example` i tam říká
 * o ceně výstupu „musí být KLADNÁ" a jeho preflight bez ní běh odmítne. Jméno
 * té proměnné se sem nepíše schválně — hranici mezi oběma stropy drží lexikální
 * test v `./__tests__/pipeline.test.ts` a ten ji hlídá i v komentářích.
 *
 * **Cena vstupu se nevyžaduje, ale její náhradou je cena výstupu — ne nula.**
 * Původní znění tady tvrdilo, že vstup je „pár stovek tokenů" a nula ho tedy
 * podhodnotí jen nepatrně. **To bylo měřením vyvráceno 21. 8. 2026:** systémová
 * zpráva má ~7000 znaků a prompt až 2000, tedy ~3000 vstupních tokenů. Při
 * ceníku, který používají vlastní testy repozitáře (1000 výstupních tokenů,
 * vstup 3 / výstup 15 USD za Mtok), rezervace kryla 0,015 USD ze skutečných
 * 0,0243 USD — strop 5 USD by pustil ~333 volání za ~8,04 USD, tedy **o 61 %
 * přes**. Při výchozích hodnotách (8000 výstupních, Opus) je přestřel 7,6 %.
 *
 * Náhrada za chybějící cenu vstupu je proto cena výstupu: rezervace tím spíš
 * přestřelí, což je u stropu ta bezpečná strana. Výslovná nula se pořád přijme —
 * to je vědomé rozhodnutí operátora, ne tichá výchozí hodnota, a právě tichá
 * výchozí hodnota byla ta vada.
 */
export function upstreamConfigFromEnv(env: Record<string, string | undefined>): UpstreamConfig | null {
  const endpoint = env.WORLDSMITH_MODEL_ENDPOINT;
  const apiKey = env.WORLDSMITH_MODEL_KEY;
  if (endpoint === undefined || endpoint.length === 0) return null;
  if (apiKey === undefined || apiKey.length === 0) return null;

  // `positiveNumber` by tu nestačila: ta vadnou hodnotu tiše nahradí náhradou,
  // a náhrada za cenu je právě ta nula, která strop vypíná.
  const usdPerMTokOut = Number(env.WORLDSMITH_USD_PER_MTOK_OUT);
  if (!Number.isFinite(usdPerMTokOut) || usdPerMTokOut <= 0) return null;

  return {
    endpoint,
    apiKey,
    // Prázdný řetězec NENÍ chybějící hodnota, dokud to někdo nenapíše: `??` ho
    // propustí a k poskytovateli odejde `{"model": ""}`, na což odpoví 400 a
    // živá větev je mrtvá přesně v té konfiguraci, kterou `.env.example`
    // předepisuje (naměřeno toutéž revizí).
    model: (env.WORLDSMITH_MODEL ?? '').trim() === '' ? EMISSION_MODEL : env.WORLDSMITH_MODEL!.trim(),
    effort: effortLevel(env.WORLDSMITH_MODEL_EFFORT),
    pricing: {
      usdPerMTokIn: inputPrice(env.WORLDSMITH_USD_PER_MTOK_IN, usdPerMTokOut),
      // Ověřená výš, tady se jen dosazuje — jiná cesta sem hodnotu nepustí.
      usdPerMTokOut,
    },
    maxOutputTokens: positiveNumber(env.WORLDSMITH_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveNumber(env.WORLDSMITH_UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

/**
 * **Existuje cloudová cesta vůbec?** Jediná odpověď na tuhle otázku v celém repu.
 *
 * Musí platit obojí: někdo živou větev **objednal** (`WORLDSMITH_BRANCH=live`) a
 * zároveň je **čím jet** (koncový bod i klíč). Ani jedno samo nestačí, a každý
 * z těch dvou důvodů je jiný:
 *
 * - Objednávka bez klíče by nabídla cestu, která nemá čím jet — uživatel by
 *   dostal 503 místo světa.
 * - Klíč bez objednávky by znamenal, že proměnná zděděná z jiného projektu
 *   tiše přepne produkt na **placenou** cestu. To je ta dražší chyba z těch dvou.
 *
 * ## Tohle NENÍ výběr větve v `/api/generate`, a nesmí se tím stát
 *
 * Routa se ptá na **objednávku** (`WORLDSMITH_BRANCH === 'live'`), tahle funkce
 * na **dostupnost**. Vypadají podobně a liší se přesně v jednom případě, který
 * rozhoduje: objednaná živá větev **bez klíče**. Tady je to `false` (cloud se
 * nenabízí), v routě to pořád znamená živou větev, která odpoví 503
 * `BRANCH_UNCONFIGURED`.
 *
 * Naměřeno 21. 8. 2026: sjednotit obojí do téhle funkce shodí
 * `src/app/api/generate/__tests__/route.test.ts` („živá větev bez konfigurace je
 * 503"), a je to ten test, kdo má pravdu. Server, kterému chybí klíč, by jinak
 * tiše sjel na offline větev a **vydával mock za model** — operátor s překlepem
 * v klíči by se to nedozvěděl nikdy. Vadné nastavení selhává nahlas, stejně jako
 * u rozbitého vypínače stropu v `./spend-cap.ts`.
 */
export function cloudBranchAvailable(env: Record<string, string | undefined>): boolean {
  return env.WORLDSMITH_BRANCH === 'live' && upstreamConfigFromEnv(env) !== null;
}

/**
 * Živá větev. `config: null` znamená nenakonfigurovaný poskytovatel — větev
 * existuje, drží kontrakt a každé volání odmítne, aniž by kamkoli sáhla.
 */
export function upstreamBranch(
  config: UpstreamConfig | null,
  fetchImpl: typeof fetch = fetch,
): GenerationBranch {
  if (config === null)
    return {
      id: UPSTREAM_BRANCH_ID,
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      worstCaseUsd: () => 0,
      generate: () =>
        Promise.resolve({
          ok: false,
          reason: 'BRANCH_UNCONFIGURED',
          detail: 'no upstream endpoint or key is configured; nothing was called',
          usage: null,
        }),
    };

  return {
    id: UPSTREAM_BRANCH_ID,
    pricing: config.pricing,
    worstCaseUsd: (call) => worstCaseUsd(call, config),
    generate: (call) => generate(call, config, fetchImpl),
  };
}

function worstCaseUsd(call: GenerationCall, config: UpstreamConfig): number {
  const inputTokens = Math.ceil((call.request.system.length + call.request.user.length) / CHARS_PER_TOKEN);
  return (
    (inputTokens * config.pricing.usdPerMTokIn + config.maxOutputTokens * config.pricing.usdPerMTokOut) /
    1_000_000
  );
}

function usageOf(payload: unknown): Usage | null {
  const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  // **Záporná složka (a `NaN`) je nečitelná účtenka, ne sleva.** `costUsd()`
  // obě složky **sčítá**, takže dost záporný vstup zaplatí kladný výstup a
  // součet vyjde těsně nad nulou, kde ho `release()` přijme jako poctivou
  // cenu: `{-1249, 250}` nad textem o 3000 znacích se zaúčtovalo 0,000005 USD
  // proti rezervaci 0,219505 USD, tedy **44 000× méně**. `!(x >= 0)` chytá
  // i `NaN`.
  //
  // **Bydlí to tady, ne u čtenáře textu**, a to je oprava z 1. 9. 2026: první
  // znění sedělo v `readableUsage()`, kterou `generate()` volá jen na dvou
  // návratech nesoucích text. Třetí návrat („odpověď nenese textový blok")
  // předával účtenku syrovou, takže tatáž otrávená dvojice byla přes
  // `MALFORMED_RESPONSE` **levnější než neposlat nic** (0,000005 proti
  // rezervaci, kterou jinak `BILLED_ON_FAILURE` na téhle příčině účtuje).
  // Naměřeno nezávislou revizí nad commitem `df4a6b5`.
  //
  // **Nekonečno se tu naopak schválně NEODMÍTÁ.** Zkusilo se to 21. 8. 2026
  // a bylo to horší; dnes už `null` zadarmo neúčtuje (`pipeline.ts` na něj
  // strhne rezervaci), ale `Infinity` se stejně dostane na tutéž rezervaci
  // přes `costUsd()` → `release()`, takže by změna nekoupila nic a jen by
  // zahodila jediné číslo, které o té odpovědi ven jde.
  if (!(usage.input_tokens >= 0) || !(usage.output_tokens >= 0)) return null;

  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/**
 * Účtenka **úspěšné** odpovědi. Dvojitá nula je na ní nečitelná účtenka, ne
 * volání zadarmo.
 *
 * `null`, `NaN` i záporná čísla už rezervaci účtují; nula je oproti nim
 * *známá* hodnota, projde každou kontrolou a `costUsd()` z ní vyjde přesně 0.
 * `settle(0)` pak dolarovým stropem nehne vůbec a placené volání je zadarmo —
 * zbývá jen počítadlo volání, které se na serverless resetuje s chladným startem.
 *
 * Odpověď, na kterou se tohle použije, **nese text**: nula spálených výstupních
 * tokenů k němu neexistuje.
 *
 * ⚠ **A právě proto to nesmí platit na celou funkci** — nález nezávislé revize
 * 1. 9. 2026, který opravuje tentýž den starou vadu. `usageOf()` se čte
 * **před** kontrolou textového bloku, takže dokud tohle pravidlo bydlelo uvnitř
 * ní, chytalo i `MALFORMED_RESPONSE`. Naměřeno: odpověď 200 s prázdným
 * `content` a vynulovanou spotřebou účtovala **celou rezervaci** (0,2195 USD
 * proti 0,00003 USD u téže vady s účtenkou `{1,1}`), takže bránou, kterou
 * nikdo nehlídá, se dá strop 5 USD vyčerpat asi 23 odpověďmi bez jediného
 * dolaru skutečné spotřeby — a nasazené demo pak každému dalšímu porotci
 * odpoví 429. Odmítnutá odpověď se proto účtuje dál podle `BILLED_ON_FAILURE`.
 *
 * ## Rovnost na (0, 0) byla bod, ne mez — proto ta druhá půlka
 *
 * Dvojitá nula sama je jen jediný zakázaný bod v celém prostoru účtenek a
 * **poskytovatel nebo brána, která podhlásí o jeden token, ji obejde celou**:
 * `{0, 1}` se při ceníku 3/15 zaúčtuje 0,000025 USD, tedy 7300× levněji než
 * sousední `{0, 0}`, a dál se hne jen počítadlo volání — které se na serverless
 * resetuje s chladným startem. Naměřeno nezávislou revizí 1. 9. 2026.
 *
 * Hranice se proto **odvozuje z textu, který ta odpověď doopravdy nese**: kolik
 * výstupních tokenů si vůbec lze pro tolik znaků představit
 * (`FLOOR_CHARS_PER_TOKEN`). Jen výstup — vstup se legitimně cachuje, takže
 * `{0, 900}` je poctivá účtenka a musí se jí dál účtovat; hranice patří **pod**
 * ni. Konstanta v dolarech by tu byla špatná odpověď: ceník je konfigurace a
 * cenu z tokenů dělá až `costUsd()` nad `pricing` té větve.
 *
 * **Zvedá se, nikdy nesanuje — a to se soudí podle účtu, ne podle pole.**
 * Záporná, `NaN` i nekonečná účtenka projde beze změny: ty už si `release()`
 * v `./spend-cap.ts` účtuje celou rezervací, což je dražší než hranice.
 * Podmínka proto sahá i na **vstup**, přestože hranici dostává jen výstup —
 * naměřeno toutéž revizí, že bez toho `{-1, 0}` spadne z 0,2195 na 0,0062 USD
 * (35×) a `{-1000, 3}` na 0,0013 USD (176×): záporná složka totiž stlačovala
 * součet pod nulu, kde ho `release()` odmítal, a zvednutý výstup ho vrátil nad
 * nulu, kde ho přijme. Zlevnění otrávené účtenky je regrese směrem k penězům,
 * i když se pole, které se mění, jen zvedá.
 * Vedlejším účinkem hranice padá i `{n, 0}`, které dřív účtovalo jen vstup.
 *
 * ## Záporná složka je nečitelná účtenka, ne rozdíl
 *
 * Rovnost na (0, 0) a hranice zdola sahají obě jen na **jedno** ze dvou polí,
 * která `costUsd()` sčítá. Účtenku, jejíž jedna složka je záporná, tím ani
 * jedna z nich nezavírá: `{-1249, 250}` nad textem o 3000 znacích má výstup
 * přesně na hranici (250), takže hranice nespustí, a záporný vstup pak celý
 * součet stlačí na 0,000005 USD — **44 000× pod rezervaci 0,2195 USD**, a
 * `release()` to jako kladné konečné číslo přijme. Naměřeno nezávislou revizí
 * 1. 9. 2026; vada je starší než hranice, ta ji jen nezavřela.
 *
 * Kterákoli záporná složka proto padá na `null`, tedy na rezervaci — ale
 * **rozhoduje se to o patro výš, v `usageOf()`**, a to je oprava téhož dne.
 * Když pravidlo bydlelo tady, chránilo jen dva ze tří návratů `generate()`:
 * třetí („odpověď nenese textový blok") sem nikdy nedojde a předával účtenku
 * syrovou. U `release()` naopak bydlet nemůže — ten soudí jednu částku a ta je
 * v tomhle případě legitimně kladná; rozpad na složky vidí jen tenhle soubor.
 * Tahle funkce proto od té chvíle dostává zaručeně nezáporné složky.
 *
 * ## Co tím zavřít NEJDE
 *
 * **Délku textu volí poskytovatel**, takže dvouznakový textový blok srazí
 * hranici na jediný token a účtenka `{0, 1}` je pak od hranice k nerozeznání.
 * Proti nepoctivému poskytovateli dolarový strop neplatí nikdy — platí jen
 * počítadlo volání, a to se na serverless resetuje s chladným startem
 * (`T9-capcoldstart`). Hranice je obrana proti podhlášení, ne proti lhaní; tak
 * se o ní musí i mluvit.
 *
 * **Používá se na obou návratech, kde text existuje**, ne jen na tom úspěšném —
 * druhý nález téže revize. Kritérium je „odpověď nese text", takže i vadný JSON
 * uvnitř textového bloku sem patří; jinak by zbyla zrcadlová díra téhož tvaru,
 * kterou tahle funkce vznikla zavřít (naměřeno: strop 5 USD se nehne, běh
 * omezuje jen počítadlo volání, tedy až ~44 USD skutečné nejhorší útraty).
 */
function readableUsage(usage: Usage | null, text: string, maxOutputTokens: number): Usage | null {
  if (usage === null) return null;
  // Pořadí je podstatné: dvojitá nula je nečitelná účtenka a musí spadnout na
  // rezervaci, ne na hranici, která je o dva řády levnější.
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return null;
  // Delší text, než na kolik se rezervovalo, znamená poskytovatele, který
  // ignoroval `max_tokens`. Hranice z něj nesmí vyrůst nad výstupní půlku
  // rezervace — jinak se strhne víc, než se na to volání drželo.
  const floorTokens = Math.min(Math.ceil(text.length / FLOOR_CHARS_PER_TOKEN), maxOutputTokens);
  // `< floorTokens` vyřadí nekonečno; záporná čísla a `NaN` zastavil `usageOf()`.
  // Nesmyslná účtenka tak projde dál nedotčená a zaplatí rezervaci, dražší.
  if (usage.outputTokens < floorTokens) return { inputTokens: usage.inputTokens, outputTokens: floorTokens };
  return usage;
}

async function generate(
  call: GenerationCall,
  config: UpstreamConfig,
  fetchImpl: typeof fetch,
): Promise<GenerationOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxOutputTokens,
        // `effort` bydlí uvnitř `output_config`, ne nahoře — nahoře ho API
        // neuvidí a mlčky pojede na výchozím `high`.
        output_config: { effort: config.effort },
        system: call.request.system,
        messages: [{ role: 'user', content: call.request.user }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (thrown) {
    return {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: `the upstream call did not complete: ${(thrown as Error).message}`,
      usage: null,
    };
  }

  if (!response.ok)
    return {
      ok: false,
      // 4xx je odmítnutý požadavek — odpověď se negenerovala. 5xx je výpadek,
      // u kterého nevíme, jestli se něco spálilo, a účtuje se odhadem.
      reason: response.status < 500 ? 'UPSTREAM_REJECTED' : 'UPSTREAM_UNAVAILABLE',
      detail: `upstream answered ${response.status}`,
      usage: null,
    };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the upstream answer is not JSON: ${(thrown as Error).message}`,
      usage: null,
    };
  }

  // Od téhle chvíle spotřebu známe, i když je odpověď nepoužitelná — tokeny
  // se spálily a účtují se skutečností, ne odhadem.
  const usage = usageOf(payload);
  const text = (payload as { content?: { type?: unknown; text?: unknown }[] } | null)?.content?.find(
    (block) => block.type === 'text',
  )?.text;
  if (typeof text !== 'string')
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: 'the upstream answer carries no text block',
      usage,
    };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (thrown) {
    return {
      ok: false,
      reason: 'MALFORMED_RESPONSE',
      detail: `the upstream text block is not JSON: ${(thrown as Error).message}`,
      // **Rozhoduje text, ne úspěch.** Sem se dojde jen s textovým blokem
      // v ruce, takže nula spálených výstupních tokenů je i tady nečitelná
      // účtenka. Návrat výš (`carries no text block`) tuhle podmínku nesplňuje
      // a účtenku si nechává, jak dorazila.
      usage: readableUsage(usage, text, config.maxOutputTokens),
    };
  }

  return {
    ok: true,
    body,
    // NEsrážet na `{0, 0}`: `null` znamená „účtenku neumíme přečíst" a strop na
    // to musí účtovat rezervaci. Nula znamenala volání zdarma — a vynulovaná
    // účtenka pod textovým blokem je totéž, viz `readableUsage()`.
    usage: readableUsage(usage, text, config.maxOutputTokens),
    provenance: {
      branch: UPSTREAM_BRANCH_ID,
      source: 'upstream-http',
      synthetic: false,
      model: config.model,
    },
  };
}
