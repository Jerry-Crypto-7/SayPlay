# P33 fáze 1 – snímky proti auditu

**Hloubka:** technical + content. **Snímky:** `phase1/` (9 stavů × telefon 390×844 a desktop 1440×900, `P33_SHOTS_LABEL=phase1`), výchozí stav v `before/`.
**Větev:** `features/p33-ui` po T9 (`2220c6da`). Soubory `ArcadePlay.tsx` a `src/app/play/page.tsx` patří do předání (HALT) stopě D, fáze 1 na ně nesahala.

## Stav bodů auditu

| # | Bod auditu | Stav | Kdo / kdy | Snímek |
|---|---|---|---|---|
| 1 | První věc na `/play` je „You lost“ | **Částečně.** `/play` už nikdy neukáže prohru bez vstupu: hra z feedu čeká na plakát `Tap to play`, úvodní ukázka hraje sama a neprohraje. Vlastní hra z věty ale dál prohraje bez dotyku (liška po 3,5 s). | T8 hotovo; zbytek **T11** (každá hra čeká na první dotek) | `phase1/home-5s-phone.png`, `phase1/game-5s-phone.png` |
| 2 | Kartu prohry překrývá panel HUD | **Vyřešeno.** Karta stojí dole uprostřed (desktop 420 px nad lištou cílů), na telefonu je spodní list; HUD vlevo nahoře se jí nedotkne. | T4 | `phase1/result-desktop.png`, `phase1/result-phone.png` |
| 3 | Karta po hře má 10 prvků | **Vyřešeno.** Jedno hlavní tlačítko `Play again`, pod ním `Change it` (list s polem a čipy) a `Challenge a friend`; `Save clip` je odkaz, jen když klip existuje. Test počítá hlavní akce. | T4 | `phase1/result-phone.png`, `phase1/remix-open-phone.png` |
| 4 | Pole pro větu je pod ohybem | **Desktop vyřešen, telefon částečně.** Desktop otevře na titulu a poli (y ≈ 155 místo ≈ 740), feed je pod ním. Telefon má hru první a plovoucí `+ New game`, které posune k poli. | T9; rozvržení stránky **T13** | `phase1/home-0s-desktop.png`, `phase1/home-0s-phone.png` |
| 5 | Hra na desktopu malá, na telefonu tři pruhy nahoře | **Částečně.** Dva proužky („Designed by AI…“, „How this game works“) jsou jeden řádek `About this game` s listem. HUD arkády dál bere 8–211 px (runner a arena mají 516 z 844 px). Hra na `/play/<id>` má na desktopu celé okno; na `/play` stojí v rámu feedu (výška 52 % okna) pod polem. | T7 hotovo; zbytek **T12** (hra na celou plochu, tenký pruh, boční sloupec) a **T13** (feed) | `phase1/home-5s-phone.png` (HUD runneru), `phase1/result-desktop.png`, `phase1/home-0s-desktop.png` |
| 6 | Lišta „1 egg GO …“ nesrozumitelná, stránka se posouvá do strany | **Vyřešeno.** Jeden řádek s vlastním posunem, karta = ikona + jméno, žádné „GO“; nepřítel je červený čip `avoid` bez čísla a bez klepnutí; číslo klávesy jen s myší. Stránka na telefonu do strany neujede (stráž v `p33-shots`). | T6 | `phase1/targets-phone.png`, `phase1/targets-desktop.png` |
| 7 | Technické nebo rozbité texty | **Částečně.** Pryč: „Instant draft from the keywords…“ (T7), stejná věta archetypu u všech karet feedu a „0 remixes“ (T8). Zůstává: „s dog“ z „farmer's dog“ (jádro), dlouhá pomlčka v podtitulku (stopa B), cíl na kartách feedu jen u aktuální a další hry (API). | T7, T8; zbytek jiné stopy – viz Findings v plánu | `phase1/result-desktop.png` („Avoid the s dog“), `phase1/home-0s-desktop.png` (podtitulek) |
| 8 | 15 velikostí písma, ruční průhlednosti, malá tlačítka, dvě h1, favicon 404 | **Částečně.** Pět velikostí písma, průhlednosti jako tokeny, tlačítka a čipy ≥ 44 px, sdílené prvky v `ui/` (test hlídá stupnici). Písmo zůstává systémové – Inter i Manrope mají licenci, kterou RULES.md §4 nepovoluje (rozhodnutí vlastníka). Dvě h1 a favicon: `page.tsx` a `ArcadePlay.tsx`. | T2, T3; zbytek **T13** | `phase1/home-0s-desktop.png` |
| 9 | Chybí stavy (načítání, po odeslání věty, vysvětlení ovládání) | **Částečně.** Po odeslání věty čtyři kroky stavby s aktivním zvýrazněným a chyba s `Try again`. Prázdný div načítání fyziky a ovládání, které na telefonu po 4 s zmizí, jsou v `ArcadePlay.tsx`. | T9; zbytek **T14** (načítání), **T12** (stálá řádka ovládání), **T11** (`Tap to start`) | `phase1/create-progress-phone.png`, `phase1/create-error-phone.png` |

## Regresní běh

- **Vitest** `src/components/play src/app/play`: 174/174 zelených.
- **E2e** seznamu T10 (server `next start` na 3360): 103 zelených ve společném běhu. `play-frame` jednou spadl na přerušené spojení se serverem (`ECONNRESET` při `POST`), samotný pak 28/28. `play-sentence-read` na serveru s `PLAY_READER=on`: 2/2.
- **`play-phone`, runner a arena:** 516 z 844 px na hru (limit 70 % = 591). Plochu bere HUD arkády (8–211 px, `ArcadePlay.tsx`) a pod ním řádek `About this game`. Oba případy mají `test.fail` s odkazem na T12 – až T12 HUD zmenší, test zčervená a značka musí pryč. Mřížka (grid) stejný test splní (593 z 844).
