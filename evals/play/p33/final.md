# P33 – závěrečné snímky proti auditu

**Hloubka:** technical + content. **Snímky:** `final/` (10 stavů × telefon 390×844 a desktop 1440×900, `P33_SHOTS_LABEL=final`; `runner.png`, `arena.png`, `grid.png` z `play-phone`), výchozí stav v `before/`, mezistav v `phase1/`.
**Větev:** `features/p33-ui` po T14 (`8aaa7772`).

## Stav bodů auditu

| # | Bod auditu | Stav | Kdo | Snímek |
|---|---|---|---|---|
| 1 | První věc na `/play` je „You lost“ | **Vyřešeno.** `/play` otevře na poli; hra z feedu čeká na plakát `Tap to play` a pak na `Tap to start`; vlastní hra z věty stojí na tiku 0, dokud se hráč nedotkne. Po 5 s žádné „You lost“ na telefonu ani desktopu. | T8, T11 | `final/home-5s-phone.png`, `final/game-5s-phone.png`, `final/game-5s-desktop.png` |
| 2 | Kartu prohry překrývá panel HUD | **Vyřešeno.** Karta dole uprostřed (telefon spodní list), HUD je tenký pruh nahoře, sloupec akcí vpravo mimo kartu. | T4, T12 | `final/result-desktop.png`, `final/result-phone.png` |
| 3 | Karta po hře má 10 prvků | **Vyřešeno.** Jedno hlavní `Play again`, pod ním `Change it` a `Challenge a friend`. | T4 | `final/result-phone.png`, `final/remix-open-phone.png` |
| 4 | Pole pro větu je pod ohybem | **Vyřešeno.** Telefon i desktop otevřou na jediné h1, poli a vzorech; feed je pod nimi a z něj vede k poli plovoucí `+ New game`. | T9, T13 | `final/home-0s-phone.png`, `final/home-0s-desktop.png` |
| 5 | Hra na desktopu malá, na telefonu tři pruhy nahoře | **Vyřešeno.** Hra na celou plochu: pruh nahoře 48 px přes scénu (telefon), 64 px nad scénou (desktop, scéna 1440×836, nejvýš 16:9). Akce ve sloupci vpravo, info v jednom listu `About`. Pruhy přes šířku berou ≤ 15 % výšky telefonu (`play-phone`). | T7, T12 | `final/runner.png`, `final/game-5s-desktop.png`, `T12/runner-desktop.png` |
| 6 | Lišta „1 egg GO …“ nesrozumitelná, stránka se posouvá do strany | **Vyřešeno.** Jeden řádek s vlastním posunem, ikona + jméno, nepřítel červený čip `avoid`; stránka na telefonu do strany neujede (stráž v `p33-shots`). | T6 | `final/targets-phone.png`, `final/targets-desktop.png` |
| 7 | Technické nebo rozbité texty | **Částečně – zbytek předán.** Pryč: „Instant draft…“, stejná věta archetypu na kartách, „0 remixes“, „Building the world…“. Zůstává mimo P33: **„s dog“** z „farmer's dog“ (jádro, `src/play/draft/draft.ts`), **dlouhá pomlčka v podtitulku** (stopa B, `SUBHEAD` v `starters.ts` + `PRODUCT_COPY.md`), **cíl a nálada jen u načtených karet feedu** (vlastník API `GET /api/play/games?recent`). | T7, T8, T14; zbytek jádro, B, API | `final/result-desktop.png` („Avoid the s dog“), `final/home-0s-phone.png` (podtitulek) |
| 8 | 15 velikostí písma, ruční průhlednosti, malá tlačítka, dvě h1, favicon 404 | **Vyřešeno.** Pět velikostí písma, průhlednosti jako tokeny, tlačítka ≥ 44 px, nadpisy Luckiest Guy (rozhodnutí vlastníka `c206e6b9`), jedna h1 na `/play` (název hry v HUD je tam h2), favicon `src/app/play/icon.svg`. | T2, T3, T13 | `final/home-0s-desktop.png` |
| 9 | Chybí stavy (načítání, po odeslání věty, vysvětlení ovládání) | **Vyřešeno.** Od `Play it` do první scény jedna obrazovka: název z věty, tón nálady, pruh, `Building your game…`, kroky stavby; scéna pod plátnem ukazuje oblohu sady místo tmy (300 ms po kliknutí ≤ 90 % tmavých pixelů – pin v `p33-shots`). `Tap to start` s povelem a stálá řádka ovládání dole; chyba s `Try again`. | T9, T11, T12, T14 | `final/build-300ms-phone.png`, `final/build-300ms-desktop.png`, `final/create-error-phone.png` |

## Předáno jiným stopám (z `## Findings routed by the run` v plánu)

- **Jádro:** „s dog“ – apostrof brát jako součást slova v `draft.ts`.
- **Stopa B:** dlouhá pomlčka v `SUBHEAD`; `CHANGE ONE THING` / `CHALLENGE A FRIEND` verzálkami v `starters.ts` (karta je zatím převádí).
- **Vlastník API feedu:** `goal` a `mood` v řádku `GET /api/play/games?recent=N`.
- **Vlastník `play-feed` (P27B/P28D):** halda-test „ten moves“ je nestabilní i na základu `f02904fd` (bez úniku – plató 20–25 MB); oprava v testu.

## Regresní běh

- **E2e** seznam T10 + `p32-first-seconds` (server `next start` na 3360): 118 zelených, 2 červené ve společném běhu – obě prostředí: `play-sentence-read` potřebuje server s `PLAY_READER=on`, halda-test `play-feed` je nestabilní i na základu. Na serveru s čtečkou oba soubory samy 10/10.
- **Vitest** celá sada přes zámek, bez souběžné zátěže: 8900 zelených, 10 červených v 8 souborech. Všech 8 je známé prostředí worktree, nic z PLAY UI: `a4-fixtures` ×3, `comparison-winning-gap`, `comparison-losing`, gauntlet `corpus`, `submission-check` a `repeated-hero` čtou gitignorované soubory (`plans/**`, `evals/worldstream/create-raw.json`), které worktree nemá; `catalog-coverage` a `divergence-lock` jsou červené už na `p32-base`. Celou sadu certifikovat v hlavním checkoutu před pushem. `src/components/play` + `src/app/play` samy 190/190.
- Přepsané naměřené artefakty (`evals/hostile-report.json`, `evals/play/compiled/report.json`, `evals/play/regression/report.{json,md}`, `evals/shape/diversity.json`) vráceny.
