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
| T6 server větve `55f1a838`: 12 dev vět, 10 placených čtení (`shots.mjs spend`; s088 a s069 nečteny, viz T6) | 0,310 |
| T6 server větve `17e8715a`: 24 zapečetěných vět, 24 placených čtení (`shots.mjs spend`, strop 0,86) | 0,747 |
| T6 čas do hratelné hry, robot, cílené testy a e2e: servery bez klíče čtečky (`PLAY_READER=off`) | 0,000 |
| **Celkem** | **3,842** |

Před zapečetěnou sadou zbývalo 0,905 USD, po ní 0,158 USD ze 4 USD. Strop serveru rezervuje před každým čtením nejhorší případ volání (znak = token, 0,09–0,12 USD), proto `--cap-usd` musí ležet aspoň ~0,12 nad očekávanou útratou, jinak poslední věty zůstanou nečtené.

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

## T6: dev po opravách T2–T4 (`after-dev.json`)

Měřeno 27. 10. večer stejně jako `main` v T1:
- větev `55f1a838`, `npm run build`, `shots.mjs serve` (astra jen pro AI verzi, režisér bez dosažitelného modelu) na portu 3163;
- `shots.mjs shoot` nad `read-set.json` [24..35], snímky `D:/caches/p63/p63-dev/`;
- `judge.mjs --judge claude` (Opus 5.5, `claude -p --safe-mode`), list desktop jen s řádky větve jako list T1 jen s řádky `main`, seed 61026, souběh 1, jeden běh, `sheet.png` v prázdném `mkdtemp`; listy `D:/caches/p63/sheets-p63-dev/`.

| Strana | `main` (T1) | P63 | P63 bez s069 |
|---|---|---|---|
| rychlá hra | 0,50 / 0,40 (11 vět) | 0,475 / 0,35 (12) | 0,50 / 0,35 (11) |
| po čtení (hra ze čtení, jinak rychlá) | 0,50 / 0,40 (11) | 0,50 / 0,375 (12) | 0,50 / 0,40 (11) |
| hra ze čtení (jen kde vznikla) | 0,425 / 0,40 (2) | 0,50 / 0,475 (2) | – |

Věrnost / hrál bych. s069 v T1 nemá platnou odpověď soudce, proto sloupec bez ní.

| Věta | Rychlá `main` → P63 | Po čtení `main` → P63 | Výtka soudce u P63 po čtení |
|---|---|---|---|
| s039 zombie shooter in a mall | 0,60 / 0,40 → 0,60 / 0,40 | = rychlá | zombie malé, hala mlhavá a prázdná |
| s037 space marine, alien bugs | 0,60 / 0,40 → 0,60 / 0,35 | = rychlá | brouci malí, scéna kalná a statická |
| s002 knight, three keys, ghosts | 0,70 / 0,45 → 0,70 / 0,45 | = rychlá (hra ze čtení uložená, neohlášená) | hrdina začíná jako modrý kvádr, rytíř nečitelný, pruh „obstacles aren't here yet“ |
| s003 hamster, supermarket, Roomba | 0,50 / 0,35 → 0,40 / 0,35 | = rychlá (hra ze čtení uložená, neohlášená) | bílá prázdnota místo supermarketu, žádná Roomba |
| s006 corgi, sausages, sprinklers | 0,25 / 0,30 → 0,30 / 0,30 | 0,40 / 0,40 → 0,60 / 0,55 (ze čtení) | corgi na cestě parkem, postřikovač s popiskem, kombo; párky a pes nečitelné |
| s008 banana temple run | 0,45 / 0,50 → 0,50 / 0,50 | = rychlá | banán jako žlutá láhev, opice nečitelná |
| s022 tiny robot, tower | 0,45 / 0,45 → 0,45 / 0,45 | 0,45 / 0,40 → 0,40 / 0,40 (ze čtení) | tytéž ostrovy jako rychlá, žádná věž ani pohyblivé plošiny |
| s021 obby, lava, spinning bars | 0,50 / 0,45 → 0,50 / 0,45 | = rychlá (hra ze čtení uložená, neohlášená) | láva ano, rotující tyče ne |
| s035 flappy underwater | 0,25 / 0,15 → 0,40 / 0,25 | = rychlá | 2 ze 3 snímků konec hry po 1,4 s |
| s050 snowballs, kids, fort | 0,45 / 0,30 → 0,50 / 0,35 | = rychlá | děti malé, koule v letu nevidět |
| s088 angry birds, cats, boxes | 0,50 / 0,35 → 0,40 / 0,25 | = rychlá | žádný prak ani věže krabic, nic neletí |
| s069 candy crush, gems, cave | – → 0,15 / 0,15 | = rychlá | žádná mřížka match-3 („swapping isn't supported“) |

- Mimo rozptyl soudce (T1 P61: nejvýš 0,10) se pohnuly jen s006 po čtení (+0,20 / +0,15) a s035 (+0,15 / +0,10). s003 a s088 −0,10 leží na hraně rozptylu.
- Hra ze čtení vznikla podle měřidla jen u řetězů s006 a s022, jako v T1. U s002, s003 a s021 ji ale server vytvořil – viz „Největší zbývající ztráta“.
- s088 a s069 se nečetly: strop 0,40 USD rezervuje před čtením nejhorší případ volání (znak = token), po deseti čteních (0,31 USD) se další nevešlo. Druhý server se stropem 0,09 nečetl nic.
- Provoz: výstup prvního serveru šel přes filtr v rouře, filtr skončil a každý zápis serveru do výstupu pak hodil EPIPE. Logování té chyby psalo do téhož výstupu – smyčka (CPU profil: zdrojové mapy chyb Next.js) zasekla server u s069. Chyba prostředí, ne produktu. s069 dofocena na druhém serveru bez roury; obě instance zastavené podle PID.

### Největší zbývající ztráta: hra ze čtení k hráči nedojde, když AI verze skončí bez hry

**Fakt:** souborové úložiště her (`data/play/store`, gitignorované) má po běhu u s002, s003 a s021 dítě `relation: 'reading'` rychlé hry:
- s002 `arena.collect`: rytíř, klíče, duch jako nebezpečí;
- s003 `arena.escape`: křeček a pronásledovatel „giant roomba“;
- s021 `platformer.default`: robot, rotující tyč a láva.

Přesně tyhle tři hry předpověděla diagnóza nad `readings.p63.astra.json` (s069 by byla čtvrtá, ale nečetla se). Měřidlo přitom dostalo `draft-final MODEL_UNAVAILABLE` bez hry ze čtení.

**Příčina** (`src/app/api/play/_upgrade.ts`, `directUpgrade`):
- Práce počká na publikaci hry ze čtení a vrátí konec režiséra bez jejího id.
- Režisér s nedostupným modelem skončí za 1–2 s po čtení, takže `job.reading` a `job.outcome` vzniknou v téže chvíli. `pending` s hrou ze čtení tak existuje jen mezi dvěma dotazy – táž mezera, kterou P58E T2 zavřel u řetězu.
- Stejně v T1 na `main`: „Rozptyl čtečky“ výš (s002, s003, s021, s069) nebyl rozptyl čtečky, ale tahle mezera.
- S živým režisérem (~57 s) přijde hra ze čtení v `pending` a klient na ni přejde. Měřidlo tedy u jedné hry měřilo něco jiného, než dostane hráč. Hráč, jehož AI verze skončí bez hry (strop, výpadek, odmítnutí), nedostal nic.

**Oprava `6d5ac168`:**
- Konec `draft-final` práce, která hru ze čtení publikovala, ji nese jako konec řetězu (`reading: { versionId }`). Hotová AI verze (`ready`) má přednost.
- Klient (`UpgradeBanner.readingMove`) přechod na konec s hrou ze čtení už uměl, mění se jen komentář.
- Test `upgrade-reading.test.ts` „an AI version that ends without a game still hands the player the reading game“: před opravou červený (dítě v úložišti, konec bez id), po opravě zelený. Druhý test: bez hry ze čtení konec nic nenese.
- Test P58D T4 v `upgrade.test.ts` (odmítnutí stropem předběhne uloženou hru ze čtení) dál chce konec, ne `pending`; nově s id uložené hry.
- `npx vitest run src/app/api/play src/components/play`: 1958 / 1959 před úpravou testu P58D T4, oba upgrade soubory potom 58 / 58. `tsc` čistý.

**Ověření bez nového čtení (0 USD):** tři uložené hry ze čtení nafocené týmž postupem jako `shots()` na serveru s vypnutou čtečkou (`D:/caches/p63/p63-dev-fix/`). Soud na listu s řádky rychlá + ze čtení (`D:/caches/p63/sheets-p63-dev-fix/`, seed 61026, Claude, jeden běh), věrnost / hrál bych:

| Věta | P63 rychlá | P63 ze čtení | Výtka soudce u hry ze čtení |
|---|---|---|---|
| s002 | 0,60 / 0,50 | 0,40 / 0,30 | „no keys ever appear, and the run fades to a grey game-over“ |
| s003 | 0,50 / 0,55 | 0,60 / 0,50 | Roomby honí křečka po dlaždicích obchodu, ale nejsou obří a cíl je přežít, ne utéct |
| s021 | 0,50 / 0,50 | 0,45 / 0,45 | táž láva, tyče pořád nejsou, v prvním snímku náhradní zelený kvádr |

- Hra ze čtení vyhrála věrností jen u s003. Odvozeno: zařazená do mediánu by „po čtení“ zůstalo 0,50 / 0,40 bez s069 (0,475 / 0,375 s ní).
- Rychlá s002 má na tomto listu 0,60 / 0,50, na listu jen s rychlou hrou 0,70 / 0,45 – tytéž snímky. Vliv sousedního řádku na listu je tedy kolem 0,10, jak zjistil už P61 T7.
- Oprava dev číslo nezvedá. Mění, co měřidlo a zapečetěná sada uvidí: u jedné hry teď soudí hru ze čtení, kterou hráč se živým režisérem dostává už dnes.

**Nález pro další kolo (neopraveno, druhé kolo se nedělá):**
- **s002:** duch hry ze čtení stojí hned u startu hrdiny. Ve snímcích životy 3 → 1 → 0 za ~4 s, konec hry dřív, než je vidět klíč; rychlá hra má duchy daleko.
- Duch je díl nebezpečí z T2 (`compose/assemble.ts`, `foeless`: pronásledovatel věty v aréně bez hrozby jde jako `hazard`). Soubor P63, ne P62.
- **Návrh:** díl nebezpečí v aréně startuje od hrdiny aspoň tak daleko jako pronásledovatelé.
- Odvozeno ze snímků, pozice v kódu neověřená. Robot hru vyhraje, nečinný hráč ne, takže publikační brána to nechytí.

## T6: zapečetěná brána

**Jak se měřilo:**
- Sada otevřená jednou 27. 10. 2026 v 18:27 UTC na větvi `17e8715a` (`holdout-opened.json`), otisk při otevření seděl.
- Větev nafocená do `D:/caches/p63/p63-holdout/` týmž `shots.mjs` jako `main` v T1 (`495bbc77`, `D:/caches/p63/main-holdout/`): `npm run build`, `shots.mjs serve` na portu 3163 (astra jen pro AI verzi, režisér bez dosažitelného modelu, strop 0,86 USD), snímky v 1, 3 a 5 s, desktop i Pixel 7, upgrade cesta při focení zablokovaná. 24 z 24 vět bez chyby, všech 24 přečtených.
- Na větu jeden list (desktop) s řádky `main` rychlá, `main` ze čtení, P63 rychlá, P63 ze čtení – co vzniklo, 2 až 4 řádky. Pořadí `pure-rand` se seedem 61026.
- Soudce Claude Opus 5.5 (`claude -p --safe-mode`), obrázek jen jako `sheet.png` v prázdném `mkdtemp`, souběh 1, jeden běh. 24 volání, všechny odpovědi platné napoprvé → `result.json`. Listy a odpovědi v `D:/caches/p63/sheets-t6b-holdout/`.

| Strana | Věrnost | Hrál bych | Vět |
|---|---|---|---|
| `main` rychlá hra | 0,29 | 0,30 | 24 |
| `main` po čtení | 0,375 | 0,35 | 24 |
| P63 rychlá hra | 0,35 | 0,34 | 24 |
| P63 po čtení | 0,40 | 0,375 | 24 |

„Po čtení“ = hra ze čtení, a když nevznikla, rychlá hra. Hra ze čtení sama (jen kde vznikla): `main` 0,375 / 0,425 (8 vět, jen řetězy), P63 0,40 / 0,40 (19 vět).

| Brána | P63 | `main` | Výsledek |
|---|---|---|---|
| G1 po čtení: medián věrnosti ≥ 0,75 | 0,40 | 0,375 | nesplněna |
| G2 po čtení: medián věrnosti ≥ `main` | 0,40 | 0,375 | splněna |
| G3 po čtení: medián „hrál bych“ ≥ 0,70 | 0,375 | 0,35 | nesplněna |
| G4 po čtení: medián „hrál bych“ ≥ `main` | 0,375 | 0,35 | splněna |
| G5 rychlá hra: medián věrnosti ≥ `main` − 0,02 | 0,35 | 0,29 | splněna |
| G6 rychlá hra: medián „hrál bych“ ≥ `main` − 0,02 | 0,34 | 0,30 | splněna |
| G7 věta → hratelná: medián větve ≤ `main` + 0,2 s (desktop i Pixel 7) | 3,04 s / 9,31 s | 2,64 s / 9,69 s | nesplněna |

Brány přepočítává `__tests__/result.test.ts` ze skóre po větách v `result.json` (G7 ze surových běhů v `timing`), prahy má z plánu. Celkový verdikt (`result.json` → `verdict`): nesplněny G1, G3 a G7. G7 je čas do hratelné hry, rozbor níž; robot / nečinný / replay taky níž.

**Co brána srovnává:**
- Na `main` hra ze čtení u jedné hry k měřidlu nikdy nedošla. Režisér bez modelu skončí hned a jeho konec nenesl id hry ze čtení; větev to opravila v `6d5ac168` (T6 dev výš).
- `main` má proto řádek ze čtení jen u 8 řetězů. P63 ho má u 19 vět: 8 řetězů a 11 jedné hry. U těch 11 vět „po čtení“ srovnává hru ze čtení P63 s rychlou hrou `main`.
- Se živým režisérem by hráč `main` hru ze čtení dostal také. Jestli by byla stejná, nevíme: T2 a T3 mění čtečku, role i publikaci.

**Rozklad podle skupin vět** (věrnost / hrál bych, mediány):
- **Řetězy (8 vět):** hra ze čtení `main` 0,375 / 0,425, P63 0,325 / 0,40. Šest z osmi má stejné skóre, p06 −0,10. Leží v rozptylu soudce (T1 P61: nejvýš 0,10).
- **Jedna hra, kde větev nově předá hru ze čtení (11 vět):** `main` rychlá 0,35 / 0,30, P63 rychlá 0,35 / 0,30, P63 ze čtení 0,40 / 0,35. Hra ze čtení byla věrnější než vlastní rychlá hra u 4 vět (p02, p07, p16, p22) a méně věrná u 6 (p03, p04, p12, p15, p17, p20). Hráč tedy častěji přejde na hru, kterou soudce vidí hůř.
- **Bez hry ze čtení (5 vět – p01, p08, p11, p13, p21):** čtení dalo tutéž hru, skóre beze změny.
- **Rychlá hra:** 20 z 24 vět má na obou stranách tutéž hru (shodné id verze). Na nich `main` 0,25 / 0,275, P63 0,30 / 0,30. Odvozeno: náskok G5 a G6 dělá rozptyl snímků a soudce, ne jiná hra. Příklad p04: tatáž hra, na `main` všechny tři snímky obrazovka prohry (0,02), na větvi kopání na branku (0,35).
- Věrnost ≥ 0,75 má po čtení 1 věta z 24 (p16), „hrál bych“ ≥ 0,70 žádná.

### Verdikt: G1 a G3 nesplněny

Hra po čtení má medián věrnosti 0,40 místo 0,75 a „hrál bych“ 0,375 místo 0,70. Proti `main` je o 0,025 lepší v obou číslech (G2, G4), což je pod rozptylem soudce. Podle sady se nic neladilo.

Po větách, věrnost / hrál bych. „(ze čtení)“ = výtka platí pro hru ze čtení, jinak pro rychlou hru.

| Věta | `main` rychlá | P63 rychlá | `main` po čtení | P63 po čtení | Hra ze čtení P63 | Výtka soudce u hry P63 po čtení |
|---|---|---|---|---|---|---|
| p01 kuchař obrací burgery | 0,25 / 0,20 | 0,27 / 0,20 | 0,25 / 0,20 | 0,27 / 0,20 | – | pult s věcmi, žádný gril, burgery ani zákazníci |
| p02 klaun žongluje s pochodněmi | 0,15 / 0,20 | 0,15 / 0,20 | 0,15 / 0,20 | 0,35 / 0,30 | `catch` | (ze čtení) chytání hořících pochodní s klaunem, ale prázdná louka místo šapitó a pochodně drobné |
| p03 plavčík tahá plavce z bouřlivého moře | 0,25 / 0,15 | 0,35 / 0,25 | 0,25 / 0,15 | 0,10 / 0,35 | `quest.spatial` | (ze čtení) plavčík sbírá hvězdy na suché písčité ploše, žádné moře, bouře ani plavci; rychlá hra moře měla |
| p04 brankář chytá penalty | 0,02 / 0,05 | 0,35 / 0,35 | 0,02 / 0,05 | 0,10 / 0,30 | `catch` | (ze čtení) chytání jablek a uhýbání bombám na prázdné louce, z věty jen štítek „Goalkeeper“ |
| p05 rybář na zamrzlém jezeře | 0,25 / 0,40 | 0,25 / 0,40 | 0,50 / 0,45 | 0,50 / 0,45 | řetěz → `arena.collect` | (ze čtení) rybář sbírá ryby na zamrzlém jezeře, bez díry v ledu a navíjení |
| p06 instalatér v zatopeném sklepě | 0,10 / 0,30 | 0,10 / 0,25 | 0,40 / 0,45 | 0,30 / 0,40 | řetěz → `quest.spatial` | (ze čtení) instalatér sbírá záplaty na otevřené louce, žádný sklep, voda ani trubky |
| p07 myč oken mrakodrapu | 0,28 / 0,22 | 0,30 / 0,25 | 0,28 / 0,22 | 0,40 / 0,40 | `quest.spatial` | (ze čtení) cíl drhnout holubí trus a hrozba, ale rovná podlaha místo oken mrakodrapu |
| p08 baristka a zamračení roboti | 0,25 / 0,15 | 0,27 / 0,17 | 0,25 / 0,15 | 0,27 / 0,17 | – | šálky na pultu a cíl nalévat, žádní roboti ani baristka |
| p09 pirát, čtyři truhly | 0,70 / 0,55 | 0,60 / 0,45 | 0,70 / 0,55 | 0,60 / 0,40 | `quest.spatial` | (ze čtení) ostrov, truhly a počítadlo 0/4; pirát začíná jako modrý náhradní kvádr, hrozba nejasná |
| p10 dvanáct balónků nad poutí | 0,15 / 0,20 | 0,25 / 0,30 | 0,30 / 0,30 | 0,30 / 0,30 | řetěz → `quest.spatial` | (ze čtení) 8 balónků na zemi místo 12 vznášejících se, žádná pouť |
| p11 myš, 5 kousků sýra | 0,45 / 0,35 | 0,45 / 0,35 | 0,45 / 0,35 | 0,45 / 0,35 | – | myš sbírá sýr (1/5), žádná spící kočka, kuchyně nečitelná |
| p12 víla, devět luceren | 0,60 / 0,45 | 0,60 / 0,47 | 0,60 / 0,45 | 0,45 / 0,35 | `quest.spatial` | (ze čtení) víla a lucerny, hrozba ale červený náhradní kvádr a pak zelená skvrna; 8 luceren místo 9 |
| p13 štěně, tři kosti | 0,45 / 0,35 | 0,45 / 0,33 | 0,45 / 0,35 | 0,45 / 0,33 | – | zahrada, kosti a 0/3; štěně nevypadá jako pes, kopání chybí |
| p14 duch, osm táborníků | 0,15 / 0,20 | 0,15 / 0,20 | 0,50 / 0,45 | 0,50 / 0,50 | řetěz → `quest.spatial` | (ze čtení) duch honí 8 cílů v noci; táborníci jako hvězdy, oheň chybí |
| p15 robot, dva satelity na oběžné dráze | 0,50 / 0,40 | 0,50 / 0,35 | 0,50 / 0,40 | 0,40 / 0,50 | `quest.spatial` | (ze čtení) robot na červené skalnaté pláni s 0/2 a nepřátelským robotem; povrch planety místo oběžné dráhy, satelity skoro nevidět |
| p16 žába, jedenáct much | 0,25 / 0,20 | 0,25 / 0,20 | 0,25 / 0,20 | 0,75 / 0,50 | `arena.collect` | (ze čtení) žába sbírá 11 much v mlze na čas; vodu rybníka nevidět, plocha prázdná |
| p17 ježek v houbové jeskyni | 0,45 / 0,30 | 0,45 / 0,30 | 0,45 / 0,30 | 0,40 / 0,35 | `arena.collect` | (ze čtení) ježek sbírá krystaly v tmavé jeskyni, svítících hub málo, pruh přiznává, že kutálení není |
| p18 ponorka v hlubinném příkopu | 0,35 / 0,30 | 0,35 / 0,35 | 0,30 / 0,40 | 0,30 / 0,40 | řetěz → `arena.collect` | (ze čtení) ponorka sbírá perly na světlém písku, žádný příkop ani ďasové |
| p19 viking ve fjordech, mořští hadi | 0,20 / 0,30 | 0,30 / 0,50 | 0,15 / 0,35 | 0,12 / 0,30 | řetěz → jízda | (ze čtení) auto na zasněžené silnici, žádná loď ani hadi; na `main` táž hra |
| p20 opice na liánách, kokosy | 0,60 / 0,65 | 0,60 / 0,60 | 0,60 / 0,65 | 0,40 / 0,40 | `platformer` | (ze čtení) opice na plovoucích blocích v džungli, žádné liány ani kokosy, skoro se nehýbe |
| p21 závodní auto v poušti | 0,60 / 0,50 | 0,62 / 0,52 | 0,60 / 0,50 | 0,62 / 0,52 | – | auto na pouštní trati, chrastavce nečitelné |
| p22 sova nosí dopisy | 0,35 / 0,30 | 0,30 / 0,25 | 0,35 / 0,30 | 0,40 / 0,35 | `quest.spatial` | (ze čtení) sova na tmavém poli, víc rekvizit a akce Use; žádná vesnice ani dopisy |
| p23 dinosaurus drtí auta | 0,30 / 0,25 | 0,40 / 0,35 | 0,55 / 0,45 | 0,55 / 0,45 | řetěz → `quest.spatial` | (ze čtení) dinosaurus na náměstí s auty jako cíli, ničení skoro nevidět |
| p24 šnek závodí s broukem | 0,55 / 0,50 | 0,60 / 0,65 | 0,35 / 0,40 | 0,35 / 0,40 | řetěz → jízda | (ze čtení) deštivá cesta a cíl „Beat the beetle“, ale auto místo šneka a žádný brouk; na `main` táž hra |

**Tři největší ztráty proti `main` po čtení:**
1. **p20 opice** (−0,20 / −0,25): hráč přejde z běžce (0,60 / 0,60, opice i padající kokos) na plošinovku ze čtení bez lián a kokosů. Pravidlo T3 (`namesNoLess`) počítá role čtení proti rolím specifikace, ne co scéna ukáže. Odvozeno: kokos jako role ve hře je, vidět není.
2. **p03 plavčík** (−0,15 věrnost, +0,20 hrál bych): rychlá hra má bouřlivé moře s majáky, hra ze čtení `quest.spatial` suchou písčitou plochu. Místo věty má hra ze čtení ve specifikaci, scéna úkolu ho ale nenakreslí. Odvozeno, kód nesledován; vzhled scény jsou soubory P62.
3. **p12 víla** (−0,15 / −0,10): hra ze čtení nese nepřítele, kterého scéna kreslí jako červený náhradní kvádr a pak zelenou skvrnu; rychlá hra měla vlka. Na obou stranách 8 luceren místo devíti.

**Příčiny podle výtek soudce, seskupené:**
1. **Hra ze čtení kreslí prázdnou plochu místo místa věty** – p02 šapitó, p03 moře, p04 stadion, p06 sklep, p15 oběžná dráha, p18 příkop, p22 vesnice: hra hraje sloveso a nese role, scéna úkolu, arény nebo chytání ale ukáže louku nebo písek. Tohle drží věrnost po čtení kolem 0,40 a je to vzhled (soubory P62).
2. **Sloveso, které hra neumí** – p01 obracet, p05 navíjet, p08 nalévat, p13 kopat, p17 kutálet, p20 houpat se: pruh „… isn't here yet“ a náhradní žánr.
3. **Auto místo hrdiny** – p19 viking, p24 šnek: hra ze čtení je jízda a kreslí auto (P62 `heroModel`, týž nález jako h14 a h18 v T1). `main` má tutéž hru.
4. **Počet nad osm se ořízne na osm** – p10 „twelve“ → 8, p12 „nine“ → 8, na `main` i větvi. Kandidáti: `src/play/draft/draft.ts:638` (`clamp(…, 2, 8)`) a `THING_MAX_COUNT = 8` (`src/play/arcade/rules/compile.ts:66`). Který z nich to dělá, neověřeno.
5. **Náhradní kvádr na startu** – p09 pirát, p12 nepřítel: známý nález P61 T7 (start modelů).

Duch u startu hrdiny (s002, T6 dev výš) jde jako T7 po bráně, tady se neopravoval.

### Robot / nečinný / replay

Všech 60 her sady, jak je P63 postavil:
- zapečetěná sada: 24 rychlých her (z toho 8 řetězů) a 19 her ze čtení, větev `17e8715a`;
- dev: 12 rychlých her (z toho 2 řetězy) a 5 her ze čtení – s006 a s022 z řetězu, s002, s003 a s021 z ověření opravy `6d5ac168`, větev `55f1a838`. s069 a s088 hru ze čtení nemají, nečetly se.

Hry vrátil server větve `d03aa1c1` nad týmž souborovým úložištěm, ve kterém vznikly (`next start`, čtečka vypnutá, 0 USD), přes `/api/play/games/<id>` jako v P61. Dvě kontroly:
- **publikační brána** (zpráva serveru u každé hry): robot vyhraje, nečinný hráč nevyhraje, dvě přehrání skončí ve stavu běhu robota; u řetězu každé kolo i celý řetěz;
- **znovu offline** v novém procesu nad publikovaným světem (`verifyArcade` / `verifyChain`, dočasný skript `t6c-robot.measure.ts` přes `vitest.measure.mts`, mimo repo v `D:/caches/p63/`), otisk běhu robota i nečinného proti zprávě serveru.

| Sada | Her | Robot vyhraje | Nečinný nevyhraje | Přehrání shodné | Otisk běhu = server |
|---|---|---|---|---|---|
| zapečetěná (24 vět) | 43 | 43 | 43 | 43 | 43 |
| dev (12 vět) | 17 | 17 | 17 | 17 | 17 |
| Celkem | 60 | 60 | 60 | 60 | 60 |

Publikační brána prošla 60/60 ve všech čtyřech bodech. Hry `main` se znovu nekontrolovaly, jen to, že větev drží robota, nečinného a replay na všech hrách sady. Počty jsou v `result.json` → `robot`.

### Čas do hratelné hry (G7) – na desktopu nesplněna mediánem, ve druhém kole splněna

**Měření** – 27. 10. večer, `scripts/measure/first-playable-ab.mjs`:
- A = `main` `495bbc77` (`D:/caches/p63/main`, port 3164), B = větev `d03aa1c1` (port 3163).
- Oba `npm run build` a `next start`, každý s prázdným `PLAY_STORE_DIR`, `PLAY_READER=off`, žádný klíč čtečky ani režiséra, 0 placených volání.
- Prvních 5 dev vět (`p30/dev.json` [0..4], tytéž jako P61 T8), 3 běhy na stranu, dvojice A+B těsně po sobě se střídavým začátkem, desktop 1280×720 i Pixel 7 s CPU 4×. Hratelná = plátno hry odpoví na dva vstupy po sobě; hratelných 60 z 60 běhů.
- Stroj byl vytížený jinými agenty (~90 procesů node), na klid se nečekalo. První pokus o měření skončil po 34 bězích bez výstupu (dva běhy telefonu na obou stranách vypršely po 120 s, telefon tehdy kolem 12 s místo 9 s); do výsledku nejde.
- Surová data: `D:/caches/p63/t6c-ttp2.json` (celé měření), `t6c-ttp3.json` (druhé kolo desktopu), běhy v `result.json` → `timing`.

| Profil | `main` medián | P63 medián | rozdíl mediánů | párový rozdíl | Brána ≤ +200 ms |
|---|---|---|---|---|---|
| desktop 1280×720 | 2635 ms | 3041 ms | +406 ms | +96 ms | nesplněna |
| Pixel 7, CPU 4× | 9687 ms | 9313 ms | −374 ms | −853 ms | splněna |
| desktop, druhé kolo hned po prvním | 2487 ms | 2469 ms | −18 ms | +98 ms | splněna |
| desktop, obě kola 6 + 6 | 2597 ms | 2751,5 ms | +154,5 ms | +97 ms | splněna |

Po větách, medián 3 běhů v ms, `main` → P63:

| Věta | Desktop | Desktop, druhé kolo | Telefon | Hra `main` → P63 |
|---|---|---|---|---|
| s039 zombie shooter in a mall | 2570 → 3172 | 2647 → 2469 | 14 615 → 9280 | tatáž střílečka (stejné id) |
| s037 space marine, alien bugs | 2137 → 2233 | 2069 → 2208 | 12 236 → 10 960 | tatáž střílečka (stejné id) |
| s002 knight, three keys, ghosts | 2635 → 2503 | 2281 → 2335 | 9356 → 8057 | `arena.escape` na obou stranách, jiná verze (počet z T4) |
| s003 hamster, Roomba | 3163 → 3401 | 2791 → 2809 | 9058 → 9313 | tentýž běžec (stejné id) |
| s006 corgi, sausages, sprinklers | 2852 → 3190 | 2743 → 3069 | 9261 → 8408 | tentýž řetěz o 5 kolech (stejné id) |

**Verdikt:**
- Na telefonu větev bránu splňuje (−0,37 s, párově −0,85 s).
- Na desktopu ji celé měření mediánem nesplnilo o 206 ms. Párový rozdíl byl +96 ms, rozptyl jedné strany ve stejné větě až 2 s (s039 B 1691–4522 ms). Druhé kolo hned potom na týchž serverech a hrách dalo −18 ms, obě kola dohromady +154,5 ms. Brána v `result.json` zůstává nesplněná podle celého měření.
- Čtyři z pěti vět hrají na obou stranách tutéž verzi hry, takže rozdíl dělá kód klienta nebo zátěž stroje, ne jiná hra.
- **Nález, neprofilováno:** s006 (řetěz) je na desktopu pomalejší v 5 ze 6 dvojic, medián +0,34 s v prvním a +0,33 s ve druhém kole, první snímek +0,52 / +0,19 s. Na telefonu je táž věta o 0,85 s rychlejší. Odvozeno: buď skutečná práce navíc při startu řetězu na desktopu, nebo zátěž – rozhodne CPU profil startu s006 na desktopu, A proti B. Podle sady se nic neladilo, kód se neměnil.
