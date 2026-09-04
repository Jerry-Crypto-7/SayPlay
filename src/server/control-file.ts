/**
 * **Jeden ovládací soubor pro celý běžící server** (P15 T30).
 *
 * Provoz se za běhu ovládá dvěma věcmi — stropem utrácení (`spend-cap.ts`) a
 * kill switchi (`kill-switch.ts`) — a obojí je **soubor na disku, ne proměnná
 * prostředí a ne administrátorská routa**. Důvod je u obou stejný a stojí za
 * zopakování, protože je to jediné místo, kde je napsaný jednou:
 *
 * - **proměnná prostředí** se na Vercelu mění jen redeployem, což je při
 *   incidentu ta nejpomalejší možná cesta;
 * - **routa bez přihlášení** je horší než žádný vypínač: kdokoli ji zavolá dřív
 *   než my. A přihlašování tenhle produkt nemá a mít nebude (`RULES.md` §3.3
 *   dává porotci přístup bez účtu);
 * - **soubor** čte modul při každém rozhodnutí, takže změna platí od dalšího
 *   požadavku, a přístup k němu má jen ten, kdo má přístup ke stroji.
 *
 * Do P15 T30 uměl tenhle trik jen strop a měl ho schovaný v sobě. Kill switche
 * z `plans/P7-brany-a-evaluace.md` T707 by byly druhý soubor téhož tvaru, tedy
 * **druhé místo, kam se za incidentu musí sáhnout**, a druhá sada pravidel
 * o tom, co znamená rozbitý soubor. Proto je čtení tady a soubor je jeden:
 * `WORLDSMITH_CONTROL_FILE`.
 *
 * ⚠ **Od P15 `T30-controllever` jsou ZDROJE dva, povel je pořád jeden.** Na
 * Vercelu je disk kromě `/tmp` jen pro čtení a `/tmp` je per-instance, takže
 * tam soubor napsat nejde a vypínač zůstával bez páky. Druhým zdrojem je klíč
 * ve sdíleném obchodě, který drží účetní knihu; nese přesně týž JSON a soubor
 * má před ním přednost. Celé pravidlo i jeho cena jsou u `readControlFrom()`
 * dole — všechno v tomhle odstavci a v tabulce níž platí pro obojí.
 *
 * ## Tři odpovědi, ne dvě
 *
 * | Stav souboru | Odpověď | Co si s tím počne volající |
 * |---|---|---|
 * | cesta není nastavená, nebo soubor neexistuje | `absent` | výchozí chování — **nikdo vypínačem nehnul** |
 * | nedá se přečíst, není to JSON, není to objekt | `broken` | selhat zavřeně — **někdo vypínačem hnul a rozbil ho** |
 * | přečetl se objekt | `read` | rozhodne obsah |
 *
 * Rozdíl mezi prvními dvěma je celý smysl téhle funkce. Kdyby chybějící soubor
 * a vadný soubor splynuly do jedné odpovědi, musel by volající vybrat jedno
 * chování pro obě: buď by rozbitý soubor znamenal „bez stropu" (tichý průchod,
 * který v logu vypadá jako splněná brána), nebo by čistá instalace bez
 * ovládacího souboru neobsloužila nikoho.
 *
 * **Čte se pokaždé znovu, schválně.** Cache by potřebovala invalidaci a smysl
 * celé věci je, že změna platí hned. Soubor má jednotky řádků, takže proti
 * volání modelu je ten `readFileSync` neměřitelný — a proti požadavku, který
 * se má odmítnout, je to jediná práce, kterou ten požadavek způsobí.
 */

import { readFileSync } from 'node:fs';

import { type ControlStore, controlStoreFromEnv } from './spend-store';

/**
 * Jediné klíče, které ovládací soubor smí nést — obě jeho půlky dohromady.
 *
 * **Neznámý klíč je rozbitý soubor, ne cizí klíč k přehlédnutí.** Nález
 * nezávislé revize 3. 9. 2026, `VERDICT: blocking`: od chvíle, kdy chybějící
 * klíč stropu znamená „platí výchozí hodnota", je **překlep k nerozeznání od
 * mlčení**. `{"enabled":true,"capusd":0.01}` — operátor, který za incidentu
 * sráží strop a splete jedno písmeno — tedy neskončí odmítnutím, ale výchozím
 * stropem 5 USD, což je 500násobek toho, co napsal. Táž doktrína jako u
 * neznámého jména v `off` (`kill-switch.ts`), jen o patro výš: **překlep vznikl
 * při pokusu něco utáhnout, takže se nesmí přeložit na povolení.**
 *
 * Je to seznam za celý soubor, ne za jednu půlku, protože soubor je jeden.
 * Kdyby si každá půlka soudila svoje klíče sama, musela by tolerovat klíče té
 * druhé — a `{"offf":["all"]}` by prošlo jako „nic není vypnuté" přesně tak,
 * jak to revize naměřila.
 *
 * Naměřeno tímtéž během: **26 ovládacích souborů napsaných v repu, 0 z nich
 * nese jiný klíč**, takže tenhle seznam nezakazuje nic, co existuje.
 *
 * ## `note` — jediný volný klíč, a nikdo ho nečte (P15 T30-whitelistedge)
 *
 * JSON komentáře nemá, takže `{"off":["upstream"],"note":"účet utíká"}` je to
 * nejpřirozenější, co operátor za incidentu napíše — a uzavřený seznam na to
 * odpovídal `broken`, tedy troje placené dveře dolů a každé `reserve()`
 * odmítnuté. Selhává to zavřeně, takže peníze neutečou; padá dostupnost
 * přesně ve chvíli, kdy na ní záleží (naměřeno nezávislou revizí 3. 9. 2026,
 * CONFIRMED spuštěním). `note` proto na seznamu je, **smí nést cokoli a žádný
 * čtenář ho neinterpretuje** — strop bere `enabled`/`capUsd`/`callCap`,
 * vypínače `off`, a `note` nevidí ani jeden. Překlep v `note` je pořád překlep
 * v klíči (`notes`, `Note`) a soubor rozbije; to je cena za to, že seznam
 * zůstává uzavřený.
 *
 * ## Opakovaný klíč se neřeší — zapsané rozhodnutí, ne přehlédnutí
 *
 * `{"capUsd":0.01,"capUsd":1000}` projde `JSON.parse` jako `{capUsd:1000}`;
 * `Object.keys` vidí až výsledek, takže poslední výskyt vyhraje a seznam to
 * nepozná. Je to jediná podoba překlepu, kterou schová sám formát. Zavřít by
 * to šlo počítáním klíčů nad syrovým textem nebo `reviver`em, který redefinici
 * odmítne — obojí je vlastní parser JSONu kvůli souboru o pěti klíčích.
 * Naměřeno 4. 9. 2026: **žádný ovládací soubor v repu ani na nasazení
 * neexistuje** (na Vercelu ani disk, `T30-controllever`), takže by ten parser
 * dnes hlídal nulu souborů. Rozhodnutí: **mimo rozsah, poslední klíč vyhrává**;
 * kdo soubor píše, píše každý klíč jednou. Otevře se to znovu, až bude soubor
 * na nasazení existovat a ukáže se, že se do něj dopisuje pod starší řádky.
 */
export const CONTROL_KEYS = ['enabled', 'capUsd', 'callCap', 'off', 'note'] as const;

/**
 * Odkud ten obsah přišel. Jde to jen do diagnostiky operátora — ven nikdy.
 *
 * Rozlišuje se proto, že od `T30-controllever` jsou zdroje dva a **odmítnutí
 * musí říct, který z nich je rozbitý**. Věta „ovládací soubor je nečitelný"
 * posílala operátora na disk, na kterém na Vercelu žádný soubor není, zatímco
 * povel doopravdy leží ve sdíleném klíči.
 */
export type ControlSource = 'file' | 'store';

export type ControlRead =
  /** Nikdo vypínačem nehnul. Platí výchozí hodnoty volajícího. */
  | { readonly kind: 'absent' }
  /** Někdo vypínačem hnul a rozbil ho. Volající selhává zavřeně. */
  | { readonly kind: 'broken'; readonly source: ControlSource; readonly detail: string }
  | {
      readonly kind: 'read';
      readonly source: ControlSource;
      readonly value: Record<string, unknown>;
    };

/**
 * Obsah ovládacího povelu, ať přišel odkudkoli.
 *
 * **Jedno místo, kde se soudí tvar** — soubor i sdílený klíč nesou přesně týž
 * JSON a musí z nich plynout přesně totéž. Dvě kopie téhle validace by se
 * rozešly a operátor by dostal jiný verdikt podle toho, kam povel napsal.
 */
function parseControlBody(raw: string, source: ControlSource): ControlRead {
  const where = source === 'file' ? 'control file' : 'shared control key';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'broken', source, detail: `${where} is not JSON` };
  }
  // Pole je taky `object` a `null` taky. Ani jedno není ovládací soubor.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { kind: 'broken', source, detail: `${where} is not a JSON object` };

  const known = new Set<string>(CONTROL_KEYS);
  const unknown = Object.keys(parsed).filter((key) => !known.has(key));
  if (unknown.length > 0)
    return {
      kind: 'broken',
      source,
      detail: `${where} has unknown keys: ${unknown.join(', ')} (allowed: ${CONTROL_KEYS.join(', ')})`,
    };

  return { kind: 'read', source, value: parsed as Record<string, unknown> };
}

export function readControlFile(path: string | null): ControlRead {
  if (path === null) return { kind: 'absent' };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (thrown) {
    const error = thrown as NodeJS.ErrnoException;
    return error.code === 'ENOENT'
      ? { kind: 'absent' }
      : {
          kind: 'broken',
          source: 'file',
          detail: `control file could not be read: ${error.code ?? 'unknown error'}`,
        };
  }

  return parseControlBody(raw, 'file');
}

/**
 * Kde ovládací soubor leží. `null` znamená „nikde", tedy výchozí chování.
 *
 * Jedno jméno pro celý server. Do P15 T30 se tatáž cesta jmenovala
 * `WORLDSMITH_SPEND_CAP_FILE`, protože strop byl jediný, kdo ji četl; jméno se
 * přejmenovalo ve chvíli, kdy do souboru přibyly kill switche, aby soubor
 * neměl jméno po jedné ze svých dvou polovin.
 *
 * ⚠ **Staré jméno se proto čte dál, a není to pohodlí — je to peníze.**
 * Nález nezávislé revize 3. 9. 2026, `VERDICT: blocking`: přejmenování bez
 * záchytu znamená, že nasazení, které v proměnných pořád nese staré jméno,
 * přestane ovládací soubor vidět **v okamžiku deploye**. `controlFilePath()`
 * vrátí `null`, soubor je „nepřítomný", strop se tiše vrátí na výchozí hodnoty
 * a všechny čtyři vypínače hlásí „nic není vypnuté" — tedy operátorovo
 * `{"enabled":false}` i každý kill switch se stanou mrtvým dopisem, a nevznikne
 * u toho jediný řádek. Nové jméno má přednost; staré je záchranná síť, ne
 * druhá cesta.
 */
export function controlFilePath(env: Record<string, string | undefined>): string | null {
  // **Prázdná hodnota není „nastaveno".** `??` by na `WORLDSMITH_CONTROL_FILE=`
  // (přesně ten řádek, který ship `.env.example`, a přesně to, co zbyde po
  // vymazání políčka v dashboardu během přejmenování) odpověděl prázdným
  // řetězcem, tím zastínil staré jméno a vyrobil zpátky tutéž tichou ztrátu
  // stropu i vypínačů, kterou má záchyt zavírat. Nález druhé nezávislé revize
  // 3. 9. 2026. Bere se proto první **neprázdné** jméno.
  return (
    [env.WORLDSMITH_CONTROL_FILE, env.WORLDSMITH_SPEND_CAP_FILE]
      .map((value) => value?.trim())
      .find((value) => value !== undefined && value !== '') ?? null
  );
}

/**
 * **Povel odkudkoli: nejdřív soubor, pak sdílený klíč** (P15 `T30-controllever`).
 *
 * Do `T30-controllever` byl zdroj jeden a byl to soubor na disku. Na Vercelu je
 * ale souborový systém **jen pro čtení** kromě `/tmp`, a `/tmp` je per-instance,
 * takže operátor za incidentu neměl kam napsat `{"off":["all"]}` tak, aby to
 * viděla celá flotila: vypínač existoval v kódu a chyběla mu páka. Druhým
 * zdrojem je proto tentýž sdílený obchod, který od `T29` drží účetní knihu
 * (`spend-store.ts` → `controlStoreFromEnv()`).
 *
 * ## Soubor má přednost, a je to pravidlo o jednom směru
 *
 * | Soubor | Sdílený klíč | Platí |
 * |---|---|---|
 * | je | cokoli | **soubor** |
 * | rozbitý | cokoli | **soubor**, tedy zavřené selhání |
 * | není | je | klíč |
 * | není | není, nebo se nesdílí | nikdo vypínačem nehnul |
 *
 * **Soubor vyhrává i když je rozbitý**, schválně: kdyby se na rozbitém souboru
 * padalo dál na klíč, byl by překlep v souboru cestou, jak se dostat k jinému
 * povelu, než operátor napsal. Rozbitý povel je povel, který se nepovedl, a ten
 * se nepřebíjí druhým zdrojem.
 *
 * Lokální provoz a `next start` proto zůstávají přesně, jak byly: kdo soubor
 * má, čte soubor; kdo sdílený obchod nemá, druhý zdroj vůbec nevznikne a
 * neproběhne jediný síťový let.
 *
 * ## Cena je nejvýš jeden síťový let za sekundu, ne jeden na požadavek
 *
 * Vypínač se čte **při každém rozhodnutí**, ale na sdílený obchod se přitom
 * nesahá pokaždé: `controlStoreFromEnv()` obaluje čtení oknem
 * `CONTROL_CACHE_TTL_MS` (1 s, `spend-store.ts`), takže instance vydá nejvýš
 * jeden `GET` za sekundu (limit letu `DEFAULT_CONTROL_TIMEOUT_MS`, 200 ms)
 * a souběžní čtenáři sdílejí jeden let.
 *
 * ⚠ **To okno je oprava blokujícího nálezu, ne úspora.** Bez něj byl každý
 * anonymní požadavek jeden příkaz do obchodu a tři čtecí dveře nemají strop
 * frekvence vůbec — smyčka přes `GET /api/worldstream/snapshots/<náhodný hash>`
 * tedy uměla vypálit kvótu obchodu, tedy **tu jedinou páku, kterou se za
 * incidentu vypíná utrácení**. Celý rozpad je u `CONTROL_CACHE_TTL_MS`.
 *
 * Rozhodnutí ze 4. 9. 2026 znělo „čerstvost, ne cache" a tohle je jeho
 * ohraničená podoba: zamítnutá varianta byla cache **obnovovaná jinde**,
 * s neomezeným stářím. Tady je stáří shora sekunda a soubor na disku se
 * necachuje vůbec, takže lokální provoz a `next start` jsou plně čerstvé.
 *
 * **Výpadek obchodu se čte jako rozbitý povel**, ne jako mlčení. Placené dveře
 * tím stojí (kniha by je o operaci později odmítla stejně, `LEDGER_UNAVAILABLE`)
 * a čtení hotových světů běží dál — přesně to, co §22.4 chrání jmenovitě.
 */
export async function readControlFrom(
  path: string | null,
  store: ControlStore | null,
): Promise<ControlRead> {
  const fromFile = readControlFile(path);
  if (fromFile.kind !== 'absent') return fromFile;
  if (store === null) return { kind: 'absent' };

  let raw: string | null;
  try {
    raw = await store.read();
  } catch (thrown) {
    return {
      kind: 'broken',
      source: 'store',
      // Jméno klíče ano, adresa a token ne: tenhle text čte operátor v logu a
      // potřebuje vědět, do kterého klíče se dívat. Ven ho pouští jedině
      // `PUBLIC_REFUSAL` v `/api/generate`, který ho zahazuje celý.
      detail: `shared control key ${store.key} could not be read: ${(thrown as Error).message}`,
    };
  }

  // Klíč, který nikdo nezaložil, je normální stav nasazení, na které se
  // nesáhlo — totéž co chybějící soubor.
  return raw === null ? { kind: 'absent' } : parseControlBody(raw, 'store');
}

/**
 * Oba zdroje poskládané z prostředí. Jediné, co volá běžící server.
 *
 * `fetchImpl` je parametr ze stejného důvodu jako `env`: bez něj by se čtení
 * sdíleného klíče nedalo otestovat, aniž by si test sahal na síť.
 */
export function readControl(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<ControlRead> {
  return readControlFrom(controlFilePath(env), controlStoreFromEnv(env, fetchImpl));
}
