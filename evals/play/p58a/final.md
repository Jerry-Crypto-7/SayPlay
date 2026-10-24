# P58A T9 – zapečetěná sada otevřená jednou

Sada 80 vět z T1 otevřena 24. 10. v 00:25 na `158b1c8d` (`holdout-opened.json`, otisk sedí). Od teď je to dev sada a nic se podle ní neladí. Čísla v `final.json`, příčiny po slovech v `final-why.json`, FPS v `perf-t9-a.json` a `perf-t9-b.json`.

**Brána splněná není.** Soudce viděl celou větu u 5 her z 80 a jednotlivá slova u 37 ze 160. Polovina sady jmenuje zvířata, pro která hra model nemá, a tam nepoznal skoro nic. Ve druhé polovině jsou čísla stejná jako na dev sadách.

## Výsledek

| Brána | Cíl | Výsledek | |
|---|---|---|---|
| Celé věty vidět | ≥ 0,5 | **5/80 = 0,06** | nesplněno |
| Slova vidět | ≥ 0,75 | **37/160 = 0,23** | nesplněno |
| Robot vyhraje | 80/80 | 79/80 | nesplněno (v02, stará chyba) |
| Nečinný hráč prohraje | 80/80 | 79/80 | nesplněno (v02) |
| Replay sedí | 80/80 | 79/80 | nesplněno (v02) |
| FPS na telefonu proti `1a3306eb` | pokles ≤ 10 % | medián B/A **0,993** (58,4 → 56,1 FPS) | splněno v mediánu; 2 scény −20 a −24 % |

Hrdinu soudce poznal u 26 z 80 her, protivníka nebo věc u 11 z 80.

## Jak se měřilo

Stejně jako T1 a T8, jen soudce je pro všech 80 her Opus 5.5:

1. Pečeť: `openSealedOnce` zapsal `holdout-opened.json` dřív, než kdo větu četl.
2. Čtení: lokální gpt-oss-20b přečetl všech 80 vět jednou (`read-holdout.cmd`, rozpočet 60 s). Odpověděl u 79, medián 3,1 s. Věta v05 čtení nedostala a hrála bez čtečky.
3. Hra a snímek: build `158b1c8d`, `next start`, čtení z přehrávače, `visible.mjs play` (plátno 1280×800 po 3 s hry, text stránky skrytý).
4. Slepý soud: `visible.mjs judge --judge claude`, prázdný adresář jen se snímkem, 78 her.
5. Robot, nečinný hráč a replay: `holdout.measure.ts` nad stejnými čteními, semínko 1 (postup P56A T13).
6. FPS: `play-look-shots.mjs perf`, Pixel 7 s CPU 4× pomalejším, 34 scén (`p46g/genres` + `p56b`), 3 opakování, A a B prokládaně scénu po scéně. A je build `1a3306eb` (worktree `demo-main-2026-10-23`), B je HEAD. Čtečka vypnutá na obou stranách.

## Dvě hry nevznikly

- **v02** „a dog has to grab a ball and escape from a farmer“: čtení zvolí `arena.escape` a návrh hry spadne v `compose()` na „Unsupported native recipe: walk/escape“. Server vrátí 500 s prázdným tělem.
- **v55** „a takin pushes a barrel up snowy steps while an avalanche chases it“: server hru odmítne (422, kontrola „slovesa prokázaná“ neprošla). Offline kontrola robota na semínku 1 ji pustí, protože slovesa věty nekontroluje.
- **Obě chyby jsou stejné na `1a3306eb`** (stejné přehrané čtení, `next start` z worktree `demo-main`). P58A je nezpůsobila. Patří ke čtení a volbě žánru (P58B).
- Měřidlo do T9 takovou větu neumělo: `play` skončil výjimkou. Teď ji zapíše jako hru bez snímku a souhrn ji počítá jako „nic není vidět“ (`8a4a7020`, test `visibility.test.ts`).

## FPS na telefonu

- **Medián přes 34 scén: B/A 0,993**, žádná scéna B pod 40 FPS.
- **Dvě scény jsou pomalejší ve všech třech opakováních**, takže nejde o šum stroje:

| Scéna | A `1a3306eb` | B HEAD | Změna | Kreslicí volání A → B |
|---|---|---|---|---|
| `02-zombie` | 53,7 · 55,1 · 52,6 | 43,3 · 39,7 · 42,9 | −20 % | 72 → 72 |
| `g-shooter` | 55,4 · 55,3 · 56,5 | 41,9 · 40,0 · 46,2 | −24 % | 37 → 52 |

- Další tři scény jsou na hraně (`g-duel` −11 %, `08-gems` −10 %, `g-ball` −10 %) se stejným počtem volání.
- **Inference:** u zombie se počet volání nezměnil, pokles je tedy práce procesoru za snímek (dřívější měření ukázala totéž: pokles FPS bez nových volání = procesor). Kandidáti z P58A jsou výpočty každý snímek: zvětšení těl (`LegibleBodies`, T3), kamera (T4) a promítání popisku (`NameAnchor`, T5). U střílečky přibylo 15 volání; kamera se od T4 natáčí k nejbližšímu terči, takže v záběru může být víc nepřátel. Ověří CDP profil ms/snímek, routovaná úloha T9r1.
- **Opraveno v T9r1** (`7a01e428`): profil ukázal měření pózy v `LegibleBodies` – u riggovaných postav přepočítávalo kosti pro každý vrchol (~57 ms na měření, 13–16 % hlavního vlákna). Teď se kost spočítá jednou. Nové měření (`perf-t9r1-a.json` / `-b.json`): zombie 0,94, střílečka 0,98, medián 34 scén 0,998, žádná scéna pod 0,9.

## Proč slova chybí

### Po polovinách sady

| | Celé věty | Slova | Hrdina | Protivník / věc |
|---|---|---|---|---|
| 40 vět mimo katalog (zvíře nebo postava bez modelu) | 0/40 | 6/80 | 3/40 | 3/40 |
| 40 vět uvnitř katalogu | 5/40 | 31/80 | 23/40 | 8/40 |
| Dev po T8 (pro srovnání) | 14/92 | 50/146 | 29/65 | 21/81 |

Věty uvnitř katalogu dopadly jako dev (slova 0,39 proti 0,34, celé věty 0,13 proti 0,15). Propad celkového čísla dělá polovina mimo katalog: sunbittern, jacana, olm, tuatara, gharial, mata mata, leafy seadragon, oarfish a podobně.

### Třídy (`why-unseen.mjs` nad `final.json`, 123 neviděných slov ze 160)

| Třída | Co znamená | Mimo katalog | Uvnitř | Celkem |
|---|---|---|---|---|
| `no-model` | role je, model je náhrada (hrdina jako robot nebo závodní auto) | 39 (34 hrdinů) | 1 | **40** |
| `no-role` | slovo nenese žádná role hry (včetně 2 her, které nevznikly) | 18 | 16 | **34** |
| `too-small` | tělo je pod hranou, nad kterou ho soudce poznává | 13 | 17 | **30** |
| `look` | správná role, přesný model, v záběru, a soudce ho stejně nepoznal | 1 | 12 | **13** |
| `off-screen` | tělo role není v záběru | 3 | 3 | **6** |

- **Velikost tu poprvé vyšla jako práh.** Hrdina nad 17 % výšky snímku je poznaný 22/33, pod ní 3/9. Protivník nebo věc nad 20 % 4/7, pod ní 6/29. T3 dává cíli 10,5 % – na téhle sadě je to málo. Na dev sadách práh nevyšel (T2, T8).
- `look` u hrdinů uvnitř katalogu (10): prase se čte jako pes, kuře jako chlupatá koule, krysa jako křeček, žába jako zmačkaná hmota. Je to tvar modelu, ne kamera.
- `no-model` uvnitř katalogu zahrnuje i žánr, který model přebije: kůň a žralok v závodě jsou závodní auto (v04, v20).

## Co dál

**Inference (ne měření):**

1. **Bránu nelze splnit bez modelů pro zvířata mimo katalog.** Polovina sady je postavená tak, aby hra model neměla. Bez nich je strop 0,5 celých vět jen teoretický. Řetěz z T7 (obrázek → TRELLIS) prošel 7 z 36 slov. Víc dá CC0 knihovna zvířat, nebo ruční úprava v Blenderu. Rozhodnutí pro majitele: je polovina vět mimo katalog férová váha pro porotu? Kolik vět skutečných hráčů jmenuje zvíře mimo katalog, nikdo nezměřil.
2. **Nejužší oprava v kódu je velikost protivníka a věci:** zvednout cíl `LegibleBodies` z 10,5 % ke 20 % výšky snímku a ověřit na dev sadách. Tahle sada je od dnešního dne dev, takže se smí použít k ladění dalšího plánu, ne k dalšímu měření brány.
3. **`no-role` (34):** věc nebo protivník z věty nedostal roli. To je čtení a obsazení (P58B), stejně jako obě hry, které nevznikly (v02, v55).
4. **Pokles FPS u zombie a střílečky (−20 a −24 %)** – opravený v T9r1, viz FPS výše.
5. **Nová brána potřebuje novou zapečetěnou sadu** (`seal-holdout.ts`, jedno volání Codexu), až budou modely z bodu 1.

## Odchylky od plánu

- Soudce je pro celou sadu Opus 5.5. T1 soudil audit-12 Codexem, Codex má denní strop.
- Robot, nečinný hráč a replay se měří offline nad čtením, stejně jako P56A T13. Server navíc odmítl v55, viz výše.
- Hry a soud běžely souběžně, soud bral hotové snímky průběžně. Dvakrát je zastavil desetiminutový limit úlohy na pozadí. Oba kroky hotové soubory přeskakují, nic se neztratilo ani neopakovalo. Všech 78 odpovědí nese soudce `claude`.
- 28 her ze 78 je řetěz miniher P56C (robot se nepustí, snímek po 3 s skutečného času, chyba hydratace Reactu #418), jako v T1.
