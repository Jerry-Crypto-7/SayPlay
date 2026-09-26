# FlashWorld na RTX 3090 – splat, nebo jen panorama (P29C T1)

Datum: 26. 9. 2026. Zdroj: `https://github.com/imlixinyang/FlashWorld` (klon `main` v `D:/tools/flashworld`),
Hugging Face API `https://huggingface.co/api/models/<repo>`.

## Pravidlo (napsané předem v plánu P29C)

`splat` jen když **všechny** licence jsou MIT/Apache/BSD, generování ≤ 90 s, soubor ≤ 20 MB a Spark vykreslí;
jinak `panorama-only`. Podmínky se vyhodnocují v tomhle pořadí a první nesplněná rozhoduje.

## Licence

| Část | Odkud | Licence | Zdroj |
|---|---|---|---|
| Kód FlashWorld | `github.com/imlixinyang/FlashWorld` | Apache-2.0 | `LICENSE` v repu |
| Váhy FlashWorld `model.ckpt` (20,94 GB) | `imlixinyang/FlashWorld` (`cli.py:198`, `hf_hub_download`) | **CC-BY-NC-SA-4.0** | `cardData.license` na `huggingface.co/imlixinyang/FlashWorld` |
| Základ Wan 2.2 TI2V 5B – transformer, VAE, UMT5 text encoder (34,2 GB) | `Wan-AI/Wan2.2-TI2V-5B-Diffusers` (`app.py:150-172`) | Apache-2.0 | `cardData.license` na `huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers` |
| gsplat | `nerfstudio-project/gsplat` | Apache-2.0 | `requirements.txt` |
| spz | `nianticlabs/spz` | MIT | `requirements.txt` |

Vlastní váhy FlashWorldu jsou **nekomerční (NC) a share-alike**. `RULES.md` §4 povoluje jen MIT/Apache/BSD,
takže první podmínka pravidla padá.

## Čas, velikost, Spark

- **Čas generování na 3090: neměřeno.** Licence rozhodla dřív; stahovat 55 GB vah, které se nesmí
  použít, by výsledek nezměnilo. Publikovaná čísla z README: 7 s na A100, 4 s na H100; paměť 51 GB
  bez offloadu, 24 GB s `--offload_t5 --offload_transformer_during_vae`, 9 GB s `--offload_t5 --offload_vae`.
  Na 3090 (24 GB, dnes sdílená s dalšími stopami, při spiku obsazeno 13,5 GB) by šla jen offload
  varianta 9 GB – odhad, ne měření.
- **Velikost výstupu: neměřeno** (CLI umí `--ply` i `--spz`).
- **Spark v Chromiu: neověřeno.** `@sparkjsdev/spark` se do projektu nepřidává, protože T8 ho podle
  tohoto rozhodnutí nepoužije; `e2e/play-env-splat-spike.spec.ts` místo vykreslení hlídá, že tento
  záznam a jeho rozhodnutí zůstanou v souladu s pravidlem.
- Na Windows by navíc bylo potřeba kompilovat gsplat (CUDA) a volitelně SageAttention; README Windows
  nezmiňuje.

## Kdy to přehodnotit

Když autor FlashWorldu přelicencuje `model.ckpt` na Apache/MIT, nebo vznikne přeučená váha
s permisivní licencí. Pak se měří čas, velikost a Spark podle pravidla výš.

DECISION: panorama-only – váhy FlashWorld `model.ckpt` jsou CC-BY-NC-SA-4.0, což `RULES.md` §4 nepovoluje.
