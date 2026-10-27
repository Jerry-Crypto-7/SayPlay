# P63 – hra po čtení hraje, co věta říká

## Zapečetěná sada

`holdout.json`: 24 nových anglických vět (8 sloveso mimo knihovnu, 8 s počtem v cíli, 8 obecných), napsané 27. 10. 2026 před první změnou kódu P63. SHA-256 nad LF bajty:

`e03e39a08c2a3e4ba2ea98054ce367b08e2ffcd9f66dc815d92222740538051b`

Otevře se jednou v T6 (`holdout-opened.json`). Nic se podle ní neladí. Věta p07 byla před zapečetěním vyměněna – původní („a janitor mops…“) se podobala příkladu v promptu čtečky.

## Čtení pro diagnózu (T1)

`read-set.json` (otevřený P61 holdout 24 + P61 dev 12) přečetla astra jednou na větu přes `evals/play/p58b/compare.measure.ts` → `readings.astra.json`. Útrata 1,103 USD.

`diagnose.mjs` projde cestu čtení jako server: čtečka → klasifikátor → skladba → překlad rolí → publikace, a zapíše krok rozchodu do `diagnosis.json`. Rozhodnutí o řetězu čte `chain/read.ts` (jako `route.ts`), žánr sestavené jízdy (`assembled.drive` bez `spec.genre`) bere ze skladby.

### Příčiny po větách

Krok = první místo cesty, kde hra přestane hrát sloveso věty nebo ztratí hrdinu či hlavní roli (`EXPECT` v `diagnose.mjs`, ručně podle slov věty). Řádky = `main` `495bbc77`.

| Věta | Krok | Místo | Příčina | Navržená oprava |
|---|---|---|---|---|
| h18 knight slays a dragon | čtečka | `src/play/read/prompt.ts:103` | Čtečka řekne `voyage.race`: prompt jí káže vzít první žánr, který sedí, a dodává, že „a final fight … does not decide“ – jízda lesem tak přebije souboj s drakem. Drak skončí jako překážka na trati. Slovník navíc nezná sloveso „slay“ (`classify.ts:293`, třída `defeat`). | T2: prompt – sloveso, které hra končí (porazit, zabít), vybírá žánr; „slay“ do třídy `defeat`. T3: přechod na hru, která ztratí roli draka jako soupeře, nepovolit. |
| h23 seal bounces a ball | čtečka | `src/play/read/prompt.ts:103` | Čtečka nevrátí žánr (`genre: null`), klasifikátor pak ze slov vybere `arena.collect` – míče se sbírají místo odpalování. | T2: prompt – „bounce / juggle / keep up“ = `catch` nebo `timing.precision`; slovník slovesa do třídy chytání. |
| h15 firefighter sprays flames | překlad rolí | `src/play/compose/compose.ts:250` | Žánr `quest.spatial` sedí, ale skladba nemá roli pro plameny a doplní pronásledovatele `ghost`, kterého věta neříká. | T2: role z věty (`flame` jako nebezpečí, které hráč hasí) přednostně před výplní z knihovny; výplňový nepřítel jen když věta žádného nejmenuje. |
| s002 knight, keys, ghosts | překlad rolí | `src/play/compose/compose.ts:250` | Hra po čtení `arena.collect` nese klíče, ale ztratí duchy (rychlá hra `arena.escape` je má). | T2: stejná oprava jako h15 – každá role čtení dostane místo ve hře. T3 zabrání přechodu, který roli ztratí. |
| h24 balloon between thunderclouds | publikace | `src/app/api/play/_upgrade.ts:305` | Hra po čtení (`voyage.race` s bouřkovými mraky) se nikdy nezveřejní: sestavená jízda (`compose/drive.ts`) nenese `spec.genre` a hlídka `readingDiffers` ji bere jako „neliší se“. Hráč zůstane na rychlé jízdě se žraloky. | T3: `readingDiffers` porovnává žánr skladby a role, ne jen `spec.genre`. |
| h02 pirates vs sea monsters | – | – | Žánr i role sedí. Paluba lodi chybí – vzhled scény (P62). | Nález pro P62. |
| h11 witch picks six mushrooms | – | – | Žánr i role sedí; počet „six“ se do cíle nepropíše. | T4: počet z věty do cíle. |
| h14 skier races downhill | – | – | Žánr i role sedí; hrdinu kreslí auto (`heroModel` v `src/play/arcade/models.ts`). | Nález pro P62. Štítek `voyage.race` je přípustný jen proto, že ho dnes jízda kreslí autem – zvážit jen `runner`. |
| h19 stack pancakes in a diner | – | – | Žánr i role sedí; jídelna a palačinky chybí ve vzhledu. | Nález pro P62. |
| s006 corgi grabs sausages | – | – | Žánr i role sedí. | – |

Souhrn: čtečka 2 (h18, h23), překlad rolí 2 (h15, s002), publikace 1 (h24), bez rozchodu 5. Klasifikátor ani skladba žánru sami větu nerozešli.

**Rozptyl čtečky:** živé čtení serveru se od uloženého liší (dev s002, s003, s021, s069: diagnóza hru ze čtení publikuje, server ne). Diagnóza proto říká, kde se cesta láme při daném čtení, ne jak často.

### Nálezy pro P62 (soubory P62, tady se neopravují)

- Hrdinu lyžaře (h14) i rytíře (h18) kreslí auto: `heroModel` / `heroChoice` v `src/play/arcade/models.ts` nemá model pro lyžaře ani jezdce.
- h02: chybí paluba lodi; h19: chybí jídelna a palačinky jako model. Obojí vzhled scény.

## Výchozí stav `main` na dev (T1, 27. 10., `495bbc77`)

`baseline-dev.json`, Claude ×1, listy desktop: rychlá hra 0,50 / 0,40, po čtení 0,50 / 0,40 (n = 11), hra ze čtení jen u řetězů s006 a s022 (0,425 / 0,40). s069 bez platné odpovědi soudce. Server zaplatil 12 čtení.

Snímky `main` na zapečetěné sadě: `D:/caches/p63/main-holdout/` (24/24, nesouzené, otevře je T6). Hra ze čtení vznikla u 8 z 24 vět.

## Návrat hráčů (T5)

Klíče v Upstash na návštěvníka: jeden s dnem prvního příchodu (90 dní) a jeden „viděn dnes“ na každý den, kdy přišel (2 dny). Navíc 4 denní čítače × 31 dní = 124 klíčů celkem.

Odhad (inference, ne měření): při 200 návštěvnících denně a nikom vracejícím se je nejvýš 18 000 klíčů prvního dne a ~400 denních, řádově 2 MB. Příkazy: první událost dne stojí 3–5 příkazů, každá další téhož dne jeden. Na demo provoz Upstash unese.

## Útrata čtení

| Krok | USD |
|---|---|
| T1 čtení pro diagnózu (36 vět, compare.measure) | 1,103 |
| T1 server `main`: 12 dev + 24 zapečetěných vět (`shots.mjs spend`, 36 volání) | 1,090 |
| T2 nový prompt čtečky: 7 vět P61 + 12 dev (`reread-set.json`, compare.measure) | 0,592 |
| **Celkem** | **2,785** |

Zbývá 1,215 USD. T6 potřebuje ~1,09 (server větve: 12 dev + 24 zapečetěných vět), proto T2 nečetl znovu všech 36 vět, jen 19.

## T2: nový prompt čtečky (`readings.p63.astra.json`)

Prompt: jak se hrdina někam dostane (běží, jede, letí), žánr nerozhoduje; rozhoduje, když věta říká porazit nebo zabít jmenovaného nepřítele (mimo závod, který boj jen končí). Nápověda `catch.default` zná i odrážení zpátky nahoru. Jeden nový příklad (jízda údolím a souboj s yetim → `duel.default`).

Změna žánru čtečky proti `readings.astra.json` na 19 větách: jen h18 `voyage.race` → `duel.default` a h23 `null` → `catch.default`. Zbylých 17 beze změny.

**Překlad rolí (`82bb9481`):** výplňový nepřítel z knihovny jen když čtení žádného nejmenuje (`draft.ts` `placeFoe`); hrozba volně chodící hry bez boje dostane díl nebezpečí (`assemble.ts`). Na 36 větách beze změny žánru i buňky; obsazení se změnilo jen přidáním nepřítele čtení: h15 `chaser:ghost` → `chaser:flame`, s002 + `hazard:ghost`, h10 + `hazard:bat`, h16 + `hazard:seal`.

**Zbývá (inference):** netopýři h10 („without waking the bats“) a tuleni h16 padají jako překážky – mají místo ve hře, ale ne roli z věty. h15 má cíl „Use all 5 cats“ (počet je T4). h16 nese minci a hlídku „fish“, které věta neříká.

**Test:** `src/play/read/__tests__/p63-verbs.test.ts` – sedm vět P61 proti tabulce sloveso → žánry, hrdina a role z věty; 36 vět P61 proti `diagnosis.json` (cíleně mění žánr h18, h23 a publikaci h24).

## T4: cíl počítá, co věta počítá (`38b7d426`)

**Příčina h11 (rychlá hra, jen slova):** návrh žánru (`draft.ts`) sloveso „picks“ nezná. Sbíral proto výchozí věc bažiny (banán) a houby přidala až skladba ze záměru věty (`compose.ts` `contentOf`, `put`). Počet věty návrh přiřadil jen své věci, takže u hub zůstal ležet a cíl ukázal výchozí sběr „Collect 10 mushrooms per wave, 3 waves.“ Hra po čtení počet měla (čtení nese `roles[].count` = 6). Oprava v místě vzniku: věc, kterou skladba vezme ze slov, si vezme i počet věty (`composedCounts`).

Táž chyba na dalších místech (test `src/play/genre/__tests__/p63-count.test.ts`, před opravou 9 z 33 červených):
- **Útěk se sběrem** (s002 „three keys … while dodging ghosts“): „Grab 3 keys per wave, 4 waves“ = 12 klíčů. Útěk věty s počtem teď sbírá počet celkem po vlnách jako sběr P61 T5 (`arena_escape` s `counted`). Pronásledovatelé honí od začátku, probouzí je nové pravidlo `arena_wake`. Robot vyhraje s002 za 41,6 s na všech 12 zkoušených semínkách.
- **Cíl přenosu** („recovers three fuel cells“): „Collect the cells!“ → „Collect 3 cells!“.
- **Souboj a střílečka**: počet věty je soupeřů v aréně naráz, resp. nepřátel ve vlně. Cíl ho teď říká („Knock out 5 waves of 2 wolves.“). `objective.count` střílečky dál počítá vlny, protože výhru dávají vlny.
- **Úkol**: `objective.count` chyběl. **Obrana**: cíl v HUD počet neříkal.

**h15** („rescues a cat“ → „Use all 5 cats, 3 rounds.“) **není táž chyba.** Věta číslo neříká, takže platí výchozí počet úkolu 5 (AC: bez počtu výchozí hodnota žánru). Odvozeno, neověřeno: „Use“ vzniká tím, že role kočky po čtení přijde bez slovesa věty a úkol pak vezme výchozí `use`. Patří ke slovesu hry po čtení (T2/T3).

**Nálezy, neopraveno:**
- **Žánry pruhů** mají změřenou dolní mez délky hry (P54C T14br1): chytání a bouchání 13, krájení 22, vytlačování 7. „Whack six moles“ proto hraje 13 krtků. Počet one–twelve se do nich nedostane bez nového tempa generátorů.
- **Bludiště** (h10 „Grab ten gold coins in a haunted castle“, buňka `assembled.walk`) má jednu minci: „Collect the gold coin and reach the exit.“ Generátory `walker_*` počet věcí neznají.
- **Počet ze slov** (`readCountedNouns`) bere nejvýš jedno přídavné jméno a jen množné číslo na -s. „five falling honey jars“ ani „twelve fish“ počet nedají (čtečka ano).
- **Krádež** (`ability_grab`, sloveso „grabs“) počítá do sebraných i okradené nepřátele. „A diver grabs 9 pearls while escaping two sharks“ robot vyhraje za 22–29 s a počítadlo ukáže 9/9 dřív, než sebere 9 perel. Skóre útěku to nafukovalo už před T4, teď je to vidět na počítadle.
- **Běžec**: počet věcí jde do role, cíl v HUD je doběhnout („Reach the finish line“). Věci nejsou podmínkou výhry.

## T4: start na telefonu (s002, s006)

**Měření** – 27. 10. večer, `scripts/measure/first-playable-ab.mjs`:
- A = `main` `495bbc77` (`D:/caches/p63/main`, port 3164), B = větev `38b7d426` (port 3163).
- Oba `npm run build` a `next start`, `PLAY_READER=off`, žádný klíč čtečky, 0 placených volání.
- Pixel 7, CPU 4×, A/B prokládaně, 3 běhy na stranu. Stroj byl vytížený jinými agenty, na klid se nečekalo.
- Surová data: `D:/caches/p63/t4-ttp.json`, `t4-ttp2.json`.

| Věta | `main` medián | větev medián | rozdíl mediánů | párový rozdíl | první snímek A → B | Brána ≤ +200 ms |
|---|---|---|---|---|---|---|
| s002 knight, three keys, ghosts | 8942 ms (7950–10892) | 9241 ms (9184–11359) | +299 ms | +467 ms | 5433 → 5300 ms | nesplněna |
| s002, druhé kolo 3 + 3 běhy | 9645 ms | 9640 ms | −5 ms | +288 ms | 5322 → 5459 ms | splněna |
| s002, všech 6 + 6 běhů | 9294 ms | 9441 ms | +147 ms | +383 ms | 5378 → 5421 ms | splněna |
| s006 corgi, sausages, sprinklers | 9073 ms (8415–11859) | 8585 ms (8089–8655) | −488 ms | −418 ms | 6047 → 6024 ms | splněna |

s006 hraje na obou stranách tutéž hru (shodné id verze v 5 z 6 běhů). s002 hraje na větvi jinou hru: útěk s počtem z T4 místo čtyř vln.

**CPU profil** (CDP `Profiler`, `D:/caches/p63/profile-start.mjs`):
- Okno: od odeslání věty do prvního snímku plátna hry + 4 s.
- Pixel 7, CPU 4×, A/B prokládaně, 3 běhy na stranu.
- Profily: `D:/caches/p63/t4-prof-raw4/`, souhrn `t4-prof4.json`.

| | s002 A | s002 B | s006 A | s006 B |
|---|---|---|---|---|
| první snímek hry (medián) | 5518 ms | 5266 ms | 5883 ms | 6021 ms |
| vzorky CPU v okně (medián) | 11 529 ms | 11 141 ms | 12 042 ms | 11 975 ms |

Nejdražší položky, průměr vlastního času na jeden start (s002 A / B; s006 A / B). Chunky mají v každém buildu jiný hash, položky jsou spárované podle shodného kódu:
1. `(program)` – práce prohlížeče a GPU mimo JS: 2675 / 2619; 2194 / 2283 ms.
2. `getProgramInfoLog` – three.js čeká na slinkování shaderu při prvním použití programu (`getUniforms` z `renderBufferDirect`): 1874 / 1797; 1865 / 1730 ms. Rozložené od 3,5 do 10 s; asi 0,6 s z toho přijde až po prvním snímku, když se objeví další materiály.
3. three.js jádro (`updateMatrixWorld`, `fromBufferAttribute`, `setXYZ`): 1650 / 1598; 2150 / 2127 ms.
4. Renderer three.js: 1396 / 1435; 900 / 1504 ms.
5. Křivka trati běžce `sumOf` (`src/components/play/arcade/runner/path.ts:74`), jen s006: 250 / 144 ms.
6. Rapier wasm ~115 ms, `fetch` ~100 ms, start zvuku (`AudioContext`) ~70 ms – na obou stranách stejně.

**Verdikt:**
- s006 bránu splňuje.
- s002 ji v prvním kole o 99 ms nesplnil. Druhé kolo dalo −5 ms, všech šest dvojic +147 ms.
- Profil nenašel na větvi žádnou práci navíc: tytéž nejdražší položky, méně CPU a první snímek o 0,25 s dřív.
- Rozdíl s002 leží až po prvním snímku, v sondě „plocha dvakrát odpoví na vstup“. Na CPU 4× trvá jeden pokus 0,6–1 s, takže je to v rozptylu jednoho pokusu. Navíc s002 hraje na větvi jinou hru (útěk s počtem).
- Mimo soubory P62 tedy start nemá co opravit. Nic se neměnilo.

**Nálezy pro P62 (scéna, soubory P62):**
- **Shadery při prvním použití** stojí ~1,8 s na start na `main` i větvi, ~0,6 s z toho po prvním snímku. Materiály, které se objeví později (pronásledovatelé dalších vln, boss, věci, modely), nejsou předehřáté. `compileAsync` ve `feed/StageHost.tsx` je nezachytí.
- **Návrh:** předehřát všechny materiály scény před prvním snímkem (i předlohy, které přijdou později), nebo sloučit materiály se stejným programem.
- **Odhad (inference):** až ~0,6 s z úseku „první snímek → hratelná“ na Pixel 7.

**Návrh mimo P62, neprovedeno:** `sumOf` v `runner/path.ts` počítá sinusy při každém dotazu na trať, na startu běžce to je 0,14–0,25 s. Tabulka po metrech by to stáhla na zlomek. Nejde o regresi proti `main`, proto se pro bránu neměnilo.
