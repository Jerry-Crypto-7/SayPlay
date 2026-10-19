# P52 – akce z věty: co hráč napíše, to hrdina umí a použije

Plán `plans/P52-akce-z-vety-2-2026-10-17.md` (necommitovaný). Větev `features/P52-akce-z-vety-2-2026-10-17`; T1 ji posunula fast-forwardem na lokální větev P51 (`e3b2fd4a`, obsahuje `origin/main` `9aa10350`) – P51 na origin není.

## Sady

- **`dev.json`** – 40 vět napsaných 18. 10. na mezery, které nechal P47B (Fakta plánu): 17 mezer po dvou větách (`gap`) a 6 pastí, kde sloveso akce patří nepříteli (`enemy-verb`, `wants: []`). `wants` = ruční štítek akcí hrdiny v pořadí věty. Žánr, kam věta na semínku 1 padne, test nedrží (T8 ho u duelu záměrně mění); zapisuje ho `baseline.json`. Na dev sadě, na `p47b/verb-dev.json` a na větách P46A se ladí a diagnostikuje.
- **`holdout.json`** – 40 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen pět akcí hrdiny s příklady sloves, tvar záznamu, pokyn psát přirozené věty hráčů 13+ a rozložení: 30 vět s akcí hrdiny (po 6 na akci, asi 8 se dvěma akcemi), 10 vět se slovesem jen u nepřítele (`family: "enemy"`). Věty zapsal sám a vrátil jen otisk – nikdo z P52 je nečetl. **SHA-256 nad LF bajty: `5dad1fbaac0da5066ff2a8906ce9fba5677770db33b868176b004bf32c8d3e61`** (hlídá `__tests__/sets.test.ts`). Do konečného měření T11 ho čte jen test otisku a tvaru (do výstupu jdou jen id).
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.

## Měřidlo

Gauge P47B (`p47b/actions.ts`, popis v `p47b/README.md`), od P52 navíc s žánrem návrhu v řádku (`genre`, `genreOfSpec` z P47A):

```
P47B_SET=p52|dev|p46a P47B_OUT=<f> npx vitest run --config vitest.measure.mts evals/play/p47b/actions.measure.ts
```

`P47B_SET=p52` bez `P47B_OUT` píše `evals/play/p52/p52.json`. Holdout P52 jen v T11: `P47B_SET=p52-holdout P52_OPEN_HOLDOUT=1`. Finále P51 hlídá gauge P47A: `P47A_SET=p51 P47A_OUT=<out> npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts` (píše do `evals/play/p51/`).

## Výchozí stav (`baseline.json`, po T1)

Robot `intermediate`, semínko 1, kompilátor `genre.v5`. Podíly nad větami, které akci chtějí; past = podíl pastí, kde hrdina akci ze slovesa dostal.

| Sada | Vět | Chce akci | Má akci | Robot použije | Sloveso se projeví | Past | p95 návrhu |
|---|---|---|---|---|---|---|---|
| P52 dev | 40 | 34 | 0,12 | 0,24 | 0,24 | 0,5 (3/6) | 3,6 s |
| P47B dev (`verb-dev.json`) | 65 | 50 | 0,70 | 0,76 | 0,74 | 0 | 3,7 s |
| P46A | 20 | 19 | 1 | 1 | 0,89 | – | 3,2 s |
| Finále P51 (gauge P47A) | dev 30 / panel 40 | – | – | – | – | – | finále 0,97 / 0,93 |

- P47B dev klesl proti `p47b/after-dev.json` (0,74 / 0,84 / 0,82) – změřeno nad sloučenou P51; o kterou větu jde, ukáže srovnání řádků v T3.
- p95 návrhu je čas stroje a v době měření běžely souběžně jiné relace; P47B naměřil 1,7 s. Brána ≤ 2 s se posoudí v T11 na klidném stroji.
- Hratelné všechny hry ve všech třech sadách.

## T3 – slovník a past sloves nepřítele

Slovník akcí hrdiny je v `src/play/draft/controls.ts` (`ABILITY_CUES`, `heroDoes`), sloveso záměru v `src/play/intent/extract.ts`; T3 mění oba.

- **Nová slovesa** (minutá na dev sadě P52): „darts/veers + předložka“ → dash (d29, d30), „smacks“ (+ „thumps“, „pummels“) → strike (d02), zvednutý štít „raises a force field“, „holding up a shield“ → shield (d22, d28).
- **Past nepřítele** (`enemyDoes` v `extract.ts`): sloveso střelby nebo úderu ve vedlejší větě s jiným podmětem („as hunters shoot“, „as cannons blast“) nebo holý množný podmět, který střílí na hrdinu („enemy turrets fire at a little robot crossing…“, „guards shoot at you“, „hawks grab at a field mouse running…“). Záměr takové sloveso nepočítá jako akci hrdiny (jen `shoot`/`fight`/`kick`, „until the door unlocks“ zůstává) a doplněk střelby ho nečte.
- **Gauge po T3:** P52 dev 0,24 / 0,35 / 0,32, past **0** (dřív 0,5); P47B dev 0,70 / 0,76 / 0,74 a P46A 1 / 1 / 0,89 beze změny. Věty T3 (d02, d28, d29, d30 – bránil jim jen slovník) mají `hasAction` 4/4; d22 slyší štít, ale střílečka štít nebere (T7).
- **Zbývá:** d35 („enemy turrets fire at a little robot…“) staví střílečku – hrdina střílí, protože je to mechanika žánru, ne akce ze slovesa; gauge ji jako past nepočítá. d25 („…and the captain grabs the treasure map“) – kapitán není hrdina věty, nechává se na T8.
- Uložené hry: spec nese akce i doplňky, slovník čte jen nový návrh – replay brána, `golden.test.ts` a `p51-stored-v4.test.ts` zelené.

## T5 – úder v bludišti, questu a sběru se dvěma akcemi

- **Bludiště** (d05, d06): nepřátelé stojí na cestě ke východu (`walkerFoeCells`), robot je cestou udeří. **Quest** (d03, d04): `quest_spatial` bere jen úder, robot s připraveným úderem dojde k pronásledovateli. **Sběr s úderem a dashem nebo štítem** (v13, v40): sběr ve vlnách přivedl za hru jednoho pronásledovatele a obě akce ho zničí, takže druhé sloveso nešlo dokázat; robot teď pronásledovatele přiděluje akcím střídavě a dash/štít mačká až těsně před dotykem (`ARENA_PRESS`). d01 (aréna, chytání) fungovala už před T5.
- **Vyváženost:** úder pronásledovatele zničí natrvalo, takže začátečník vyhrával skoro vždy (quest 9/10 proti 6/10 bez úderu, sběr s dashem a úderem 9/10 proti 4/10 bez akcí). Ve `genre.v5` proto další vlna zničené doplní (`restock` v `arena_waves`) a vlny přivedou pronásledovatele navíc: quest ve druhém kole jednoho, sběr se dvěma akcemi v každé vlně od první s pronásledovatelem jednoho (`sharedChasers` v `abilities/index.ts`). Novice / intermediate po změně, semínka 1–10 (test) a 1–20 (semínka brány P41):

| Buňka | 1–10 | 1–20 | bez akce 1–20 |
|---|---|---|---|
| quest s úderem (d03, d04) | 0,7 / 1 | 0,65 / 0,95 | 0,55 / 0,95 |
| sběr, dash + úder (v13) | 0,6 / 0,9 | 0,7 / 0,95 | 0,45 / 0,95 |
| sběr, štít + úder (v40) | 0,6 / 0,9 | 0,65 / 0,9 | 0,45 / 0,95 |

- **Gauge po T5** (proti T4): P52 dev 0,29 / 0,44 / 0,44 → **0,41 / 0,56 / 0,56** (d03–d06 nově 1 / 1 / 1), P47B dev 0,76 / 0,80 / 0,78 → **0,80 / 0,84 / 0,82** (v13, v40 nově 1 / 1 / 1), P46A 1 / 1 / 0,95 beze změny, finále P51 dev 0,97 a panel 0,93 beze změny; vše hratelné. p95 návrhu 2,7–3,4 s – čtyři měření běžela souběžně, brána se posoudí v T11.
- v01, v09 a v14 z AC jsou v otevřeném holdoutu P47B – neměří se, platí za ně obdoby d01–d06.
- **Mimo T5:** sběr jen s úderem (beze změny od P47B, otisk `5c0da6ca` drží test) má na semínkách 1–20 novice 0,85 (bez akce 0,45) – mimo pásmo už před P52; zapsané v plánu jako nález.

## T6 – dash, štít, střelba a krádež v chodci

- **Bludiště** bere všech pět akcí: dash, štít a střelba míří na nepřátele z T5 na cestě ke východu. Střela letí směrem chůze (`aim: 'heading'`) a zeď ji zastaví; robot střílí, jen když je nejbližší tělo v ose chůze nepřítel, který patří střelbě (`walkerShot`). **Plížení** bere jen krádež – okrade strážného ve vstupní chodbě nebo sebere věc a jiskry; okradený strážný přestane hlídat.
- **Vedlejší nález:** s chodcem, který bere štít, dala věta d06 „gnomes that block the paths“ hrdinovi štít. Opraveno ve slovníku: vztažná věta za množným jménem, které hrdina není, patří nepříteli.
- **Gauge po T6** (proti T5): P52 dev 0,41 / 0,56 / 0,56 → **0,65 / 0,79 / 0,79** (d11–d18 nově 1 / 1 / 1), P47B dev 0,80 / 0,84 / 0,82 → **0,88 / 0,92 / 0,90** (v17, v41, v45, v61 nově 1 / 1 / 1), P46A a finále P51 (0,97 / 0,93) beze změny, past 0. p95 návrhu 1,4–2,0 s (měřidla sériově).
- **Vyváženost:** všech 12 vět T6 na semínkách 1–20 novice i intermediate 20/20, stejně jako bez akce.

## T7 – štít v míči, krádež a štít ve střílečce

- Hrdina míče i střelnice stojí: štít bere střelu soupeře (`hazard`, náraz jako nepřítel), krádež kořist (`collectible`); obojí přiletí zepředu po ose hrdiny, první za 90 tiků, další po 180, nejvýš 3, jen dokud hra jistě běží (`ballOpenUntil`, `shooterOpenUntil`).
- **Gauge po T7** (proti T6): P52 dev 0,65 / 0,79 / 0,79 → **0,82 / 0,85 / 0,85** (d07, d08, d19–d22 nově 1 / 1 / 1), P47B dev 0,88 / 0,92 / 0,90 → **0,92 / 0,92 / 0,90** (v53, v55 nově 1 / 1 / 1), P46A a finále P51 (0,97) beze změny, past 0. p95 návrhu P52 dev 1,5 s, P47B dev 2,2 s, P46A 2,5 s – měřeno při zátěži stroje 72 % CPU (medián P46A 0,84 → 1,15 s bez jediné změněné věty); přeměřit v klidu v T10.
- **Předchozí pád:** `p46-fixtures.test.ts` o01 („A rabbit steals carrots…“) chce `adds: ['boss']`, dostane i `action` – padá i na kódu před T7, tedy z dřívější úlohy; patří do regresní vlny T10.

## T7b – střelba v chytání

- Kořist chytání je role nepřítele: střela ji zabila a robot prohrál 4/4. Teď ji střela nesebere (`shot_hit` `spare`) a robot na ni nestřílí; cílem jsou dvě včely na přímce start → kořist (`CATCH_BEES`: první 6 m od startu, nejvýš 35 % cesty, druhá v 65 %). Dotyk včely vrátí hrdinu na start. Kořist utíká rychleji než hrdina a cestu stočí jinam, proto robot s připravenou střelou jde ke včele v dosahu 8 m a sestřelí ji (bez toho semínko 16 nedokázalo sloveso).
- Střelu jako akci bere z volného pohybu jen chytání (`GENERATOR_ONLY`); útěk a sběr dál úder, dash, štít a krádež, souboj a quest beze změny.
- **Gauge po T7b** (proti T7): P52 dev 0,82 / 0,85 / 0,85 → **0,85 / 0,88 / 0,88** (d10 nově 1 / 1 / 1), P47B dev, P46A a finále P51 beze změny, past 0. p95 návrhu P52 dev 1,4 s, P47B dev 1,7 s, P46A 2,3 s (stroj dál vytížený, přeměřit v T10).
- **Vyváženost** d10 na semínkách 1–20: novice 9/20 (bez akce 8/20), intermediate 19/20 (20/20); ověření 20/20, intermediate sestřelí včelu do 60. tiku, novice do 73.
- **Zbývá:** d09 („catches falling snowflakes … shoots tiny snowballs at the crows“) jde do jiného žánru než volný pohyb a akci nemá – mimo T7b. Včely se kreslí modelem kořisti (hra nemá roli `enemy` s popiskem z věty) – nález T7b-R1.

## T8 – duel se střelbou nebo krádeží

- Duel bral jen úder, dash a štít, takže věty „duels the sheriff, firing a ray gun“ a „duels another thief to swipe the king's crown“ akci ztratily. Teď duel bere všech 5 akcí: střelba a krádež jsou sloveso zásahu soupeře jako úder (`judge` `verb`, `duelHitOf` v `capabilities.ts`) – Tap, žádné druhé tlačítko, nápověda řekne slovo věty („Tap right or Space to fire“). Zásah nese jedno sloveso, proto duel bere jen jednu z těch tří akcí – úder před střelbou a krádeží („steals its eggs and punches it“ → úder); úhyb jde vedle. Svět se pohne jen u duelu, jehož spec akci nese; duel bez akce staví totéž (otisk v `duel-verbs.test.ts`).
- **Gauge po T8** (proti T7b): P52 dev 0,85 / 0,88 / 0,88 → **0,94 / 0,97 / 0,97** (d23, d24, d26 nově 1 / 1 / 1), P47B dev 0,92 / 0,92 / 0,90 → **0,96 / 0,96 / 0,94** (v54, v67 nově 1 / 1 / 1), jiná věta se nezměnila; P46A a finále P51 (dev 0,97, panel 0,93) beze změny, past 0. p95 návrhu P47B dev 1,7 → 2,1 s při vytíženém stroji (P46A 2,35 → 2,38 s) – přeměřit v T10.
- **Vyváženost** na semínkách 1–10 stejná jako u duelu bez akce (sloveso jen označí zásah, pohyb ani časování se nemění): novice 6/10 (d24, v54, d26, v67), intermediate 10/10, idle 0/10. d23 novice 0/10 už před T8 (věta přidá díl „fire“) – buňka P41 `duel.default` se nemění.
- **Zbývá:** d25 („two pirates duel on the deck and the captain grabs the treasure map“) – slovník krádež nepřizná, protože „the captain“ není podmět hrdiny („two pirates“).

## T9 – souboj v aréně s dashem i štítem

- **Proč novice prohrával** (věta testu P47B T6, semínka 1–10): bez akcí 6/10, štít 5/10, dash 6/10, oba 1/10 se štítem na A a 3/10 s dashem na A. Novice reaguje o 20 tiků pozdě a ze dvou ochran mu volba častěji nevyjde: zápas se táhne (8 úderů soupeře místo 4) a flanker průběhu P51 mu mezitím bere celé životy. Flanker sám je smrtící (jen flanker 1/10), přepadník neškodný (jen přepadník 6–8/10).
- **Změna:** ve `genre.v5` se soupeř souboje, ve kterém hrdina nese dash i štít, napřahuje 40 tiků místo 30 (`FIGHT.pairTelegraph`, parametr `telegraph` ovládání `fight`); nápřah ve scéně se kreslí přes celou délku. Jedna ochrana a uložená `genre.v4` staví týž svět (otisky v `p52-fight-balance.test.ts`).
- **Vyváženost po T9:** štít na A novice 5/10 (9/20), dash na A 6/10 (12/20), intermediate 9/10 (19/20); věta d33 novice 6/10 (12/20), intermediate 9/10 (19/20). Telegraf 50 dal 5/10 a 6/10, ale na 20 semínkách 0,65 a 0,7 – na hraně, proto 40.
- **Gauge po T9:** P52 dev beze změny 0,94 / 0,97 / 0,97 (d33, jediná věta sad se soubojem s oběma ochranami, 1 / 1 / 1), finále P51 dev 0,97. P47B dev a P46A souboj s oběma ochranami nemají – jejich světy se nehnuly. Žádná buňka `evals/play/p41/difficulty.json` dash ani štít nenese, otisky řádků se neposunuly.

## Rozhodnutí

- T1: větev P51 na origin není (`git ls-remote` bez ní); sloučena lokální `features/P51-…`, která `origin/main` už obsahuje – fast-forward bez merge commitu.
- T5: quest s úderem drží bránu P41 (novice 0,3–0,7, intermediate ≥ 0,8), ne „vyhraje stejně jako bez úderu“ – quest bez úderu je v pásmu sám, takže platí brána; srovnání s hrou bez akce zůstává jen u bludiště, které je lehké už bez úderu (novice 10/10).
- T6: plížení bere jen krádež – jiné akce v něm nikdo neměřil a věty sady chtějí jen ji. Brána vyváženosti chodce je „vyhraje stejně jako bez akce“: buňky chodce jsou mimo pásmo P41 už bez akcí (novice 20/20).
- T7: míč bere jen štít, střílečka krádež a štít; střelba je u střílečky vlastní mechanika, akci nedostane. Přílety k hrdinovi (střela soupeře, kořist) jen do tiku, kdy hra jistě běží – hra, která skončí dřív, akci nedostane (kompozice ji zahodí), místo aby slibovala sloveso, které nejde použít. Brána vyváženosti „vyhraje stejně jako bez akce“ (±0,1 na semínkách 1–10, d07, d08, d19, d21), jako u chodce. Střelba ve volném pohybu (`arena_catch`) oddělena do T7b – kořist je tam nepřítel a střela by ji zabila, potřebuje vlastní návrh.
- T7b: cílem střelby v chytání jsou včely, které hrdinu vrátí na start (ne jen body navíc) – bez toho by sloveso nic neměnilo. Brána vyváženosti „vyhraje stejně jako bez akce“ na semínkách 1–20 (na 1–10 vychází rozdíl novice přesně 0,1, na hraně); chytání bez akce zůstává bajt po bajtu (otisky semínek 1–3 v testu).
- T8: duel dostal akci, výchozí přesměrování bránu nedrželo. Souboj v aréně (`FIGHT_ABILITIES`) střelbu ani krádež nebere; přesměrování na střílečku (střelba) a sběr v aréně (krádež) dalo gauge stejné 1 / 1 / 1, ale vzalo duelu jeho přestřelku za poledne – „cowboy duel at high noon, first to shoot wins“ (P36A T11) spadl na střílečku – a ve sběru zmizel lístek i koruna z věty (mince, květina). Duel se slovesem zásahu nechá hru, kterou věta řekla, a změnu drží v souborech plánu.
- T9: pákou je délka nápřahu soupeře (síla hrozby), ne flanker průběhu. Odebrat flankera nebo ho vyměnit za přepadníka dalo novice 0,7–0,8 (nad pásmem), pozdější příchod nic nezměnil (rozvrh ho staví na vrchol křivky) a dash či štít proti výpadu chování jen +0,1. Změna sedí v `abilities/index.ts` (`fightGuard` – jen tam se ví, že hra nese obě ochrany) a ve scéně souboje (`FightFx`, `ArenaScene`); `fight-bot.ts` beze změny, robot čte zbývající tiky telegrafu ze stavu.
