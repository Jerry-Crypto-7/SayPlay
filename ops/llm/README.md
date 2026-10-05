# Lokální LLM na RTX 3090 – llama.cpp, čtenář a záložní režisér

Instalace mimo repo: binárky `D:/tools/llama.cpp` (`LLAMA_CPP_DIR`), modely `D:/caches/gguf` (`GGUF_DIR`).

```
powershell -ExecutionPolicy Bypass -File ops/llm/install.ps1   # idempotentní, stažení se navazuje
node ops/llm/check.mjs                                         # exit 0 = vše na místě
```

`install.ps1` bere nejnovější build z `github.com/ggml-org/llama.cpp/releases` (buildy jsou vedené jako prerelease, proto ne `/releases/latest`), asset `llama-*-bin-win-cuda-12.4-x64.zip` plus `cudart-llama-bin-win-cuda-12.4-x64.zip`. **Proč CUDA 12.4, ne 13.4:** ovladač 610.60 na tomhle stroji hlásí CUDA 13.3, build 13.x je dělaný na 13.4.

**Porty z plánu:** čtenář `8791`, záložní režisér `8792`. Startovací skript přijde v pozdější úloze.

## Pravidlo výběru

1. Licence jen `MIT`, `Apache-2.0`, `BSD` (`RULES.md` §4). Nic od Tencentu.
2. Čtenář (čte větu hráče a vrací strukturu) zabere nejvýš **6 GB VRAM**.
3. Čtenář + záložní režisér dohromady nejvýš **20 GB VRAM** (zbytek 24 GB karty je pro ostatní procesy a rezervu).
4. Musí běžet v llama.cpp (formát GGUF, který llama.cpp umí načíst).
5. Oba kandidáti na zálohu, kteří se vejdou, se stáhnou; porovná je až T9. Se čtenářem vždy běží jen jeden z nich.

## Kev – co jsem našel

- **Existuje:** [`jaredpalmer/kev-4b`](https://huggingface.co/jaredpalmer/kev-4b), licence Apache-2.0, plus sourozenci 0.5B, 0.6B, 0.8B, 9B. Je to LoRA adaptér (doplněk k základnímu modelu) s vlastní „pointer head“ nad `Qwen/Qwen3.5-4B-Base`.
- **Není to generativní model.** Kev je „decision model“: dostane dokument a sadu otázek s pevnými možnostmi (`choice` / `score` / `noul`) a vrátí pravděpodobnost pro každou možnost v jednom průchodu. Text negeneruje, takže z věty neumí napsat strukturu hry.
- **GGUF pro llama.cpp neexistuje.** Jediné GGUF ([`mys/kev-4b-GGUF`](https://huggingface.co/mys/kev-4b-GGUF), `kev_4b_ud_q4_k_m.gguf` 4,2 GB) jsou podle vlastní karty pro kompilátor `ggmlc` / server `laya` a „loading them in llama.cpp will fail“. Originál se servíruje přes Python (`kev.serve`, bf16 ~9 GB VRAM).
- **Licenční výhrada:** adaptér i základ jsou Apache-2.0, ale trénovací data „carry their own licenses“ – mezi nimi `SetFit/amazon_reviews_multi_en` a `Yelp/yelp_review_full`, jejichž podmínky komerční použití omezují. Na to by se muselo podívat, kdyby se Kev někdy použil.
- **Závěr:** pro čtenáře v llama.cpp nevyhovuje (bod 4 pravidla). Použit je `Qwen3-4B-Instruct-2507`. Kev by dával smysl jen jako samostatný klasifikátor přes `laya serve`, což je jiná úloha.

## Vybrané modely

Naměřeno 26. 9. 2026, llama.cpp `b11200` (CUDA 12.4), `llama-bench -p 512 -n 128 -r 3`, přes zámek GPU. VRAM = rozdíl `nvidia-smi` před během a ve špičce.

| Role | Model a GGUF (repo) | Licence | Soubor | VRAM | pp512 t/s | tg128 t/s |
|---|---|---|---|---|---|---|
| čtenář | Qwen3-4B-Instruct-2507, `Qwen3-4B-Instruct-2507-Q5_K_M.gguf` ([unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)) | Apache-2.0 ([LICENSE](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/LICENSE)) | 2,89 GB | **3,3 GB** naměřeno, celý na GPU | **7 498** | **169** |
| záloha A | gpt-oss-20b, `gpt-oss-20b-MXFP4.gguf` ([ggml-org/gpt-oss-20b-GGUF](https://huggingface.co/ggml-org/gpt-oss-20b-GGUF)) | Apache-2.0 ([LICENSE](https://huggingface.co/openai/gpt-oss-20b/blob/main/LICENSE)) | 12,11 GB | celý na GPU ~12,5 GB (odhad); naměřeno 8,5 GB s `-ncmoe 8` | 860 ⚠ | 17 ⚠ |
| záloha B | Qwen3.6-35B-A3B, `Qwen3.6-35B-A3B-UD-IQ3_S.gguf` ([unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)) | Apache-2.0 ([LICENSE](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE)) | 13,68 GB | celý na GPU ~14 GB (odhad); naměřeno 11,1 GB s `-ncmoe 16` | 621 ⚠ | 6,5 ⚠ |

**Součet se vejde:** čtenář 3,3 GB + záloha A ~12,5 GB = ~16 GB, se zálohou B ~17,5 GB, obojí pod 20 GB. Odhad „celý na GPU“ = velikost vah podle `llama-bench` (11,27 GiB, 12,73 GiB) plus ~1 GB na cache a výpočet; změřený není.

**⚠ Čísla záloh nejsou výkon na volné kartě.** Ostatní procesy držely 13–13,5 GB z 24 GB a po 9 minutách čekání se neuvolnily, takže oba modely běžely s částí expertů (MoE vrstev) na CPU (`-ncmoe N`) – to generování několikanásobně zpomalí. U zálohy B navíc karta ve špičce došla na 24,1 GB z 24,6 GB, souběžně běžel generátor z jiného worktree a rozdíl VRAM je proto zašuměný. Skutečné porovnání celého modelu na GPU patří do T9, až bude volných aspoň ~15 GB.

Kvantizace zálohy B: `UD-IQ3_S` je nejvyšší kvalita, která se se čtenářem vejde do 20 GB; `UD-Q3_K_S` (15,4 GB) a výš by rozpočet překročily. Obraz (`mmproj`) se nestahuje, čtenář i režisér pracují jen s textem.

Soubory, které `check.mjs` hlídá (v `D:/caches/gguf`):

- `Qwen3-4B-Instruct-2507-Q5_K_M.gguf` – čtenář
- `gpt-oss-20b-MXFP4.gguf` – záložní režisér, kandidát A
- `Qwen3.6-35B-A3B-UD-IQ3_S.gguf` – záložní režisér, kandidát B

Každý příkaz, který model načte do VRAM, jde přes zámek GPU: `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.
