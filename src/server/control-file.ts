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

export type ControlRead =
  /** Nikdo vypínačem nehnul. Platí výchozí hodnoty volajícího. */
  | { readonly kind: 'absent' }
  /** Někdo vypínačem hnul a rozbil ho. Volající selhává zavřeně. */
  | { readonly kind: 'broken'; readonly detail: string }
  | { readonly kind: 'read'; readonly value: Record<string, unknown> };

export function readControlFile(path: string | null): ControlRead {
  if (path === null) return { kind: 'absent' };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (thrown) {
    const error = thrown as NodeJS.ErrnoException;
    return error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'broken', detail: `control file could not be read: ${error.code ?? 'unknown error'}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'broken', detail: 'control file is not JSON' };
  }
  // Pole je taky `object` a `null` taky. Ani jedno není ovládací soubor.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { kind: 'broken', detail: 'control file is not a JSON object' };

  const known = new Set<string>(CONTROL_KEYS);
  const unknown = Object.keys(parsed).filter((key) => !known.has(key));
  if (unknown.length > 0)
    return {
      kind: 'broken',
      detail: `control file has unknown keys: ${unknown.join(', ')} (allowed: ${CONTROL_KEYS.join(', ')})`,
    };

  return { kind: 'read', value: parsed as Record<string, unknown> };
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
