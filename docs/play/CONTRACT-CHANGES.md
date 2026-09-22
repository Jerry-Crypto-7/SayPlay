# Nálezy proti sdílenému kontraktu (P23)

Základ (`spec.ts`, `registry.ts`, `contracts.ts`, fixtury) se v plánech P23-A/B/C nemění.
Co v něm chybí nebo neplatí, přistane tady a P23-D to sloučí najednou.

## P23-A – kompilátor a verifikátor

### `estimateCost` není horní mez (T7, 20. 9. 2026)

`registry.ts` slibuje „odhad shora: kompilátor smí vydat méně, nikdy víc“ a `readGameSpec`
z něj počítá `budgets.maxRules`. Skutečné počty pravidel adaptérů (bez `sys.moveTo.*`,
které odhad přičítá za entitu) jsou u sedmi mechanik vyšší:

| Mechanika | Odhad registru | Kompilátor vydá | Proč |
|---|---|---|---|
| `collectible` | 2 | `count + 1` | pravidlo na instanci – rolový `onPickup` dá složený predikát mimo abecedu hledače |
| `hazard_zone` | `count + (pulse ? 3 : 0)` | `count × (pulse ? 3 : 2) + (pulse ? 2 : 0)` | `enter` + `start` (hráč už stojí v zapnuté zóně) + `catch` (zóna se zapne pod hráčem) na instanci |
| `switch` | `2n + 1` | `4n` | stráže vidí stav před tikem, dveře zkouší kombinaci „po přepnutí“ |
| `chaser` | `12 × count + 1` | `count × (w × h + 2)` | sleduje po buňkách, ne po 12 pásmech (`chase_escape` seed 1: 68 pravidel) |
| `lock_key` | 2 | `keysNeeded + 1` | pravidlo sběru na instanci klíče |
| `defeat` | `count × hitsPerTarget + 1` | `2 × count + 1` | `hit` + `down` na cíl bez ohledu na `hitsPerTarget` |
| `carry` | `fragile ? 4 : 3` | `items × (2 + destinations + fragile × movers)` | sběr v cíli vyhrává rovnou (stráž `hasItem` po sběru v témž tiku ještě neplatí); křehký dort se rozbije o každého chodce |

Naměřeno nad fixturami, seed 1 (pravidla adaptérů + `sys.moveTo` vs. odhad): `collect_exit`
14 / 10, `chase_escape` 76 / 22, `survival_timer` 28 / 18, `switch_puzzle` 18 / 14,
`hazard_crossing` 31 / 23, `combat_lite` 18 / 13; `checkpoint_race`, `delivery` pod odhadem.
Žádná fixtura nepřekročí `REGISTRY_LIMITS.maxRules` (200), ale `budgets.maxRules` ve specu
je proti skutečnému světu měkký. **Návrh pro P23-D:** přepsat `cost` na vzorce z tabulky;
`chaser` buď zastropovat plochou mřížky, nebo nechat kompilátor vydat pásma, až bude hledač
umět více než jeden `moveTo` na tik.

**Vyřešeno 21. 9. 2026 (P23-D R1):** `cost` sedmi mechanik počítá podle tabulky a z počtu
instancí rolí, ne z parametrů; `chaser` bere horní mez plochy mřížky (`maxLayoutCells` přes
všechny hody kompilátoru – mřížka se přestěhovala do registru jako `LAYOUT_GRID`), `carry`
počet chodců z druhů rolí. Navíc `patrol`: mysl `1 + stops × 3` plus `touch` na instanci
(odhad byl o jedno pravidlo pod `delivery`). `registry-cost.test.ts` drží skutečný počet
pravidel světa (`ir.rules` včetně `sys.moveTo` a myslí) ≤ odhad nad všemi fixturami,
semínka 1–8; po opravě `collect_exit` 14 / 14, `chase_escape` 76 / 77, `delivery` 19 / 19.

### `property_transform.from` mimo výchozí stav role (T7)

Výchozí stav entity dává druh role (`INITIAL_STATE` v `compile/sim.ts`: `exit` → `open`,
`hazard` → `on`, `checkpoint` → `pending`, …). `from`, které se s ním neshoduje a žádná
mechanika ho nenastaví, je mrtvé pravidlo – spec projde, transformace nikdy nevystřelí.
**Návrh:** validovat `from` proti výchozímu stavu druhu role, nebo ho ze schématu vypustit a
brát výchozí stav role.

**Vyřešeno 21. 9. 2026 (P23-D R2):** výchozí stavy se přestěhovaly do `spec.ts`
(`ROLE_INITIAL_STATE`), mechaniky deklarují `setsStates` a `readGameSpec` odmítne
(`MECHANIC_REJECTED`) `from`, který role nemá od startu a žádná mechanika ho nenastaví.
Shodu `setsStates` s adaptéry drží `registry-cost.test.ts` nad všemi fixturami.

### `property_transform` s `trigger: 'timer'` nemá délku (T7)

Parametry nemají `afterSeconds`; kompilátor bere pevných `TRANSFORM_AFTER_SECONDS = 10`.
**Návrh:** přidat `afterSeconds` do `propertyTransformParams`.

**Vyřešeno 21. 9. 2026 (P23-D R2):** `afterSeconds` volitelné (1–180, výchozí 10), kompilátor
ho použije; konstanta zmizela.

### `spawn_wave` oživuje, nespawnuje (T7)

Runtime nezná „neaktivní od startu“ (`active` začíná 1 pro každou entitu) a `despawn` není
v capabilities `spawn_wave`. Vlna proto oživuje členy poolu, které jiná mechanika (`defeat`)
odstranila; bez ní se nikdy nic neobjeví. `explanation` v registru („New things … appear on a
schedule“) slibuje víc. **Návrh:** buď `active: false` v `SurfaceEntity` pro pool nad
`maxAlive`, nebo přepsat `explanation` a `roleRefs` tak, aby `spawn_wave` vyžadoval `defeat`
na téže roli.

**Vyřešeno 21. 9. 2026 (P23-D R3):** oživení zůstává (runtime „neaktivní od startu“ pořád
nezná), ale je úplné: s `defeat` na téže roli přidá `spawn_wave` na instanci `revive` –
vstup do hnízda ve stavu `down` vrátí `alive` a vynuluje čítač zásahů (dřív byl oživený cíl
aktivní a nezranitelný). `explanation` teď slibuje návrat sražených, ne nové kusy. Test nad
`combat_lite` + `spawn_wave`: oživený slime jde srazit podruhé.

## P23-B

- **`DirectorResult` větev `ok:false` nemá kdy nastat.** `direct()` (`src/play/director/index.ts`)
  má vždy návrh ze slov (`draftGameSpec` nikdy nevrátí `null`), takže výpadek modelu, nečitelná
  odpověď i neopravitelný spec končí `ok:true, source:'draft'` a důvod jde do `fallbackReason`
  (`MODEL_UNAVAILABLE` | `MALFORMED` | `UNREPAIRED`). `DirectedGame` je **rozšíření**
  `Extract<DirectorResult, {ok:true}>` o `fallbackReason`, `warnings`, `ms`, `calls` –
  přiřaditelné do kontraktu beze změny. Návrh: při společném kroku větev `ok:false` z
  `DirectorResult` vypustit a `fallbackReason` do kontraktu přidat.
  **Vyřešeno 21. 9. 2026 (P23-D R4):** `DirectorResult` je jediný tvar `ok: true` s
  `fallbackReason`; `FallbackReason` bydlí v kontraktu, `DirectedGame` ho jen rozšiřuje.
- **Klíč cache** bere `endpoint` z `GenerationBranch.id` a `model` z `UpstreamRequest.model`
  (= `EMISSION_MODEL`), protože `direct()` dostává větev, ne konfiguraci. Kdyby obálka měla dva
  koncové body s týmž `id`, potřebuje kontrakt `branch.id` odlišit – zatím není důvod.

## P23-C

- **`CompiledGame.compilerVersion` rozšířit na `string`.** Dnes je typované jako
  `typeof GAME_COMPILER_VERSION` (`'play-compiler-v1'`), takže dvojník kompilátoru
  (`src/app/api/play/_compiler.ts`) svou verzi `'stub-authored-v1'` vydává přes přetypování
  na jednom místě. `GameVersion.compilerVersion` už `string` je; `CompiledGame` by měl
  být stejně široký, aby dvojník i budoucí druhá verze kompilátoru prošly bez castu.
  **Vyřešeno 21. 9. 2026 (P23-D R4):** `CompiledGame.compilerVersion: string`.
- **`gameVersionId` dává 8 hex znaků (FNV-1a 32 bitů z `canonicalHash`).** Veřejné id
  hry s 2^32 hodnotami je na hraně kolize už u desítek tisíc her; obálka (`_errors.ts`)
  proto přijímá `/^[a-f0-9]{8,64}$/`, aby delší hash prošel bez změny. Doporučení: v
  kontraktu spočítat `versionId` přes SHA-256 (`node:crypto` je na serveru, kde se
  pečetí, k dispozici) a nechat `canonicalHash` jen pro `specHash`/`worldHash`.
  **Vyřešeno při sloučení 20. 9. 2026:** bezpečnostní revize id trefila hrubou silou za
  7,6 min (volný `seed`), takže `gameVersionId(fields, spec)` je od teď prvních 128 bitů
  SHA-256 nad poli verze i celým specem (32 hex). Zároveň dostaly klíče hry expiraci a
  publikace denní strop (`PLAY_VERSION_TTL_SECONDS`, `PLAY_PUBLISH_DAILY_CAP`; `put` → `quota`, routa 429 `PUBLISH_QUOTA`).

## P23-D

- **Progresivní hra přidala tři volitelná pole do uloženého `PublishedGame`, ne do
  `GameVersion`** (T2, 21. 9. 2026): `origin { sentence, seed }` u návrhu z věty (upgrade jde
  spustit i z procesu, který POST neviděl), `relation: 'upgrade'` u autorské verze návrhu
  (`parentId` = návrh; remix pole nemá) a `timings` (`ackMs`, `draftReadyMs`, `directorMs`,
  `compileMs`, `verifyMs`, `source`). Do `versionId` nejde nic z toho; `put` porovnává obsah
  bez `timings`, takže táž verze s jinými časy je `exists`. `GET /api/play/games/:id` je vrací
  beze změny tvaru ostatních polí; `POST` s větou vrací navíc `upgrade` (adresu dotazu).

## P24

- **`GAME_COMPILER_VERSION` → `play-compiler-v2`** (22. 9. 2026). Pronásledovatel se poprvé
  rozjíždí až po `CHASER_START_GRACE` = 60 tiků (3 s), dřív za `CHASER_DELAY` (8 tiků): hráč
  v honičce prohrál na ticku 17 bez jediného vstupu. Mění to pravidla simulace, a tedy
  `worldHash` u `chase_escape`; ostatní archetypy mají svět beze změny. Blueprint navíc
  vyřezává kulisy rodiny nad hrací plochou (`carve` + rovný terén) – to je geometrie, ne
  simulace, a `worldHash` nehýbe. Staré publikované hry zůstávají pod `play-compiler-v1`.

## P25B

- **`GAME_COMPILER_VERSION` → `play-compiler-v3`** (22. 9. 2026, T2). Hlídka (`patrol`) volí
  zastávky tak, aby obdélník mezi po sobě jdoucími zastávkami (i od startovní buňky) nepokryl
  spawn hráče; po 400 pokusech bere jakoukoli volnou buňku. Duchové v `collect_exit` jinak
  zabili nečinného hráče v 6. tiku a hra nešla certifikovat. Mění se spotřeba losovače, a tedy
  `worldHash` u archetypů s hlídkou (fixtura `delivery`). Tvar `GameSpec` ani registru beze
  změny; návrh ze slov jen přidá roli `enemy` (hlídka nebo pronásledovatel) a keypoint
  `enemy_touch_loses`.
