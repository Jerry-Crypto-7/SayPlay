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

## P25A

- **`GameSpec` → volitelné `control: 'tap_go' | 'runner'` a `controlParams`** (22. 9. 2026).
  Bez `control` je hra `tap_go` – dnešní mřížka, beze změny. Pole nemá výchozí hodnotu
  schválně: default by se vepsal do každého přečteného specu a pohnul `specHash` všech her.
  `controlParams` (`speed` slow/normal/fast, `density` low/normal/high, `lengthM` 60–500,
  `obstacles` hurdle/slide-bar/cone/crate) bere jen `control: 'runner'`, jinak
  `MALFORMED_SPEC`. Prompt režiséra tím narostl z 10 485 na 10 654 B.
- **`CompiledGame.blueprint` a `PublishedGame.blueprint` smí být `null`; nové volitelné
  `arcade: ArcadeWorld`.** Arkádová hra (`src/play/arcade`) nemá mřížkový svět – hraje se
  z `arcade`. `compileGame` ji pozná podle `control` a pošle do `compileArcade`; `reportFor`
  ji ověří `verifyArcade` (robot se zpožděním 8 tiků vyhraje, nečinný hráč ne, dvojí přehrání
  = týž hash, meze jádra) do téhož `QualityReport` – keypointy `bot_wins`, `idle_loses`,
  `replay_equal`, `within_limits`. `worldHash` = `canonicalHash(arcade)`,
  `compilerVersion` = `${GAME_COMPILER_VERSION}/arcade-v1` (po sloučení s P25B
  `play-compiler-v3/arcade-v1`). `verifyGame` na arkádovou hru hodí
  výjimku (nemá ji kdo volat). Hashe v `evals/play/compiled/report.json` beze změny.
- **Po sloučení (revize P25A):** trať, kterou vyhraje i nečinný hráč, vrací `compileArcade`
  jako `LAYOUT_FAILED` (dveře zkusí další semínko); vylepšení režisérem, které změní
  `control` návrhu, skončí `draft-final` / `MALFORMED` a dítě nevznikne.

## P25B

- **`GAME_COMPILER_VERSION` → `play-compiler-v3`** (22. 9. 2026, T2). Hlídka (`patrol`) volí
  zastávky tak, aby obdélník mezi po sobě jdoucími zastávkami (i od startovní buňky) nepokryl
  spawn hráče; po 400 pokusech bere jakoukoli volnou buňku. Duchové v `collect_exit` jinak
  zabili nečinného hráče v 6. tiku a hra nešla certifikovat. Mění se spotřeba losovače, a tedy
  `worldHash` u archetypů s hlídkou (fixtura `delivery`). Tvar `GameSpec` ani registru beze
  změny; návrh ze slov jen přidá roli `enemy` (hlídka nebo pronásledovatel) a keypoint
  `enemy_touch_loses`.
- **`patrol.params.sight?: boolean`** (T3, plížení). Nový volitelný parametr registru; bez něj
  se hlídka kompiluje beze změny (hashe v3 drží). S ním je každý úsek trasy zóna
  `<instance>_beat<i>` a hráč na úseku, který hlídka právě jde, prohraje; úseky se vyhnou cestě
  svědka spawn → cíl. `patrol` má v capabilities navíc `onStart` (hráč vstříknutý do výhledu).
  Plížení je varianta `collect_exit`, ne nový archetyp: registr už hlídku v každém archetypu
  povoluje a cíl „ukradni a uteč“ je sběr + východ. Režisér vidí parametr ve schématu (prompt
  +70 B, pin 10 555 B).
- **`switch.params.ordered?: boolean`** (T4, pořadí). Bez něj se spínače kompilují beze změny
  (hashe v3 drží). S ním jdou žádané spínače zapnout jen v pořadí `required`; stisk mimo
  pořadí (pravidlo `switch.<sw>.wrong`) vypne všechny žádané a dveře zůstanou zamčené. Svědek
  tiskne v pořadí `required`. Návrh ze slov: „in the right order“ a „knock … off“ jsou cue
  `switch_puzzle` (věta s080 už nepadá do `checkpoint_race`), keypoint `wrong_order_resets`.
- **`switch.params.crateRole?: roleRef`** (T4, bedny). i-tá žádaná deska dostane i-tou instanci
  role; cesta bedny x-pak-y se dělí na nejvýš `PUSH_STEPS = 3` úseky (sokety
  `<bedna>_push<k>`, čítač `<bedna>_at`) a `use` na bednu ji posune o úsek. Deska se zapne
  příjezdem bedny (`onEnterZone`), ne stiskem; dveře odemkne příjezd, když ostatní spínače sedí.
  Capabilities `switch` navíc `onEnterZone`, `moveTo`, `addCounter`. Svědek po posledním posunu
  čeká dalšími `use` naprázdno, než bedna dojede. Návrh ze slov: „push boxes/crates onto“ →
  role `box` (`prop`), keypoint `crate_opens` (věta s072). Bez parametru beze změny hashů.
- **`carry.params.menu?: roleRef[]`** (T5, objednávky). Jídla jsou výdejny (sběr dá do slotu
  ID role jídla), i-tý zákazník (instance `destinationRole`) chce `menu[i mod délka]`. Předávka
  je `use` na zákazníka (vstup do zóny by obsloužil zákazníka po cestě); správné jídlo odebere a
  přičte `orders_served` + `<zákazník>_served` (max 1), špatné nic. Všichni obslouženi = výhra,
  prohru dává časovač směny. Capabilities `carry` navíc `onAction`, `onCounterReaches`,
  `addCounter`. Fixtura `delivery_orders`, keypointy `right_order_scores`,
  `wrong_order_ignored`. Návrh ze slov: vaření/zákazníci/obchod/farma nebo jídlo bez „… to Y“ →
  objednávky (s160–s166); „carry/deliver X to Y“ zůstává nesením. Pin promptu režiséra
  10 555 → 10 615 B (tři nové parametry ve schématu). Bez parametru beze změny hashů.

## P25C

- **`ARCADE_RUNTIME_VERSION` → `arcade-v2`** (22. 9. 2026, T1), tedy `compilerVersion`
  arkádových her `play-compiler-v3/arcade-v2`. Co se změnilo v jádru:
  - **Hlavička stavu +4 sloty** (`spawnBase`, `respawnX/Y/Z`), čítače od slotu 8, těla od 16.
  - **Pevné tělo zastaví hráče i z boku a zespodu** (dřív jen dopad shora): bok vrátí hráče na
    hranu a vynuluje `vx`/`vz`, strop vynuluje `vy`; kontakt se hlásí dál, takže pravidlo
    `hit` běžce prohraje stejně. Odkud hráč přišel, se čte z polohy před integrací (u
    pohyblivého tělesa z jeho polohy minus rychlost).
  - **`BodyInit` volitelně `vx/vy/vz`, `gravity`, `kinematic`, `template`**; `ArcadeLevel`
    volitelně `spawnSlots` (rezerva pro spawn, součet s těly ≤ `maxBodies`). `FLAG.kinematic`:
    tělo jede jen svou rychlostí (gravitace ani země ho nezastaví) a hráč, který na něm stojí,
    se veze. `template` = předloha pro spawn, ve světě mrtvá.
  - **Role navíc** `platform` 6, `hazard` 7, `enemy` 8, `projectile` 9, `target` 10,
    `checkpoint` 11 (stávající čísla beze změny).
  - **Efekty navíc** `spawn` (kopie předlohy na pozici s rychlostí; slot = první mrtvý
    spawnutý, jinak rezerva, jinak se zahodí – těla úrovně se nikdy nepřepíšou), `respawn`
    (hráč na místo návratu bez rychlosti) a `checkpoint` (místo návratu = horní hrana těla).
    `checkpoint` plán neuváděl; bez něj by `respawn` uměl jen start, a plošinovka (T2) ho
    potřebuje.
- **Hash běžce se mění vědomě:** stav je o 4 sloty delší, takže `worldHash` i hash každého
  přehrání běžce je jiný. Výsledek her se nemění – robot běžce do boku nenaráží (náraz = prohra
  i dřív); jediný viditelný rozdíl je, že prohraná hra končí na přední stěně překážky, ne v ní
  (pin ve `verify.test.ts`: zeď v 60 m → „59 m into the track“). Pinovaný hash běžce v testech
  není. Hashe mřížkových her (`evals/play/compiled/report.json`) beze změny.
- **Uložené hry `arcade-v1` hrají dál:** `instantiate` pozná `runtimeVersion: 'arcade-v1'` a
  počáteční stav převede do rozložení v2 (vloží `spawnBase` a místo návratu = start hráče).
- **`GameSpec.control` += `'platform' | 'flap'`** (T5). `controlParams` je ve schématu sjednocení
  parametrů běžce, plošinovky a poletování (všechna pole volitelná, bez výchozích hodnot, takže
  `specHash` starých her se nehne); `readGameSpec` je pak ověří proti schématu zvoleného
  `control` – parametry jiného ovládání = `MALFORMED_SPEC` s `(… control)` na konci hlášky.
  Hláška pro parametry u mřížkové hry se změnila na „only an arcade game (runner, platform,
  flap) takes control parameters“. Kód, který čte pole běžce (`speed`, `density`,
  `obstacles`), musí `controlParams` zúžit na `RunnerParams`. Kompilátor posílá do arkádového
  jádra každé `control` kromě `tap_go`.

## P25D

- **`timer.params.phases?: { goSeconds, stopSeconds, watcher? }`** (22. 9. 2026, T1,
  červená–zelená). Parametr dostal `timer`, ne `patrol`: světlo je čistě hodinové (žádná
  trasa ani mysl postavy) a `timer` je koření povolené v každém archetypu. Časovače
  `<id>_go`/`<id>_stop` střídají flag `<id>_red`; každý sloupec a řádek mřížky je zóna
  `<id>_col<x>`/`<id>_row<y>` a vstup hráče do kterékoli v červené prohraje (runtime nemá
  událost „pohnul se“, každý krok ale vstoupí do nového sloupce nebo řádku). Flag
  `<id>_armed` z `onStart` odfiltruje první tik, ve kterém runtime vidí hráče „vstoupit“ do
  buňky, kde stojí. `watcher` (role) je v zelené `away`, v červené `watching`. Capabilities
  `timer` navíc `onEnterZone`, `setFlag`, `setState`; `CostWorld` má nově `maxSpan`
  (šířka + výška mřížky). `AdapterOutput.witnessWindow` řekne `planWitness`, že svědek smí
  chodit jen v zelené. Návrh ze slov: „red light / green light / squid game / when you don't
  look / freddy / fnaf“ → `collect_exit` se světlem a hlídačem (s153, s176, s178), keypointy
  `moving_on_red_loses` a `standing_on_red_is_safe`. Fixtury P25D leží v
  `src/play/__fixtures__/p25d/`, aby nehýbaly počtem fixtur v testech jiných plánů. Pin promptu
  režiséra 11 253 → 11 362 B. Bez parametru beze změny hashů.
- **`collectible.params.hiddenIn?: roleRef`** (22. 9. 2026, T2, hledání schovaných věcí).
  i-tý předmět leží v i-té instanci role skrýše; `onStart` všechny schované předměty
  despawnuje (neaktivní entita se nevykreslí), vstup hráče do skrýše předmět spawne (vlastní
  pool na předmět, `tag` = ID instance) a nastaví čítač `<instance>_found`. Runtime akci na
  neaktivní entitu nezakáže, proto sebrání hlídá i `<instance>_found = 1`. Capabilities
  `collectible` navíc `onStart`, `onEnterZone`, `despawn`, `spawn`. Svědek jde do skrýše,
  pak sbírá. Návrh ze slov: „hidden / hide and seek / explore / ruins / search“ mění sběr na
  hledání (skrýší o dvě víc než předmětů), pod vodou relikvie v troskách a cíl „surface“
  (s074, s184); keypoint `hidden_item_does_not_count`, počítací keypoint šablony nejdřív
  vstoupí do skrýše. Pin promptu režiséra 11 362 → 11 453 B. Bez parametru beze změny hashů.
- **`hazard_zone.params.pulse.alternate?: boolean`** (22. 9. 2026, T3, pohyblivé zdi).
  Instance 2k a 2k+1 jsou dvě polohy jedné zdi: liché svítí, když sudé ne (pravidlo
  `<role>.stagger` z `onStart` je vypne, `catch` liché polohy čeká na konec `on` časovače).
  Runtime má `space.blocked` pevné a entity neblokují, takže zeď cestu nezavře – vstup do
  polohy, kde zeď stojí, prohraje. Návrh ze slov: „walls that move / moving walls / shifting
  maze“ → dvě zdi (role `wall`, 4 instance) v `collect_exit` (s076), keypointy
  `standing_wall_loses` a `moved_wall_is_safe`. Bez parametru beze změny hashů.

## P25E

- **`POST /api/play/games` → volitelné `honesty: { reason, closest }`** (T2). Jen u věty, na
  kterou knihovna ovládání nemá (`unsupportedGame` v `src/play/draft/unsupported.ts`: třídy
  `sandbox`, `manipulate`, `idle`, `build_place`). Hra se publikuje dál; `closest` je hra, kterou
  návrh postavil místo toho („a collect-and-escape game“). Spec, verze ani hashe se nemění –
  `/play/[id]` hlášku počítá znovu z `origin.sentence` (u upgradu z rodiče) a ukáže proužek.

## P25G

- **Projektil v jádře** (23. 9. 2026, T1). Role `projectile` dostala chování; `arcade-v2` se
  nezvedá, protože žádný kus ani fixtura před P25G projektil nestaví (běžec, plošinovka ani
  poletování role nepoužívají) – hashe jejich světů i přehrání beze změny.
  - **`BodyInit.lifetime?`** (tiky 1..`maxTicks`, výchozí `PROJECTILE_LIFETIME` = 180) a
    **`bounce?`** (0..`BOUNCE_MAX` = 1000), jen pro roli `projectile`; `buildWorld` odmítne
    jiný rozsah, tato pole u jiné role a kinematický projektil. Ve stavu: `aux0` = odraz,
    `aux1` = zbývající život; efekt `spawn` je u projektilu z předlohy nenuluje.
  - **Spouštěč pravidla `hit`**: projektil skončil – zásah živého `target`/`enemy`/pevného
    těla (`other` = tělo), nebo zem bez odrazu, dokutálení či dohasnutí (`other` = −1). Jádro
    projektil despawnuje samo; `RuleContext` má nově povinné `source` (projektil u `hit`,
    jinak −1) – kód, který kontext skládá sám (testy), ho musí doplnit.
  - **Hráč projektil nevidí:** `collide` role `projectile` přeskočí (ani zastavení, ani
    kontakt), aby střela nezasáhla střelce. Nepřátelská střela na hráče zatím není.
  - Pořadí tiku: … kolize hráče → projektily → pravidla (`contact`, `hit`, `tick`, `counter`).
- **Čítače zbraně a efekt `count`** (23. 9. 2026, T2). `COUNTER` += `ammo` 2, `reserve` 3,
  `cooldown` 4 (sloty hlavičky existovaly, jen neměly jméno); efekt `{ kind: 'count', counter,
  amount }` přičte k čítači; `ArcadeLevel.counters?` nastaví počáteční hodnoty (kromě `health`,
  to dál nese `BuildWorldInput.health`). Pravidla nemění stav sama, takže zásobník a přebíjení
  bez efektu udělat nešlo. Stávající hry čítače 2–4 nečtou, hashe beze změny.
- **Stohování `settle()`** (23. 9. 2026, T4). Nový krok tiku mezi integrací a kolizí: tělo
  s gravitací (ne hráč, ne projektil, ne kinematické), které za tik propadlo horní hranou
  živého pevného těla pod sebou, na ní přistane (`vy = 0`, `grounded`). Pořadí podle indexu,
  věž se staví odspodu; zmizí-li podpora, tělo příští tik padá dál. Běžec, plošinovka ani
  poletování nemají jiné tělo s gravitací než hráče, hashe beze změny.
