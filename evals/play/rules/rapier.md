# Rapier za arkádovým jádrem – měření (P29A T11, 26. 9. 2026)

| Co | Naměřeno |
|---|---|
| Balíček | `@dimforge/rapier3d-compat@0.19.3`, Apache-2.0, pinovaný přesně (0.21.0 vyšel den před měřením) |
| WASM (`rapier_wasm3d_bg.wasm`) | 1 569 588 B, **gzip 583 479 B**, brotli 429 334 B |
| Co stáhne prohlížeč (`rapier.mjs`, WASM v base64) | 2 238 719 B, gzip 834 345 B, brotli 614 287 B |
| `init()` v Node 22 | import 38 ms + init 86 ms |
| `init()` v Chromiu (produkční build, `/play/lab/physics`) | 416 ms včetně stažení a importu |
| Scéna determinismu | 20 těles (věž 8 kostek, 6 padajících beden, 6 koulí), 600 tiků, kvantováno po každém tiku (poloha a rychlost v jednotkách jádra, kvaternion × 10 000) |
| Hash Node (2 běhy) | `63bbc1ff`, shodný |
| Hash Chromium | `63bbc1ff`, shodný s Node |

## Rozhodovací pravidlo z plánu

„Když hash Node ≠ Chromium, nebo WASM > 800 kB gzip, T12–T13 se přeskočí.“ **Obojí prošlo:** hash se shoduje a WASM má 583 kB gzip. T12–T13 pokračují s Rapierem.

**Výhrada:** `-compat` build nese WASM jako base64 uvnitř JS, takže hráč stáhne 834 kB gzip (614 kB brotli, které Vercel posílá). Proto se Rapier načítá dynamicky jen ve hrách s fyzikálními tělesy (T13), nikdy do prvního snímku ostatních her.

Determinismus stojí na tom, že Node i Chromium spouští tentýž WASM ve V8. Deterministický build (`@dimforge/rapier3d-deterministic-compat`) zatím není potřeba; kdyby se hash rozešel na jiném stroji nebo prohlížeči, je to první náhrada.
