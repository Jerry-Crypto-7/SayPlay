# P46F – noční seznam podle dopadu na hru

Pořadí, v jakém smyčka `D:/caches/p46f/loop.mjs` jména generuje. Strojová podoba: `round-nouns.json` (pole `order`, `group`, `sentences`), synonyma pro slepého soudce: `aliases.json`, znak každého jména: `ops/gen3d/features.toml` (oddíly „P46F“). Sestavil `D:/caches/p46f/build-t3.mjs`.

## Co rozhodlo, která jména na seznam smí

- **Jméno ani synonymum nesmí nést slovo třídy** z `scripts/assets/p32-manifest.mjs` (helicopter, spider, crab, robot, wizard, ninja, jet, fly, shark…). Takové jméno zapíše model do manifestu `src/play` a test `src/play/assets/__tests__/catalog-entries.test.ts` (pevný počet 261) zčervená. `src/play` patří P46A/B/D, takže by se model musel vyřadit. Skript to kontroluje generátorem manifestu nad celým seznamem: 0 zásahů. Jediné vyřazené synonymum: „ninja star“ u shuriken.
- **Boss, nepřítel a pronásledovatel model dostanou i bez manifestu.** `enemyModel` / `chaserModel` (`src/play/arcade/models.ts`) hledají podle štítku katalogu (`tagModel`, `models.ts:157`) a boss je model pronásledovatele zvětšený 9/4 (`pieces/behaviours/boss.ts:38`). Nový golem nebo blimp se tak ve hře objeví, když ho věta jmenuje. T5 to ověří na 5 povýšených bossech.
- **Jméno, které katalog už má** (štítek, id nebo synonymum z `evals/play/p37d/aliases.json`), na seznam nesmí. Výjimka jsou jména známá jen ze slepého soudu (`seen:`): treasure chest, gold bar a katana. Štítek `seen:` jen říká, že soudce jméno viděl na jiném modelu, a vlastní model je lepší.
- **Zdroj vět** pro pořadí uvnitř skupiny: korpus poptávky `evals/play/demand/corpus.json`, vývojová sada `evals/play/p37a/dev-150.json` a panel P45 bez řádků ze zapečetěné P30. `evals/play/p45d/missing.json` je vyčerpaný (zbyla v něm slovesa a šum), a protože věty bosse a zbraně jmenují zřídka, má číslo vět jen 10 jmen. Ostatní pořadí je ruční: nejdřív jména, která hráč napíše nejspíš.

## Pořadí skupin

Skupiny jednoho stupně se střídají po jednom jménu, takže už první kola mají bosse všech žánrů a první kola akcí všechny druhy věcí. Neprošlé jméno dostane jedno opakování s novými semínky (`a2,b2,a3`). Smyčka ho zařadí, jakmile se nasbírá 10 takových jmen.

| stupeň | skupina | jmen | proč |
|---|---|---|---|
| 1 | boss běžce – pronásledovatel, který útočí | 27 | P46B: běžec potřebuje velkého pronásledovatele, katalog má jen pár (stone golem, ogre, yeti, minotaur) |
| 1 | boss řízení – stroj nebo tvor nad tratí | 12 | P46B: vrtulník je slovo třídy, takže jiný stroj nad tratí (blimp, vzducholoď, vírník, bouřkový mrak) |
| 1 | boss skákačky – šéf na konci | 29 | P46B/P46E: finále potřebuje hrozivé tvory, katalog má draka, krakena, minotaura |
| 1 | boss-stroj, který brání trať | 12 | věž s dělem, laserová věž, Teslova cívka – boss, který stojí a střílí |
| 2 | zbraň nebo střela (shoot, strike) | 33 | P46A: akce hrdiny potřebují vidět, čím hrdina útočí |
| 2 | štít | 5 | P46A/P46C: štít jako akce i power-up |
| 2 | power-up (rychlost, skok, štít, 2×) | 19 | P46C: magnet, srdce a lektvar katalog má, chybí rychlost, skok a štěstí |
| 2 | kořist ke krádeži, poklady | 29 | P46A grab: věc, kterou hrdina sebere nebo ukradne |
| 3 | nepřítel, kterého věty jmenují | 25 | menší nepřátelé bez slova třídy |
| 3 | překážka nebo past | 28 | běžec a skákačka: překážky, které katalog nemá |
| 4 | drobný tvor | 13 | výplň na konec okna |
| – | chybějící hrdinové | 0 | **odloženo**: nový hrdina je vždy záznam manifestu `src/play`, a to patří P46A/B |

## Skupiny v pořadí (v závorce věty, které jméno chtějí)

- **boss běžce:** golem (2, opakování z P45E/F), lava golem, angry bull, t rex, ice golem, bigfoot, wild boar, locomotive, steamroller, headless horseman, grizzly, giant snowball, sabertooth, iron golem, rock giant, krampus, evil snowman, mud golem, sand golem, crystal golem, scrap golem, warthog, bison, buffalo, rattlesnake, anaconda, tarantula
- **boss řízení:** blimp, airship, gyrocopter, storm cloud, thunderbird, pterodactyl, flying carpet, harpy, roc, vulture, floating eye, hovercraft
- **boss skákačky:** frost giant (3), hydra (1), necromancer (1), sorcerer (1), kaiju, wyvern, gargoyle (opakování z P45G), grim reaper, megalodon, kraken tentacle, colossus, medusa, cerberus, lich, basilisk, manticore, chimera, leviathan, sandworm, oni, banshee, wraith, ghoul, gremlin, chupacabra, stone guardian, giant hand, venus flytrap, mimic chest
- **boss-stroj:** cannon tower, laser turret, tesla coil, sentry gun, gatling gun, trebuchet, siege tower, battleship, howitzer, chariot, combine harvester, cement mixer
- **zbraně a střely:** laser gun (1), battle axe, katana, war hammer, bazooka, shuriken, spiked club, flamethrower, freeze ray, whip, nunchaku, scimitar, harpoon, energy ball, flail, morning star, laser rifle, plasma gun, tomahawk, throwing knife, musket, flintlock pistol, water pistol, bubble gun, cream pie, magic orb, shrink ray, power glove, halberd, rapier, machete, sickle, quiver
- **štíty:** round shield, energy shield, kite shield, tower shield, riot shield
- **power-upy:** speed boots, winged shoes, stopwatch, four leaf clover, power crystal, golden apple, spring shoes, magic bean, elixir, angel wings, halo, invisibility cloak, pogo stick, hoverboard, hang glider, feather, grappling hook, spell book, rune stone
- **kořist:** treasure pile (3), cheese wheel (1), treasure chest, gold bar, ruby, golden egg, money bundle, diamond ring, emerald, sapphire, safe, chalice, loot sack, pearl necklace, tiara, vault door, golden idol (opakování z P45I), golden statue, pocket watch, spyglass, ancient scroll, music box, purse, honey pot, cookie jar, pizza slice, chocolate bar, popsicle, sundae
- **nepřátelé:** grave robber (2), lumberjack (1), bandit, hyena, panther, cockroach, jaguar, porcupine, electric eel, barracuda, praying mantis, centipede, stegosaurus, killer tomato, pumpkin head, bounty hunter, coyote, badger, moray eel, hammerhead, ankylosaurus, brontosaurus, rooster, giant slug, salamander
- **překážky:** spiked ball, swinging axe, spike trap, explosive barrel, banana peel, crusher, flame trap, tnt crate, landmine, roadblock, thorn bush, spike wall, giant gear, piston, barbed wire, electric fence, arrow trap, spike pit, quicksand, geyser, snow pile, sandbag wall, turnstile, haystack, mousetrap, beach ball, domino, totem pole
- **drobní tvorové:** possum, armadillo, iguana, gecko, toad, meerkat, lemur, platypus, ostrich, turkey, pelican, puffin, chipmunk

## Co na seznamu není a proč

- **Slovo třídy v jméně:** police helicopter, giant spider, giant crab, mech, skeleton king, evil wizard, killer robot, ghost ship, guard dog, sea serpent, water balloon, rocket boots, fire jet, fly swatter.
- **Katalog už má:** helicopter, kraken, minotaur, stone golem, dragon, ogre, yeti (proto ne abominable snowman), griffin, ufo, drone, tank, monster truck, gorilla, spider, crab, scorpion, mace, spear, trident, crossbow, bow, blaster, ray gun, cannon, fireball, grenade, boomerang, magnet, lightning bolt, star, heart, potion, battery, jetpack, hourglass, money bag, crown, coin, trophy, key, bear trap, trampoline, saw blade, wrecking ball, boulder.
- **Jméno, které dávka nepřijme:** „t-rex“ – `ops/gen3d/cache.py` bere jen písmena a mezery, proto „t rex“ se synonymy tyrannosaurus.
- **Jev nebo terén, který kreslí scéna:** laser beam, oil slick, mud pit, tar pit, whirlpool, sinkhole, pothole.

## Rozsah okna

232 jmen v prvním průchodu plus jedno opakování každého neprošlého (u P45I neprošlo 44 %, tedy asi 100 opakování). To je kolem 33 kol po 10 jménech, při 14–15 min na kolo (P45I) zhruba do 06:10. Smyčka po 06:10 novou dávku nespustí.
