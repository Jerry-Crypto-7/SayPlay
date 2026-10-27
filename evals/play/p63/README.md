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
| **Celkem** | **2,193** |
