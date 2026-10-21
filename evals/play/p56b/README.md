# P56B – Toy Box doopravdy: výchozí stav vzhledu

Plán `plans/P56B-toy-box-doopravdy-2026-10-21.md` (necommitovaný). Větev `features/P56B-toy-box-doopravdy-2026-10-21`, předek `72665fdc` (tip P55). Strana A = worktree `D:/tmp/p56b-base` na `72665fdc`, `next start` na `127.0.0.1:3157` (port 3111 patří autopilotům P56A/P56C).

## Sada vět (T1)

`sentences.json` – 12 vět živého auditu 21. 10. (slug `NN-slovo`); `--set genres` přidá 18 vět, jednu na žánr (`evals/play/p46g/genres.json`). Celkem 30 scén.

## Výchozí snímky (T1)

`node scripts/play-look-shots.mjs shots --set p56b,genres --base http://127.0.0.1:3157 --out evals/play/p56b/before` a totéž s `--profile pixel7 --out …/before-phone`: **30 snímků `before/` + 30 `before-phone/`** (+ `manifest.json` v každém; SwiftShader, tik 150 ukázky robota).

### Jas plátna nočních scén

`node scripts/play-look-shots.mjs luma <dir>` – střední luma Rec. 709 (0–1) a podíl pixelů s jasem < 0,04. Celá sada: `luma-before.json`, `luma-before-phone.json`.

| Scéna | desktop jas | desktop < 0,04 | telefon jas | telefon < 0,04 |
|---|---|---|---|---|
| 02-zombie (farma v noci) | 0,122 | 0,2 % | 0,111 | 0,5 % |
| 09-astro (vesmír) | 0,269 | 1,0 % | 0,342 | 0,2 % |
| 12-ghost (strašidelný dům) | 0,165 | 0,0 % | 0,208 | 0,0 % |

Nejtmavší celé sady je `g-fight` (0,074, 13,8 % pod 0,04 na desktopu). Brána T7 (≥ 1,8× jasu) se počítá z řádků 02 a 12.

### 404 na `/assets/`

Sonda v `manifest.json` (`assets404` u každého snímku): **4× 404 na 30 scén**, stejně na desktopu i telefonu – ne 19 jako v auditu (audit počítal i riggované id `rigged:*-lod1.glb`; ta opravil `d4dff794` dřív, než tyto snímky vznikly).

- `game/player-lod1.glb` – 09-astro, 12-ghost, g-runner: počítadla schopností a pulzu nesou druh hrdiny a stav ve velikosti, takže je kontrola velikosti brala za tělo s modelem.
- `game/pad-lod1.glb` – g-lander: přistávací plochu kreslí `VoyageBackdrop`, `World` ji kreslil podruhé.

Obojí opravil `bc9c9408` (T3).

### Feed

`node scripts/play-look-shots.mjs feed --base http://127.0.0.1:3157` (`feed-before.json`): čerstvý návštěvník na `/play` vidí **6 obrázků karet, 0 z `/og`**, všech 6 jsou kurátorské snímky `/feed-thumbs/` (3 hry × na výšku a na šířku). Karty `/og` dostávají hry, které návštěvník sám udělal nebo hrál („Up next“) – to měří až T12 po zahrání 3 vět.

### Šum FPS

`perf --base A --vs A --repeats 3` (Pixel 7, CPU 4×, prokládaně A, A′ scénu po scéně, 30 scén; `perf-before.json` = A, `perf-noise-b.json` = A′, souhrn `perf-noise.json`): **šum = medián |A′/A − 1| = 0,08** (p90 0,32, medián poměru 1,005). Brány T8 a T13 tedy čtou „po/před ≥ 0,92“.

- Měřeno pod zátěží: během běhu na stroji dvakrát doběhl `npm run build` a snímky T6 – prokládání ji nese oběma stranám stejně, šum je proto spíš horní odhad.
- Pod 40 FPS už na základu (A): 01-frog, 02-zombie, 09-astro, 10-chef, 12-ghost, g-runner, g-race, g-platform – brána T8 „žádná scéna pod 40, která v A byla nad 40“ se jich netýká.

## Černá obrazovka před prvním snímkem (T4)

**Reprodukce** (`e2e/p56b-first-frame.spec.ts`: časová řada jasu plátna po 250 ms od zmizení karty kroků, 4 s, `/assets/` zdržené o 5 s):

- Na GPU stroji černá nevznikne ani se zdrženými modely – scéna na modely nečeká, obloha, zem a mlha se kreslí hned (hypotéza (a) „`Suspense` čeká na modely“ neplatí).
- Vzniká jen při pomalém prvním snímku (SwiftShader 87 % černých pixelů; na slabém telefonu překlad shaderů): do té doby je vidět podklad pod plátnem, a ten byl `scene.sky`.
- **Příčina (c):** vesmírná `sky` `#020617` je sama pod mezí černé (luma < 0,04) – jediná sada, jejíž `sky` pod mez spadne. Na `72665fdc` sonda padá přesně tady: podklad `rgb(2,6,23)` u 09-astro, desktop i telefon.

**Oprava:** podklad pod plátnem (`--_sky` v `ArcadePlay` a `GridShell`) je `horizon` scény po náladě a denní době – táž barva, kterou `StyleRig` kreslí jako pozadí scény, takže první snímek na ni navazuje; obzor žádné sady pod 0,04 není (nejtmavší je vesmír `#0b1730`, luma 0,087; tóny nálad jsou všechny nad 0,2, takže je nestáhnou níž). Po opravě: 6 vět × desktop + Pixel 7, žádný vzorek nad 2,6 % černých pixelů; `p32-first-seconds` čeká obzor scény (`sceneLook(theme).horizon`), ne syrovou barvu sady – věta „haunted castle“ má náladu, která obzor ztmaví.

**Věta → hratelná** (`scripts/measure/first-playable-ab.mjs`, A = `72665fdc` na 3157, B = T4 na 3158, 6 vět auditu × desktop + Pixel 7 CPU 4×, A a B prokládaně): server A po 24 bězích přestal odpovídat (`page.goto` 60 s), takže platí **8 úplných dvojic** z plánovaných 36. Medián rozdílu B − A ve dvojici **−57 ms** (desktop +44 ms, telefon −202 ms), rozdíl mediánů +400 ms (2 671 → 3 071 ms, táhne ho jediná dvojice 02-ghost desktop +1 279 ms), první snímek +22 ms. Obojí pod šumem 414 ms z `evals/play/first-playable/README.md` – T4 dobu do hratelnosti nezhoršila. Surová data `runs.jsonl` mimo repo (scratchpad relace `793eb4f9`).

## Kamera arény (T9)

`ARENA_OUT=<soubor> npx vitest run src/components/play/arcade/__tests__/arena-camera.test.ts` – robot hraje 600 tiků, poměr 1280/800 (wide) a 390/844 (tall). Vzdálenost kamery (m, medián) a podíl tiků, kdy je střed nejbližšího nepřítele do 22 m v obraze:

| Běh | vzdálenost před → po | nepřítel v obraze před → po |
|---|---|---|
| 02-zombie wide | 15,3 → 10,9 | 1,00 → 1,00 |
| 02-zombie tall | 13,9 → 8,5 | 1,00 → 0,99 |
| 08-gems wide | 15,9 → 11,3 | 0,89 → 0,93 |
| 08-gems tall | 14,4 → 14,9 | 0 (72665fdc) → 0,69 |
| 10-chef wide | 15,9 → 11,3 | 1,00 → 1,00 |
| 10-chef tall | 14,4 → 8,8 | 1,00 → 1,00 |

Medián všech šesti běhů klesl o víc než 20 %. **Odchylka od AC:** 08-gems na výšku drží nepřítele v obraze v 69 % tiků, ne 85 %. Nepřítel tam celou hru bloudí 6–16 m do strany a do úzkého obrazu se s hrdinou vejde jen s kamerou tak daleko, že hrdina klesne pod podlahu `e2e/p32-arena.spec.ts` (8 % výšky obrazu na telefonu): první verze T9 (natažení 2,5×) dala 92 %, ale kočce na Pixel 7 jen 6,4 % výšky a e2e spadl. Platí podlaha hrdiny (natažení 1,8×, na výšku 2,1×, hrdina ≥ 7,8 % a 8,6 %); zbytek nepřátel ukazuje šipka na okraji. Test pro tento jediný běh hlídá 0,65.

## Noc (T7)

`shots --set p56b --only 02-zombie,12-ghost,09-astro` desktop i Pixel 7 na buildu T7, pak `luma` → `luma-after-t7.json`, `luma-after-t7-phone.json` (snímky `after-t7/`, `after-t7-phone/` mimo git jako `before/`):

| Scéna | desktop T1 → T7 (brána) | telefon T1 → T7 (brána) | pod 0,04 |
|---|---|---|---|
| 02-zombie (farma v noci) | 0,122 → 0,227 (0,220) | 0,111 → 0,255 (0,200) | 0 % |
| 12-ghost (strašidelný dům) | 0,165 → 0,305 (0,297) | 0,208 → 0,407 (0,374) | 0 % |
| 09-astro (vesmír, kontrola) | 0,269 → 0,276 | 0,342 → 0,347 | 0,2 % |

- **Jen měsíc nestačil:** slunce noci 0,35 → 0,9, studené, shora a zezadu (`sunDir` noci), a okraj toonu 0,15 → 0,5 pod tmavým obzorem daly 0,150 a 0,202 na desktopu (1,23×). Zbytek nese **přizpůsobení expozice tmě** v rigu (`exposureOf`, 2,4×): jen tmavá obloha (`darkness`, lineární jas obzoru pod 0,1) a zároveň světlo u noční meze. Vesmír (slunce 1,6), bouřka a mlha (světlá obloha), podmořský svět a sopka (obzor nad 0,1) zůstávají beze změny.
- **Mez tmavých sad:** hřbitov a jeskyně bez noci a nálady svítí aspoň jako noc (`lightFloor`, stejný vzorec a stejná noc jako `withMood` v katalogu). Řešené v rigu, ne v `sceneLook` – katalog mimo řádky `NIGHT` sdílí P56A.
- Silnější noc zvedá i mez nálad (`withMood` počítá z `NIGHT`): bouřka, šero a strašidelno na denní sadě svítí aspoň 0,99 místo 0,61 (jas polokoule a slunce, lineární).
- Bílý nepřítel na desktopovém snímku 02 je záblesk zásahu (`FightFx`, řízený časem, ne tikem); bez něj ~0,222.

## Telefon startuje na `medium` (T8)

`perf --base http://127.0.0.1:3157 --vs http://127.0.0.1:3158 --repeats 3 --set p56b,genres` (A = `72665fdc`, B = HEAD s T3–T8, Pixel 7, CPU 4×, d3d11, prokládaně scénu po scéně; souhrn `perf-t8.json`, `perf` nově zapisuje úroveň kvality na konci každého okna):

- **Brána prošla krokem (1):** medián poměru B/A **0,941** (brána ≥ 0,92 = 1 − šum T1), žádná scéna neklesla pod 40 FPS, která v A byla nad 40 (pod 40 jsou v obou g-arena a g-fight). Kroky (2) bez AO a (3) bez bloomu nebyly potřeba.
- Nejvíc ztrácí g-runner 0,74, g-glide 0,79, g-race 0,82, g-ball a 11-drum 0,83 – samé scény, kde B během okna sestoupil z `medium` na `low`; sestup trvá 3 s pod 45 FPS a ty jsou v okně vidět.
- **Úrovně na konci oken:** B na `medium` ve všech třech oknech v 10 z 30 scén, aspoň jednou na `high` v 5 (03, 05, 06, g-timing, g-lander), na `low` ve všech třech oknech v 5 (g-arena, g-fight, g-quest, g-ball, g-shooter). A (start `low`) v 15 scénách aspoň jednou vystoupal na `medium`, na `high` nikdy. Emulace brzdí CPU, ne GPU – skutečný telefon rozhodne HALT po T13.
- Měřeno na méně vytíženém stroji než šum T1 (medián A 56,9 FPS, v T1 bylo pod 40 osm scén).

## Šedé kvádry a desky (T10)

**Inventura na `72665fdc`** (výpis z kódu – sonda `data-fallback` tam ještě není):

- `StaticModel` (`World.tsx`) kreslí kvádr během načítání a natrvalo, když model chybí (404 → `loadModel` vrátí `null`). Barva z `FALLBACK_COLOR` podle druhu těla, jinak šedá `#94a3b8`. Na základu to byly 4× 404 z T1 (`player` v 09, 12 a g-runner, `pad` v g-lander), opravené v T3.
- **08-gems:** plot arény (`StyledWorld`, tělo bez věci pravidel) je kvádr `FENCE_COLOR` `#78716c` – 6 šedých kvádrů na louce. Totéž v g-arena.
- **12-ghost:** „deska“ na konci cesty je zeď rozcestí běžce (`divider`, 1,6 × 1,5 × 8–14 m), tedy `RunnerStructure` z kamene `look.block ?? ['#78716c', '#a8a29e']`. Hřbitov ani sídlo `block` nemají.
- Překážky běžce bez popisku z věty jsou ve všech 18 sadách tytéž stavební zábrany z `game/` (`hurdle`, `slide-bar`, `cone`, `crate`).
- Náhradní barvy postav v `ArcadeStage.tsx` byly surové hexy, soupeř šedý `#64748b`.

**Oprava:** `src/play/arcade/look/obstacle-kits.json` – každá sada má díl pro `hurdle`, `slide-bar`, `crate`, `cone` a `block` (plot arény a zeď rozcestí). Model z popisku věty má dál přednost. Laťka sady a plot vyplní celé tělo, tvar se kryje se srážkou. Zeď rozcestí je řada dílů po křivce trati (hřbitov železný plot, louka živý plot). Náhradní díl je zaoblený, v hlavní barvě rekvizit sady; postavy mají barvy kitu. Licence všech 90 dílů z `disclosure.json`: CC0 nebo vlastní generované, žádná CC BY-ND (v `disclosure.json` žádná není).

**Po T10** (build HEAD, `e2e/p56b-look.spec.ts`, 30 scén): `data-fallback` = 0 ve všech 23 scénách se sondou, 0× 404. Sondu nemá 7 scén, které žádný model nevepisují (11-drum, g-ball, g-shooter, g-throw, g-timing, g-rhythm, g-duel). Druhý test sondu ověřuje naopak: když díly sad vrátí 404, 12-ghost hlásí `data-fallback` > 0 a jen jejich id. Snímky `after-t10/` (08, 12, 06, g-runner, g-arena) jsou mimo git jako `before/`.

**Mimo T10 zůstává:** překážky agaru (`AgarWorld`, g-agar) jsou dál kvádr `FENCE_COLOR`, věc pravidel bez modelu je barevný kvádr `thingColor` a tunel a plošiny mají barvu z `look.block`, jinak výchozí kámen.

## Pruhy z povrchu sady (T11)

**Oprava:** pruhy obrany, krájení a kostry pruhů (`LaneScene`) kreslí `genres/lanes/LaneStrips.tsx` jako pásy cesty (`roadGeometry`, jako dráha běžce): povrch sady (hlína, prkna, dlažba, písek, sníh, asfalt), lem po krajích, spáry prken. Sousední pruhy se liší jen jasem (lichý o 16 % tmavší). Všech pět pruhů jsou 3–4 sítě místo pěti kvádrů.

- **Obrana:** zelený kvádr živého plotu na konci je řada osmi dílů `block` z kitu sady (louka živý plot, obývák pohovky, hrad zbořená zeď), vyplněná do objemu plotu, takže nepřátele dál schová.
- **Chytání:** zelený kvádr koruny jsou dvě řady kulatých chomáčů listí v barvě listí sady (`flora.leaf`), jedna síť. Deska si nechává světlou výplň P55 (papír a `cream-deep`), od sady dostane jen lem a spáry.
- **Krájení:** bedny, ze kterých věci vylétají, zůstaly – nejsou deska pruhu.

**`boxGeometry` před → po:** DefenseScene 7 → 5, CatchScene 3 → 1, SliceScene 6 → 5, LaneScene 2 → 1.

**Kontrast cíl/pruh** (WCAG poměr jasu, nejhorší z obou pruhů; míchání jako `look/ground.ts`; skript ve scratchpadu relace `8031cb8e`):

| Pruhy | ovoce `sun` | zlatý `sun-deep` | bonus `sky` | meloun `mint-deep` | bomba `ink` |
|---|---|---|---|---|---|
| před: obrana a krájení (`mint`/`mint-deep`) | 1,05 | 1,04 | 1,08 | 1,00 | 7,96 |
| po: asfalt | 4,07 | 3,08 | 3,96 | 2,97 | 2,41 |
| po: hlína | 2,70 | 2,05 | 2,63 | 1,97 | 3,53 |
| po: prkna | 2,46 | 1,87 | 2,40 | 1,80 | 3,87 |
| po: dlažba | 1,71 | 1,29 | 1,66 | 1,25 | 5,50 |
| po: sníh | 1,14 | 1,51 | 1,17 | 1,56 | 12,45 |
| po: písek | 1,10 | 1,03 | 1,07 | 1,07 | 8,51 |

- Cíle (ovoce, zlatý a modrý bonus, meloun) mají proti pruhům kontrast stejný nebo vyšší ve všech šesti površích. Jediná výjimka je zlatý bonus na písku, 1,03 proti dřívějším 1,04, což je v mezích zaokrouhlení.
- **Bomba krájení na tmavém povrchu klesá** (asfalt 2,41, hlína 3,53 proti 7,96). Bomba se ale čte ve vzduchu proti obloze a kulise, ne proti pruhu. E2e `play-slice` je zelené.
- **Chytání:** povrch zesvětlený k papíru (zkoušeno 60 %) by snížil kontrast ovoce na 1,01–1,26 proti dnešním 1,31 a bomby na ~10 proti 14,3. Proto deska drží výplň P55 a kontrast se nemění.

**Ověření** (build HEAD, `next start` 3158): `play-catch`, `play-whack`, `play-defense`, `play-slice` 12/12 zelené. Telefonní rozpočet: obrana 35 sítí a 85 volání, krájení 24/63, bouchání 21/60. `p56b-look` 2/2 na 34 scénách: 0× 404, 0 náhradních dílů.

Snímky `shots --set genres --only g-catch,g-whack,g-defense,g-slice` jsou mimo git jako `before/`: desktop v `after-t11/`, telefon v `after-t11/phone/`, základ `72665fdc` v `before-t11/`. Volání kreslení na snímku: obrana 104 → 111 (osm dílů plotu místo kvádru), chytání 51 → 44, krájení 68 → 61, bouchání 60 → 60.

**Sada `genres` má 22 vět místo 18.** Přibyly `g-catch`, `g-whack`, `g-defense`, `g-slice` – věty z `draft.test.ts`, které jsou připnuté ke svému žánru, protože AC T11 je fotí přes `--set genres`. Čtou je i `p56b-look` (teď 34 scén), `p54b-landmark` (počítá aspoň 13 bodů v záběru absolutně, takže nové věty bez bodu ho neshodí) a galerie scén. Sada T13 `p56b,genres` má tím 34 scén; před/po se měří na téže sadě.

## Kotva proti hrám z obchodu (T2)

`anchor-before.json` (`node scripts/play-p46g-blind.mjs anchor --anchor D:/tmp/p56b-ref --dir evals/play/p56b --ours before-phone --set p56b --out evals/play/p56b/anchor-before.json`): **náš snímek vyhrál 0 z 30 dvojic** (0/10 proti každé hře), levá strana vyhrála 0,5 – soudce stranu nepreferuje.

- **Hry:** Crossy Road, Hole.io, Subway Surfers – všechny stylizované, hračkové, na výšku. Stumble Guys z návrhu plánu nahradilo Hole.io: snímky Stumble Guys nesou přes herní plochu joystick, banner úkolu a počítadla, které ořez neodstraní.
- **Odkud:** veřejné snímky obrazovky ze stránek Google Play (`com.yodo1.crossyroad`, `io.voodoo.holeio`, `com.kiloo.subwaysurf`), oříznuté na herní plochu bez rámečků obchodu a textu. Použité ořezy: Crossy Road 6, Subway Surfers 4, Hole.io 2 (seznam v `anchor-before.json` → `references`).
- **Jen mimo repo:** `D:/tmp/p56b-ref/<hra>/{raw,crop}/` (autorská práva); v gitu není žádný soubor z `p56b-ref`.
- Soudce: `claude -p --safe-mode --tools Read`, jedna dvojice na volání, `sheet.png` sám v čerstvém prázdném `mkdtemp`, strana z `pure-rand` (seed 56021). Otázka a model v `anchor-before.json` → `judge`.

Brána T13: `anchor-after` ≥ 0 + 0,15.

## Slepý soud, pokus 1 (T13, HEAD `ea9466c2`) – desktop neprošel

`node scripts/play-p46g-blind.mjs judge --dir evals/play/p56b --set p56b,genres --pairs <před>:<po> --question store --pass-at 26 --seed 56013` zvlášť pro desktop a telefon (34 + 34 dvojic, otázka „which first frame looks like a finished game from an app store“), sloučeno do `judge.json`. Snímky „před“: `before/`, `before-phone/` z T1 + 4 věty pruhů ze základu (`72665fdc`, SwiftShader jako T1); „po“: `after/`, `after-phone/` (mimo git jako `before/`, 0× 404, 0 chyb).

- **Telefon prošel:** nový vzhled 26/34 (0,765, brána 0,75), levá strana 0,559.
- **Desktop neprošel:** 21/34 (0,618) a soudce volí levou stranu v 0,706 (povoleno 0,35–0,65). Nový vzhled vlevo vyhrál 14/17, vpravo jen 7/17 – kde se scény liší málo, rozhoduje strana.
- **Co soud jmenoval (13 proher desktopu):** noc 02-zombie a 12-ghost – „props look like broken white materials“, „washed-out, glaring white prop materials“; listí a stromy 01-frog, 07-goalkeeper, g-race, g-ball – „broken textures“, „more consistent foliage“; pět dvojic „nearly identical“ (g-timing, g-rhythm, g-voyage, g-walker, g-lander).
- **Příčina noci (pozorování):** na snímku 12-ghost jsou náhrobky, lavička a keře s texturou bílé s tmavými pruhy, na `72665fdc` tlumeně modré; velké skály bez textury vypadají v obou podobně. **Odvozeno:** světlý kámen textury × expozice noci 2,4× (T7 `NIGHT_EXPOSURE`) se v ACES přepálí do bílé, tmavé barvy palety ne.
- **Vyvrácená hypotéza:** toon kopie texturovaných modelů bez tří stupňů světla (jen paleta a okraj) – přestavěno a vyfoceno, 12-ghost ani 07-goalkeeper se viditelně nezměnily; změna vrácena, necommitnutá.
- Kotva, `perf --vs` a e2e brány v pokusu 1 neběžely – měří se až na vzhledu, který soud projde.
