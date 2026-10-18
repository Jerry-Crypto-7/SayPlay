# Duch – zapojení pro stopu B (P37C T3)

Duch je průhledný hrdina dřívějšího běhu, který závodí vedle hráče: **kamarád** z odkazu výzvy (`?dare=`) nebo **nejlepší běh** hry. Stopa C dodává zdroj ducha a jeho kresbu; zapojení do `ArcadePlay.tsx` a do `GhostSlot.tsx` patří B (P37B T8). Dokud zapojený není, nic se nemění – slot nekreslí nic a hash hry je týž.

## Co C dodává

| Soubor | Co v něm je |
|---|---|
| `ghost-source.ts` | `fetchGhost(versionId, dareId, world)` – přečte běh výzvy (`GET /api/play/games/:id/dare/:dareId`) a vrátí `GhostReplay` (zdroj pro `GhostSlot`), nebo `null`, když výzva ducha nemá. `createGhostSource(world, run)` a `ghostRunOf(replay)` pro testy. |
| `Ghost.tsx` | `<Ghost source session label place? children? />` – kresba ducha uvnitř plátna, štítek ve světě (`.sp-world-tag`), zmizení na konci záznamu. `worldPlacement` = převod scén nad `World`. |
| `session.ts` | `session.alpha()` – podíl rozběhnutého tiku z posledního `advance`; duch se kreslí mezi tiky stejně jako hráč. |

## Zapojení krok za krokem

1. **Odkud vzít id výzvy.** Kamarád: `?dare=<dareId>` v adrese `/play/[id]`; stránka ho ověřila v `challengeOf` (`challenge !== null` = platná výzva téhle hry). Nejlepší běh: `bestDare.dareId` z `GET /api/play/games/:id` (P37C T2); stránka `/play/[id]` ho pro první načtení pošle v props (`bestDare`, P50 T6), další načtení se ptá dveří. Kamarád má přednost.
2. **Načíst zdroj** v `ArcadePlay.tsx` – mimo render, jednou na hru:
   ```tsx
   const [ghost, setGhost] = useState<GhostReplay | null>(null);
   useEffect(() => {
     if (dareId === null) return;
     let live = true;
     let loaded: GhostReplay | null = null;
     void fetchGhost(versionId, dareId, arcade).then((source) => {
       loaded = source;
       if (live) setGhost(source);
       else source?.dispose();
     });
     return () => {
       live = false;
       loaded?.dispose();
     };
   }, [versionId, dareId, arcade]);
   ```
   Hra s fyzikou: `fetchGhost` sám počká na Rapier.
3. **Slot ducha** (`GhostSlot.tsx`, B) rozšířit o relaci, štítek a převod scény a kreslit `Ghost`:
   ```tsx
   export function GhostSlot({ ghost, session, label = 'friend', place }: { readonly ghost?: GhostSource; readonly session: ArcadeSession; readonly label?: GhostLabel; readonly place?: (pose: GhostPose) => GhostPlacement }) {
     if (ghost === undefined) return null;
     return <Ghost source={ghost} session={session} label={label} place={place} />;
   }
   ```
   Test `__tests__/ghost-slot.test.tsx` hlídá „bez ducha nic“ a jeden slot na hru – oboje zůstává.
4. **Převod scény.** Póza je v jednotkách jádra (`BODY.x/y/z`), natočení `yaw` v osách jádra (0 = po +z, kladné k +x). `worldPlacement` platí pro běžce, plošinovku, poletování a závod (`World` zrcadlí x, tedy i natočení). Scény s jiným převodem (aréna, souboj na ose z, střelnice, hod, načasování, rytmus) podají vlastní `place` – týž převod, jakým kreslí hrdinu.
5. **Kdy ducha schovat** rozhoduje B: při ukázce robota (`session.demo() !== null`) a na obrazovce výsledku dává smysl `ghost` do slotu nepodat.

## Co duch dělá sám

- **Jede v kroku s hráčem:** v každém snímku se ptá na pózu v tiku hráče (`session.state()[HEADER.tick]`); jeden krok jádra na tik.
- **Restart hráče** (tik spadne) přehraje ducha znovu od tiku 0 – nic se volat nemusí.
- **Konec záznamu:** za posledním tikem běhu póza není a duch poskočí a zhasne (`GHOST_VANISH_MS` = 420 ms); restart ho vrátí.
- **Model hrdiny:** bez `children` kreslí siluetu v rozměrech hrdiny (barva `sky`, průhlednost `GHOST_OPACITY`). Když scéna podá model hrdiny jako `children`, duch jeho materiály zkopíruje průhledné; originál hrdiny se nemění.
- **Hash hry se nemění:** duch má vlastní stav, program i svět Rapieru; stav hráče nevidí. Pin: `__tests__/ghost.test.ts` (běžec i hra s fyzikou).

## Čísla a sondy

- Tik ducha stojí na desktopu nejvýš ~0,09 ms (hra s fyzikou), ostatní žánry ≤ 0,03 ms; test drží strop 0,5 ms. FPS na telefonu měří B.
- `window.__playGhost()` – co duch v posledním snímku nakreslil (`tick`, `shown`, `vanishing`, poloha ve scéně). Štítek má `data-testid="play-ghost-tag"`.
- Zkušební scéna `/play/lab/ghost?game=<id>&dare=<dareId>` (jen s `PLAY_LAB=1`) a e2e `e2e/p37c-ghost.spec.ts`.
