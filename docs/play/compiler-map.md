# P23-A – mapa znovupoužitelných kusů pro kompilátor her

Co z existujícího kompilátoru, runtimu a certifikace kompilátor `GameSpec → WorldstreamBlueprint`
používá, s přesnou cestou a signaturou. Ověřeno čtením zdrojů 20. 9. 2026, ne odhadem.

## 1. Geometrie z rodiny

Modelový kompilátor (`src/model/worldstream-compiler.ts:464` `compileBlueprint(answer, plan, options)`)
geometrii z rodiny **neskládá** – bere ji z odpovědi modelu a `chooseFamily` schválně neimportuje.
Rodinu skládá až prohlížeč:

- `src/geom/family-choice.ts:162` `chooseFamily(look: unknown, seed: number): string` – čte
  `look.atmosphere` (tabulka počasí) a `look.palette` (tabulka materiálů) **jen jako řetězce**;
  bez známého slova padá na `familyForSeed(seed)` (`:132`). Slova: `stone|slate|sand|brick|amber…
  → terraces`, `frost|ice|glass|neon|teal|blue → spires`, `green|meadow|moss|forest|wood → grove`,
  `steel|iron|rust|copper|orange|industrial → works`; počasí `fog|mist|snow → spires`,
  `rain|storm|smoke → works`.
- `src/geom/families/index.ts` `FAMILIES`, `familyById(id): Family | undefined`;
  `src/geom/families/family.ts:40` `Family.compose(seed: number): GeomProgram`; palety rodin
  `dunes | frost | thicket | foundry` (`src/kit/palettes.ts`, bez fialové).
- Vykreslení: `src/components/viewer/scenery.ts:237` `buildProgramGroup(family.compose(seed), …)`
  a `src/components/viewer/Viewer.tsx:242` `deriveLook({ palette: family.palette, terrain:
  terrainOfProgram(family.compose(seed)), seed })` (`src/worldstream/look.ts:360`).
- Objekt blueprintu se `source.kind:'geom'` musí mířit na uzel z `placedFrom(nodes, root)`
  (`src/geom/program.ts:514`) a každý uzel smí nárokovat jen jeden objekt
  (`src/worldstream/references.ts:106` `rowClaimedBy`). Strop `GEOM_LIMITS.maxNodes = 96`.

**Důsledek pro T8:** `world.look.palette` a `world.look.atmosphere` se zapíší jako **řetězce**
s klíčovým slovem z `theme.setting`/`theme.mood`, aby `chooseFamily` v prohlížeči vybral tutéž
rodinu jako kompilátor; `geometry = familyById(chooseFamily(look, seed)).compose(seed)`.

## 2. `SemanticObject` z katalogu assetů

- `src/assets/resolver.ts:5` `representationCandidates(object: PlannedObject, manifest):
  { stableId, status: 'candidates' | 'cache-miss', candidates: [{ source: {kind:'asset',
  assetId, version, hash}, label, tags, style, bounds, sockets, parts, supportSurfaces }] }` –
  skóre = počet tagů assetu obsažených ve slovech `label + synonyms`, nejvýš 3 kandidáti.
- `src/assets/catalog.ts` `WORLDSTREAM_ASSETS = createAssetManifest(catalog.json)` – 30 assetů;
  `src/assets/manifest.ts:9` `manifest.resolve(reference)` ověří `assetId@version` a `hash`.
- `src/assets/manifest.ts:28` `fitAsset(asset, targetBounds, stretchAxes, rotationY)` – contain-fit
  s dnem na `targetBounds.min[1]`; `src/assets/binding.ts:7` `assetObjectIssues(object, asset)`
  žádá, aby každý `binding.sockets[i]` seděl na transformovaný soket assetu (±0.0001) a `parts`
  na díly assetu. Nejjednodušší platná vazba je `binding: { entityId, collider: targetBounds,
  sockets: [], parts: [] }` – schéma (`src/worldstream/schema.ts` `objectBindingSchema`) žádá
  `collider` vždy, `entityId` volitelně; asset bez `binding` schéma odmítne, `version` musí být
  `worldstream-v2`.
- `binding.entityId` musí jmenovat klíč `world.sim.entities` a každou entitu smí nárokovat jen
  jeden objekt (`src/worldstream/references.ts:118`).
- Pokrytí katalogu labely fixtur: `button → push-button`, `door → panel-door`, `table →
  dining-table`, `gate → iron-gate`, `portal → iron-gate`; `fox`, `mushroom`, `robot`, `Roomba`,
  `slime`, `cake`, `lava` nemají tag → `source.kind:'geom'` na uzel rodiny.

## 3. Certifikace a křížové odkazy

- `src/model/certify.ts` `certifySteps(input: CertifyInput): Generator<EmitPhase, Verdict>` –
  pořadí: `peelEnvelope` → `worldEmissionSchema` (`src/ir/worlddoc.ts:131`, kořen `irVersion,
  simRevision, lookRevision, sim, look`, bez `simHash`) → `findDanglingReferences(parsed.data)`
  (`:272`, `src/ir/references.ts`) → `validateLook` (`:287`, `src/ir/worlddoc.ts:724`: schéma sedmi
  polí `look` + konečnost čísel) → `sealSimHash` (`src/ir/worlddoc.ts:303`, `simHash =
  canonicalHash(sim)`) → `buildRuntimeWorld(parsed.data.sim)` (`:300`) → `verifyWitness(built.world,
  built.world.trace)` (`:315`). Fáze `witness` = svědek z `sim.witness.ops` došel do `won`.
  Vstup je `{ promptId, upstream, provenance, body }`, `body` = emise s `sim` a `look`.
- `src/worldstream/references.ts:48` `findBlueprintReferenceIssues(blueprint, assets =
  WORLDSTREAM_ASSETS): BlueprintReference[]` – duplicitní `stableId`/`shapeId`, `signalFlag` bez
  flagu, `entityId` bez entity nebo nárokovaná dvakrát, asset mimo katalog nebo s vadnou vazbou,
  `geom` uzel mimo tabulku / neumístěný / nárokovaný dvakrát, tvar bez objektu, `lookBindings`
  na neznámou proměnnou.
- `src/worldstream/schema.ts:321` `validateBlueprint(input): { ok, issues }` – obálka
  `{ version, sessionSeed (0..2^31-1), title, intent (readIntent: setting, mood, spatialThesis,
  actors[], heroObjects[], interactions[], unsupported[] – `src/model/worldstream-intent.ts:234`),
  sceneSpec?, world: worldDocSchema (se `simHash`), geometry, objects (1..64), shapes (≤3),
  lookBindings? }`.
- Svědka hledá `src/verify/solve.ts:290` `solveWitnessDetailed(world, { maxNodes, maxTicks,
  maxDepth, settleTicks, goal? }): { status: 'solved'|'search-exhausted'|'budget-exhausted'|
  'ineligible', result: { ops, nodes, wonAtTick } | null }`. Abeceda = predikáty
  `p.onAction.<actor>.<actionId>.<target>` (`:188` `inputAlphabet`), tedy **akce fungují z
  libovolné vzdálenosti**, pokud pravidlo nemá stráž na polohu. Svět, který vyhraje bez vstupu,
  je `ineligible` (`isInstaWin`, `src/sim/interpreter.ts:1010`).

## 4. Sémantika povrchových událostí a podmínek (`src/ir/surface.ts`)

- `expandEvent` (`:238`): `onEnterZone/onExitZone {entity?, zone}` (`:255`) → `inZone(entity,
  zóna)` hrana nahoru/dolů; zóna se rozpouští přes `buildZones` (`:115`): **každý soket je zóna
  1×1 téhož jména** a `state.zones.<jméno> = [[x,y,w,h], …]` přidá obdélníky (`jméno`, `jméno.r1`…).
  `onCollide {a, b}` (`:268`) → `overlapping(a,b)` = táž buňka, hrana nahoru. `onPickup {role |
  entity}` (`:274`) → `onAction(actor,'pickup',entita)` **pro každou entitu role** – pulz, žádný
  `hasItem`. `onDrop {item, socket}` → `socketHolds`, jinak `onAction(actor,'drop',target)`.
  `onSeen {agent, target}` (`:317`) → `visible(agent,target)` hrana nahoru. `onAction {actor?,
  actionId, target?}` (`:323`) → pulz `acted(actor, actionId, target|none)`; bez `target` se
  rozloží na `none` + každou entitu. `onTimerEnd {timer}` → pád `timer > 0`. `onCounterReaches
  {ref, threshold}` → hrana `counter >= n` (`src/ir/lower.ts:91`).
- `lowerCondition` (`:356`): `counterIs {ref, op, value}`, `flagIs {ref, value}`, `timerRunning`,
  `stateIs {target, value}`, `lockedIs {target, value}`, `inZone {entity?, zone}` (`:428`,
  `anyOf` přes obdélníky zóny), `hasItem {slot: number, item}` (slot se píše číslem → `slot0`),
  `countInZone {zone, tag, op, value}` (`:445`, **jen zóna s jedním obdélníkem**), `allOf/anyOf
  {operands}`, `not {operand}`.
- `lowerAction` (`:503`): `setState {target, value}`, `setLocked {target, locked}`, `setFlag {ref,
  value}`, `addCounter {ref, by}`, `startTimer {ref, durationTicks?}` (délka z
  `state.timers.<id>.durationTicks`), `stopTimer`, `spawn {poolTag, socket}`, `despawn {target}`,
  `moveTo {target, socket, ticks ≥ 1}`, `freeze {target, ticks}`, `giveItem/takeItem {slot, item}`,
  `emit {signal}`, `playEffect`, `win`, `lose`.
- Stavy entit se **nedeklarují**, sbírají se z `stateIs/setState/onStateEnter` (`collectStates`
  `:617`); inventární sloty z `hasItem/giveItem/takeItem` (`collectItems` `:651`).
- Viditelnost: `traceSight` (`src/sim/interpreter.ts:458`) jde po Bresenhamovi přes
  `space.blocked`, a `buildRuntimeWorld` píše `blocked: []` (`src/ir/build.ts:348`) – **`visible(a,b)`
  je v povrchovém světě vždy pravda**. „Stojí vedle“ tedy dává jen `overlapping` (táž buňka) nebo
  `inZone(player, zóna kolem cíle)`.

## 5. Stav entity v `Uint32Array` a pohyb

- `src/sim/interpreter.ts:218` `ENTITY_FIELDS = ['state','locked','x','y','active','freeze',
  'moveTo','moveTicks']`, `:220` `entitySlotId(stableId, field) = "e:<id>:<field>"`; sloty
  `c:<id>` čítač, `f:<id>` flag, `t:<id>` časovač, `i:<id>` inventář, `m:<agent>#<index>` paměť.
- `src/sim/state.ts:61` `readSlot(layout, state, id)`, `:70` `writeSlot(layout, state, id, value)`
  (clamp na meze slotu); `runtime.layout`, `runtime.state` jsou veřejná pole `Runtime`
  (`createRuntime` `:250`). `entityPlacements(runtime)` (`:391`) čte `x, y, active, state, locked`.
- `moveTo` efekt (`:754`) zapíše `e:<id>:moveTo = x*(gridHeight+1)+y+1` a `moveTicks = ticks`;
  `settle` (`:795`) čeká `moveTicks` tiků, pak **jeden krok za tik** (`stepToward` `:680`, nejdřív
  osa x, pak y) až do cíle. Zmrazená entita (`freeze > 0`) se nehýbe. Hráče hýbe systémové pravidlo
  `sys.moveTo.<cíl>` (`src/ir/build.ts:273`, `ticks: 1`) na **deklarovaný soket** cíle – ne na
  jeho aktuální polohu. Hráč = entita s `role: 'actor'`, jinak první deklarovaná (`:198`).
- Fáze tiku (`step` `:853`): vstupy → `sense` (fakty) → trigger (hrany proti pre-stavu, stráže) →
  apply (efekty v pořadí `phase, priority, ruleId`) → `settle` (časovače −1, pohyb). `win`/`lose`
  se projeví na konci téhož tiku; `emit` se doručí až příští tik. `StepResult.fired` nese
  `ruleId` skutečně vykonaných pravidel.
- Mysli (`src/sim/agents.ts:235` `expandAgentMinds`): `state.agents = [{ id, disposition:
  'bold'|'wary'|'restless', goals: [soket…] }]`; cíl musí být soket a musí projít
  `SYMBOL_PATTERN` (`:132`, **bez tečky**), 1–6 různých cílů, mysl nesmí patřit hráči.

## 6. Úplný povrchový `sim` se zónami

`src/worldstream/authored-worlds.json` → `worlds[id="c09"].compiler.world.sim` (19×7,
6 soketů, 6 entit, `state.zones.centralPassage = [[5,3,6,1]]`, `state.flags.passageTraversed =
{ init: false }`, tři pravidla `onEnterZone → setFlag/setState`, `onStateEnter → win`):

```json
"sim": {
  "layout": { "width": 19, "height": 7 }, "grid": { "cell": 1 },
  "sockets": { "westEntrance": [1,3], "passageMid": [7,3], "commonsPad": [10,3], "dwellingPad": [15,2], "treeCore": [10,5], "villageCore": [10,4] },
  "collisionAabb": { "villagers": [1,3,1,1], "hollowFallenTree": [0,0,19,7], "...": "…" },
  "entities": { "villagers": { "role": "actor", "socket": "westEntrance", "state": "arriving", "locked": false }, "...": "…" },
  "state": { "counters": {}, "flags": { "passageTraversed": { "init": false } }, "timers": {},
             "zones": { "centralPassage": [[5,3,6,1]] }, "slots": 0, "pool": {} },
  "rules": { "traverseSharedPassage": { "phase": 0, "priority": 0,
             "event": { "kind": "onEnterZone", "entity": "villagers", "zone": "centralPassage" },
             "condition": null, "actions": [{ "kind": "setFlag", "flag": "passageTraversed", "value": true }] }, "...": "…" },
  "witness": { "tier": "short", "H_cert": 600, "ops": [{ "tick": 0, "actionId": "moveTo", "target": "…" }] }
}
```

Žádný z jedenácti autorovaných světů nenese `state.agents`; tvar mysli je ve
`src/sim/__tests__/agents.test.ts:63` (`agents: [{ id: 'watcher', disposition, goals }]`, entita
`watcher` s `role: 'agent'`). Zmrazený C01 (`evals/frozen/responses/index.jsonl`, první řádek) ukazuje
`state.counters.keysHeld = { min, max, init }`, `state.slots: 3`, entitu `exit` se `locked: true` a
svědka s `pickup` bez předchozího `moveTo` – sběr na dálku je v runtimu legální.

## Co z toho plyne pro adaptéry

- **Sběr:** `onPickup {entity}` → `addCounter`; entita se nedespawnuje (mimo capabilities
  `collectible`), takže stejný předmět jde sebrat vícekrát – čítač má `max = count`, takže se to
  nezvrhne, a výherní brána stojí na `onCounterReaches`.
- **Východ:** `zone_trigger` na soketu role (`onEnterZone(player, soket)`); stráž „sebráno vše“
  je `counterIs(collected, '>=', count)`.
- **Nebezpečí, checkpointy, cíle:** zóny `state.zones.<role>_<i>` 1×1 nebo 2×2 nad buňkou role.
- **Pronásledovatel:** pásma jako zóny `chase_zN`, pravidla `onEnterZone(player, chase_zN)` se
  stráží `visible(chaser, player)` → `moveTo(chaser, soket pásma, ticks)`; chycení = `onCollide`.
- **Hlídka:** `state.agents` s cíli na soketech `<role>_stop<i>` (bez tečky, kvůli `SYMBOL_PATTERN`).
- **Vlny:** `state.pool.<role> = { size, tag }`, členové poolu se jmenují prefixem jména poolu
  (`src/ir/build.ts:85` `buildTags`); `spawn {poolTag, socket}` oživí nejnižší neaktivní.
