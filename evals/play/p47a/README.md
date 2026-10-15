# P47A – finále, boss a chování nepřátel

Plán `plans/P47A-finale-a-nepratele-2026-10-15.md` (necommitovaný). Větev `features/P47A-finale-a-nepratele-2026-10-15` z `abe38f04` (tip integrační větve P46).

## Sady

- **`dev.json`** – 30 nových vět pro šest žánrů plánu (aréna se sbíráním 10, útěk/přežití 4, quest v prostoru 5, stanoviště 4, duel 4, hod 3). `cell` = žánr, který rychlý návrh postavil na semínku 1 (`genreOf` v `p45/fun.ts`); test to drží. Na dev sadě a panelu P45 se ladí a diagnostikuje.
- **`holdout.json`** – 60 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen pravidla seznamu z `evals/play/fidelity/corpus.json` (2–4 podstatná jména, právě 1 sloveso se seznamem ovládání), tvar záznamu a rozložení skupin P45 (threat 24, everyday 15, fantasy 12, non-game 9). **SHA-256 nad LF bajty: `7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79`** (hlídá `__tests__/sets.test.ts`). Kromě testu otisku ho do konečného měření (T12) nic nečte.
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.
- Zapečetěná sada P45 je otevřená (`p45/sealed-opened.json`) a tady se na ní neladí ani nediagnostikuje.

## Měřidlo

`finale.ts` – pro každou větu žánr a generátor rychlého návrhu, zda svět nese pravidlo `pacing`, a když ne, proč:

| Důvod | Co průběh vypnulo |
|---|---|
| `entry` | generátor bez záznamu v `GENRE_PACING`, spec bez žánru nebo uložená verze `genre.v1` |
| `assembly` | díly P42 (`assemblyParts`) |
| `rules` | pravidla specu – u rychlého návrhu šablona P45B T9 (`ownShape`) |
| `things` | věci specu |
| `lives` | málo životů (`livesAtMost`) |
| `budget` | záznam průběh postavil, ale strop pravidel jádra mu nenechal chování ani finále |

Z běhu robota `intermediate` na semínku publikace pak finále podle telemetrie P45A (`boss` / `climax` / žádné), počet chování, nejdelší mezeru a stoupání. Souhrn po žánrech, které hra opravdu postavila: podíl průběhu ze všech postavených her, čísla zábavy jen z hratelných (jako `p45/fun.ts`).

`P47A_OUT=baseline|after npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts` (~1 min) zapíše `<out>.json` (dev, panel P45 a obojí).

## Výchozí stav (`baseline.json`, `abe38f04`)

| Žánr | Sada | Vět | Průběh | Důvod bez průběhu | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupá |
|---|---|---|---|---|---|---|---|---|
| aréna se sbíráním | dev | 10 | 0 | pravidla 7, díly 3 | 0 | 1 | 4,8 s | 0,4 |
| útěk / přežití | dev | 4 | 0 | pravidla 4 | 0 | 2 | 15,1 s | 0 |
| quest v prostoru | dev | 5 | 0 | pravidla 5 | 0 | 2 | 11,1 s | 0 |
| stanoviště | dev | 4 | 1 | – | 0 | 0 | 1,7 s | 0,5 |
| duel | dev | 4 | 1 | – | 0 | 1 | 2,2 s | 1 |
| hod | dev | 3 | 1 | – | 0 | 0 | 2,4 s | 0 |
| **dev celkem** | dev | 30 | 0,37 | pravidla 16, díly 3 | **0** | 1 | 4,7 s | 0,33 |
| **panel P45 celkem** | panel | 40 | 0,6 | pravidla 8, vstup 6, díly 2 | **0,38** | 1 | 4,0 s | 0,63 |

- Diagnóza plánu platí: každá hra arény se sbíráním, útěku i questu v prostoru bez dílů P42 má pravidla šablony P45B a průběh nemá (`rules` 16/16 na dev, 8/8 na panelu). Stanoviště, duel a hod průběh mají, ale telemetrie u nich finále neuzná (0/11 na dev).
- Panel P45 dává táž čísla jako konečné měření P46 na panelu (finále 0,38, mrtvý čas 4,0 s, stoupání 0,63, chování 1).
- **Díly P42:** 3/30 vět dev (aréna se sbíráním) a 2/40 panelu – dohromady 5/70 = 7 % < 10 %, takže T3 je nezkouší (Co nevíme, plán).

## Rozhodnutí

- **T2 – průběh pod šablonou: A pro sběr a útěk, B pro quest v prostoru.** Měřeno na 16 větách dev sady bez dílů P42 × 8 semínek (`genre.v4`, robot intermediate / začátečník). Sběr s šablonou pod průběhem (A) 8/8 / 7–8/8, útěk 7–8/8 / 5–8/8 – bez ztráty proti v3 bez průběhu (sběr 8/8 / 8/8, útěk 7–8/8 / 5–8/8). Quest pod průběhem s šablonou jen 6–7/8 (brána ≥ 0,8 neprošla, v3 bez průběhu 6/8), bez šablony (B) 8/8 / 3–5/8 – v pásmu. Útěk bez šablony by začátečníka shodil na 2/8 (e01, e02), proto A tam zůstává. Začátečník ve sběru 7–8/8 je nad pásmem 0,7 už na `abe38f04` (8/8), P47A ho nezhoršila. Uložené `genre.v3` hry se šablonou staví týž svět (`pacing-template.test.ts`, specy zmrazené nad `abe38f04`).
- **T3 – výhra sběru a útěku s věcmi čeká na bosse.** Šablona `treasure_rush` pod průběhem sype věci navíc a robot došel k cíli bez věcí bosse. Ve `genre.v4` proto `grow_to` dostane `boss` (vzor `fight_end.boss`) a robot průběhu od dosaženého skóre věci nevidí a jde na bosse (`pacing_bot.points`); bez toho robot bez profilu ve větě „Collect five glowing mushrooms…“ kroužil kolem věci až do konce hodin (semínka 4 a 33 ze 40). Rozsah navíc: `pieces/arena.ts` a `pieces/pacing.ts`. Semínka 1–8: boss padl v 8/8 výher u všech devíti vět sběru a útěku s věcmi bez dílů P42 (dřív c02/c04/c05/c07 7/8, c08 3/8, e02 5/8), buňky `arena.collect` a `arena.escape+collect` 20/20 na 20 semínkách; intermediate 8/8 všude, začátečník proti T2 beze změny (buňky 5/8, na 20 semínkách 13/20 a 12/20).
- **T3 – cíl sběru měřený bez dílů P42:** finále 7/7 = 1,0 (≥ 0,85); celkem 0,7, protože 3/10 vět s díly P42 průběh podle T1 nedostanou a podíl shora omezují.
- **T3 – skóre místo věcí** (`FIELD.bossScore` 1 bod) pro poslední vlnu bez věcí nebo bez předlohy věci: na dev sadě nenastane (generátor dává každé vlně stejně věcí), hlídá ho test na sestrojených částech.
- **T3 – rozpočet pravidel na dev nikdy neváže, room ≈ 8** (`rulesBesides`); aby ustoupila šablona, musel by se měnit `arcade/compile.ts`, proto jen test, že boss zůstane i pod největší overlay šablonou `waves_survive` (4 pravidla).
- **T3 – sběr s jedním životem zůstává bez průběhu:** s průběhem (8 semínek; hra žánru s mincemi a věty c02, c03, c06, c08 s jedním životem) intermediate 4–7/8 a začátečník 0–4/8, bez průběhu 8/8 a 8/8.
- **T3 – finále přežití nedodáno, cíl útěku/přežití 0,75 nesplněn (0,5: e01/e02 boss, e03/e04 nic).** Nápor ostřelovačů v posledních 10 s (ve v4 obě chování poolu) dal climax v každé výhře, ale na 20 semínkách buňky `arena.escape` (jeden život) neudrží pásma: 2 ostřelovači vedle pronásledovatelů intermediate 14/20 (bez náporu 18/20); pronásledovatelé s náporem odejdou – intermediate 17/20, ale začátečník 17/20 (nad 0,7, bez náporu 10/20); 3 ostřelovači s odchodem intermediate 5/20; 1 ostřelovač dal climax jen ve 3/7 výhrách e03. Na semínkách 1–8 dva ostřelovači prošli (7/8, začátečník 4/8) – na útes jednoho života je 8 semínek málo. Další kolo: nápor, který život nebere (jen vznik těl, např. přepadníci), nebo nápor jen pro přežití se ≥ 2 životy (e03 20/20, e04 17/20 s odchodem pronásledovatelů).
- **T3 – robot nečeká na strážce přišpendleného ke stěně.** Strážce věci u stěny, kterého oběh tlačí ven, stojí; robot čekal, až přejde na druhou stranu věci, do konce hodin (`genre/__tests__/waves.test.ts`, „Collect five glowing mushrooms…“, semínko 19 ze 40 – červené od T2, která dala šabloně `treasure_rush` průběh a se strážcem). Oprava je jen v robotovi (`guardian.botStep`), ne v chování: uložené hry hrají stejně. Pásma se strážcem na 20 semínkách (intermediate / začátečník) beze změny: `quest.spatial` 19 / 10 s opravou i bez ní, `arena.collect` 20 / 13 a `arena.escape+collect` 20 / 12 jako po T3.

## Známé červené pro T11

- `src/play/compose/__tests__/difficulty.test.ts` – otisk specu `run.escape` (a dalších buněk žánru) neodpovídá `evals/play/p41/difficulty.json` od T2: `GENRE_COMPILER_VERSION` `genre.v4` mění otisk každého specu žánru; řádky přeměřit v T11.

## Průběh plánu (`after.json` = poslední měření)

| Po úloze | Dev: průběh | Dev: finále | Dev: chování (medián) | Dev: mrtvý čas | Panel: finále |
|---|---|---|---|---|---|
| výchozí | 0,37 | 0 | 1 | 4,7 s | 0,38 |
| T2 | 0,9 (bez dílů P42 1,0) | 0,27 | 2 | 4,9 s | 0,43 |
| T3 | 0,9 (bez dílů P42 1,0) | 0,3 (sběr bez dílů P42 1,0, útěk/přežití 0,5) | 2 | 4,9 s | 0,43 |
