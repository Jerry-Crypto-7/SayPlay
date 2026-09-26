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

## Zvukové efekty – MOSS-SoundEffect

- **Licence:** váhy i kód [Apache-2.0](https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect) (karta modelu), zvukový kodek [MOSS-Audio-Tokenizer Apache-2.0](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer), kód [github.com/OpenMOSS/MOSS-TTS](https://github.com/OpenMOSS/MOSS-TTS). Ověřeno přes HF API 26. 9. 2026. Záznam `MOSS-SoundEffect` je v `disclosure.json`.
- **Prostředí:** `uv sync --project ops/audio --group sfx` (torch 2.9.1 cu128, transformers 5.0, bitsandbytes). Váhy v `D:/caches/huggingface/hub` (16 GB model + 6,7 GB kodek).
- **VRAM:** 8B v bf16 (16 GB) se vedle ostatních stop na 3090 nevejde, proto `--bits 4` (nf4) a kodek na CPU (`--codec-device cpu`).
- **Past na Windows:** procesor MOSS skládá id repa přes `os.path` → `OpenMOSS-Team\MOSS-SoundEffect` a HF ho odmítne; `sfx.py` proto předává lokální složky ze `snapshot_download`.
- **Spuštění:**
  ```
  node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/audio python ops/audio/sfx.py --bits 4 --codec-device cpu
  ```
- **Postup jednoho zvuku:** popis události + zabarvení looku → model → `trim_silence` (−45 dB) → zkrácení na délku události (jump/hit 0,6 s, pickup 0,8 s, lose 2 s, win 2,5 s) se zeslabením 80 ms → `normalize` (−16 dBFS RMS) → Ogg Vorbis mono 24 kHz ≤ 25 kB.
- **Naměřeno 26. 9. 2026 na 3090 (nf4, kodek na CPU):** 90 zvuků, průměr **7,6 s na zvuk** včetně dekódování, načtení modelu ~40 s, **778 kB celkem**, největší soubor 18 kB.
- **Výstup:** `src/play/audio/sfx-catalog.json` (`sounds[look][event]` → URL).
- **Poslech:** testy hlídají ticho, délku a hlasitost, ne to, jestli „skok“ zní jako skok. To ověří až člověk ve hře.

## Hlas vypravěče – Kokoro-82M

- **Licence:** váhy [Apache-2.0](https://huggingface.co/hexgrad/Kokoro-82M) (karta modelu), kód [`kokoro` 0.9.4 Apache-2.0](https://github.com/hexgrad/kokoro), převod na fonémy [`misaki` Apache-2.0](https://github.com/hexgrad/misaki). Ověřeno přes HF API a PyPI 26. 9. 2026. **Pozor:** `misaki[en]` si pro neznámá slova táhne `espeakng-loader` a `phonemizer-fork` (espeak-ng, **GPL-3.0**). Běží jen lokálně jako nástroj; do produktu jde jen vygenerovaný zvuk, žádný kód ani váhy – stejně jako ComfyUI u hudby.
- **Prostředí:** `uv sync --project ops/audio --group voice --group dev` (s `--group sfx` navíc, když má zůstat i MOSS – `uv sync` drží jen jmenované skupiny). První běh stáhne `en_core_web_sm` a váhy do `HF_HOME`.
- **Služba:**
  ```
  AUDIO_KEY=... HF_HOME=D:/caches/huggingface uv run --project ops/audio python ops/audio/server.py
  ```
  Jen `127.0.0.1:8794`, každá cesta chce `X-Audio-Key`. `POST /voice {"text"}` založí úlohu (fronta jedné úlohy, nejvýš 50 čekajících), `GET /voice/{id}` vrátí Ogg, 202 (generuje se) nebo 404. Id = prvních 32 hex ze SHA-256 `af_heart\n<text>` – Next ho počítá stejně (`src/app/api/play/_voice.ts`), takže nahrávku najde bez paměti. Model se načte až s první úlohou; generování drží sdílený zámek karty `D:/claude/_shared/gpu.lock` (týž protokol jako `gpu-lock.mjs`, mrtvého vlastníka převezme). Cache: `ops/audio/.voice-cache/` (gitignorovaná).
- **Napojení:** Next zná službu z `PLAY_VOICE_ENDPOINT` + `PLAY_VOICE_KEY` (tunel). Publikace pošle cíl hry a nečeká; hra si nahrávku vyžádá po prvním gestu přes `GET /api/play/games/:id/voice` (204, dokud není hotová). Bez služby hra mlčí.
- **Postup:** cíl hry (`tutorial.goalLine`, nejvýš 240 znaků) → Kokoro (`lang_code="a"`, hlas `af_heart`, 24 kHz) → `normalize` (−18 dBFS RMS) → Ogg Vorbis mono q 3. Ticho je chyba úlohy, ne nahrávka.
- **Naměřeno 26. 9. 2026 na 3090:** načtení modelu 46,6 s (se stažením jazykového modelu), první věta 3,6 s, další **0,44 s**; 3,1–3,8 s řeči, 19–23 kB na větu.

## Testy

```
uv run --project ops/audio pytest ops/audio/tests
```

`test_loop.py` drží šev smyčky, `test_music_catalog.py` pokrytí všech looků, rozpočet velikosti a záznam každého souboru v disclosure, `test_sfx.py` okamžitý nástup, délku a hlasitost zvuků a pokrytí 18 looků × 5 událostí.
