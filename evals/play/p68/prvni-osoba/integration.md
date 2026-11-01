# P68 – předání k zapojení: kategorie `prvni-osoba` (P68-F)

Hra `railfps`. Sekce podle `../integration-template.md` v jejím pořadí, navíc `## VR` (jen poznámka). Značka
`p68-ready` na konci (hodnota `railfps`) platí od T6: herní aserce zelené (`pieces/__tests__/railfps-bot.test.ts`) a e2e
`play-railfps` bez `skip` zelený na `chromium`, `iphone-touch`, `pixel7-touch`. Čísla „dnes“ jsou naměřená 1. 11. 2026 nad kostrou P68-I (`classifyGenre(věta, null)`, bez čtení).

## `railfps`

- Žánr `railfps`, režim `default`; ovládání `railfps`, generátor `railfps_rail`, robot `railfps_bot`, pravidla
  `railfps_shot` a `railfps_round` (`RAILFPS_RULES`); scéna `railfps`, vstup `genre` → `genres/railfps/RailfpsTouch.tsx`.
- Vstup: jedna kvantovaná osa natočení (yaw). Krok `yawStep` −16..16 na držáku (`RAILFPS_SLOTS.yawStep`), 9 sektorů po
  15° (−4..4 = ±60°), sektor `s` = krok `4s` = osa `250 × s`; střed se posílá osou **1** (0 = žádný vstup).
  `sectorToAxis` / `axisToSector` v `src/play/arcade/pieces/railfps-world.ts`. `LEFT` / `RIGHT` posunou cíl o sektor,
  `FIRE` / ťuk vystřelí, až natočení dorazí.
- Parametry: `targets` 8–36 (výchozí 16; terče + nepřátelé + boss dohromady), `waves` 2–5 (výchozí 3; poslední končí
  bossem). Role `enemy`, `target`, `boss`; místo ze `spec.setting` → `theme.setting` → `theme.look`. 3 životy.

## Popis pro režiséra a čtečku

Střelnice z vlastních očí: hráč stojí na místě (mezi vlnami ho kolej posune dál), rozhlíží se jen do stran a ťukem
sestřeluje terče a nepřátele, kteří k němu jdou. Vyhraje, když vyčistí všechny vlny včetně bosse na konci poslední;
prohraje, když mu nepřátelé, kteří dojdou až k němu, vezmou tři životy, nebo když vyprší čas. Volit ji, když věta mluví
o pohledu z vlastních očí, o jízdě po kolejích, o střelnici nebo o tom, že hráč stojí a otáčí se za tím, co se blíží;
pro volný pohyb po světě, plížení, závod nebo uhýbání je to jiná hra. Čte parametry `targets` a `waves` a role
`enemy` (koho věta střílí), `target` (sbíraná věc nebo kulisa věty, jinak terč) a `boss` (boss režiséra, jinak velký
nepřítel téhož druhu); místo věty jde do `theme.setting`.

## Věty pro klasifikátor

**Mají skončit v `railfps`** – 20 vět z `evals/play/p68/prvni-osoba/sentences.json` (s13–s20 = dev d17–d24 z
`evals/play/p68/dev.json`). Po `draftFill` + `compile`: nepřítel věty v roli `enemy` u 20 z 20, místo v `theme.setting`
u 19 z 20 (s07: „of the old temple“ nemá předložku místa, kterou modul zná). Sloupec „Dnes“ = kam věta jde, dokud je
`railfps` v `ROUTE_PENDING`: `shooter` 12, `platformer` 4, `quest.spatial` 3, `voyage.race` 1.

| id | Věta | Nepřítel (`enemy`) | Místo (`theme.setting`) | Dnes |
|---|---|---|---|---|
| s01 | Zap alien invaders in the space station hallway | alien invader | space station hallway | quest.spatial |
| s02 | look around and shoot the zombies shambling toward you in the abandoned mall | zombie | abandoned mall | shooter |
| s03 | stand on the castle wall and fire arrows at the skeletons climbing up | skeleton | castle wall | platformer |
| s04 | blast the mutant rats swarming through the sewer tunnels | mutant rat | sewer tunnels | shooter |
| s05 | through your own eyes on a pirate ship, shoot the sea monsters rising from the waves | sea monster | pirate ship | shooter |
| s06 | stand guard in a snowy forest and shoot the wolves running out of the trees | wolf | snowy forest | shooter |
| s07 | aim at the giant spiders crawling down the walls of the old temple | giant spider | – (chybí) | shooter |
| s08 | a shooting gallery at the county fair where you hit the wooden bears before they roll past | wooden bear | county fair | shooter |
| s09 | riding a hover sled across the frozen lake, zap the ice gremlins chasing you | ice gremlin | frozen lake | quest.spatial |
| s10 | inside a sunken submarine, shoot the killer sharks before they bite through the hull | killer shark | sunken submarine | shooter |
| s11 | turn left and right in the dusty canyon and blast the scorpions crawling at you | scorpion | dusty canyon | shooter |
| s12 | ride a lava cart through the volcano and blast the fire imps jumping onto the track | fire imp | volcano | platformer |
| s13 | a first-person ride in a mine cart on rails, turning to shoot the bats that swoop at you in the dark tunnels | bat | dark tunnels | shooter |
| s14 | ride a train through the wild west and shoot the bandits on horseback before they jump aboard | bandit | wild west | platformer |
| s15 | an on-rails shooter on a river boat where you aim at crocodiles leaping out of the swamp | crocodile | swamp | platformer |
| s16 | seen through the eyes of a kid on a roller coaster, splat paint balloons at clowns popping up along the track | clown | roller coaster | quest.spatial |
| s17 | a ghost train ride through a haunted house where you zap the ghosts flying at your cart with a flashlight | ghost | haunted house | voyage.race |
| s18 | sit in a tour jeep that follows the jungle road on its own and fire at the angry monkeys throwing coconuts at you | angry monkey | jungle road | shooter |
| s19 | a first person rail shooter on a space station monorail, blasting drones before they reach you | drone | space station monorail | shooter |
| s20 | ride a log flume through a pirate cove and soak the pirates with a water cannon before they fire at your log | pirate | pirate cove | shooter |

**NESMÍ skončit v `railfps`** – stejná slovesa střelby bez pohledu z očí a bez kolejí, nebo pohled z očí bez střelby.
Prvních osm dnes jde do žánru před dvojtečkou a po zapojení tam musí zůstat:

- `shooter`: „a space shooter where your ship blasts the asteroids before they hit you“; „shoot the aliens from your
  spaceship at the bottom of the screen“; „a tank aims at the enemy tanks across the desert and fires“; „a top-down
  shooter where you blast robots in a factory“; „a cowboy shoots the bottles off the fence“.
- `survivor`: „survive endless waves of zombies while your wizard shoots on its own“; „a knight holds out against
  hordes of skeletons and picks an upgrade between waves“; „auto-fire at swarms of bats in a dark cave and survive as
  long as you can“.
- Pohled z očí, ale volný pohyb, plížení nebo závod (samotné „first-person“ nestačí): „walk through a first-person
  maze and find the golden key“ (dnes `voyage.race`); „sneak past the guards in first person and steal the diamond“
  (dnes `arena.escape`); „a first-person race through the city streets in a sports car“ (dnes `voyage.race`).

Věty starších sad, které narážky přesunou (P68-I přepíše jejich očekávání): p54c holdout h32 „first person shooter
on a space station against alien soldiers“ (distraktor, dnes `shooter`), p55 holdout h65 „Shooting gallery at the
county fair, hit the ducks sliding past with a water pistol“ (distraktor, dnes `runner`), demand s052 „shoot the
ghosts in a haunted carnival shooting gallery“ (`genre: shooter` v `evals/play/p36/depth.json`).

## Narážky

Rodiny slov pro znak žánru, každá s větou ze `sentences.json`:

- **pohled z očí** – „first-person“, „first person“: s13, s19 („a first person rail shooter on a space station monorail…“);
- **vlastníma očima** – „through my / your (own) eyes“, „through the eyes of“: s05 („through your own eyes on a pirate
  ship, shoot the sea monsters…“), s16;
- **koleje** – „on rails“, „on-rails“, „rail shooter“: s13 („…a mine cart on rails…“), s15 („an on-rails shooter on a
  river boat…“), s19;
- **střelnice** – „shooting gallery“: s08 („a shooting gallery at the county fair where you hit the wooden bears…“);
- **otáčení na místě** – „look around and shoot“, „turn left and right“, „turning to shoot“: s02 („look around and
  shoot the zombies…“), s11, s13;
- **jízda + střelba v jedné větě** – „ghost train“, „mine cart“, „roller coaster“, „log flume“, „ride a train … and
  shoot“: s17 („a ghost train ride through a haunted house where you zap the ghosts…“), s13, s16, s20, s14;
- **„zap … in the hallway“**: s01 („Zap alien invaders in the space station hallway“).

Slova o pohledu, která dnes zahazuje `src/play/intent/extract.ts` (`NOT_AN_ACTOR`, správně – nejsou postava ani věc):
`first-person`, `first`, `third-person`, `top-down`, `side-scrolling`, `twin-stick`. Dál je nic nenese, takže pohled
slyší jen klasifikátor ze surové věty. `third-person`, `top-down`, `side-scrolling` a `twin-stick` jsou pro `railfps`
záporné („a top-down shooter where you blast robots…“ zůstává `shooter`).

Kam narážky patří (fakt z kódu): `cues` modulu přidá jen +1 a `cuePattern` v `classify.ts` zahodí pomlčku
(„first-person“ → „firstperson“, ve větě se nenajde), přitom dnešní žánr těchto 20 vět má 4–8 bodů. Samotné `cues`
tak nepřesměrují žádnou z 20 vět. Potřeba je řádek `sign` ve `VERBS` (+6, vzor `survive` u `survivor`); `cues` modulu
jen jako doplněk (`'first person'`, `'on rails'`, `'rail shooter'`).

Proč nic neukradne větu staré hře (inference z měření výše): každá rodina je slovo o pohledu nebo o kolejích, ne
sloveso střelby; žádná z 8 záporných vět `shooter` / `survivor` je nemá. Tři záporné věty s pohledem z očí nestřílí,
takže znak má chtít pohled nebo koleje **spolu** se slovesem střelby ve větě. Sporná je jen „shooting gallery“ – dnes
ji drží `shooter` v `NAMES` (+2). Doporučení: brát ji pro `railfps` (střelnice, kde hráč stojí a míří, je přesně tahle hra) a přepsat očekávání
tří vět ze starších sad výše; jinak s08 zůstane `shooter`.

Jemnější krok osy než `RAILFPS_YAW_STEPS = 16` hra nepotřebuje: 9 sektorů po 15° je každý 4. krok mřížky
`RAILFPS_AXES`.

## Assety

Žádný nový soubor v `public/`. Hra kreslí jen existující modely přes `modelOf` a sadu prostředí přes `theme.look`.

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|
| `public/assets/worldstream/cc0/cc0-alien-lod1.glb` | CC0-1.0 | https://kenney.nl/assets/space-kit | nepřítel fixture (`modelOf('alien invader')`); `DISCLOSURE.md` → „## Assety“, řádek s touto cestou |
| `public/assets/worldstream/game/astronaut-lod1.glb` | vlastní | `scripts/assets/blender/game_models.py` | hrdina fixture; `DISCLOSURE.md` → „## Vlastní, ne třetí strana“ |
| `public/assets/worldstream/game/target-lod1.glb` | vlastní | `scripts/assets/blender/game_models.py` | terč (`modelOf('target')`); `DISCLOSURE.md` → „## Vlastní, ne třetí strana“ |
| nepřítel jiné věty | podle souboru | knihovna modelů (`modelOf`) | každý soubor má vlastní řádek v `DISCLOSURE.md` (`cc0/` v „## Assety“, `game/` a `gen3d*/` v „## Vlastní, ne třetí strana“); 4 z 20 vět dostanou náhradní model (rat → hamster, sea monster → goblin, wolf → dog, imp → goblin) |
| sada místa (`theme.look`) | – | `src/play/arcade/look/` | fixture → sada `space`; povrchy jsou barvy (`SURFACES`), kulisy z existujících modelů sady |

## Požadované změny sdíleného kontraktu

| Soubor | Co změnit | Proč | Test | Zjistila |
|---|---|---|---|---|
| `src/play/arcade/compile.ts` | `RAILFPS_RULES` do `HOOKED_GENRE_RULES` | `railfps_shot` bere volitelné `combo`, ale zdroj komba je jen pravidlo z `HOOKED_GENRE_RULES` (`hookedComboSources`); bez toho série zásahů nezvedne násobič | přeložená fixture má `railfps_shot.params.combo`, dva zásahy za sebou dají ×2 | T2 |
| `src/play/arcade/hooks/boss.ts` (`bossTemplateOf`) nebo `hooks/index.ts` (`completeHooks`) | předlohu bosse brát i z `railfps_shot.params.boss` (nebo pole `boss` v `HookRequest`) | `completeHooks` doplní háčkům `boss` jen z pravidla `boss_beat`; příchod bosse poslední vlny (`spawn` předlohy `RAILFPS_BODIES.boss`) proto nevydá `boss_enter` ani hlášku `boss` | běh fixture robotem: tik příchodu bosse má `boss_enter` a `callout: 'boss'` | T2 |
| `src/play/capabilities.ts` | `railfps`: `setting: true`, `roles: ['enemy', 'target', 'boss']`, `labels: ['player', 'enemy', 'target', 'boss']`, `mechanics: ['health']` (vzor `survivor`) | kostra má prázdné seznamy; modul tyto role, místo a 3 životy zapisuje | `capabilities.railfps` rovno; prompt režiséra role uvádí | T4 |
| `src/play/compose/presets.ts` | buňku `'railfps.default'` přesunout ze `STAGED_PRESETS` do `PRESETS` | aktivace v rychlé hře | buňka je živá, `STAGED_PRESETS` ji nemá | plán |
| `src/play/genre/classify.ts` | `railfps` pryč z `ROUTE_PENDING`; řádek `sign` ve `VERBS` podle „Narážky“ | dnes klasifikátor žánr nevidí; `cues` modulu na 20 vět nestačí | 20 vět ze `sentences.json` → `railfps`, 11 záporných vět zůstane | plán, T7 |
| `src/play/director/answer-schema.ts` | `railfps` pryč z `DIRECTOR_PENDING` | režisér hru dnes nenabízí | prompt režiséra má řádek `railfps` | plán |
| `src/play/spec.ts` | `railfps` pryč ze `STAGED_CONTROLS` | čtení modelem ovládání nevidí; `classify.ts` ho jmenuje spolu s `ROUTE_PENDING` a `DIRECTOR_PENDING` | `READ_CONTROLS` obsahuje `railfps` | T7 |
| `src/play/genre/railfps.ts` (soubor hry, přepíná P68-I) | `availability` → `'ready'`, `cues` podle „Narážky“ | modul drží hodnotu kostry `staged`, aktivace je úloha „zapoj railfps“ | test modulu: `availability` = `ready` | plán |
| `src/play/genre/__tests__/p68-staged.test.ts` | ř. 68–69: vyřadit `railfps` ze smyčky „a skeleton does not compile“ (nebo smyčku omezit na hry, jejichž modul je ještě kostra) | test čeká „not live“ od všech pěti her, „dokud kategorie nedodá hru“; hotový modul `railfps` se přeloží, takže od T4 test padá. Plán P68-I (1. 11.) uvádí, že blok odstraní PR P68-S; po jeho sloučení řádek odpadá | sada zelená | T4 |
| `src/components/play/arcade/genres/touch-registry.ts` (`GenreTouchProps`) | předat adaptéru i `surface` (prvek stage) | adaptér dostává jen `{ session }`, plátno hledá přes rodiče a natočení s zorným polem čte z `data-railfps-yaw` / `data-railfps-fov`; funguje, ale je křehké | `RailfpsTouch` bez hledání rodiče, e2e `play-railfps` zelený | T5 |

## Fixture spec

`e2e/fixtures/p68-railfps-spec.json` – věta „Zap alien invaders in the space station hallway“: `genre.v7`, ovládání
`railfps`, generátor `railfps_rail`, 16 věcí ve 3 vlnách (10 alien invaders, 6 terčů), 3 životy, místo „space station
hallway“. `src/play/genre/__tests__/railfps.test.ts` drží, že ji modul přeloží přesně takhle, úroveň projde
`checkRailfpsLevel` a robot ji vyhraje. E2e `e2e/play-railfps.spec.ts` (T6) ji hraje přes `POST /api/play/games`.

## VR

Jen poznámka, implementace je mimo P68-F. V brýlích je natočení otočení hlavy, simulace ale potřebuje kvantovaný
sektor v ose: yaw hlavy zaokrouhlit na sektor a poslat `sectorToAxis(s)` v `src/play/xr/input-map.ts` (`mapPad` dnes
vstup `genre` nezná), režim zapsat v `src/play/xr/modes.ts` (dnes z kostry `railfps: { mode: 'desk', pose: 'table' }`).
Do řezu VR hru nenabízet – stejná cesta jako nepodporované ovládání.

<!-- Značku níže přidat až když je hra hotová (herní aserce z `assertions.json` zelené, e2e `play-<id>` bez `skip`). -->
<!-- p68-ready: railfps -->
