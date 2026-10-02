# WORLDSTREAM PLAY – obálka (P23-C)

Stránky `/play` a `/play/[id]`, veřejné API publikace a remixu, neměnné verze s rodokmenem.
Kompilátor a režisér jsou tu dvojníci nad fixturami (`src/app/api/play/_compiler.ts`,
`_director.ts`); P23-D je přepne na skutečné vrstvy. Nic jiného v `src/app/api/play/**`
fixtury neimportuje.

## Veřejné API

Bez přihlášení. Chybové tělo je všude `{ "error": { "code", "message" } }` – nikdy stack,
cesta ani adresa úložiště. `code` je stabilní, `message` je věta pro člověka.

### `POST /api/play/games` – publikace

Tělo: `{ sentence?: string, spec?: GameSpecV1, seed?: number, parentId?: string | null }`,
právě jedno ze `sentence` / `spec`. `seed` je celé číslo 1..2^31 − 1 (strop `sessionSeed` blueprintu); bez něj se odvodí hashem
z věty nebo specu (nikde `Math.random`, táž věta = táž hra).

Pořadí bran (odmítnutí v kterémkoli kroku = do úložiště nešel ani bajt):

| Krok | Kód | Stav |
|---|---|---|
| vypínač `all` / `sessions` | `DISABLED` | 503 |
| identita za proxy nastavená a neověřená | `OWNER_IDENTITY_REQUIRED` / `OWNER_IDENTITY_UNAVAILABLE` | 403 / 503 |
| strop frekvence (dveře `play`, 50 / 10 s na volajícího, klíč z důvěryhodného konce – `x-vercel-forwarded-for`, ne `x-forwarded-for`) | `TOO_MANY_REQUESTS` / `SERVER_AT_CAPACITY` | 429 + `retry-after` |
| tělo nad 64 kB (měří se po kusech, nad stropem se nic nedrží) nebo věta nad 500 znaků | `BODY_TOO_LARGE` | 413 |
| tělo nedorazilo do 5 s | `BODY_TIMEOUT` | 408 |
| příliš mnoho souběžně čtených těl (volající / instance) | `TOO_MANY_BODY_READS` / `SERVER_AT_CAPACITY` | 429 + `retry-after` |
| tělo není JSON, cizí pole, obojí / ani jedno, špatný `seed` | `BAD_REQUEST` | 400 |
| `parentId` neexistuje nebo nemá tvar id | `UNKNOWN_PARENT` | 404 |
| spec neprošel `readGameSpec` (i z režiséra) | `SPEC_REJECTED` | 422 |

U věty se zdraví úložiště ověří **před** režisérem (`publishRefusal`: 503 `STORE_UNAVAILABLE`), aby se nezaplatil model za hru, kterou by úložiště odmítlo. Vyčerpaný denní strop publikací už publikovanou větu nezavře (200); novou hru odmítne úložiště (429 `PUBLISH_QUOTA`) a synchronní režie se pak nespustí. Autorská verze (`relation: 'upgrade'`) se do denního stropu nepočítá – drží ji strop utrácení a denní počet placených volání režiséra na volajícího (`PLAY_DIRECTOR_CALLS_PER_CALLER`, výchozí 12); volající se pro ten počet pozná jen z důvěryhodného konce (`x-vercel-forwarded-for` na Vercelu, ověřená proxy vlastníka), jinak všichni sdílejí jeden počet – `x-forwarded-for` píše volající. Režisér volá model jen s volným slotem vlastních dveří `play` (pod celkovým stropem souběžných placených volání s `/api/generate` a relacemi WORLDSTREAM); bez slotu je hra návrh ze slov nebo odpověď z cache. Režie má rozpočet 270 s od příchodu požadavku (`maxDuration` 300 s); timeout volání se zkrátí na zbytek a pod 75 s zbytku volání neodejde. Hra od modelu, která neprojde kompilací ani kontrolou (422), spadne na návrh ze slov.

| kompilátor odmítl (u odvozeného semínka se `LAYOUT_FAILED`/`UNWINNABLE` zkouší ještě na třech dalších, `derivedSeeds`) | `MECHANIC_UNSUPPORTED` / `LAYOUT_FAILED` / `WORLD_REJECTED` / `UNWINNABLE` | 422 |
| verifikátor (`verifyGame`) nepustil hru k publikaci – keypoint, svědek, replay nebo rozpočet | `NOT_PUBLISHABLE` + `keypoints: string[]` (ids, které neprošly) | 422 |
| jiná hra pod týmž id (liší se jen to, co do hashe nejde) | `VERSION_CONFLICT` | 409 |
| úložiště neodpovídá | `STORE_UNAVAILABLE` | 503 |

Odpověď **201** `{ versionId, title, parentId, archetype, url: "/play/<id>" }`; táž hra
podruhé **200** téhož tvaru (`versionId` je hash obsahu – čte se dřív, než se píše).

### `GET /api/play/games/:id` – čtení

Tytéž brány jako u zápisu (vypínač čte páku `snapshots`, kterou vypne jedině `all`;
strop frekvence sdílí dveře `play`). `id` musí odpovídat `/^[a-f0-9]{8,64}$/`; jinak i pro neznámé id **404** `NOT_FOUND` –
táž odpověď, ať se z rozdílu nedá nic vyčíst. **200**
`{ version, spec, blueprint, report, children: string[], lineage: GameVersion[] }`
(`lineage` od kořene k listu, nejvýš 32 nejnovějších – uložený při publikaci, ne počítaný
chůzí po rodičích; jeden `GET` = tři příkazy úložiště). `cache-control: public, max-age=0, s-maxage=60`
– verze je neměnná, `children` může být na hraně o minutu pozadu.

Velikost odpovědi nad fixturovými světy: 5–8 kB blueprintu (změřeno nad
`authored-worlds.json`, T1) – hluboko pod 500 kB, blueprint jde klientovi celý.

### `POST /api/play/games/:id/remix` – remix

Tělo: `{ chip: "harder" | "twist" | "swap_enemy" | "reskin" }` nebo `{ spec: GameSpecV1 }`,
volitelně `seed`. Rodič z úložiště (404 `NOT_FOUND`), čip → `remixPatch` + `applyRemix` (`src/play/director/remix.ts`,
RFC 6902 záplata bez modelu; čip, který na hře nemá co změnit, je 422), výsledek přes `readGameSpec` (422),
publikace jako výše s `parentId = id`. **Rodič se nemění**; semínko dítěte se odvozuje
z rodiče a čipu, takže týž čip podruhé je **200** s týmž `versionId`.

Čipy popisuje hlavička `src/play/director/remix.ts` (P23-B T8): `harder` mění právě jeden parametr,
`twist` přidá mechaniku s rolí a keypointem, `swap_enemy` jiný nepřítel (bez něj `harder`),
`reskin` jen `theme`, titul a `label`y.

### `POST /api/play/games/:id/dare` – výzva Dare (P36B T5)

Tělo: `{ inputs: number[], patches?: { tick, patch }[] }`. `inputs` jsou běhy vstupů zhuštěné po čtveřicích
`[mezera, délka, tlačítka, osa]` (`packInputs` v `src/play/score/dare.ts` – držená osa je jedna čtveřice, nejhlučnější
běh 90 s se vejde pod 64 kB), `patches` živé změny přijaté za běhu (`LiveEntry`, nejvýš 32). Server běh přehraje na uložené
arkádové hře (`scoredReplay`, každá změna projde v tiku, kdy padne, `patchProblem`) a uloží `play:dare:<dareId>`
`{ dareId, versionId, score, ticks, hash, liveChanges, createdAt }` s expirací hry (`liveChanges` = kolik živých změn běh
použil; skóre pak patří změněné hře). **Skóre, čas ani hash z těla se nečtou** – pole navíc se zahodí, neodmítnou.
`dareId` = prvních 32 hex SHA-256 z (hra, výsledek přehrání – hash konce, tik, skóre – a změny před koncem běhu
seřazené i uvnitř tiku), ne z poslaných vstupů: týž běh podruhé – i s no-op vstupem, se vstupem po konci nebo
s přeházenými změnami – je **200** s týmž id a denní strop neubírá, nová výzva **201**; obě
`{ dareId, score, ticks }`, `cache-control: no-store`.

| Krok | Kód | Stav |
|---|---|---|
| vypínač, identita, strop frekvence (dveře `play`, jako publikace) | `DISABLED` / `OWNER_IDENTITY_*` / `TOO_MANY_REQUESTS` | 503 / 403 / 429 |
| vlastní okno výzev `play/dare`: 5 za 10 s na volajícího, 10 za 10 s na instanci – výzva přehraje celý běh, až ~250 ms CPU (`MAX_DARE_REQUESTS_PER_WINDOW` v `src/server/rate-limit.ts`) | `TOO_MANY_REQUESTS` / `SERVER_AT_CAPACITY` | 429 + `retry-after` |
| id bez tvaru nebo neznámá hra | `NOT_FOUND` | 404 |
| tělo nad 64 kB / pozdě / souběh čtení | `BODY_TOO_LARGE` / `BODY_TIMEOUT` / `TOO_MANY_BODY_READS` | 413 / 408 / 429 |
| tvar: vstupy nejsou čtveřice celých čísel, cizí tlačítka, osa mimo ±1000, běh delší než 5 400 tiků, změna mimo tvar nebo víc než 32 | `BAD_REQUEST` | 400 |
| mřížková hra, změna, kterou hra nevezme, běh, který hru nevyhraje (i vstupy jiné hry) | `DARE_REJECTED` | 422 |
| denní strop výzev napříč volajícími (`PLAY_DARE_DAILY_CAP`, výchozí 2 000) | `DARE_QUOTA` | 429 + `retry-after: 3600` |
| úložiště neodpovídá | `STORE_UNAVAILABLE` | 503 |

Bez Upstash žije výzva v paměti procesu jako hry (`x-play-store: memory` v produkci). Testy: `src/app/api/play/__tests__/dare.test.ts`.

### `POST /api/play/events` – událost smyčky (P27D T4)

Tělo: `{ name, versionId, session }` a **nic jiného** – `name` z uzavřeného seznamu `impression | first_input | win | lose |
restart | next_game | share | shared_open` (`src/play/loop-events.ts`), `versionId` hex id verze, `session` náhodné id záložky
(12–32 znaků `[a-z0-9]`); jen `share` smí nést booleany `withClip` (šel klip) a `dare` (odkaz nesl výzvu, P36B T6). Klíč
navíc (věta, text) i cokoli mimo tvar je 400 `BAD_REQUEST`; úspěch `204`. Vlastní okno stropu
frekvence (`play/events`), takže statistika hráči neubere kvótu na tvorbu; páka `sessions` vypne i tyhle dveře. Zápis: řádek
do `data/play/events/<den>.jsonl` pod `next start`, na Vercelu řádek `[play-loop] {…}` do logu funkce; souhrn s jmenovateli
`scripts/play-loop-report.mjs`. Robot ověřovače (sonda `playWitness`) ani ukázka „Show me how“ události neposílají.
Sdílený odkaz nese `?via=share` a jeho otevření je `shared_open` – samotné sdílení doručení nedokládá. Po výhře arkády
pošle klient vstupy běhu na `…/dare` hned (nabídka sdílení chce čerstvé gesto) a „Dare a friend to beat it“ sdílí
`/play/<hraná verze>?via=share&dare=<dareId>`; když výzva nevyjde, obyčejný odkaz a toast „Couldn't attach your score…“.

## Verze a úložiště

`sealVersion` (`src/play/version/version.ts`): `versionId = gameVersionId(specHash, worldHash,
seed, schemaVersion, compilerVersion, runtimeVersion, parentId)`; titul a `createdAt` do hashe
nejdou. `VersionStore` (`store.ts`): paměť procesu, nebo Upstash REST z téhož obchodu jako
kniha stropu (`sharedStoreFromEnv`, klíče `<prefix>:play:v:<id>`, `<prefix>:play:children:<parentId>`,
`<prefix>:play:lineage:<id>`),
`SET … NX` = zapiš jednou; čtení nikdy nevyhazuje, zápis při výpadku `VersionStoreUnavailable`.

## Testy

`npx vitest run src/play src/app/api/play` – švy nad skutečnými vrstvami (`stubs.test.ts`),
brány placené větve režiséra (`director-seam.test.ts`), verze a úložiště (`version.test.ts`,
oba backendy), remix (`director-remix.test.ts`), routy s osmi poli Oracle a `NOT_PUBLISHABLE`
(`routes.test.ts`, handlery volané přímo).

## Stránky

| Adresa | Soubor | Co dělá |
|---|---|---|
| `/play` | `src/app/play/page.tsx`, `src/components/play/CreateGame.tsx` | věta → `POST /api/play/games` → přechod na `/play/<id>`; osm startovních karet |
| `/play/<id>` | `src/app/play/[id]/page.tsx`, `src/components/play/PlayShell.tsx` | hra: plátno, HUD, karty cílů, konec, po dohrání, rodokmen, „How this game works“ |
| `/play/<neznámé id>` | `src/app/play/[id]/not-found.tsx` | 404 s větou `This game does not exist or has expired.` a odkazem na `/play` |
| `GET /api/play/games/:id/og` | `src/app/api/play/games/[id]/og/route.ts`, `_og.ts` | PNG 1200×630 podle `spec.theme.mood`, `s-maxage=3600`; neznámé id 404 JSON |
| `GET /api/play/games/:id/voice` | `src/app/api/play/games/[id]/voice/route.ts`, `_voice.ts` | cíl hry přečtený hlasem (Ogg, `immutable`), nebo 204 `no-store`, dokud není hotový; neznámé id 404 JSON |

Stránka hry čte úložiště verzí přímo (ne přes HTTP), bez přihlášení a bez kroku „create“.
`generateMetadata` dává `<title>` `<titul> – WORLDSTREAM PLAY`, `og:description` = `tutorial.goalLine`
a absolutní `og:image` složený z hlaviček požadavku (kořenový layout `metadataBase` nemá).

**Ovládání „klepni na cíl“** (`targets.ts`): karta na každý cíl hráče z `controller.actions`,
popisek z `blueprint.objects[].label`. První klepnutí `moveTo`, druhé na tutéž kartu `pickup`
nebo `use`, když je svět pro ten cíl deklaruje (jinak karta hlásí `Move here`). Klávesy 1–9,
mezerník, E přes `intentFromKey`. Klepnutí přímo na mesh v plátně není – vyžadovalo by zásah
do `WorldstreamCanvas.tsx` (nález pro P23-D). Autorské světy dvojníka nabízejí jen `moveTo`.

**Hodiny:** `setInterval` po 50 ms volá `advanceTicks(1)`, dokud hra běží, svět je postavený
a záložka je vidět. **Replay** přetočí runtime na tik 0 (`observeAt(0)`) a nechá hodiny
přehrát uložené vstupy – nic se nepřipíše, konec je tentýž tik.

**Po dohrání:** čipy `play-chip-<harder|twist|swap_enemy|reskin>` → `POST …/remix` → nová
stránka (shell má `key` = id verze, takže dostane nový runtime). `CHALLENGE A FRIEND` kopíruje
adresu; bez schránky ukáže pole s adresou. Měď čipů je opis `CHIP_LABELS` ve `starters.ts`
(klient nesmí táhnout zod přes `src/play/remix`), test ji drží proti balíčku i remixu.

**„How this game works“:** věty skládá server (`lab.ts` – registr mechanik zůstává mimo
klientský bundl): mechaniky s vysvětlením a parametry, `Rules checked: N/M`,
`Winnable at tick T` / `Not proven`, `Replay: identical` / `stub`, zkrácené id a předci.

**Mikrofon (P29D T6):** `MicButton.tsx` vedle pole v `CreateGame` (`play-mic`) a v `RemixBox`
(`remix-mic`) diktuje větu přes Web Speech (`@/input/speech`, anglicky); přepis se k napsanému
přidá. Prohlížeč bez Web Speech (Firefox) tlačítko nevidí vůbec. Výzva `FirstPrompt` pole nemá
– je to jen překryv s povelem –, takže mikrofon pro změnu uprostřed hry nese pole živé změny.
**Offline přepis Moonshine se nepřidal (rozhodnuto 26. 9. 2026):** model sám by pravidlo splnil
(MIT, kvantovaný `moonshine-tiny-ONNX` = enkodér 7,9 MB + dekodér 20,2 MB ≈ 28 MB ≤ 60 MB),
ale cesta do prohlížeče vede přes `@huggingface/transformers` (Apache-2.0), který tahá `sharp`
a s ním binárky `@img/sharp-libvips-*` pod **LGPL-3.0-or-later** – mimo MIT/Apache/BSD
(`RULES.md` §4). Vlastní dekodér nad holým `onnxruntime-web` (MIT) by byl nový kus práce,
ne přidání; do té doby zůstává tlačítko bez Web Speech skryté.

**Živá změna (P29D T9):** `LiveBox.tsx` – tlačítko `Change` (`live-open`) nebo Enter mimo pole
otevře pole (`live-input`) s mikrofonem (`live-mic`). Hra běží dál a klávesy psané do pole si
nevezme. Enter v souboji, načasování a hrách se střelbou (`blaster`) patří hře, tam jen tlačítko. Výsledek hlásí `live-status`
(`data-kind`: `live`, `remix`, `unknown`, `refused`). Počasí a denní dobu kreslí `Weather.tsx`
jako CSS překryv nad plátnem. Pravidla patchů: `ARCADE.md` → „Živé změny“.

**Klip (P29D T1–T2):** `arcade/clip.ts` nahrává plátno nativním `MediaRecorder` přes
`captureStream` (bez závislosti), nejvýš 16 s včetně 1,5 s dojezdu po konci; ukázka robota klip
nemá. Po hře `Save clip` (`play-save-clip`) a Share: kde nabídka sdílení bere soubory, jde klip
s odkazem, jinak se klip stáhne a odkaz zkopíruje. Prohlížeč bez `captureStream` tlačítko nevidí.

**Zvuk (P29D T5, T11):** hudba a efekty jsou předgenerovaná knihovna podle `lookOf(theme)`
a nálady (`src/play/audio/library.ts`, katalogy z `ops/audio`). Nic se nestáhne před prvním
gestem, chybějící soubor zní syntetickým ZzFX, `M` / `play-mute` ztlumí všechno a
`PLAY_MUSIC=off` při buildu vypne hudbu. **Hlas vypravěče** přečte cíl hry jednou po prvním
gestu, jen když je nahrávka hotová (dveře `…/voice`), ztlumená hra ho nespustí a ztlumení ho
utne. Nahrávky dělá lokální Kokoro-82M (`ops/audio/server.py`) – bez `PLAY_VOICE_ENDPOINT`
a `PLAY_VOICE_KEY` hra mlčí a publikace je stejná.

## Sonda `window.__playShell`

Jen pro e2e, stejný vzor jako `__worldstreamStage`: `inputs()` (vstupní log runtime),
`tick()`, `playWitness()` – přehraje `witness.ops` světa posunuté o aktuální tik a dotočí běh
do konce (strop 3 600 tiků), vrací `{ runState, tick }`.

## e2e

`E2E_PORT=3121 npx playwright test --project=chromium e2e/play-*.spec.ts` – 14 testů, ~2 min
včetně buildu. `play-create` (formulář), `play-shell` (HUD, tik, klepnutí, mobil 390×844,
svědek → `You won`), `play-postrun` (Replay, čip → jiné id a rodokmen, sdílení),
`play-share` (čistý kontext, OG meta a PNG, 404), `play-language` (lexikální filtr z
`interface-language.spec.ts` nad všemi obrazovkami a otevřeným panelem). Po běhu `git status`.
