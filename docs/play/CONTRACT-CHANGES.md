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

### `property_transform.from` mimo výchozí stav role (T7)

Výchozí stav entity dává druh role (`INITIAL_STATE` v `compile/sim.ts`: `exit` → `open`,
`hazard` → `on`, `checkpoint` → `pending`, …). `from`, které se s ním neshoduje a žádná
mechanika ho nenastaví, je mrtvé pravidlo – spec projde, transformace nikdy nevystřelí.
**Návrh:** validovat `from` proti výchozímu stavu druhu role, nebo ho ze schématu vypustit a
brát výchozí stav role.

### `property_transform` s `trigger: 'timer'` nemá délku (T7)

Parametry nemají `afterSeconds`; kompilátor bere pevných `TRANSFORM_AFTER_SECONDS = 10`.
**Návrh:** přidat `afterSeconds` do `propertyTransformParams`.

### `spawn_wave` oživuje, nespawnuje (T7)

Runtime nezná „neaktivní od startu“ (`active` začíná 1 pro každou entitu) a `despawn` není
v capabilities `spawn_wave`. Vlna proto oživuje členy poolu, které jiná mechanika (`defeat`)
odstranila; bez ní se nikdy nic neobjeví. `explanation` v registru („New things … appear on a
schedule“) slibuje víc. **Návrh:** buď `active: false` v `SurfaceEntity` pro pool nad
`maxAlive`, nebo přepsat `explanation` a `roleRefs` tak, aby `spawn_wave` vyžadoval `defeat`
na téže roli.

## P23-B

- **`DirectorResult` větev `ok:false` nemá kdy nastat.** `direct()` (`src/play/director/index.ts`)
  má vždy návrh ze slov (`draftGameSpec` nikdy nevrátí `null`), takže výpadek modelu, nečitelná
  odpověď i neopravitelný spec končí `ok:true, source:'draft'` a důvod jde do `fallbackReason`
  (`MODEL_UNAVAILABLE` | `MALFORMED` | `UNREPAIRED`). `DirectedGame` je **rozšíření**
  `Extract<DirectorResult, {ok:true}>` o `fallbackReason`, `warnings`, `ms`, `calls` –
  přiřaditelné do kontraktu beze změny. Návrh: při společném kroku větev `ok:false` z
  `DirectorResult` vypustit a `fallbackReason` do kontraktu přidat.
- **Klíč cache** bere `endpoint` z `GenerationBranch.id` a `model` z `UpstreamRequest.model`
  (= `EMISSION_MODEL`), protože `direct()` dostává větev, ne konfiguraci. Kdyby obálka měla dva
  koncové body s týmž `id`, potřebuje kontrakt `branch.id` odlišit – zatím není důvod.
