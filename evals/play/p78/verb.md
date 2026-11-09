# P78 T3 – kontrola „sloveso přečteno“ podle dnešních her (8. 11. 2026)

**Výsledek:** po rozšíření kontroly o novější hry je sloveso přečtené u **100 z 200** held-out vět (dřív **75 z 200**). Ze 25 nových zásahů je 7 sporných (viz níž); bez nich **93 z 200**. Hry se neměnily – stará kontrola nad dnešním stromem dává pořád 75/200, celý rozdíl je ve změně kontroly.

- Sada: `evals/play/p30/test-200.json` (otevřená jednou 4. 10. 2026, nic se podle ní neladí).
- Měřidlo: `offlineChain` (`scripts/play-fidelity.mjs` → `src/play/fidelity/chain.ts`), rychlá verze, offline – stejně jako P74 T5.
- Běh: `npx vitest run --config vitest.measure.mts evals/play/p78/verb.measure.ts` → `evals/play/p78/verb.json`.

| | sloveso přečteno |
|---|---|
| P74 T5, 7. 11. (`evals/play/p74/run-2026-11-07.json`) | 75 / 200 |
| stará kontrola, dnešní strom | 75 / 200 |
| **nová kontrola, dnešní strom** | **100 / 200** |
| nová kontrola bez 7 sporných | 93 / 200 |

## Co se v kontrole změnilo

Kontrola uznávala sloveso, když ho hrálo ovládání ze seznamu sady (`controls`), mechanika, vystřelené pravidlo, nebo žánr – ten ale znala jen u sedmi starších generátorů (aréna, plavba, quest). Novější hry tím propadaly, i když sloveso hrály.

1. **Nativní hry** dostaly žánr, za který je vydává knihovna (`src/play/compose/allowed.ts`): let `glide_course` → závod plavby, míč `ball_pitch` → hod, chůze `walker_labyrinth` → prostorový quest, `walker_escape` a `walker_stealth` → útěk.
2. **Hry s vlastním žánrem** (třídění, krájení, obrana, tlačení, chytání, mlácení krtků, přecházení, …) nesou žánr ve `spec.genre`; kontrola ho čte, když generátor v tabulce chybí.

O tom, jestli žánr sloveso hraje, rozhoduje dál tatáž tabulka sloves, podle které produkt žánr vybírá (`verbPlayedBy` v `src/play/genre/classify.ts`). Kontrola tím nic nového nevymýšlí.

Zkoušel jsem i přísnější pravidlo: žánr počítat jen u slovesa, kterému sada dala ovládání nebo mechaniku. Shodilo ale 8 vět, které quest opravdu hraje („repair“, „cook“, „paint“, „fix“…). Sada je starší než quest, proto u nich ovládání nemá. Pravidlo jsem proto nepoužil.

Test: `src/play/fidelity/__tests__/native-chain.test.ts` – let hraje „fly“, třídění „sort“, ani jeden nehraje cizí sloveso. Se starou kontrolou test padá.

## Věty, které se změnily (všechny ne → ano)

| věta | hra | sloveso | sporné |
|---|---|---|---|
| t057 sort recycling on a fast conveyor belt at the dump | sort | sort | |
| t097 a sushi chef slices fish tossed into the air | slice | slice | |
| t102 an elf archer defends the forest gate from orcs | defense | defend | |
| t157 a sumo cat pushes dogs off a rooftop | push | push | |
| t158 catch falling apples in a basket before they hit the ground | catch | catch | |
| t175 whack moles in a vegetable patch before they eat the carrots | whack | whack | |
| t200 a snail must cross a highway at rush hour | hop | cross | |
| t106 a phoenix rises from the ashes and flies over a burning desert | let | fly | |
| t133 a baby dragon learns to fly over a volcanic island | let | fly | |
| t140 a paper airplane glides through an office without hitting the ceiling | let | glide | |
| t156 aliens invade new york and you pilot a fighter jet | let | pilot | |
| t168 fly a helicopter through a canyon full of wind turbines | let | fly | |
| t103 a vampire sneaks through a village without waking anyone | chůze | sneak | |
| t161 a firefly lights the way through a dark swamp maze | chůze | light the way | |
| t197 hide from a T-rex in a jungle ranger station | chůze | hide | |
| t061 wrap presents at the north pole before christmas eve | rytmus | wrap | |
| t063 a spider weaves a web between two lamp posts | rytmus | weave | |
| t111 a knight and a dragon play chess in a tower | souboj | play chess | |
| t002 help me write a birthday poem for my mom | stavění věže | write | **ano** – ne-hra |
| t031 Write a haiku about autumn leaves | stavění věže | write | **ano** – ne-hra |
| t018 renewing my passport at city hall | stavění věže | renew | **ano** – ne-hra |
| t024 breaking up with my boyfriend over text | souboj | break up | **ano** – ne-hra |
| t028 negotiating a raise with my boss | souboj | negotiate | **ano** – ne-hra |
| t143 shoot hoops with a gorilla at the zoo | střílečka | shoot hoops | **ano** – basketbal hraný jako střelba |
| t187 a hamster bartender slides drinks down a long counter | běžec | slide | **ano** – klouže hrdina, ne sklenice |

## Co zbývá (100 vět bez přečteného slovesa)

Většina jsou věty bez hratelného slovesa (esej, shrnutí, „explain“, „meditate“) a slovesa, která hra opravdu nehraje: sběrací aréna místo „milk“, „scoop“, „spit“, míčové hry s „play football“ nebo „play tennis“. To je stav hry, ne chyba kontroly – a podle sady se ladit nemá.
