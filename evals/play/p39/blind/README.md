# P39 T14 – slepý soud: hra před P39 proti hře po P39

## Výsledek

**Kolo 2: nové vyhrává 9 z 12, remíza 2, staré vyhrává 1.** Podmínka plánu (nové vyhrává aspoň 7 z 12) **je splněná**.
`verdict.json` je kolo 2. Kolo 1 (3 / 9 / 0, pod hranicí) je rozebrané níž a jeho verdikt je v commitu `416b5c5e`.

## Co se soudilo v kole 2

- **Před** = build `88245889` (main před P39) ve vlastním worktree, **po** = HEAD `0f8a2178` (s opravami po kole 1:
  `768a0047`, `1f8438bc`, `1d6ffe47`, `aba96714`, `0f8a2178`). Každá strana běžela na vlastním `next start` se živým
  režisérem přes předplatné (`codex-cli`, 0 USD).
- **Výběr vět – jediná změna pravidel proti kolu 1:** soudí se jen dvojice, kde se hra před a po liší (výsledná GameSpec
  není totožná). V kole 1 bylo 7 z 12 dvojic na obou stranách táž hra a jediná správná odpověď u nich byla remíza.
  Zásobník 20 vět (`SENTENCES` ve skriptu) jsem sestavil **před hraním** ze sondy, která pro 100 kandidátů (60 z dev sady
  `evals/play/p30/dev.json`, 40 vlastních) porovnala rychlou verzi obou stromů. Rychlá verze se lišila u 17 z nich, k tomu
  `squirrel`, kde se liší jen AI verze (munice), a `d12` + `d10` jako šestý a sedmý žánr. Skript hrál zásobník v pořadí
  a skončil, jakmile měl 12 lišících se dvojic. Soudce dostal prvních 12 z nich. Výběr nezávisí na výsledku soudu.
- **Žánry:** plošinovka (trigger, zombies, zombierun, desert), běžec (drones, dogcity, s008), střílečka (mansion,
  skeletons, alien), házení (squirrel), aréna (dino). **Plavba (d12) a souboj (d10) vyšly na obou stranách jako táž hra**,
  takže do soudu nešly: P39 je u těchto vět nemění. Šest žánrů z plánu tak pokrývá zásobník, soud jen pět.
- Tři role: mansion, squirrel, dogcity. Věc bez modelu v knihovně: dogcatcher (dogcity), „animal“ (trigger).
  „shoot X“ v plošinovce (trigger, zombies, desert) i v běžci (drones). Spouštěcí věta o lišce (trigger).
- Snímky, list 2×2 a soudce jsou stejné jako v kole 1 (viz níž), nový seed **39015** (vlevo 8× staré, 4× nové).

## Dvanáct verdiktů kola 2

| věta | žánr | verze před / po | verdikt | co soudce viděl |
|---|---|---|---|---|
| trigger – jumping and shooting game in the forest against animals | plošinovka | AI / AI | **nové** | zvíře jako nepřítel, před robot |
| drones – run and shoot drones on a highway | běžec | rychlá / rychlá | **nové** | dron s rotory, před auta |
| mansion – collect coins, dodge ghosts and shoot bats in a haunted mansion | střílečka | AI / AI | **nové** | mince místo terčů |
| squirrel – a squirrel grabs acorns, dodges owls and throws pinecones at a fox | házení | AI / AI | **nové** | hod je vidět (projektil v letu) |
| zombies – jump and shoot zombies in a graveyard | plošinovka | AI / AI | **nové** | poznatelný zombík |
| dino – a dinosaur stomps cars and dodges helicopters in a city | aréna | rychlá / AI | **nové** | auto k rozdupání, před helikoptéra |
| dogcity – a dog runs through a city chased by a dogcatcher grabbing bones | běžec | AI / AI | remíza | ani jedna strana neukáže lapiče |
| skeletons – shoot skeletons and collect potions in a dungeon | střílečka | AI / AI | **nové** | lahvičky místo terčů |
| zombierun – run from zombies and jump over cars in a city | plošinovka | AI / AI | remíza | zombíci ani auta nejsou poznat |
| desert – jump over cactus and shoot scorpions in a desert | plošinovka | AI / AI | **nové** | štír, před hranatý humanoid |
| s008 – temple run but you're a banana running from a monkey | běžec | AI / AI | **staré** | opice na cestě, po není v záběru |
| alien – an astronaut shoots aliens and collects crystals on the moon | střílečka | AI / AI | **nové** | krystaly místo terčů |

Role obou stran a doslovné zdůvodnění soudce jsou ve `verdict.json` (`before.roles`, `after.roles`, `why`).

## Rozbor kola 2

**Fakta:**

- Osm z devíti výher stojí přímo na P39: jmenovaná věc nahradila výchozí nebo cizí model (zvíře, dron, zombík, štír,
  auto) nebo terč střelnice nese věc z věty (mince, lahvičky, krystaly). Devátá (squirrel) je spíš načasování: soudce
  ocenil projektil v letu, ne to, co se hází.
- **Jediná prohra (s008) a obě remízy mají společnou příčinu: pronásledovatel není v záběru.** Před P39 hrála opice
  v běžci překážku na cestě, takže ji kamera ukázala (`hazard:monkey`). Po P39 je opice správně pronásledovatel
  (`chaser:monkey`), ale běží za kamerou a na snímku po 3 s chybí. Totéž dogcity (lapič psů) a zombierun (zombíci
  v plošinovce). Snímek s008 jsem prohlédl: vlevo (před) opice na cestě, vpravo (po) jen banán a kámen.
- mansion: AI verze po vypustila duchy (střílečka nemá roli pro „dodge“), soudce u obou stran duchy nenašel.

**Odvozeno (inference):**

- Role je po P39 ve spec správně, ale „vidět“ z cíle plánu u pronásledovatele v běžci a plošinovce neplatí – hráč neví,
  že ho něco honí. To je jiná oprava než obsazení: kamera nebo pronásledovatel musí být v záběru. Zapsáno do plánu
  jako nález.

## Kolo 1 (3 / 9 / 0) a co se po něm opravilo

Kolo 1 (`416b5c5e`, seed 39014) soudilo pevnou dvanáctku vět podle kritérií plánu: 7 z 12 dvojic byla táž hra
(wolf, s037, d12, d10, s006, s002, s003 – remíza bez informace). Z pěti lišících se dvojic vyhrálo nové 3 (trigger
zaslouženě, drones omylem soudce, squirrel náhodou načasování), 2 remízy (zombies, mansion), 0 proher.
Nálezy kola 1 a jejich opravy:

1. „on a highway“ dělalo ze střílené věci nástroj a výchozí auto přebilo jmenované drony – `768a0047`.
2. Házení házelo věc ke sběru místo náboje (žaludy místo šišek) – rychlá verze `1f8438bc`, AI verze `0f8a2178`
   (náboj, který odpověď režiséra nenapsala, doplní rychlá verze; prompt beze změny).
3. Střílečka zahazovala `collect` / `avoid` – terč střelnice nese jmenovanou věc (`1d6ffe47`) a kreslí se jejím
   modelem, ne kotoučem (`aba96714`).
4. Výběr vět: soudit jen dvojice, které se před a po liší (kolo 2).

Mimo rozsah zůstává: sovy a žaludy v házení nemají místo (žánr hraje jen náboj a cíl).

## Jak se soudí

- Snímky pořizuje Playwright a zachycují jen plátno, text stránky (název, věta, HUD, úvodní karta) je skrytý. Ke každé hře
  jsou dva snímky: první snímek po načtení a snímek po 3 s hry (180 tiků robota „Show me how“ na ručních hodinách).
- List 2×2: hra A vlevo, hra B vpravo, nahoře první snímek, dole po 3 s. Na listu jsou jen písmena A a B.
  Kdo je vlevo, losuje `pure-rand` (`xoroshiro128plus`, `uniformInt(0, 1)` po dvojicích v pořadí soudu).
- Soudce je Codex přes předplatné: `codex exec -i sheet.png --output-schema` v prázdném adresáři z `mkdtemp`, takže
  z cesty ani jména souboru stranu nepozná. Otázka je ve `verdict.json` (`judge.question`), odpověď
  `{winner: A|B|tie, why}`; skript ji převede na stranu (`winnerSide`).

## Jak soud zopakovat

```
# před: worktree s buildem 88245889 (node_modules je junction), po: npm run build v repu
# oba servery: next start + proměnné živého režiséra přes předplatné z .claude/start-demo.cmd,
#   PLAY_DIRECTOR_CALLS_PER_CALLER=1000, WORLDSMITH_CALL_CAP=1000
node node_modules/next/dist/bin/next start -p 3150     # cwd = worktree „před“
node node_modules/next/dist/bin/next start -p 3151     # cwd = repo „po“
node scripts/play-p39-blind.mjs play --before http://127.0.0.1:3150 --after http://127.0.0.1:3151 --run <id> --gpu
node scripts/play-p39-blind.mjs judge --run <id> [--seed 39015]
```

Hra jde po dvou voláních režiséra najednou (víc předplatné neunese); kolo 2 hrálo 14 vět zásobníku za ~10 min,
soud trval ~1,5 min. Snímky, listy a odpovědi soudce jsou v `evals/play/fidelity/runs/<id>/` (gitignorované, nikdy ne
v trénovacích datech). Hotová strana ani hotová odpověď se při dalším běhu neopakuje.
