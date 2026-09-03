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
