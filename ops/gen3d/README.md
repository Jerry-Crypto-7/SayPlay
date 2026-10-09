# gen3d – podstatné jméno → low-poly GLB na lokální RTX 3090

Řetězec: zadání obrázku (FLUX.2-klein-4B) → odstranění pozadí (BiRefNet) → TRELLIS.2 → GLB,
pak dodělávka v Blenderu (osy, metry, pivot, paleta 12 barev) a gltfpack (LOD0/LOD1), náhled
a kontrola kvality. Všechno běží lokálně za 0 USD.

## Instalace

```powershell
./install.ps1        # ComfyUI do D:\tools\comfyui, váhy do D:\caches\huggingface (~41 GB)
uv sync --group dev
```

ComfyUI (GPL-3.0) je samostatný nástroj mimo repo, stejně jako Blender – nic z něj se
nedistribuuje. Spuštění:

```bash
cd D:/tools/comfyui && HF_HOME=D:/caches/huggingface .venv/Scripts/python.exe main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
```

## Služba

```bash
GEN3D_KEY=<tajný klíč> uv run server.py     # jen 127.0.0.1:8790
```

- Bez `GEN3D_KEY` odmítne start. Každá cesta (i `/health`) chce hlavičku `X-Gen3d-Key`
  přesně shodnou s klíčem, jinak vrací 401 a žádná úloha nevznikne.
- `POST /generate {"noun": "penguin"}` → `{"jobId"}`; `GET /jobs/{id}` → `queued | running |
  done | failed`, u `done` cesty ke GLB relativně ke cache (`glb`, `lod1`, `preview`) a výsledek
  kontroly `gate`, u `failed` důvod `reason` (typ výjimky + zpráva, cesty disku zkrácené na jméno
  souboru); `GET /health` → stav ComfyUI a délka fronty.
- Slovo se normalizuje (malá písmena, bez členu, jednotné číslo): „Penguins“ i „the penguin“
  vedou na `penguin`. Jiné znaky než písmena a mezery (max. 4 slova, 40 znaků) → 422.
- Cache: `D:/claude/_gen3d-cache/<slovo>/` (jinde přes `GEN3D_CACHE_DIR`). Hotové slovo se
  vrátí hned, bez karty.
- Fronta zpracovává jednu úlohu naráz – karta je jedna; nad 50 čekajících slov vrací 429.
  Pád ComfyUI ukončí úlohu `failed`. Rezervovaná jména Windows (`con`, `nul`, …) → 422.
- Vestavěné stránky FastAPI (`/docs`, `/redoc`, `/openapi.json`) jsou vypnuté – klíč by obešly.

## Dávka

```bash
node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from <seznam> --precheck --start-comfy --no-quarantine --record <batch.json>
```

- **Seznam** je textový (`jméno  # poznámka` na řádek) nebo JSON ve tvaru `evals/play/p45d/gen-nouns.json`
  (`{"nouns": [{"noun", "class", "flat"}]}`) – jen ten nese třídu těla.
- **Zadání podle třídy** (P45E): `config.toml` `[prompts.<třída>]` pro `quadruped`, `biped`, `flyer`,
  `swimmer`, `vehicle`, `prop` a `flat` (ploché a drobné jméno přebije třídu); textový seznam a služba
  používají `prop.a`, zadání všech modelů před P45E. Rozlišovací znak za jménem z `features.toml`
  (orca: „black and white killer whale…“), psaný ručně.
- **Pokusy** `--attempts a0,b0,a1` (výchozí): zadání A se semínkem 0, pak zadání B, pak A se semínkem 1.
  Záznam nese použité `prompt`, `variant` a `seed`; `provenance()` píše do karantény skutečně použité
  zadání. Povýšení `scripts/p37d/promote-batch.mjs` zapisuje do původu jen semínko (schéma dávky
  `catalog-batch.v1` zadání nenese).
- **`--precheck`**: obrázek se před TRELLIS ukáže slepě Codexu (`precheck.py` →
  `scripts/p37d/judge-sheet.mjs --precheck`, prázdný adresář, jen `sheet.png`) a 3D se generuje jen
  z obrázku, který soudce pozná (`top1`/`top3`). Odpovědi v `D:/caches/p45e/precheck/` (mimo repo).
  Bez odpovědi Codexu (limit, pád) obrázek projde jako `unavailable` – kartu to nezastaví.
- Mezipaměť je jedna na jméno: pro nové kolo nad jmény, která už v cache jsou, nastav `GEN3D_CACHE_DIR`.

## Rychlost

Změřeno 24. 9. 2026 (`evals/gen3d/bench.json`): teplý medián **47 s** na slovo (obrázek 9 s,
TRELLIS.2 35 s), studený start ~46 s navíc. Na hru za běhu je to pomalé, proto se modely
generují dávkově dopředu.

## Licence

Zapsané v `disclosure.json` (ověřeno 24. 9. 2026 z model card / LICENSE, ne z blogu). Nic
z toho se nedistribuuje – váhy leží v `D:/caches/huggingface`, nástroje mimo repo.

| Co | Licence | Poznámka |
|---|---|---|
| ComfyUI 0.37.0 | GPL-3.0 | nástroj mimo repo, volá se jen přes lokální HTTP API; `RULES.md` §4 GPL zakazuje – pořadatel to může odmítnout, náhrada trellis.cpp (MIT) + diffusers |
| TRELLIS.2-4B (Microsoft) | MIT | nativní uzly ComfyUI, bez nvdiffrast/nvdiffrec (nekomerční) |
| DINOv3 ViT-L (Meta) | DINOv3 License | kodér obrázku v balíku TRELLIS.2; komerčně dovoleno, zakázané vojenské, jaderné, zbraňové a ITAR použití – **rozhoduje uživatel u QA** |
| FLUX.2-klein-4B | Apache-2.0 | výchozí obrázek; varianta 9B je nekomerční a nepoužívá se |
| Z-Image-Turbo + Qwen3-4B | Apache-2.0 | záložní obrázek; kodér textu sdílí i FLUX.2 |
| BiRefNet (dotrénovaný Lucida) | MIT | místo RMBG-2.0, ta je nekomerční |
| gltfpack 1.2.0 | MIT | přes `npx` |
| Blender 5.1 | GPL | nástroj, stejně jako jinde v repu |
| VR Blender Generate | vlastní dřívější dílo autora | port dodělávky, bez částí Hunyuan3D (`RULES.md` §5) |

Python závislosti (`uv.lock`): fastapi 0.141.1 MIT, uvicorn 0.53.0 BSD-3-Clause, trimesh 5.1.0
MIT, huggingface_hub 1.32.0 Apache-2.0, pyyaml 6.0.3 MIT, numpy 2.5.3 BSD-3-Clause AND 0BSD
AND MIT AND Zlib AND CC0-1.0 (vše povolené v `RULES.md` §4); jen pro testy httpx a pytest.

## Ověření

```bash
uv run --group dev pytest -q          # jednotkové testy, ComfyUI je v nich atrapa
uv run smoke.py --noun penguin        # skutečný ComfyUI + karta + klíč, zabije jen své procesy
```
