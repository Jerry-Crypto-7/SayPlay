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

## Kotva proti hrám z obchodu (T2)

`anchor-before.json` (`node scripts/play-p46g-blind.mjs anchor --anchor D:/tmp/p56b-ref --dir evals/play/p56b --ours before-phone --set p56b --out evals/play/p56b/anchor-before.json`): **náš snímek vyhrál 0 z 30 dvojic** (0/10 proti každé hře), levá strana vyhrála 0,5 – soudce stranu nepreferuje.

- **Hry:** Crossy Road, Hole.io, Subway Surfers – všechny stylizované, hračkové, na výšku. Stumble Guys z návrhu plánu nahradilo Hole.io: snímky Stumble Guys nesou přes herní plochu joystick, banner úkolu a počítadla, které ořez neodstraní.
- **Odkud:** veřejné snímky obrazovky ze stránek Google Play (`com.yodo1.crossyroad`, `io.voodoo.holeio`, `com.kiloo.subwaysurf`), oříznuté na herní plochu bez rámečků obchodu a textu. Použité ořezy: Crossy Road 6, Subway Surfers 4, Hole.io 2 (seznam v `anchor-before.json` → `references`).
- **Jen mimo repo:** `D:/tmp/p56b-ref/<hra>/{raw,crop}/` (autorská práva); v gitu není žádný soubor z `p56b-ref`.
- Soudce: `claude -p --safe-mode --tools Read`, jedna dvojice na volání, `sheet.png` sám v čerstvém prázdném `mkdtemp`, strana z `pure-rand` (seed 56021). Otázka a model v `anchor-before.json` → `judge`.

Brána T13: `anchor-after` ≥ 0 + 0,15.
