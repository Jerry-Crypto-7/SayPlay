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
- **T3 – finále přežití je déšť mincí, ne nápor nepřátel.** Ve `genre.v4` přinese poslední vlna přežití 9 s před koncem hodin 8 mincí na místech vstupu (`FIELD.shower`); život nevezmou a telemetrie je počítá (vznik a sebrání), takže posledních 10 s nese 10–13 událostí proti 0–3 a climax platí v každé výhře. Na 20 semínkách (intermediate / začátečník / climax ve výhrách, v závorce bez deště): buňka `arena.escape` 18 / 11 / 18 (18 / 10 / 0), e03 20 / 20 / 20 (20 / 20 / 0), e04 20 / 20 / 20 (19 / 19 / 0). Gauge: útěk/přežití 0,5 → 1,0. Nápor ostřelovačů v posledních 10 s dal climax taky, ale buňce s jedním životem vzal pásma (2 ostřelovači intermediate 14/20; s odchodem pronásledovatelů začátečník 17/20; 3 ostřelovači 5/20; 1 ostřelovač climax jen ve 3/7 výhrách e03).
- **T3 – robot nečeká na strážce přišpendleného ke stěně.** Strážce věci u stěny, kterého oběh tlačí ven, stojí; robot čekal, až přejde na druhou stranu věci, do konce hodin (`genre/__tests__/waves.test.ts`, „Collect five glowing mushrooms…“, semínko 19 ze 40 – červené od T2, která dala šabloně `treasure_rush` průběh a se strážcem). Oprava je jen v robotovi (`guardian.botStep`), ne v chování: uložené hry hrají stejně. Pásma se strážcem na 20 semínkách (intermediate / začátečník) beze změny: `quest.spatial` 19 / 10 s opravou i bez ní, `arena.collect` 20 / 13 a `arena.escape+collect` 20 / 12 jako po T3.
- **T4 – boss úkolu nese všechny cíle posledního kola, ne jeden.** `interact` vyhrává, když jsou hotové všechny živé cíle, takže jediný cíl u bosse a ostatní na zemi by daly výhru s živým bossem; poslední kolo proto cíle nepoloží a padlý boss jich vydá tolik, kolik by kolo položilo (`boss_beat.drop`, 5 na dev sadě). Boss padl ve 20/20 výhrách intermediate buňky i všech pěti vět q01–q05 (20 semínek); že cíl posledního kola před pádem neleží, hlídá `quest-boss.test.ts` (buňka 20 semínek, věty 8).
- **T4 – boss úkolu má 5 HP** (`FIELD.questBossHp`): na 20 semínkách (intermediate / začátečník) buňka `quest.spatial` se 4 HP 20 / 14, s 5 HP 20 / 8, věty q03 a q05 se 4 HP 20 / 15, s 5 HP 20 / 13 (strážce v3: 19 / 10); se 4 HP byl začátečník na horní mezi pásma 0,3–0,7 a nad ní. Pronásledovatelé s bossem odejdou jako ve sběru: když zůstanou, buňka 9 / 0.
- **T4 – hodiny z věty:** věty s 30 a 45 s mají jedno kolo a průběh ani bosse nedostanou (beze změny); „light all the lanterns in the temple within 90 seconds“ (hodiny 80 s) a „paint every fence in the neighborhood within 75 seconds“ mají dvě kola s bossem a robot publikace vyhraje před hodinami na všech 4 semínkách publikace, boss padl pokaždé.
- **T4 – mrtvý čas questu v prostoru cíl ≤ 4 s nesplnil: 9,6 → 9,3 s** (medián nejdelší mezery, dev q01–q05). Nejdelší mezera (sonda se 4 HP, q01 a q03, semínka 1–4) leží buď uprostřed kola (q01 na semínkách 1–3 z 4: 8,8–9,5 s chůze mezi cíli), nebo od příchodu bosse k prvnímu zásahu (7,9–8,9 s: boss přijde na nejvzdálenějším místě vstupu a jde pomaleji než hráč); medián pěti vět drží mezery uprostřed kola, které finále nemění – patří do T9 (rozestup cílů, tep). Příchod bosse blíž by měnil místa vstupu všech chování (`spots`), proto ho T4 nezkoušela.
- **T5 – spěch stanoviště jsou poslední kola o aspoň 9 s, ne jen poslední kolo.** Samotné poslední kolo climax nedá: nese vždy ~12 událostí, i okamžité by dalo 24,5 události v posledních 10 s proti potřebným 24,8 (s01). Ve spěchu je držení i pečení na třetinu (`interact.rush`, `rules/interact.ts` mimo seznam souborů), lhůta přetečení na dolní mez křivky (240 tiků proti 273/315), kopie stanovišť přijdou s prvním kolem spěchu o půl rozestupu blíž (buňka climax 16/20 → 20/20). Kol ubere jen tolik, aby odhad robota nebyl o víc než půl kola delší než hra bez spěchu: bez té rezervy začátečník na buňce s hodinami 40 s 18/20, s ní 13/20 (pásmo 0,3–0,7; ubrat 2 kola 15/20, 1 kolo 5/20).
- **T5 – škůdce-boss není potřeba:** finále `quest.station` na dev sadě 0 → 1,0 (4/4, climax), stoupání 0,5 → 1,0; pravidlo plánu ho žádá jen při climaxu pod 0,8. `station-rush.test.ts` hlídá climax aspoň v 80 % výher na 8 semínkách (buňka a věty s01–s04); druhý krok zůstává možný, kdyby holdout v T12 ukázal méně.
- **T6 – šampion je totéž tělo soupeře, ne nové tělo:** předloha `bossBody` (9/4 rozměrů soupeře, `kind` `boss`, HP = `foeHealth` 5) leží na konci úrovně (index 2, za hráčem a soupeřem) a ovládání `duel` (`champion`) ji otiskne do těla soupeře (`DUEL_FOE`) v tiku, kdy padne předposlední z 9 soupeřů, takže robot, čítač HUD i scéna dál čtou jedno tělo se stavem fáze.
- **T6 – nízké `foeHealth` nenastane:** generátor duelu dává soupeři 4–6 HP (obtížnost easy / normal / hard), podmínka telemetrie ≥ 3 zásahy proto platí vždy a zvláštní větev pro méně než 3 není; `duel-champion.test.ts` hlídá ≥ 3 na buňce i větách d01–d04.
- **T6 – zásah zapisuje `judge`** (`champion: { body, after }`, `after` = 5 × 8 = 40): trefa, která porazila předposledního soupeře, šampiona nezasáhne (začínal by o 1 HP níž než čítač), po knockoutu šampion leží jako živé tělo s HP 0 a rozzuření `DUEL_ENRAGE` zůstává.
- **T6 – hratelnost se nemění:** buňka `duel.default` na 20 semínkách intermediate 20/20 a začátečník 8/20 se šampionem i bez něj (`genre.v3`), boss podle telemetrie ve 20/20 výhrách; gauge duel finále 0 → 1,0 (dev 4/4, panel 2/2), chování 1 a mrtvý čas 2,24 s beze změny.
- **T6 – scéna šampiona zatím neukazuje:** `DuelScene` kreslí soupeře z počátečních rozměrů a modelu věty, větší tělo a `kind` `boss` za běhu ukáže až T10 (banner „Champion!“ v tiku, kdy čítač zásahů dosáhne 40, a pipy HP z čítače).
- **T7 – terč-boss nahradí v posledním kole bonusový terč a 3 nejvyšší cíle (věž shora), ne kolo navíc:** boss ke všem cílům kola prohrál buňce `throw.default` na hodiny 52 s (intermediate 15/20, hodiny došly bossovi s 1–2 HP), o kolo kratší hra s bossem dala začátečníkovi 20/20 a kolo jen s bossem zkrátilo hody na věž pod 30 s (22–23 s); takhle kolo bosse trvá jako kolo, které nahradilo, a buňka má na 20 semínkách intermediate 20/20 (boss padl ve 20/20 výhrách) a začátečník 11/20 jako `genre.v3`.
- **T7 – tělo bosse je `bossBody` bonusového terče:** role `enemy`, `kind` `boss` (hod nemá nepřítele věty – terč věty má roli `target`), 2250 × 2250 × 675 (9/4 bonusového terče 1000 × 1000 × 300), HP 3, kýve se rychlostí posledního kola z křivky jako bonusový terč, kterého nahradil (buňka, semínko 2: 105 jednotek za tik, horní mez `THROW_SWING.speed`) a stojí za cíli kola jako on.
- **T7 – zásah zapisuje `shot_hit.tough`, ne `boss_beat_hit`:** `boss_beat_hit` bere HP jen v okně `recover` chování `boss` a hod chování nemá; `tough` (předloha bosse) dá každým míčem efekt `hit` za 1 HP a teprve třetí míč bosse sebere s bodem skóre. Rozsah navíc: `pieces/shots.ts` (parametr `tough`), `pieces/throw-bot.ts` (robot míří i na kývajícího se nepřítele) a `__tests__/pacing-static-b.test.ts` (test bonusových terčů na uložené `genre.v3`, měřidlo tlaku vidí i bosse).
- **T7 – rezerva munice 2 hody:** kolo bosse má hodů za zbylé cíle + 3 na bosse + hody navíc kola jako v3 + 2; roboti nemíjejí (bez rezervy pásma stejná), rezerva je pro člověka, aby poslední míč nebyl útes – bez ní hlídá test `throw-boss.test.ts` (přesný počet hodů).
- **T7 – věty dev sady t01–t03 jsou bez hodin:** začátečník 20/20 se bossem i bez něj (výchozí stav), pásmo 0,3–0,7 platí pro buňku P41; stoupání hodu zůstává 0 (kolo bosse nese 3 zásahy a 1 pád místo 3 pádů a bonusu).
- **T7 – scéna terč-bosse zatím neukazuje jinak:** banner „Boss target!“ s posledním kolem (čítač kola `trigger` dosáhne počtu kol, kdy `throw_rounds` bosse vyšle) a pipy HP z těla bosse (`kind` `boss`, role `enemy`) dodá T10.

## Známé červené pro T11

- `src/play/compose/__tests__/difficulty.test.ts` – otisk specu `run.escape` (a dalších buněk žánru) neodpovídá `evals/play/p41/difficulty.json` od T2: `GENRE_COMPILER_VERSION` `genre.v4` mění otisk každého specu žánru; řádky přeměřit v T11.

## Průběh plánu (`after.json` = poslední měření)

| Po úloze | Dev: průběh | Dev: finále | Dev: chování (medián) | Dev: mrtvý čas | Panel: finále |
|---|---|---|---|---|---|
| výchozí | 0,37 | 0 | 1 | 4,7 s | 0,38 |
| T2 | 0,9 (bez dílů P42 1,0) | 0,27 | 2 | 4,9 s | 0,43 |
| T3 (sběr) | 0,9 (bez dílů P42 1,0) | 0,3 (sběr bez dílů P42 1,0, útěk/přežití 0,5) | 2 | 4,9 s | 0,43 |
| T3 (přežití) | 0,9 (bez dílů P42 1,0) | 0,37 (sběr bez dílů P42 1,0, útěk/přežití 1,0) | 2 | 4,9 s | 0,48 |
| T4 (quest v prostoru) | 0,9 (bez dílů P42 1,0) | 0,53 (quest v prostoru 0 → 1,0, mrtvý čas 9,6 → 9,3 s) | 2,5 | 4,9 s | 0,55 |
| T5 (stanoviště) | 0,9 (bez dílů P42 1,0) | 0,67 (stanoviště 0 → 1,0, stoupání 0,5 → 1,0) | 2,5 | 4,9 s | 0,6 |
| T6 (duel) | 0,9 (bez dílů P42 1,0) | 0,8 (duel 0 → 1,0, boss) | 2,5 | 4,9 s | 0,65 |
| T7 (hod) | 0,9 (bez dílů P42 1,0) | 0,9 (hod 0 → 1,0, boss; chování hodu 0 → 1) | 2,5 | 4,9 s | 0,68 |
