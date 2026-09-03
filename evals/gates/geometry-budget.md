# Rozpočty přechodů a geometrie do prvního snímku

**Naměřeno 2026-09-03.** Generuje `e2e/geometry-budget.spec.ts`, soudí
`evals/gates/bench/transition.ts`. Ručně se to needituje — příští běh to přepíše.

## Stroj a renderer

| Co | Hodnota |
|---|---|
| Platforma | Win32 |
| Jader | 16 |
| Prohlížeč | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36 |
| Renderer | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) |

⚠ **Sada jede na SwiftShaderu**, tedy na softwarovém rendereru bez GPU.
Trojúhelníky, kreslicí volání a jas měří spolehlivě; **snímková frekvence a
všechno, co závisí na ovladači, ne**. Čísla níž jsou proto stropy latence
naměřené na pomalejším rendereru, než na jakém demo poběží — jsou to horní
odhady, ne cíle. Číslo závislé na ovladači se sem nepíše vůbec.

## Od věty po první snímek hrubého světa

Měřeno od kliknutí na odeslání po **první snímek, na kterém svět doopravdy byl**
(`window.__worldsmith.worldFrames() > 0`), ne po vznik entit v paměti.

| Co | Naměřeno | Rozpočet §23 | Verdikt |
|---|---|---|---|
| věta → první snímek hrubého světa (`/`, renderer `WorldScene`) | 419 ms | 3000 ms | **vejde se** (14 % rozpočtu) |

Všechny běhy: 655 ms · 419 ms · 405 ms.

⚠ **Měří se dnešní hlavní cesta, tedy renderer `WorldScene` na `/`, ne
`WorldstreamStage`.** Věta se k worldstreamovému plátnu zatím nedostane —
propojení je úloha `T21b` a do té doby ta cesta neexistuje. Až se propojí,
tohle číslo se **musí přeměřit**: bude o jiný renderer a o jiný plánovač.

## Přechod z hrubé úrovně na vysokou

Měřeno na `/dev/worldstream` od povelu k materializaci po commit odhalení.

| Co | Medián | Nejrychlejší běh |
|---|---|---|
| první materializace po načtení stránky | 19068 ms | 12747 ms |
| materializace po odmítnutém pokusu (worker už běžel) | 3147 ms | 3022 ms |
| z toho předepsaná animace odhalení | 700 ms | |
| **z toho práce** (medián druhého řádku) | 2447 ms | |

Všechny běhy, první sada: 12747 ms · 19068 ms · 19329 ms.
Všechny běhy, druhá sada: 3305 ms · 3022 ms · 3147 ms.

Rozpočet §23 na první hrdinský objekt po hrubém světě je
500 ms. Proti němu se soudí **práce**, ne celý
přechod: animace je 700 ms schválně a zkrátit ji je rozhodnutí o návrhu, ne
o výkonu. Práce **přes rozpočet** (489 %).

### Co ta čísla NEŘÍKAJÍ — přečti dřív, než z nich budeš plánovat

**Cituj druhý řádek, ne první.** První řádek měří první materializaci po načtení
stránky, tedy hlavně cenu toho načtení — a ta na tomhle stroji **skáče o řád
mezi běhy** (dvě nezávislé sady 3. 9. 2026 daly 2,7–3,9 s a 17,1–21,4 s nad
týmž kódem). Rozpočet se z takového čísla postavit nedá. Druhý řádek je proti
tomu v obou sadách stabilní, 2,5–5,3 s.

⚠ **Nevyvozuj z toho, že za tím je studený worker.** Druhá sada si worker
schválně předehřívá odmítnutým meshem, ale první sada je nestabilní i sama
v sobě, takže rozdíl mezi řádky nemá jediné vysvětlení, které by tohle měření
uneslo. Zůstává to naměřené a nevysvětlené.

**Meshing v tom čísle skoro není.** Vymeshování 48³ stojí na tomhle stroji
**524 ms** (`evals/shape/mesh-budget.json`, ve workeru, nejlepší ze tří po
zahřátí) — tedy zlomek naměřeného přechodu. Zbytek je **nevysvětlený**
a tenhle report si nevymýšlí čím.

Co z toho plyne pro `T26`: **snížení mřížky osekává jen těch ~524 ms, ne celý
přechod.** Adaptivní kvalita postavená na předpokladu „mřížka řídí cenu přechodu"
by uspořila málo a měřitelně by to nepoznala.

Co má příští kolo změřit: rozložit `order('high')` na volání workeru a na
commit odhalení a **každou část časovat zvlášť uvnitř stránky**. Dokud se ty dvě
části neoddělí, je jakékoli další vysvětlení domněnka.

## Rozdíl proti §23, zapsaný a nepřepsaný

| Co | §23 | Produkt | Proč |
|---|---|---|---|
| Mřížka úrovně A | 64³ | 48³ | Žebřík se 29. 8. 2026 snížil na 32³ / 48³; `admitMesh()` soudí proti příčce, kterou produkt doopravdy staví |
| Trojúhelníky na hrdinu | 30000 | 32000 | Důsledek téhož snížení žebříku, ne samostatné rozhodnutí |

**Kniha se tímhle reportem nepřepisuje.** §23 zůstává, jak je; kdo bude `T26`
psát, ať ví, že dvě její čísla popisují mřížku, kterou nikdo nespustí.
