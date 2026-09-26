# ops/env – prostředí z věty (P29C)

Věta prostředí → bezešvé panorama 2:1, které hra vykreslí jako oblohu a pozadí. Generuje se lokálně
na RTX 3090 přes `diffusers` (ne ComfyUI – GPL-3.0).

| Model | Licence | Kde |
|---|---|---|
| `black-forest-labs/FLUX.2-klein-4B` (transformer, VAE, Qwen3 text encoder, 16 GB) | Apache-2.0 | `D:/caches/huggingface/` |

Varianta 9B je nekomerční a nepoužívá se. FlashWorld (splat) vyloučen licencí vah, viz
`evals/play/env/flashworld.md`.

## Jedno panorama

```
node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/env python ops/env/panorama.py --prompt '"snowy pine forest"' --out <adresář>
```

Uvnitř zámku se argument s mezerou musí obalit ještě jednou uvozovkami (`gpu-lock.mjs` spouští přes shell).

Výstup: `<slug>.webp` 2048×1024, `<slug>-low.webp` 512×256 a `<slug>.json` (prompt, seed, horizont, čas).

**Jak to funguje:** FLUX.2 klein 4B (4 kroky, guidance 1.0) kreslí obraz 2304×1024 s promptem
„360 degree equirectangular panorama of …“. `seam.py` prolne pravý přesah 256 px přes levý okraj a
odřízne ho, takže okraje navazují dokola. `horizon_color` je průměr prostředních 10 % výšky – ta barva
jde do mlhy, aby přechod z ploché barvy na panorama neskočil.

**Naměřeno 26. 9. 2026** (`snowy pine forest`, seed 0, GPU sdílená, 14 GB obsazeno cizími procesy,
`enable_model_cpu_offload`): **156 s** celkem včetně načtení vah (samotné 4 kroky 23 s),
2048×1024 **302 kB**, 512×256 **25 kB**, horizont `#acbbc4`. Šev: průměrný rozdíl posledního a
prvního sloupce 8,9/255 proti 7,7/255 mezi sousedními sloupci uvnitř obrazu – na oko žádný šev.
Obraz vyšel jako skutečné equirektangulární panorama (horizont kolem 55 % výšky) bez LoRA, takže
záložní válcové pozadí z plánu není potřeba.

## Testy

```
uv run --project ops/env pytest ops/env/tests
```
