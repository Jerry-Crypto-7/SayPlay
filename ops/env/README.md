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

## Dávka do knihovny

```
uv run --project ops/env python ops/env/batch.py settings      # seznam prostředí → evals/play/env/settings.json
node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/env python ops/env/batch.py generate
uv run --project ops/env python ops/env/batch.py catalog       # → src/play/arcade/look/env-catalog.json
```

`settings` sestaví seznam (looky × 3 varianty a prostředí z korpusů), `generate` z něj kreslí
panoramata do `public/assets/worldstream/env/` pod GPU zámkem, `catalog` zapíše katalog (id, look,
štítky, horizont). Dnes 94 panoramat, ~20 MB. Nové soubory v `public/` chtějí záznam v `disclosure.json` v témže commitu
(`scripts/assets/register-disclosure.mjs`, pak `npm run disclosure`); hook `license-gate` čte i
netrackované soubory, takže během dávky nejde commitnout nic.

## Služba na požádání

```
ENV_KEY=<tajné> uv run --project ops/env python ops/env/server.py     # jen 127.0.0.1:8793
```

| Cesta | Co dělá |
|---|---|
| `POST /panorama {"setting": "…"}` | vrátí `jobId`; jedna úloha na prostředí, hotové bere z cache `D:/caches/worldsmith-env` |
| `GET /jobs/{id}` | `queued / running / done / failed`; hotová nese `file`, `low`, `horizon` |
| `GET /files/{name}` | WebP z cache |
| `GET /health` | stav a délka fronty |

Každá cesta chce hlavičku `X-Env-Key` shodnou s `ENV_KEY`, jinak 401; `/docs` a OpenAPI služba
nemá. Fronta má strop 20 úloh (pak 429), generování drží sdílený GPU zámek, takže se nepotká
s dávkami jiných stop. Selhaná úloha drží hodinu (`FAILED_COOLDOWN_SEC`): hra se ptá opakovaným
`POST` a prostředí, které na kartě padá vždy, by se jinak zařadilo s každým dotazem znovu.

Hra ji volá z `src/app/api/play/_env.ts` přes `PLAY_ENV_ENDPOINT` a `PLAY_ENV_KEY` (táž hodnota
jako `ENV_KEY`); venku za tunelem. Vypnout jde pákou `env` ve vypínači (`src/server/kill-switch.ts`).

## Testy

```
uv run --project ops/env pytest ops/env/tests
```
