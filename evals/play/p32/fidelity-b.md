# P32B T6 – věrnost po přepojení na žánry

Naměřeno 30. 9. 2026 skriptem `scripts/p32/fidelity-b.mjs`, data `fidelity-b.json`, hlídá `scripts/__tests__/p32-fidelity-b.test.ts`.
Offline řetěz `scripts/play-fidelity.mjs` nad korpusem 30 a `judge-10`, bez modelu. Proti stavu P30B (`evals/play/p30b/after.json`, sloupec `after`).

- **draft** – slovní draft nové hry, od P32B T2 hra žánru.
- **ai** – zmrazené AI specy `p30b/live.json`. Jsou to hry z doby před žánry, nový režisér (GenreSpec) offline změřit nejde – to je živé HALT O10.

## Přeměřeno 3. 10. 2026 po P36A

`fidelity-b.json` je přepsaný týmž skriptem na HEAD po sloučení P36A (žánry timing, rhythm, duel, flap, shooter, throw zpátky) a opravě slovesa „hoard“ v draftu. Součty proti P30B: hrdina 39 → 42, položky 67 → 70, prostředí 58 → 59, slovesa 61 → 61.

- **Vrátilo se 11 položek** ze ztrát níž: zombie (`s039`), alien bug (`s037`), kid (`s050`), cardboard box a launch (`s088`), log (`s095`), flap (`s035`), drum to the beat (`s144`), arrow (`j09`); nově kreslené jsou lily pad (`s144`), pancake (`s099`) a dodge (`j09`).
- **Jediná výměna je žába v `s144`:** věta zase hraje rytmus a rytmická scéna hrdinu nemá (`not-read-by-control`). V P30B žába taky nehrála, proti P30B to tedy ztráta není.
- Pořád ztracené proti P30B: `s056`, `h03`, `j04`, `j05` – důvody v tabulce níž platí.

Tabulky níž jsou stav P32B z 30. 9. 2026.

## Součty (draft + ai, obě sady)

| role | P30B | P32B | rozdíl |
|---|---|---|---|
| hrdina | 39 | 43 | +4 |
| položky | 67 | 54 | −13 |
| prostředí | 58 | 59 | +1 |
| slovesa | 61 | 57 | −4 |

- **Zmrazené AI specy neztratily nic.** Všechny ztráty jsou ve slovním draftu, tedy ve větách, které dřív hrály legacy ovládání (`shooter`, `throw`, `duel`, `tap_go`, `flap`, `rhythm`) a teď hrají žánr.
- **Hrdina +4:** žánr bere hrdinu z věty (babička, žába, astronaut, černá díra) místo hrdiny šablony.
- **Položky −13:** 14 ze 17 ztracených položek má tělo, scéna jim ale nedá model podle popisku (`no-model`). Kreslí je stylizovaná scéna žánru (`StyledWorld`) a `arcade/models.ts` dává model jen rolím `enemy` a `coin`. Žánry píšou soupeře jako `rival`, věc arény jako `item` a terč úkolu jako `target`. To je **B-R9** (soubor týmu C). Po opravě se vrátí 14 položek a součet bude 68, tedy nad P30B.
- **Slovesa −4:** od T6 počítá řetěz sloveso hry žánru podle režimu, který ho hraje (tabulka sloves klasifikátoru, stejně jako kontrola věrnosti režiséra). Ztratilo se 5 sloves, protože věta hraje jiný režim než její sloveso ze seznamu. Pro 4 z nich to určuje pravidlo T1 (sloveso nesoucí cíl vyhrává) nebo rozhodnuté zúžení na 5 žánrů. 1 sloveso se získalo.

## Ztráty po větách

| věta | dřív | teď | ztráta | proč |
|---|---|---|---|---|
| `s039` | shooter | úkol v prostoru | zombie – `no-model` | zombie je terč úkolu (`target`) a scéna žánru terči model z popisku nedá – B-R9 |
| `s037` | shooter | úkol v prostoru | alien bug – `no-model` | terč úkolu – B-R9 |
| `s050` | throw | úkol v prostoru | kid – `no-model` | terč úkolu – B-R9 |
| `s088` | throw | úkol v prostoru | cardboard box – `no-model`, sloveso launch | terč úkolu – B-R9; „launch“ tabulka sloves nezná (přidat by znamenalo „rocket launches“ poslat do úkolu), dřív ho hrálo ovládání hodu |
| `s095` | throw | úkol v prostoru | log – `no-model` | terč úkolu – B-R9 |
| `j05` | shooter | úkol v prostoru | balloon – `no-model` | terč úkolu – B-R9 (sloveso pop teď hraje úkol) |
| `s188` | duel | souboj | pigeon – `no-model` | soupeř souboje (`rival`) – B-R9 |
| `s155` | shooter | souboj | goblin – `no-model` | soupeř souboje – B-R9 |
| `h03` | throw | souboj | dragon – `no-model`, sloveso throw | soupeř souboje – B-R9; cíl nese „defend“, hod sněhových koulí je jen prostředek, takže hra je souboj a „throw“ nehraje |
| `h05` | duel | souboj | kangaroo – `no-model` | soupeř souboje – B-R9 (sloveso box teď hraje souboj) |
| `j08` | shooter | souboj | skeleton – `no-model` | soupeř souboje – B-R9 |
| `s002` | tap_go | útěk | key – `no-model` | věc arény (`item`) – B-R9 |
| `h01` | tap_go | útěk | fish – `no-model` | věc arény – B-R9 |
| `h04` | tap_go | sběr | battery – `no-model` | věc arény – B-R9 |
| `s056` | steer | úkol v prostoru | traffic – `not-in-spec`, sloveso race | cíl nese „deliver“, hra je doručovací úkol bez dopravy. Úkol navíc udělá z „before the pizza gets cold“ pronásledovatele pizzu: vzor `CATCH` v `genre/quest.ts` (tým G) nechce po slovesu zájmeno jako `CATCH_BEFORE` v `draft.ts` |
| `s035` | flap | běžec | sloveso flap | „like flappy bird but underwater“ klasifikátor pošle do běžce, „flap“ hraje let (plavba) |
| `s144` | rhythm | úkol v prostoru | sloveso drum to the beat | rytmus mezi 5 žánry není – pokles přijatý v plánu („Co nevíme“) |
| `j04` | runner | plavba | ice cream – `not-read-by-control` | plavba má „ice cream“ jako cíl trasy a ovládání `steer` popisek cíle nečte. Hrdina je loď, ne pes z věty |
| `j09` | shooter | plošinovka | arrow – `not-read-by-control` | šíp je překážka plošinovky a ovládání `platform` její popisek nečte, dřív ho četla střelnice jako nepřítele |

Získané položky: pizza (`s056`, jako pronásledovatel – viz výše), seal a fish (`h10`, běžec), acorn (`j07`). Získané sloveso: slide (`h10`).

## Co z toho plyne

- **B-R9 je jediná páka na položky.** Model podle popisku pro role `rival`, `item` a `target` ve scéně žánru vrátí 14 položek.
- **Draft má dvě chyby rolí:** pronásledovatel pizza (`genre/quest.ts`, tým G) a loď místo psa u procházky na pláži (`j04`). U lodi jde pravděpodobně o to, že věta nemá hrdinu v podmětu („walk my dog“), takže draft vezme výchozí plavidlo pláže. Neověřeno, patří k B-R1 a čtení rolí.
- **Slovesa, která hrálo jen legacy ovládání** (launch, drum, flap), žánry nehrají. U flap by pomohlo poslat „flappy“ do plavby, i to je věc klasifikátoru a golden sady, ne tohoto měření.
