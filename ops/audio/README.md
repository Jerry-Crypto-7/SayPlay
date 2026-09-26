# ops/audio – hudba, zvuky a hlas pro PLAY

Lokální generování zvuku na RTX 3090. Do produktu jde jen výsledek (`public/assets/worldstream/audio/**`), žádné váhy.

## Hudba – ACE-Step 1.5

- **Licence:** kód [Apache-2.0](https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE), váhy [MIT](https://huggingface.co/ACE-Step/Ace-Step1.5) (karta modelu), repack pro ComfyUI [Apache-2.0](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files). Ověřeno přes HF API 26. 9. 2026. Záznam `ACE-Step 1.5` je v `disclosure.json`.
- **Cesta:** sdílené ComfyUI na `:8188` (nerestartovat – používají ho i jiné stopy). Váhy v `D:/caches/huggingface/hub/models--Comfy-Org--ace_step_1.5_ComfyUI_files`, hardlinky v `D:/tools/comfyui/models/{diffusion_models,text_encoders,vae}`: turbo DiT, enkodéry `qwen_0.6b_ace15` + `qwen_1.7b_ace15` (místo 8 GB `4b`), `ace_1.5_vae`. Workflow podle blueprintu `Text to Audio (ACE-Step 1.5)`.
- **Spuštění:**
  ```
  node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/audio python ops/audio/music.py
  ```
  `--only <look>` přegeneruje jeden look, `--disclose-only` jen přepíše `disclosure.json`. Pak `node scripts/license-gate.mjs --sync`.
- **Postup jedné smyčky:** 16 s z modelu → `loop_crossfade` (2 s rovnovýkonové prolnutí konce do začátku) → `normalize` (−18 dBFS RMS) → Ogg Vorbis q 2. Šev nad 3 dB → další seed (nejvýš 6).
- **Naměřeno 26. 9. 2026 na 3090:** 36 smyček (18 looků × klidná/napjatá) po 14 s, **4,6 s na jeden pokus**, 4,6–29 s na smyčku včetně opakování kvůli švu, celý běh 6 min 45 s včetně čekání na zámek GPU, 132–178 kB na soubor, **5,4 MB celkem**, šev 0,09–2,78 dB.
- **Výstup:** `src/play/audio/music-catalog.json` (`loops[look][mood]` → URL).

## Testy

```
uv run --project ops/audio pytest ops/audio/tests
```

`test_loop.py` drží šev smyčky, `test_music_catalog.py` pokrytí všech looků, rozpočet velikosti a záznam každého souboru v disclosure.
