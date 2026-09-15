# Ordinary generation: skutečný core, oddělený transport

`reality-compiler-ordinary-generation.ts` zapojuje přímo `buildIntentRequest`,
`readPlannerEmission` a `compileWithRepair`. Zachovává výchozí tři compiler kola,
opravy s původní odpovědí a zastavení při opakovaném odmítnutí. Nevytváří druhý
compiler, renderer, HTTP endpoint ani launcher. Nemění existující produkční route.

## Zmrazený vstup

`runOrdinaryGeneration` přijímá review experiment a `ordinaryGenerationSchema`:
hash experimentu, okamžik zmrazení, slot/attempt ID, grammar path/hash,
`sessionSeed`, tři compiler kola, celkových 180000 ms a archive request limit
8388608 bytes. Čte kopie ověřených artefaktů. Grammar je explicitní JSON obsahující
`surfaceEvents`, `conditions`, `actions`, `simFields` a `lookFields`; není to celý
historický protocol ani oracle. Input log a intervention se do modelových requestů
nepředávají. Lokální hash není nezávislé či nezměnitelné zmrazení.

Model zůstává `gpt-5.6-sol`, effort `low`, official subscription transport,
bez API fallbacku. Celkový deadline se počítá od vstupu do adapteru, zahrnuje
preflight i všechna kola a nesmí se při repair obnovit. Každý live emit dostává
`remainingBudgetMs` a abort signal; transport musí tento menší budget vynutit
společně s pevnými production limity. Synchronous compiler nelze preemptovat;
adapter po jeho návratu znovu kontroluje skutečný deadline a pozdní výsledek
nepřijme. Nejde o CPU/RAM sandbox.

## Capability a evidence

- Fixture capability: `mode:'fixture'`, `emit(UpstreamRequest, signal)` vrací
  `origin:'fixture'`, raw JSON, `usage:null`, `remoteCompletion:'not-started'`.
  Model calls jsou nula; časy zahrnují lokální fixture/core práci.
- Live capability: `mode:'live'`, `transport.readiness`, `currentIdentity`,
  `emit({request, config, remainingBudgetMs}, signal, providerStarted)`.
  Před **každým** dispatch se porovnává aktuální trusted identity, production
  readiness, frozen config a runtime/sandbox evidence hash. Report není attestace.
- Jedno live volání smí oznámit právě jeden skutečný start. Další compiler/repair
  dispatch je zakázán, pokud některé předchozí volání nemá
  `remoteCompletion:'confirmed'`. Unknown intent se smí lokálně parsovat,
  ale navazující model se nespustí. Per-job local cleanup receipt toto API nemá;
  výsledek proto ponechává `termination.localCleanup:'not-verified'`.
  `observedProviderStarts` je počet skutečně přijatých start callbacků. Pokud
  některému dispatch chybí callback, `modelCalls:null`; nula callbacků není
  důkazem nula modelových volání. Fixture stále vykazuje nulu pro obě hodnoty.
- Requesty se archivují před readiness/dispatch. Archiv nese jednotlivé raw
  odpovědi, usage, provider elapsed, readiness, dispatch budget, parse intervaly,
  core phases, compiler verdict a všechny core rounds. Nadlimitní raw tělo se
  nahrazuje bytes/hash a `bodyArchived:false`. Neznámé usage/ceny zůstávají null.
  `outputBytes` počítá každou známou raw odpověď před zapečetěním, i když byla
  odmítnuta kvůli původu, usage či nadlimitní délce. Pozdní odpověď po ukončení
  nevymění konečný součet; její bytes/hash zůstávají v oddělené late evidenci.
  Arbitrární provider exception text se nevypisuje. Late response patří do
  odděleného late journalu, nikdy neopravuje zapečetěný výsledek.

`phases` měří wrappery core a mohou zahrnovat readiness/parsing. Nejde o čisté
model timing ani důkaz optimalizace. `providerElapsedMs` je null pro fixture.
Archiv musí odmítat přepsání. Chyba archivu zastaví další dispatch i tehdy,
když interní phase observer chybu diagnostiky sám polkne.

## Připojení produktu

Úspěšný výsledek vrací typovaný `blueprint`, `blueprintSha256`
(SHA-256 `JSON.stringify(blueprint)`), `generationHash`, `configHash`,
`promptSha256`, `origin`, modelCalls a termination. Blueprint je výsledek
validace/loweringu compileru; není doslovnou finální provider odpovědí.

Pro materialization lze předat `JSON.stringify(result.blueprint)` přímo do
`LivePromptProductBridge.open`, spolu s jeho hashem, frozen promptem a slotem.
**Nespouštět mezitím `runLivePromptProvider` znovu.** Fixture musí zůstat fixture
i v browseru. Tento adapter sám nevytváří produktovou session, první frame,
interakci, holdout, lidské review ani live benchmark. `liveMeasurement` a
`semanticReview` jsou vždy `NOT_RUN`, `humanObservation:false`.

Produkční launcher, auth/network ověření a ověřitelný úklid jednotlivého jobu
zůstávají samostatné závislosti. Žádná z unit fixture není jejich důkazem.
