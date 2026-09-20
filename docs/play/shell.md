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
právě jedno ze `sentence` / `spec`. `seed` je celé číslo 1..2^31; bez něj se odvodí hashem
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
| kompilátor odmítl | `MECHANIC_UNSUPPORTED` / `LAYOUT_FAILED` / `WORLD_REJECTED` / `UNWINNABLE` | 422 |
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
volitelně `seed`. Rodič z úložiště (404 `NOT_FOUND`), čip → `applyChip` (`src/play/remix/chips.ts`,
lokální dvojník remixu z P23-B, jen pole schématu), výsledek přes `readGameSpec` (422),
publikace jako výše s `parentId = id`. **Rodič se nemění**; semínko dítěte se odvozuje
z rodiče a čipu, takže týž čip podruhé je **200** s týmž `versionId`.

Čipy: `harder` – rychlejší pronásledovatel / kratší čas / +2 sbíraných, bez toho kratší hra;
`twist` – jedno koření navíc (`timer` → `health` → `counter`) s keypointem; `swap_enemy` –
jiný label a povaha nepřítele, bez nepřítele `harder`; `reskin` – jiné `theme` a titul.

## Verze a úložiště

`sealVersion` (`src/play/version/version.ts`): `versionId = gameVersionId(specHash, worldHash,
seed, schemaVersion, compilerVersion, runtimeVersion, parentId)`; titul a `createdAt` do hashe
nejdou. `VersionStore` (`store.ts`): paměť procesu, nebo Upstash REST z téhož obchodu jako
kniha stropu (`sharedStoreFromEnv`, klíče `<prefix>:play:v:<id>`, `<prefix>:play:children:<parentId>`,
`<prefix>:play:lineage:<id>`),
`SET … NX` = zapiš jednou; čtení nikdy nevyhazuje, zápis při výpadku `VersionStoreUnavailable`.

## Testy

`npx vitest run src/play src/app/api/play` – dvojníci (`stubs.test.ts`), verze a úložiště
(`version.test.ts`, oba backendy), čipy (`chips.test.ts`), routy s osmi poli Oracle
(`routes.test.ts`, handlery volané přímo).
