# P71D T6 – věta dá správnou hru, oracle v prohlížeči

**5. 11. 2026**, build `4e86d216` (`next build --webpack` + `next start -p 3013`, bez režiséra), Chromium přes Playwright,
telefon 390×844 (dpr 2, dotyk), GPU d3d11. Skript `oracle.mjs`, data `results.json`, snímky `<id>-start.png`
(úvodní karta) a `<id>-end.png` (po zahrání robota rukou).

**Výsledek: 12/12.** Žánr i hrdina odpovídají větě, robot vyhraje, nečinný hráč prohraje nejdřív po 5 s,
žádná hláška „… isn't here yet“.

| id | věta | žánr | hrdina (model) | robot | nečinný |
|---|---|---|---|---|---|
| qa-shooter | a spaceship shoots asteroids in outer space | shooter | spaceship (rocket) | výhra 50,5 s | prohra 23,8 s |
| qa-throw | toss basketballs into the hoop | throw | kid (rigged:boy-a) | výhra 43,6 s | prohra 87,0 s (čas vypršel) |
| qa-whack | whack the moles in the garden | whack | farmer (gen3d-farmer) | výhra 34,9 s | prohra 8,6 s |
| qa-quest | a wizard explores a dungeon to find the lost crown | quest.spatial | wizard (rigged:mage) | výhra 2,1 s | prohra 10,4 s |
| qa-catch | catch falling donuts and dodge the bombs | catch | baker (rigged:q-chef-hat) | výhra 36,4 s | prohra 10,3 s |
| qa-merge | merge matching fruits in a jar | merge | farmer (gen3d-farmer) | výhra 56,3 s | prohra 17,8 s |
| qa-buildshift | run a pizza shop and serve 12 customers | buildshift | chef (rigged:q-chef) | výhra 39,7 s | prohra 36,1 s |
| p-shooter | a rocket blasts meteors | shooter | rocket (rocket) | výhra 50,1 s | prohra 23,8 s |
| p-whack | hit moles with a hammer | whack | farmer (gen3d-farmer) | výhra 34,8 s | prohra 8,3 s |
| p-quest | a knight looks for the lost sword in the castle | quest.spatial | knight (rigged:knight) | výhra 1,7 s | prohra 10,2 s |
| p-catch | catch the falling apples in a basket | catch | farmer (gen3d-farmer) | výhra 36,9 s | prohra 10,6 s |
| p-buildshift | a chef runs a pizza shop | buildshift | chef (rigged:q-chef) | výhra 40,4 s | prohra 34,9 s |

Robot = `__playShell.playWitness()` (záznam ověřovače se všemi vstupy, jako `e2e/play-shooter.spec.ts`).
`handPlay('end')` posílá jen osu a tlačítka, bez míření – u obou střílaček proto prohraje (55,9 s, 53,0 s)
a jejich `-end.png` ukazuje prohru. U ostatních deseti vyjde stejně jako `playWitness`.

## Opraveno během T6

První běh ukázal správnou hru se lživým pruhem nahoře:

- střílečky: „Gliding isn't here yet – here's a shooting game.“ – let domyšlený jen ze jména lodi (`9bbef9d3`);
- hledání: „Collecting isn't here yet – here's a quest.“ – „find“ čtené jako sběr, úkol věc najde použitím (`9bbef9d3`);
- pizzerie: „Running and delivery aren't here yet – here's a shop building game.“ – „run a shop“ je provozovat (`4e86d216`).

## Neopraveno – mimo soubory, které P71D smí měnit

- **Úkol „najdi jednu věc“ trvá robotovi 1,7–2,1 s.** Jediný cíl padne do obecného prstence cílů
  (`QUEST.targetRing`, `src/play/arcade/pieces/quest.ts`) blízko startu. Hratelné, ale krátké.
- **Koncová obrazovka píše „All 1 crowns in 2.1s.“** (`src/components/play/PostRun.tsx:164`) – chybí jednotné číslo.
- „a chef runs a pizza shop“ obsluhuje roboty („Serve 12 robots their pizza!“) – výchozí zákazník z P68
  (`BUILDSHIFT_DEFAULTS`), věta zákazníky nejmenuje; ponecháno.
- Toast „Couldn't make the full-detail version right now“ je lokální server bez režiséra, ne chyba hry.
