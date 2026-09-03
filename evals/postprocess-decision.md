# Postprocessing: rozhodnuto NE, a proč (P15 T37)

**Naměřeno 3. 9. 2026.** Rozhodnutí je **nezapojovat** a oba pracovní soubory
smazat. Není to škrt — je to platné dokončení úlohy podle vlastní věty plánu.

## Co se měřilo

Netrackovaný `src/components/viewer/Postprocess.tsx` (100 řádků, hotový) stavěl
`EffectComposer` + `GTAOPass` + `OutputPass` přímo z `three/examples/jsm`, tedy
**mimo** `@react-three/postprocessing`. Tím obcházel past z `CLAUDE.md`: ta
knihovna má tvrdou závislost na `n8ao`, což je 90,9 kB gzip v jednom
netreeshakovatelném souboru. Obcházení fungovalo — viz cena bundlu níž.

Měřeno na `/embed/harbor-pier?emit=C04`, tedy na **nejhustším** světě, přes
`window.__viewer.render()` (počty za snímek z `renderer.info.render`) a přes
velikost klientských chunků z produkčního buildu.

⚠ **Snímková frekvence se neměřila a měřit nešla.** Sada jede na SwiftShaderu.
Naměřené hodnoty (1,0–1,5 fps) jsou vlastnost softwarového rendereru, ne
produktu, a vyšly **výš se zapnutým AO než bez něj** — čímž samy dokládají, že
z nich nejde nic vyvodit. Rozhodovalo se proto z trojúhelníků, kreslicích volání
a kilobajtů.

## Naměřené hodnoty

| Sestava | Kreslicí volání / snímek | Trojúhelníky / snímek | Chunky gzip |
|---|---|---|---|
| bez composeru (dnešek) | 55 | 37 452 | 2 776 628 B |
| composer, GTAO vypnuté | 56 | 37 453 | 2 788 028 B |
| composer + GTAO | **112** | **74 905** | 2 788 028 B |

Rozdíly, tedy to, o čem se rozhoduje:

| Co | Cena |
|---|---|
| Bundle za samotné zapojení | **+11,1 kB gzip** (+43,4 kB nekomprimovaně, +1 chunk) |
| Composer bez AO, za snímek | +1 kreslicí volání, +1 trojúhelník (celoobrazovkový trojúhelník `OutputPass`) |
| **GTAO, za snímek** | **+57 volání a +37 453 trojúhelníků, tedy přesně dvojnásobek** |

Proti stropům z `src/kit/budgets.ts` (`maxDrawCallsPerFrame` 300,
`maxTrianglesPerFrame` 500 000) se i zdvojený snímek **vejde** — 112 volání je
37 % stropu, 74 905 trojúhelníků 15 %. Rozpočet tedy zapojení nezakazuje.

## Proč přesto ne

Rozhodly tři věci, žádná z nich není „vypadá to hůř".

1. **Levná polovina nic nepřidá a drahá polovina zdvojí snímek.** Composer bez
   GTAO stojí prakticky nic — a taky prakticky nic nedělá: obraz je pixel po
   pixelu tentýž jako bez něj. Jediné, co obraz změní, je GTAO, a to je **plný
   druhý průchod geometrií**. Zapojit composer a nechat AO vypnuté znamená
   zaplatit 11,1 kB za nulový rozdíl.

2. **Bezpečná úroveň kvality by ho musela umět vypnout, a ta zatím není.**
   Design book §23 předepisuje pro úroveň C „plně funkční svět, **žádný drahý
   postprocess**" a pořadí degradace „postprocess → texture LOD → mřížka meshe",
   tedy postprocess padá první. Ten přepínač staví `T26`, která **hotová není**.
   Zapojit AO teď znamená zapojit ho bez vypínače, který si kniha vyžádala.

3. **Neřeší to největší zbývající rozdíl proti cílovému snímku.**
   `docs/worldstream-art-direction.md` v „Co zůstává otevřené" pojmenovává tři
   díry a AO není ani jedna z nich: **nesvítí nic** (žádné emisivní ohnisko,
   žádná noc, žádný teplotní kontrast), kompozice šesti světů čte jako jeden, a
   ruční layouty jsou drobné objekty na prázdné ploše. Okluze prohloubí kouty
   něčeho, co porotci připadá stejné jako to předchozí.

## Co se smazalo a jak to vzkřísit

Smazané: `src/components/viewer/Postprocess.tsx` a
`e2e/zz-postprocess-measure.spec.ts`. Ani jeden nebyl v gitu, takže je historie
nevrátí — proto tenhle odstavec.

Postavit to znovu je práce na hodinu a stojí to na čtyřech věcech, které stály
za celý ten soubor:

- `useFrame(..., 1)` — první callback s prioritou ≥ 1 vypne automatické kreslení
  R3F a převezme ho; priorita 0 (počítadlo snímků, kamera) běží před tím.
- **Tone mapping se v composeru nepřenastavuje.** `RenderPass` kreslí mimo
  obrazovku, kde ho `three` vynechá, a `OutputPass` ho pak vezme z
  `renderer.toneMapping`. Přepsat ho tam znamená měřit jiný rig, než jaký si
  plátno vyžádalo.
- Cíl potřebuje `samples: 4`. `antialias: true` platí pro výchozí framebuffer;
  kreslení do vlastního cíle by vyhlazení ztratilo a hrany kitu by se rozsekaly.
- **`gl.info.autoReset = false` a ruční `gl.info.reset()` v každém snímku.**
  Renderer nuluje `info.render` při každém `render()` a composer volá `render()`
  jednou na průchod, takže po snímku by v něm zbyl poslední celoobrazovkový
  čtverec, tedy `calls: 1`. Bez tohohle by rozpočty snímku v
  `e2e/render-quality.spec.ts` a `e2e/dressing.spec.ts` zůstaly zelené a
  neměřily by nic.

**Až se to bude vracet, ať se vrací s vypínačem `T26` a kvůli emisi, ne kvůli
okluzi.** Čísla výš platí a znovu se měřit nemusí; co se změnit může, je jestli
druhý průchod geometrií vadí na skutečné GPU — a to tenhle stroj nezměří.
