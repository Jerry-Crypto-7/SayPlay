# FlashWorld – spike (P29C T1)

Rozhodnutí a čísla: `evals/play/env/flashworld.md`. Výsledek: **panorama-only**, protože váhy
`imlixinyang/FlashWorld` jsou CC-BY-NC-SA-4.0.

`run.ps1` připraví klon a prostředí v `D:/tools/flashworld` a pustí CLI přes GPU zámek. Nespouštěj ho
pro produkt, dokud se licence vah nezmění – slouží jen k zopakování měření, kdyby se změnila.

- Kód: Apache-2.0, `https://github.com/imlixinyang/FlashWorld`
- Základní model: `Wan-AI/Wan2.2-TI2V-5B-Diffusers`, Apache-2.0, 34,2 GB
- Váhy FlashWorld: `model.ckpt`, 20,94 GB, CC-BY-NC-SA-4.0
- Váhy do `D:/caches/huggingface/`, nic do repa.
