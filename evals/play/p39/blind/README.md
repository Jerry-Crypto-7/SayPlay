# P39 T14 – slepý soud: hra před P39 proti hře po P39

## Výsledek

**Nové vyhrává 3 z 12, remíza 9, staré vyhrává 0.** Podmínka plánu (nové vyhrává aspoň 7 z 12) **splněná není**.
Nová verze neprohrála ani jednou. Skoro všechny remízy jsou ale hry, které P39 vůbec nezměnil, a ze tří výher
je jen jedna opravdu zásluha P39 (rozbor níž).

## Co se soudilo

- **Před** = build `88245889` (main před P39) ve vlastním worktree, **po** = HEAD `1d39daaf` (kód včetně `911f6f25`).
  Každá strana běžela na vlastním `next start` se živým režisérem přes předplatné (`codex-cli`, 0 USD).
- Pro každou větu poslal skript stejnou větu na oba servery a vzal hru, kterou server vydal: AI verzi, když přišla,
  jinak rychlou. Na obou stranách to bylo 8× AI verze a 4× rychlá (u d10, d12, s006 a drones vrátila AI rychlou verzi beze změny, `UNCHANGED`).
- Dvanáct vět je v `verdict.json` (`verdicts[].sentence`, `covers` říká, které kritérium plánu věta plní):
  7 žánrů (plošinovka, běžec, střílečka, házení, aréna, plavba, souboj), dvě věty se třemi rolemi (mansion, squirrel),
  vlk, kterého knihovna nemá a kreslí ho jako psa (wolf), „shoot X“ v plošinovce (zombies) i v běžci (drones)
  a spouštěcí věta „jumping and shooting game in the forest against animals“ (trigger). Sedm vět je z dev sady
  (`evals/play/p30/dev.json`), pět vlastních.

## Jak se soudilo

- Snímky pořizoval Playwright a zachycují jen plátno, text stránky (název, věta, HUD, úvodní karta) je skrytý. Ke každé hře
  jsou dva snímky: první snímek po načtení a snímek po 3 s hry (180 tiků robota „Show me how“ na ručních hodinách).
- List 2×2: hra A vlevo, hra B vpravo, nahoře první snímek, dole po 3 s. Na listu jsou jen písmena A a B.
  Kdo je vlevo, losoval `pure-rand` (`xoroshiro128plus`, seed **39014**, `uniformInt(0, 1)` po dvojicích v pořadí vět).
  Vyšlo to 6× nové vlevo a 6× staré vlevo.
- Soudce je Codex přes předplatné: `codex exec -i sheet.png --output-schema` v prázdném adresáři z `mkdtemp`, takže
  z cesty ani jména souboru stranu nepozná. Otázka je v `verdict.json` (`judge.question`) a odpověď je
  `{winner: A|B|tie, why}`. Skript odpověď převede na stranu (`winnerSide`).

## Dvanáct verdiktů

| věta | žánr | stejná hra? | verdikt |
|---|---|---|---|
| trigger – jumping and shooting game in the forest against animals | plošinovka | ne | **nové** |
| zombies – jump and shoot zombies in a graveyard | plošinovka | ne | remíza |
| drones – run and shoot drones on a highway | běžec | ne | **nové** (omyl soudce) |
| mansion – collect coins, dodge ghosts and shoot bats in a haunted mansion | střílečka | ne | remíza |
| squirrel – a squirrel grabs acorns, dodges owls and throws pinecones at a fox | házení | ne | **nové** (náhoda) |
| wolf – a rabbit runs from a hungry wolf in a snowy forest | aréna | ano | remíza |
| s037 – A space marine shoots alien bugs in a mining colony | střílečka | ano | remíza |
| d12 – a goldfish swims through a sunken city dodging sharks | plavba | ano | remíza |
| d10 – a pirate duels a skeleton captain on a sinking ship | souboj | ano | remíza |
| s006 – A corgi runs through a park grabbing sausages and jumping over sprinklers | běžec | ano | remíza |
| s002 – A knight must collect three keys in a haunted castle while dodging ghosts. | aréna | ano | remíza |
| s003 – A hamster escaping a supermarket while a giant Roomba hunts me | aréna | ano | remíza |

„Stejná hra“ = výsledná GameSpec je na obou stranách totožná (`sameSpec`). Role obou stran jsou ve `verdict.json` (`before.roles`, `after.roles`).

## Rozbor nevyhraných dvojic

**Fakta:**

- **Sedm z dvanácti dvojic je táž hra** (wolf, s037, d12, d10, s006, s002, s003). Spec je na obou stranách stejná
  a snímky se liší jen načasováním. Remíza je u nich správná odpověď a soudce u všech sedmi napsal, že scény jsou
  „essentially identical“. Tyhle věty zvládal už starý stav. Vlk se kreslil jako pes už před P39.
- **Pět dvojic se liší:** 3 výhry nového, 2 remízy, 0 proher.
  - **trigger – skutečná výhra P39.** Před: nepřítel vpravo je robot. Po: je to zvíře (`hazard:animal`). Soudce: „A shows
    an animal opponent … B shows a blocky robot“.
  - **zombies – remíza, ve hře je P39 lepší.** Před jsou nepřátelé `ghost` a na okraji záběru stojí robot. Po je to `zombie`.
    Nepřítel je ale na prvním snímku jen na pravém okraji a po 3 s je mimo záběr. Soudce: „partially visible enemy at
    the right edge … neither makes the zombie targets clearer“.
  - **drones – výhra je omyl soudce.** Drony nemá ani jedna strana. Rychlá verze po čte z věty místo dronů auta
    (obsazení `car: shoot_at`); „on a highway“ přebije pojmenovaného nepřítele, s „in a city“ vyjde `drone`.
    Soudce vzal za drony vzdálené červené kvádry o pár pixelech.
  - **squirrel – výhra je náhoda načasování.** Snímky jsou skoro stejné, jen po má zrovna ve vzduchu žalud. Spec po
    je chudší: AI verze po vypustila sovy i žaludy ke sběru (`hazard:owl` a `collectible:acorn` měla AI verze před).
    Nekreslily se ale ani před. Rychlá verze po navíc čte šišku jako věc ke sběru (`pinecone: collect`), ačkoli se šiškami hází.
  - **mansion – remíza, tři role nesplnila ani jedna strana.** Obraz je na obou stranách stejný: jen netopýři a terče,
    žádné mince ani duchové, a místo sídla je hrad na louce. Rychlá verze po přečte všechny tři role (`bat: shoot_at`,
    `coin: collect`, `ghost: avoid`), ale střílečka mince i duchy zahodí. AI verze před měla ve spec aspoň `hazard:ghost`.

**Odvozeno (inference):**

- Výběr dvanácti vět podle kritérií plánu (6 žánrů, dev sada) obsahuje hodně vět, které P39 vůbec nemění. Skóre
  7 z 12 by vyžadovalo, aby P39 viditelně zlepšil aspoň 7 vět, ale změnil jich jen 5. U vět, které změnil, nová verze
  neprohrála, ale jasně a zaslouženě vyhrála jen jednou (trigger).
- Co P39 slibuje u vět se třemi rolemi, střílečka a házení neplní: role ke sběru a k vyhýbání se zahodí. Plán přitom
  rozhodl „nepodporovanou roli převést na nejbližší podporovanou, nikdy nezahodit“.
- Snímek po 3 s hry robota neukáže cíle střelby v plošinovce ani v běžci, protože kamera je drží na okraji nebo mimo
  záběr. U „shoot X“ by soudce potřeboval snímek ve chvíli, kdy je cíl v záběru.

## Kandidáti na opravu (rozhodne zadání, kód produktu se tu neměnil)

1. Střílečka a házení: role `collect` a `avoid` z obsazení přidat do hry, ne zahodit (mansion, squirrel).
2. Čtení obsazení: výchozí nepřítel z prostředí („highway“ → auto) nesmí přebít pojmenovaného (drones).
3. Házení: věc za „throws … at“ je náboj, ne věc ke sběru (squirrel).
4. Pro opakovaný soud vybrat věty, které P39 opravdu mění, a fotit ve chvíli, kdy je cíl střelby v záběru.

## Jak soud zopakovat

```
# před: worktree s buildem 88245889 (node_modules je junction), po: npm run build v repu
# oba servery: next start + proměnné živého režiséra přes předplatné z .claude/start-demo.cmd,
#   PLAY_DIRECTOR_CALLS_PER_CALLER=1000, WORLDSMITH_CALL_CAP=1000
node node_modules/next/dist/bin/next start -p 3150     # cwd = worktree „před“
node node_modules/next/dist/bin/next start -p 3151     # cwd = repo „po“
node scripts/play-p39-blind.mjs play --before http://127.0.0.1:3150 --after http://127.0.0.1:3151 --run <id> --gpu
node scripts/play-p39-blind.mjs judge --run <id> [--seed 39014]
```

Hra jde po dvou voláních režiséra najednou (víc předplatné neunese), celý běh trvá ~10 min, soud ~2 min.
Snímky, listy a odpovědi soudce jsou v `evals/play/fidelity/runs/<id>/` (gitignorované, nikdy ne v trénovacích datech).
Hotová strana ani hotová odpověď se při dalším běhu neopakuje.
