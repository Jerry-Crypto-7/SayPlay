# P73D scény – hračkové diorama

- `before/` – 12 vět před úpravou (build `main` 3a0cfb75, 6. 11.), desktop 1440×900 a telefon 390×844, start + 3. a 8. s ukázky robota. Tabulka věta, žánr, ovládání, sada prostředí a záběr kamery: `before/index.md`, surová data `before/manifest.json`. Skript `scripts/play/p73d-shots.mjs --port <n> --out <dir>`.
- `target/` – koncepty směru A „hračkové diorama“, které majitel vybral 6. 11.

## Původ konceptů `target/`

| soubor | ze snímku | co |
|---|---|---|
| `race-A_diorama.png` | QA `s2-desktop-2play` (závod pod vodou) | želva a žralok na korálové dráze, oblouk cíle |
| `chase-A_diorama.png` | QA `s3-desktop-2play` (honička na střechách) | kočka s pizzou na střeše, racci, panorama města |
| `runner-A_diorama.png` | QA `s1-desktop-2play` (běh v sopce) | průzkumník na cestě, řeka lávy vedle, sopka na obzoru |
| `stack-A_diorama.png` | QA `s4-desktop-2play` (stohování) | věž palačinek na kopci, větrný mlýn za ní |

Vlastní výstupy modelu FLUX.2-klein 4B (licence Apache-2.0) přes lokální ComfyUI (`D:/tools/comfyui`, port 8188), edit snímku hry (ReferenceLatent, 4 kroky, 1152×640). Skript `restyle.mjs` ve scratchpadu QA 6. 11., prompt stylu A: „stylized toy diorama, the whole level is a small handcrafted world on a floating base, warm golden-hour light, soft shadows, tilt-shift depth of field, chunky rounded shapes, saturated but soft colours“ + „three-quarter view from behind and above the hero, visible horizon line, foreground, midground and background layers“. Jen reference vzhledu pro porovnání, do hry nejdou.
