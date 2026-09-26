# Arkádové jádro (`src/play/arcade`)

Kontrakt: `src/play/arcade/contract.ts`. Řídicí plán: `plans/P25-play-knihovna-ovladani-2026-09-22.md`.

## Proč vedle `src/sim`, ne v něm

- `src/sim` je mřížka 20 Hz: pozice jsou celá políčka, pohyb je políčko za tik, „kolize“ je rovnost políček a vstup jsou diskrétní akce `moveTo/pickup/use`. Rychlost, gravitace ani spojitá kolize v něm nejsou.
- Skok, pruh, řízení nebo let na tom postavit nejde bez změny tvaru stavu – a ta by pohnula hashi, svědky i e2e všech dnešních her.
- Proto samostatné jádro: dnešní hry (`control: 'tap_go'`, výchozí) jdou beze změny do `src/sim`, arkádové (`control: 'runner'`, …) do `src/play/arcade`.

## Jednotky a stav

- **1 m = 1000 jednotek** (`UNIT`), rychlost je v jednotkách za tik, **60 Hz** (`ARCADE_HZ`).
- Stav je jeden `Int32Array`: hlavička (`tick`, `runState`, počet těl, index hráče, `spawnBase`, místo návratu `respawnX/Y/Z`, 8 čítačů) + těla po 14 slotech (`x y z vx vy vz w h d flags role kind aux0 aux1`). Za těly úrovně je volitelná rezerva `spawnSlots` pro efekt `spawn`.
- Osy: `x` do stran, `y` nahoru, `z` vpřed. `x/y/z` je střed spodní stěny obrysu (AABB).
- Despawn jen shodí bit `alive`; indexy těl jsou stabilní po celý běh.

## Determinismus

- Žádné floaty ve stavu, žádné `Math.random`, `Date.now`, `performance.now` v `src/play/arcade/**` (hlídá grep test).
- Jediná náhoda je `pure-rand` (stream `layout` z `src/sim/rng.ts`) a spotřebuje ji jen generátor úrovně. Jádro samo je bez náhody: stav v tiku *t* je funkce počátečního stavu a vstupů 0..*t*.
- Hash stavu je FNV-1a z `src/sim/hash.ts` nad bajty stavu.
- Všechny smyčky mají strop z `ARCADE_LIMITS` (256 těl, 16 pravidel, 64 efektů za tik, horizont 5400 tiků).
- Klient: `requestAnimationFrame` jen **pohání** tiky přes akumulátor pevného kroku; vstupy se zapisují po ticích, takže záznam jde přehrát.

## Tik jádra

vstup → ovládání (kus `control`) → vezení (hráč stojící na kinematickém tělese dostane jeho rychlost) → integrace (rychlost, gravitace) → stohování (padající tělo s gravitací dosedne na pevné tělo pod sebou) → kolize AABB hráče s ostatními → projektily (život, zásah, odraz) → pravidla (`contact`, `hit`, `tick`, `counter` → `score`, `damage`, `count`, `lose`, `win`, `despawn`, `spawn`, `respawn`, `checkpoint`) → úklid.

Kolize s pevným tělem podle toho, odkud hráč přišel (poloha před integrací; u pohyblivého tělesa jeho poloha minus rychlost):

| Odkud | Co jádro udělá | Kontakt pro pravidla |
|---|---|---|
| shora | hráč stojí na horní hraně, `vy = 0`, `grounded` | ne |
| zdola | hlava pod spodní hranou, `vy = 0` | ano |
| z boku (`x` nebo `z`) | hráč na hraně, `vx`/`vz` = 0; přes roh rozhodne menší průnik | ano |

**Projektil** (role `projectile`, P25G) jde po kolizích hráče: hráče nezastaví ani se ho nedotkne (vylétá z něj). Každý tik mu jádro ubere život (`aux1`, výchozí 3 s, mez 90 s – `buildWorld` jiný neveme), pak hledá zásah – živý terč (`target`), nepřítel (`enemy`) nebo pevné tělo, první podle indexu, proti obalu dráhy za tik, takže rychlá střela tenkým terčem nepropadne. S gravitací na zemi (`y ≤ 0`) se odrazí (`aux0` = odraz 0–1000: `vy`, `vx`, `vz` × odraz / 1000), nebo skončí – bez odrazu hned, s odrazem až když vyskočí slaběji než o dva tiky gravitace. Skončený projektil jádro despawnuje samo a spustí pravidla se spouštěčem `hit` (`other` = zasažené tělo, u země a dohasnutí −1; `source` = projektil). Předloha projektilu si odraz a plný život přenese i do spawnu.

Nepevné tělo je jen kontakt. Příznaky těla: `solid` (stojí se na něm, zastaví), `gravity` (padá, drží se nad zemí `y ≥ 0`), `kinematic` (jede jen svou rychlostí, nic ho nezastaví, hráč se veze). Předloha (`template`) je ve světě mrtvá a efekt `spawn` ji kopíruje do rezervy; mrtvé spawnuté sloty se použijí znovu, těla úrovně nikdy, a když není kam, efekt se zahodí.

## Kusy

| Kus | Rozhraní | Příklad |
|---|---|---|
| `control` | `step(state, player, input, params)` – mění jen tělo hráče | `runner`: sám běží, ťuk = skok, swipe = pruh, dolů = skluz |
| `rule` | `fire(ctx, params) → efekty` na `contact` / `tick` / `counter` | náraz → prohra, mince → skóre, konec trati → výhra |
| `generator` | `generate(seed, params) → těla` – hratelné z konstrukce | trať s překážkami, mezery vždy v dosahu skoku |
| `bot` | `decide(pozorování, params) → vstup`, pozorování je 8 tiků staré | robot běžce |

Každý kus nese `params` (zod), `cost` (těla, pravidla) a `roles`.

**Rampa rychlosti (P28C T6).** `runner`, `flap` a `steer` nesou v parametrech ovládání značky `ramp` na třetině a dvou třetinách trati (`rampMarks`); za každou značkou je běh o 10 % rychlejší (`rampedSpeed`, u `steer` strop rychlosti). Generátory a kontroly hratelnosti počítají s rychlostí za značkou (odstup řad, stoupání mezi trubkami, dosah v zatáčce), robot flapu a steeru dostane tytéž značky. Svět bez značek – každý zkompilovaný před rampou – jede stálou rychlostí a jeho hash se nepohne.

## Kontrakt ověření (`verifyArcade`)

Hra je publikovatelná, když platí vše:

1. robot se zpožděním reakce 8 tiků vyhraje,
2. nečinný hráč nevyhraje,
3. dvě přehrání robotova záznamu dají stejný hash,
4. výhra přijde do 5400 tiků (90 s),
5. svět je v mezích (`ARCADE_LIMITS`).

Výsledek má tvar `QualityReport` (`src/play/contracts.ts`), takže publikace, feed a sdílení zůstávají jedna cesta.

## Ovládání z poptávky → kusy

Štítky z `evals/play/demand/labels.json` (200 vět, 22. 9.). „Kus“ = co je potřeba nad jádrem; jádro (integrace, AABB, pravidla) je společné.

| Ovládání | Vět | Ovládání (`control`) | Generátor | Pravidla | Robot |
|---|---|---|---|---|---|
| `tap_go` | 42 | zůstává v `src/sim` | – | – | – |
| `runner` | 16 | `runner` (auto běh, skok, pruh, skluz) | trať s překážkami | náraz, mince, konec trati | čte překážky vpředu |
| `platform` | 15 | vlevo/vpravo + skok | plošiny, hroty, checkpoint | pád, hrot, cíl | cesta po plošinách |
| `flap` | 1 | ťuk = vzlet | trubky s mezerou | náraz, průlet → skóre | drží výšku mezery |
| `steer` | 19 | řízení osou | trať se zatáčkami, soupeři | kolo, čas, náraz | sleduje středovou čáru |
| `move_free` | 13 | volný pohyb osou ve 2D | aréna s jídlem a soupeři | sněz menší, utíkej větším | chamtivý se strachem |
| `aim_shoot` | 15 | míření osou + ťuk = výstřel (projektil) | terče, vlny | zásah → skóre, munice | míří na nejbližší |
| `throw` | 14 | tah-pusť: síla + úhel (projektil) | koš, terč, věž z bloků | trefa, pád bloků | hledá sílu a úhel |
| `timing` | 16 | ťuk ve správnou chvíli | pohyblivý předmět | přesnost → skóre, minutí → prohra | ťukne v okně |
| `rhythm` | 6 | ťuk do rytmu | beat mapa z BPM a semínka | trefa v okně | ťuká podle mapy |
| `melee` | 5 | úder / uhnutí | vzorec soupeře | okna úderu a obrany | reaguje na nápřah |
| `manipulate` | 15 | – | – | – | mimo jádro: deska a dílky, poctivá hláška (P25 T28) |
| `build_place` | 12 | – | – | – | mimo jádro: poctivá hláška |
| `idle` | 8 | – | – | – | mimo jádro: poctivá hláška |
| `sandbox` | 3 | – | – | – | mimo rozsah krátké hry |

Hotové: `runner` (P25A), `platform` a `flap` (P25C). Ostatní řádky jsou plán fází 2–4 řídicího plánu.

## Výkon

Krok jádra (22. 9. 2026, čistý Node 22, bundle přes rolldown, fixtura běžce, 5 semínek × 5 opakování, 600 tiků se vstupy robota): **medián 0,0024 ms/tik, nejhorší vzorek 0,013 ms/tik** – cíl < 1 ms drží s rezervou ~80×. Pod vitestem je jádro ~15× pomalejší (importy jsou gettery), proto se neměří tam.

Plošinovka a poletování (22. 9. 2026, P25C T6, pod vitestem a souběžně s `npm run build`, fixtury `platform.json` a `flap.json`, 5 opakování × 600 tiků se vstupy robota): **plošinovka 0,0035–0,0059 ms/tik, poletování 0,0030–0,0047 ms/tik** (běžec týmž měřením 0,0047–0,0075, první zahřívací vzorek 0,037). I se ~15× přirážkou vitestu cíl < 1 ms drží s rezervou přes 150×.

Prohlížeč: `ArcadeStage` tiká pevným krokem 1/60 s z `useFrame` (akumulátor, strop 250 ms na snímek – skrytá záložka hru nedohraje) a těla interpoluje mezi dvěma posledními tiky. Scéna podle `control`: běžec kamera za hráčem, plošinovka a poletování boční kamera (stojí na −x, +z jde doprava; na výšku ustoupí, aby byla vidět trať vpředu). Plošinovka drží osu (`session.hold`, zapisuje se do každého tiku, kdy je nenulová); dotyk: levá čtvrtina vlevo, druhá vpravo, pravá polovina skok. Poletování čeká na první ťuk (`waitForInput`), jinak by ptáček spadl dřív, než ho hráč uvidí.

## Prostředí (P29C)

Za každou hrou (arkáda, grid, timing, rhythm, duel) visí 360° panorama prostředí z věty místo jedné ploché barvy oblohy. Je to jen obraz: jádro, hash replaye ani robot ověřovače o něm neví.

**Knihovna.** `public/assets/worldstream/env/` – 94 panoramat 2048×1024 (+ náhled 512×256, ~20 MB), 18 looků × 3 varianty a 40 prostředí z korpusů. Katalog `src/play/arcade/look/env-catalog.json` nese id, look, štítky (slova prostředí, která obraz ukazuje) a barvu horizontu. Generuje je lokálně `ops/env` (FLUX.2 klein 4B, Apache-2.0).

**Výběr.** `envFor(theme, seed)` (`src/play/arcade/look/env.ts`) vezme panorama, které nese nejvíc slov z `theme.setting` („snowy forest“ → sníh i les); když žádné, jednu ze tří variant `lookOf(theme)`. Seed je hash id verze, takže tatáž hra má vždy totéž pozadí. Nad 33 větami korpusu věrnosti, jejichž checklist prostředí jmenuje, ukáže pozadí slovo prostředí u **27 (0,818)**; všech šest minutí vzniká už v návrhu ze slov, který slovo z věty do `setting` nepřenese (`evals/play/env/README.md`).

**Obraz.** `Panorama.tsx` je koule kolem kamery (poloměr 0,9 × vzdálená rovina), kreslená první, bez mlhy a bez zápisu hloubky. Stahuje se až po prvním snímku – nejdřív náhled, pak plné – a mlha se pak srovná s horizontem panoramatu. Plátno nese `data-env` (id na obrazovce). Kontext `PlayEnv` dává obal hry (`PlayShell`, feed) v samostatném `play-env.tsx` a grid načítá Panoramu líně: statický import vtáhl `@react-three/fiber` do úvodního balíku stránky gridu a první snímek se zpozdil o 31 %. Po úpravě první snímek (desktop, medián): runner 522 → 507 ms, grid 710 → 684 ms.

**Nové prostředí na požádání.** Hra, jejíž prostředí žádný štítek knihovny nenese, založí při publikaci úlohu na službě `ops/env/server.py` (lokální RTX 3090, za klíčem, `PLAY_ENV_ENDPOINT` + `PLAY_ENV_KEY`; neblokuje, `after()`). `GET /api/play/games/:id/env` vrací `library | pending | ready | failed | unavailable` a hotové obrázky přeposílá (`?file=full|low`), takže klíč služby prohlížeč nevidí. Route je bezstavová: služba drží jednu úlohu na prostředí a hotové čte z cache na disku. Panorama se ptá každých 5 s nejvýš 5 minut a hotové vymění bez přenačtení stránky. Selhaná úloha drží ve službě hodinu, aby ji dotazy klientů nepouštěly na kartu znovu. Bez služby, po chybě nebo s pákou `env` (či `all`) ve vypínači zůstává knihovní panorama.

**Splat ne.** Gaussian splat (FlashWorld → Spark) byl podmíněná vrstva nad panoramatem. Váhy FlashWorld jsou CC-BY-NC-SA-4.0, což `RULES.md` §4 nepovoluje (`evals/play/env/flashworld.md`), takže vrstva nevznikla.
