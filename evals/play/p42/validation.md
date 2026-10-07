# P42 — implementace a stav přejímky

Implementace je na větvi `features/p42-composable-pieces`. **P42 není dokončené:** poslední nezávislá sada nesplnila pět ze šesti automatických limitů. Zelené regresní testy ani potvrzené lidské zahrání čtyř scénářů tento výsledek nenahrazují.

## Pokračování po round4 — rozpracovaná přejímka

Obecné opravy určování hrdiny, infinitivních předmětů, lokativních frází, padajících hrozeb a zájmen závodníků prošly **453/453 intent/draft testy**. Skladatel zachovává hlavní jméno prostředí a zákaz sbírání nevynucuje sběratelský režim. Fyzický kop má svědka založeného na skutečném vypuštění, pohybu a skórování míče; basketbal ani golf tento důkaz nedostanou.

Profil odhalil opakované hledání vazeb a alokace v každém tiku svědeckého pozorování. Indexování vazeb a přesun statických výpočtů zachovaly **6/6 kompletních verdiktů podle SHA**, včetně vstupů, svědků, replay hashů a způsobilosti k publikaci. **39/39 cílených regresí PASS**. Lokální časy se zlepšily, ale nejsou závěrečným latency důkazem; metodika a omezení jsou v [profilu](profile-verify-notes.md).

Otevřený diagnostický běh nad původními štítky round4: 64/64 publikovatelných her, 52/64 zachovaných vět, 64/64 hrdinů, 63/64 prostředí, osm tichých trojic. Všech osm je konflikt `fly`/`flap`: P41 a všechny první tři P42 sady konzistentně označují `fly`/`flying`/`flight` jako `glide`, round4 je označilo jako `flap`. Produkční kontrakt, historické testy ani skórování se kvůli tomu nepřepisovaly. Původní round4 výsledek FAIL zůstává zachovaný. Po diagnostice byly opraveny ještě `snowy mountain`, falešný aktér `dodge` a soupeř `it`; těchto šest regresních případů je součástí uvedených 453 testů.

Poslední produkční build včetně typů prošel, browserové ověření je rozšířené na **16/16 PASS** (3,1 minuty). Nezávislý autor připravil novou sadu round5 podle původního významového kontraktu, uzavřenou SHA256 `521dd6a7a910867f3b7b88e37d729d806035628edb08e7e158056e790134aa24`; obsah sady zatím implementace ani hlavní agent neotevřeli. Úspěšná přejímka se dosud netvrdí.

## Poslední dokončené nezávislé měření (round5)

Jednorázový nepřerušený běh dokončil všech 320 pozorování s neměnnými checkpointy: **50/64 vět (78,125 %), 55 tichých trojic, hrdina 92,1875 %, prostředí 98,4375 %, p95 1243,93 ms, golden 20/20 PASS**. Všechny hry jsou publikovatelné. Nesplněné zůstávají zachování celé věty a nulové ticho. [Úplný výsledek](round5/final.json), [souhrn](round5/final.md).

Další práce pokračuje na nyní otevřených datech: meta/causative úvody `Give me…`, `Keep…`, `Make…`, `Let…`, pseudo-cleft slovosled, obecné rozpoznání neznámých finitních sloves, plurál `-oes` a hranice příslovcí. Samostatně se prověřuje fyzická identita pojmenované munice, aby důkaz střelby rozlišoval vystřelený projektil od zasaženého cíle. Původní report a štítky se nemění.

Po třech regresích nalezených v celé compose sadě (856/859) prošly jejich opravy **39/39 cílenými integračními testy**, **340/340 cílenými parser testy**, novým buildem a **5/5 browserovými testy** nad posledním buildem (čtyři oracle + machine gun). Předchozí běh browserové sady byl 16/16 PASS. Úspěch celého P42 se nadále netvrdí.

## Historické měření round4

| Kritérium | Výsledek | Limit |
|---|---:|---:|
| Celá věta na všech pěti semenech | 39/64 — 60,94 % | ≥80 % |
| Tichá vynechání | 140 | 0 |
| Prostředí | 280/320 — 87,5 % | ≥90 % |
| Hrdina | 280/320 — 87,5 % | ≥90 % |
| Latence p95 | 3313,83 ms | ≤2000 ms |
| Publikovatelné hry | 320/320 | — |
| Golden replay | 20/20 PASS | PASS |

Podrobnosti, výsledné hry, svědci, přiznání a otisky jsou v [round4/final-resumed.json](round4/final-resumed.json), souhrn v [round4/final-resumed.md](round4/final-resumed.md). Návratový kód 1 odpovídá nesplněným limitům.

Sadu vytvořil samostatný agent bez přístupu k předchozím větám, výsledkům a implementaci. Před spuštěním byla uzavřena SHA256 `2694b9c0355a00db18cd7300e8b1e06cef3d8ad5be31c0ce0503f6b39b827bd9`; mechanicky ověřen nulový průnik s dosavadními sadami. Skórování ani limity nebyly mezi iteracemi zmírněny. Po otevření round4 se produkční kód neměnil.

Původní běh přerušila chyba `UNKNOWN` při zápisu po 187 uložených pozorováních. Příčina I/O chyby není prokázaná; report během tohoto běhu nebyl čten. [Původní final.json](round4/final.json) zůstal zachovaný. Recovery ověřilo původní fingerprint kódu, sadu a přesný prefix 187 výsledků včetně časů; dopočítalo pouze zbytek a ukládalo jednotlivé neměnné checkpointy. Případný neuložený pokus o pozorování 188 není znám. Jde o obnovené měření, nikoli nepřerušený jednorázový běh; restart omezuje srovnatelnost latence. Naměřený p95 přesto zůstává FAIL bez korekcí.

## Konkrétní zbývající mezery

- Hrdina ve volných formulacích: `Make a game about a goat…`, `Let an otter swim…`, `Put me behind the wheel of a van…` nebo `…with a horse trying to outrun zebras` vede k výchozím či nesprávným rolím. Chyba následně ovlivní také porovnání akcí.
- Pohyb a parafráze: explicitní let je realizovaný jako `glide`, zatímco nová sada očekává `flap`; toto není přiznané. Nerozpoznávají se některé formulace volného pohybu, sběru a pronásledování. Výsledky ani štítky nebyly dodatečně přepsány.
- Vedlejší aktéři a cíle: `apples fall`, `planes race it to the finish` a `then runs to the gate` nemají všechny očekávané trojice realizované nebo přesně přiznané.
- Prostředí: například station/hangar končí jako meadow, warehouse jako factory a cliff jako mountain; některá rozšířená pojmenování také nesouhlasí s očekávaným prostředím.
- Nepodporované akce: přiznání existuje, ale předmět je chybný — `knits scarves inside…` přiznává `knit inside`, `repairs clocks` přiznává `repair` bez předmětu. Podle nezměněného protokolu tedy nejde o přesné přiznání očekávané trojice.
- Latence překročila limit. Není doloženo, jakou část tvoří zatížení prostředí a jakou implementace; bez důkazu se výsledek neomlouvá zatížením.

Další konkrétní práce je sjednotit určování aktéra, pohybu a předmětu napříč rozborem a veřejným přiznáním, zachovat jména prostředí mimo známý slovník a profilovat ověřování složených her. Round4 je po otevření vývojová sada a nesmí se znovu vydávat za nový held-out důkaz.

## Zachovaná historie měření

| Sada | Celé věty | Ticho | Prostředí | Hrdina | p95 ms | Golden |
|---|---:|---:|---:|---:|---:|---|
| [První](final.md) | 55/64 | 20 | 93,33 % | 100 % | 896,97 | PASS |
| [Round2](round2/final-resumed.md) | 51/64 | 20 | 80 % | 97,83 % | 1562,38 | PASS |
| [Round3](round3/final.md) | 55/64 | 20 | 91,67 % | 95,56 % | 1818,70 | PASS |
| [Round4](round4/final-resumed.md) | 39/64 | 140 | 87,5 % | 87,5 % | 3313,83 | PASS |
| [Round5](round5/final.md) | 50/64 | 55 | 98,44 % | 92,19 % | 1243,93 | PASS |

Po každém otevření výsledků přešla daná sada mezi vývojová data; další sada byla vytvořena a uzavřena před spuštěním. Původní výsledky se nepřepisovaly. Round2 také vyžadovalo provozní pokračování po chybě zápisu se zachováním 47 původních pozorování. Výsledky různých sad nejsou měřením časového trendu na stejné distribuci.

## Implementace a ověření

Rychlá větev skládá pohyb a samostatné díly catch/rival/hazard/chaser/fight/duel/deliver/interact, včetně následné fáze útěku. Přibyli skuteční závodní soupeři, míčový tým s fyzickou střelbou, jmenované hrozby a botové/svědecké ověření dílů. Nehratelné kombinace se redukují s přiznáním rozpoznaných chybějících akcí. Další iterace opravily koordinované akce, argumenty střelby a soubojů, část prostředí, partitivní předměty a plurály vozidel. Výše uvedené mezery rozboru však zůstávají.

- Aktuální intent/draft: **408/408 PASS**.
- Aktuální integrační kontroly: **30/30 PASS**, včetně 16 scénářů veřejných přiznání na pěti semenech, osmi prostředí, dvou kombinací akcí a čtyř oracle scénářů. Artefakt: `round4-integration.json`.
- Kompletní compose sada před posledními opravami lexikonu: **842/842 PASS**; po těchto opravách proběhly výše uvedené cílené integrační testy.
- Runtime matice dílů: **110/110 PASS** po opravách walker rival a glide delivery/interact. Historický `regression-final.json` zachovává původní výsledek 1300/1303 před těmito opravami.
- UI input/render: 31 cílených testů PASS. Samurajův skutečný souboj a následný útěk trvá na pěti semenech 30–90 sekund.
- Poslední produkční webpack build včetně typové kontroly: **PASS**.
- Browserové `e2e/play-p42.spec.ts` nad posledním `next start`: **12/12 PASS** (3,2 minuty). Čtyři oracle scénáře ověřují formulář, render, botové dohrání a přesný browserový replay; osm dalších veřejná přiznání.
- Závěrečný golden replay: **20/20 PASS**. `git diff --check`: PASS.

## Lidská přejímka

Uživatel 7. 10. 2026 potvrdil „je to ok“ po předání těchto scénářů pro zahrání na `http://localhost:3000/play`:

1. `a monster truck racing other trucks and firing missiles`
2. `a seal swimming under the ice, catching fish and avoiding orcas`
3. `a goat jumping up a mountain while rocks fall`
4. `a samurai duels a bear and then escapes the burning village`

Produkční server s posledním buildem zůstává na portu 3000. Potvrzení lidské přejímky nemění nesplněné automatické limity. Žádná placená API, nové modely, commit ani publikace nebyly provedeny. Nesouvisející soubor `[k` zůstal zachován.
