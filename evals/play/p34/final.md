# P34 – finální snímky vedle referencí kitu Sayplay

Snímky: `evals/play/p34/final/` (každý stav 390×844 a 1440×900, `e2e/p34-shots.spec.ts`, `P34_SHOTS_TASK=final`), produkční build (`npm run build` + `next start`). Reference: `docs/brand/reference-screens/*@2x.png`.

Stavy: home-idea, building, create-error, game-0s, game-5s, pause, pause-goal, game-arcade, result-win, result-lose, remix-open, share-open, og-fox, og-arena (náhled odkazu 1200×630).

## Home – `01-home@2x.png` vs `home-idea-390.png`

| Bod kontrolního seznamu | Stav |
|---|---|
| Krémové pozadí, bílé plochy, obrys 2,5 px | shoda |
| Tvrdé stíny bez rozostření | shoda (bublina 7 px, Make it! 5 px) |
| Jedna rajčatová akce | shoda – jen Make it! (zvýraznění „play?“ je štítek, ne akce) |
| Nadpis s natočeným zvýrazněním | shoda |
| Bublina: popisek, Surprise me, mikrofon | shoda, navíc počítadlo 36/140 (kit ho má u limitu) |
| Karty nápadů 2×2 s náklonem | shoda |
| Tab bar | jen Make a Play (REPO-NOTES – účty nejsou); avatar „JS“ vynechán ze stejného důvodu |
| Písmo | Roboto Black místo Bricolage (REPO-NOTES) – užší a méně „baculaté“ |

**Liší se:** pod tab barem na telefonu prosvítá modrý okraj plakátu feedu. Na desktopu je vedle hrající ukázky feedu text „No games yet. Make the first one.“ – feed a ukázka si odporují (mimo P34, patří feedu).

## In-game – `02-in-game@2x.png` vs `game-0s-390.png`, `game-5s-390.png`

| Bod | Stav |
|---|---|
| Pilulka postupu s prázdnými tečkami + 0/5 | shoda |
| Slunečný časovač a kulatá pauza | shoda |
| Řádek cíle pod pilulkou, po 4 s zmizí, pauza ho vrátí | shoda (`pause-goal`, mutace v `Hud.tsx` zčervená) |
| Dolní řada: restart, Change one thing, sdílení | shoda |
| Pilulka Quick version | shoda (na telefonu zkrácená) |
| Štítky ve scéně | kit je má natočené nad objekty; u nás čipy cílů nad dolní řadou |

**Liší se:** scéna je 3D s panoramatem, kit kreslí plochou ilustraci – záměr produktu. Generovaný popisek „s dog“ („Avoid the s dog.“) je přesně vada, kterou kit cituje v `11-voice-copy.md`; vzniká v režisérovi/draftu, mimo soubory P34.

## Win – `03-win@2x.png` vs `result-win-390.png`

| Bod | Stav |
|---|---|
| Slunečný odznak s časem a „Speedy!“, náklon −6° | shoda |
| „You did it!“ + podtitulek | shoda; podtitulek je obecný („All 5 collected in 1.1s.“) |
| Tři statistiky v bílých kartách | shoda; popisek „collected“ místo „eggs“, „time“ místo „your best“ (nejlepší čas se neukládá) |
| Dare a friend to beat it (rajčatové), Play again, Remix it | shoda |
| Odkazy pod tím | Copy link (+ Save video, když je klip); „Post to story“ vynechán – funkce neexistuje |
| Konfety | nejsou |

## Testy

- Unit: `src/components/play` + `src/app/api/play` 453/453; celá sada viz commit.
- E2e dotčené specifikace 42/42 (`play-sentence-read` se serverem `PLAY_READER=on PLAY_READER_ENDPOINT=http://127.0.0.1:8799`), snímky 24/24.

## Otevřené (pro zadavatele / další plán)

1. Popisky nepřátel z generátoru („s dog“) – validovat v režisérovi (stopa B).
2. Čip „Change the world, keep the rules“ – server ho páruje v `src/play/director/remix-words.ts`, přejmenovat naráz se `starters.ts`.
3. Řádek cíle v arkádě po pauze nemá e2e hlídač: aréna hráče chytí zhruba ve chvíli, kdy řádek mizí; helper je tentýž jako v mřížce.
4. Modrý okraj plakátu pod tab barem na telefonu; feed na desktopu hlásí „No games yet“ vedle hrající ukázky.
5. Konfety a nejlepší čas na výsledku.
