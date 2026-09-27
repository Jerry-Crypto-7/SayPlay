# Kdo umí sloužit LoRA pro gpt-oss-20b po tokenech

Přečteno 27. 9. 2026.

## Závěr

Podle veřejné dokumentace žádný poskytovatel neumí vlastní LoRA adaptér pro `gpt-oss-20b` na sdíleném API s platbou po tokenech (Together i Fireworks to výslovně odmítají, ostatní podporují LoRA jen na jiných bázích nebo na pronajatém GPU a jediná neověřená je DeepInfra, jejíž seznam LoRA bází je vidět až po přihlášení), takže to **nejde**.

### Nejbližší náhrady (podrobně níže)
- **Amazon Bedrock** – vlastní dotrénování `gpt-oss-20b` přímo u nich (jen metodou RFT, tedy učení s hodnoticí funkcí) a pak volání po tokenech za 0,09 / 0,39 USD za 1M tokenů. Vlastní adaptér ale nahrát nejde.
- **W&B Inference (CoreWeave)** – vlastní LoRA po tokenech za stejnou cenu jako báze, jenže jen pro jiné modely (Qwen3, Llama, Gemma 4), max. rank 16.
- **Tinker** – po tokenech (0,45 USD za 1M výstupních), ale výslovně jen na testování, ne pro provoz.

## Přehled

| Poskytovatel | Vlastní LoRA pro gpt-oss-20b serverless | Cena s adaptérem vs bez | Studený start | Formát (rank, moduly) | Limity |
|---|---|---|---|---|---|
| Together AI | **ne** – serverless LoRA zrušená, adaptéry jen na dedikovaném endpointu | nejasné – serverless cena báze v ceníku chybí | nejasné | PEFT `adapter_config.json` + `adapter_model.safetensors`; výchozí moduly pro gpt-oss `q/k/v/o_proj` | nejasné |
| Fireworks AI | **ne** – LoRA jen na on-demand (dedikovaném) nasazení; samotný gpt-oss-20b serverless nemá | serverless neexistuje; fine-tune „za stejnou cenu jako báze“ jen na on-demand GPU (H100 8 USD/h) | nejasné | rank 4–64; moduly `q/k/v/o_proj`, `up/down/gate_proj` (`w1/w2/w3`), `block_sparse_moe.gate` | počet adaptérů na nasazení nejasný |
| DeepInfra | **nejasné** – LoRA po tokenech umí, seznam bází jen po přihlášení | LoRA o 50 % dražší než báze; báze 0,03 / 0,14 USD | nejasné; LoRA o 50–60 % pomalejší | adaptér z Hugging Face; rank a moduly nejasné | nejasné |
| Nebius Token Factory | **ne** – vyladěné modely jen na dedikovaný endpoint, MoE LoRA se má sloučit do vah | fine-tune ano, serverless LoRA pro gpt-oss ne; báze od 0,05 USD vstup | – | rank 8–128 při tréninku u nich | nejasné |
| Novita AI | **ne** – adaptéry jen v Deployments (platba za GPU-sekundu) | serverless LoRA neexistuje; báze 0,04 / 0,15 USD | – | nejasné | nejasné |
| W&B Inference (CoreWeave) | **ne** pro gpt-oss-20b – serverless LoRA jen pro 8 jiných bází | u podporovaných bází stejná cena jako bez adaptéru; gpt-oss-20b 0,03 / 0,13 USD | nejasné | PEFT jako W&B artefakt typu `lora`, max. rank 16 | nejasné |
| Amazon Bedrock | **ne** pro vlastní adaptér; **ano** pro model vyladěný u nich (RFT) | vyladěný 0,09 / 0,39 USD vs báze 0,07 / 0,15 USD | nejasné; bez nasazování | určuje Bedrock, adaptér nenahráváš | jen `us-west-2`; úložiště 1,95 USD za model a měsíc |
| SiliconFlow | **ne** – fine-tune jen pro Qwen2.5, nahrání adaptéru nedoloženo | – | – | rank u nich doporučen 8 | – |
| Parasail, AkashML, Darkbloom, DekaLLM | **nejasné** – gpt-oss-20b ≤ 0,15 USD servírují, o LoRA nic nenalezeno | – | – | – | – |
| Tinker (Thinking Machines) | **ano, ale jen na testy** – vyladěný checkpoint po tokenech, beta | vzorkování 0,45 USD, prefill 0,18 USD za 1M | nejasné | trénink u nich; nahrání cizího adaptéru nedoloženo | „nízký interní provoz“ |

## Together AI

- Serverless LoRA inference včetně Serverless Multi-LoRA byla zrušena: „Serverless LoRA inference (including Serverless Multi-LoRA) has been discontinued.“ ([zdroj](https://docs.together.ai/docs/lora-inference), přečteno 2026-09-27)
- Adaptéry běží jen na dedikovaných endpointech: „Fine-tuned adapters are served on dedicated endpoints, not through the per-token serverless API.“ Víc adaptérů jde připojit k jednomu dedikovanému endpointu s LoRA. ([zdroj](https://docs.together.ai/docs/lora-inference), přečteno 2026-09-27)
- Nahraný adaptér musí mít `adapter_config.json` a `adapter_model.safetensors`, u archivu ze S3 v kořeni archivu. Nasazuje se stejně jako báze pro dedikovanou inference. Limity ranku, modulů ani velikosti stránka neuvádí. ([zdroj](https://docs.together.ai/docs/adapter-upload), přečteno 2026-09-27)
- Fine-tuning `openai/gpt-oss-20b` nabízí (LoRA i plný), výchozí moduly LoRA `k_proj`, `o_proj`, `q_proj`, `v_proj` – jen attention, bez expertů. ([zdroj](https://docs.together.ai/docs/lora-inference), přečteno 2026-09-27)
- Kontext při SFT 131 072 tokenů, max. batch 1. Upozornění: některé modely jdou vyladit, ale nejdou nasadit jako dedikovaný endpoint. ([zdroj](https://docs.together.ai/docs/fine-tuning-models), přečteno 2026-09-27)
- Cena fine-tune `gpt-oss-20B`: SFT 0,40 USD, DPO 1,00 USD za 1M tokenů, minimum 4,00 USD na úlohu. Zda sloupec SFT znamená LoRA, nebo plný trénink, tabulka nerozlišuje – nejasné. ([zdroj](https://www.together.ai/pricing), přečteno 2026-09-27)
- Serverless cena báze nejasná: stránka modelu uvádí 0,05 / 0,20 USD za 1M tokenů a zároveň „Launching soon“, přitom serverless ceník `gpt-oss-20B` neuvádí vůbec. ([zdroj](https://www.together.ai/models/gpt-oss-20b), [zdroj](https://www.together.ai/pricing), přečteno 2026-09-27)

## Fireworks AI

- LoRA nejde na serverless: „Trained LoRA models, whether created on the Fireworks platform or imported, can only be deployed to on-demand (dedicated) deployments. Serverless deployment is not supported for LoRA models.“ ([zdroj](https://docs.fireworks.ai/fine-tuning/deploying-loras), přečteno 2026-09-27)
- Na jedno on-demand nasazení jde načíst víc adaptérů (multi-LoRA), číselný limit neuvádí. Varianta „live merge“ je jeden adaptér na nasazení. ([zdroj](https://docs.fireworks.ai/fine-tuning/deploying-loras), přečteno 2026-09-27)
- Samotný `gpt-oss-20b` na Fireworks serverless nemá („Serverless: Not supported“), jen on-demand. Fine-tuning přes LoRA podporuje. ([zdroj](https://fireworks.ai/models/fireworks/gpt-oss-20b), přečteno 2026-09-27)
- Formát nahraného adaptéru: `adapter_config.json` + `adapter_model.safetensors` (nebo `.bin`), rank 4–64 včetně. Povolené moduly: `q_proj`, `k_proj`, `v_proj`, `o_proj`, `up_proj`/`w1`, `down_proj`/`w2`, `gate_proj`/`w3`, `block_sparse_moe.gate`; `lm_head` jen u některých architektur, `embed_tokens` ne. ([zdroj](https://docs.fireworks.ai/models/uploading-custom-models), přečteno 2026-09-27)
- Ceník: LoRA SFT pro modely 16,1–80B stojí 3,00 USD za 1M trénovacích tokenů (do 16B 0,50 USD). Pod který stupeň spadá gpt-oss-20b (21B celkem, 3,6B aktivních), ceník neříká. Odhad: 16,1–80B. On-demand H100 stojí 8,00 USD/h. „Serve fine-tuned models for the same price as base models“ se týká on-demand nasazení. ([zdroj](https://fireworks.ai/pricing), přečteno 2026-09-27)

## DeepInfra

- LoRA adaptéry se nasazují na „a base model that supports LoRA at DeepInfra (see supported base models in the upload form)“ – seznam bází je jen ve formuláři po přihlášení, ne v dokumentaci. Nejasné. ([zdroj](https://docs.deepinfra.com/private-models/lora), přečteno 2026-09-27)
- LoRA se volá po tokenech přes běžné API a stojí o 50 % víc než báze: „Pricing is 50% higher than base model.“ Rychlost je o 50–60 % nižší než u báze. Příspěvek z 6. 12. 2024. ([zdroj](https://deepinfra.com/blog/inference-lora), přečteno 2026-09-27)
- Adaptér se nahrává z Hugging Face (`hf_model_name`, volitelně `base_model_name`). Rank, moduly ani velikost API neomezuje. ([zdroj](https://docs.deepinfra.com/api-reference/lora-adapters/upload-lora-model.md), přečteno 2026-09-27)
- `gpt-oss-20b` stojí 0,03 / 0,14 USD za 1M tokenů, přesnost bfloat16. O LoRA stránka modelu mlčí. ([zdroj](https://deepinfra.com/openai/gpt-oss-20b), přečteno 2026-09-27)
- Veřejná metadata modelu mají tagy `openai, tools, reasoning, json, structured-output, priority, flex`, bez `lora-base`. Stejný tag ale chybí i u Llama-3.1-8B, kterou dokumentace uvádí jako příklad LoRA báze, takže o gpt-oss nic neříká. ([zdroj](https://api.deepinfra.com/models/openai/gpt-oss-20b), [zdroj](https://api.deepinfra.com/models/meta-llama/Meta-Llama-3.1-8B-Instruct), přečteno 2026-09-27)
- Odhad: báze běží v bf16, ne v MXFP4, takže technicky by LoRA šla (vLLM ≥ 0.15 umí multi-LoRA pro MoE, viz Technické pozadí). Ověřit se to dá jen pohledem do formuláře po přihlášení nebo dotazem na feedback@deepinfra.com.

## Nebius Token Factory

- Aktuální stránka o post-trainingu: „Deployment options currently only include via Dedicated endpoints.“ a „For merging MoE LoRA adapter weights to deploy on Dedicated endpoints please follow the guide“. ([zdroj](https://docs.tokenfactory.nebius.com/post-training/models.md), přečteno 2026-09-27)
- Starší stránka pořád uvádí „serverless LoRA adapter models“, ale jen pro `meta-llama/Llama-3.1-8B-Instruct` a `Llama-3.3-70B-Instruct`; gpt-oss je tam jen jako `unsloth/gpt-oss-20b-BF16` k fine-tuningu. Obě stránky si protiřečí, platí novější. Pro gpt-oss-20b serverless LoRA nenabízí ani jedna. ([zdroj](https://docs.tokenfactory.nebius.com/fine-tuning/models), přečteno 2026-09-27)
- Návod ke sloučení MoE LoRA do vah má jako příklad gpt-oss-20b: adaptéry se „zapečou“ do základních vah. ([zdroj](https://docs.tokenfactory.nebius.com/post-training/merge-moe-lora-weights.md), přečteno 2026-09-27)
- Rank při tréninku u nich: `lora_r` 8–128, výchozí 8. ([zdroj](https://docs.tokenfactory.nebius.com/post-training/how-to-fine-tune.md), přečteno 2026-09-27)
- Báze `gpt-oss-20b` „From $0.05 / 1M input tokens“, výstupní cena na stránce nebyla čitelná (nejasné). Cenu fine-tune jsem nenašel. ([zdroj](https://nebius.com/services/token-factory/models/openai-gpt-oss), přečteno 2026-09-27)

## Novita AI

- LoRA adaptéry jdou přidat jen v Deployments (dedikované GPU): „after selecting a Base Model, click + Add Adapter“. Víc adaptérů sdílí jednu kopii báze. ([zdroj](https://docs.novita.ai/guides/llm-dedicated-endpoint), přečteno 2026-09-27)
- Deployments se účtují po GPU-sekundách, ne po tokenech: „A RUNNING Deployment is billed even when it receives zero API requests.“ ([zdroj](https://docs.novita.ai/guides/llm-dedicated-endpoint), přečteno 2026-09-27)
- Báze `gpt-oss-20b` serverless: 0,04 / 0,15 USD za 1M tokenů, fp4. ([zdroj](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints), přečteno 2026-09-27)

## W&B Inference (CoreWeave)

- Serverless LoRA s vlastním adaptérem existuje, ale jen pro osm bází: `google/gemma-4-26B-A4B-it`, `meta-llama/Llama-3.1-70B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`, `OpenPipe/Qwen3-14B-Instruct`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.6-35B-A3B`, `Qwen/Qwen3.6-27B`, `Qwen/Qwen3-30B-A3B-Instruct-2507`. `gpt-oss-20b` mezi nimi není. ([zdroj](https://docs.wandb.ai/inference/lora), přečteno 2026-09-27)
- Formát: PEFT uložený jako W&B artefakt typu `lora`, max. rank 16 u všech bází. Cena: „Calls that use LoRA artifacts are billed at the same rates as standard model inference.“ ([zdroj](https://docs.wandb.ai/inference/lora), přečteno 2026-09-27)
- Ceny: gpt-oss-20b 0,03 / 0,13 USD (bez LoRA); pro LoRA nejlevnější OpenPipe Qwen3-14B 0,05 / 0,22 USD, Qwen3-30B-A3B 0,10 / 0,30 USD, Llama 3.1 8B 0,22 / 0,22 USD. ([zdroj](https://wandb.ai/site/pricing/inference), přečteno 2026-09-27)
- Seznam obsahuje MoE báze (Qwen3-30B-A3B, Qwen3.6-35B-A3B, Gemma 4 26B-A4B), takže serverless LoRA nad MoE technicky jde. U gpt-oss to jen nikdo nenabízí.

## Amazon Bedrock

- Fine-tuning přes OpenAI-kompatibilní API podporuje `openai.gpt-oss-20b` (a `qwen.qwen3-32b`), jen v `us-west-2`. Po dotrénování jde model rovnou volat po tokenech, bez nasazování („Immediate inference … without additional deployment steps“). ([zdroj](https://docs.aws.amazon.com/bedrock/latest/userguide/fine-tuning-openai-apis.html), přečteno 2026-09-27)
- Jde o reinforcement fine-tuning (RFT) s hodnoticí funkcí v Lambdě, oznámený 17. 2. 2026. Klasické SFT pro gpt-oss ani nahrání vlastního adaptéru stránky nezmiňují – nejasné, spíš ne. ([zdroj](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-bedrock-reinforcement-fine-tuning-openai), přečteno 2026-09-27)
- Ceny RFT pro gpt-oss-20b: trénink 80 USD/h, vyladěný model 0,09 USD vstup a 0,39 USD výstup za 1M tokenů, úložiště 1,95 USD za model a měsíc. ([zdroj](https://aws.amazon.com/bedrock/pricing/), přečteno 2026-09-27)
- Báze gpt-oss-20b na Bedrocku 0,07 / 0,15 USD za 1M tokenů (v Sydney 0,0721 / 0,3090 USD, cena se liší podle regionu). ([zdroj](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints), [zdroj](https://aws.amazon.com/bedrock/pricing/), přečteno 2026-09-27)
- Custom Model Import umí vlastní váhy gpt-oss-20b (od 24. 11. 2025, `us-east-1`), ale platí se 0,05718 USD za Custom Model Unit a minutu v pětiminutových oknech, ne po tokenech. Import samostatného LoRA adaptéru článek nezmiňuje. ([zdroj](https://aws.amazon.com/blogs/machine-learning/deploy-gpt-oss-models-with-amazon-bedrock-custom-model-import/), [zdroj](https://aws.amazon.com/bedrock/pricing/), přečteno 2026-09-27)

## SiliconFlow

- Fine-tuning jen pro `Qwen/Qwen2.5-7B/14B/32B/72B-Instruct`, gpt-oss-20b ne. Nahrání cizího adaptéru dokumentace nezmiňuje. ([zdroj](https://docs.siliconflow.com/en/userguide/guides/fine-tune), přečteno 2026-09-27)
- Báze gpt-oss-20b: 0,04 / 0,18 USD za 1M tokenů, fp8. ([zdroj](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints), přečteno 2026-09-27)

## Parasail, AkashML, Darkbloom, DekaLLM

- Servírují gpt-oss-20b pod limitem: Darkbloom 0,018 / 0,09, AkashML 0,02 / 0,10, DekaLLM 0,029 / 0,14, Parasail 0,03 / 0,15 USD za 1M tokenů. ([zdroj](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints), přečteno 2026-09-27)
- O serverless LoRA u nich jsem nic nenašel; Parasail vrací na stránce dedikovaných endpointů 404. Nejasné, žádný důkaz pro „ano“.

## Tinker (Thinking Machines) – alternativa, ne provoz

- `openai/gpt-oss-20b` je k dispozici s kontextem 32K. Za 1M tokenů: prefill 0,18 USD, cached prefill 0,036 USD, sample 0,45 USD, train 0,396 USD; úložiště checkpointů 0,10 USD za GB a měsíc. ([zdroj](https://tinker-docs.thinkingmachines.ai/tinker/models/), přečteno 2026-09-27)
- OpenAI-kompatibilní endpoint pro vyladěné checkpointy je beta „meant for testing and internal use with low internal traffic, rather than large, high-throughput, user-facing deployments“. Nahrání cizího adaptéru nezmiňuje. ([zdroj](https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/openai/index.md), přečteno 2026-09-27)

## Mimo cenový limit nebo mimo hru

- **Groq** (gpt-oss-20b 0,075 / 0,30 USD): LoRA jen pro enterprise a jen pro `llama-3.1-8b-instant`. Formát ZIP s `adapter_model.safetensors` + `adapter_config.json`, rank jen 8/16/32/64, váhy float16; studený start roste s rankem. ([zdroj](https://console.groq.com/docs/lora), [zdroj](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints), přečteno 2026-09-27)
- **Cloudflare Workers AI** (gpt-oss-20b 0,20 / 0,30 USD): schéma modelu má parametr `lora`, ale LoRA dokumentace vyžaduje `model_type` jen „mistral“, „gemma“ nebo „llama“ a filtr LoRA modelů gpt-oss-20b neobsahuje – dokumentace si protiřečí, pro gpt-oss spíš ne. Limity: rank ≤ 32, soubor < 300 MB, 100 adaptérů na účet. ([zdroj](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/), [zdroj](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/), [zdroj](https://developers.cloudflare.com/workers-ai/models/?capabilities=LoRA), přečteno 2026-09-27)
- **Hyperbolic**: „The serverless inference API and the playground have been retired.“ ([zdroj](https://www.hyperbolic.ai/docs/inference/overview), přečteno 2026-09-27)
- **Cerebras**: nabízí jen gpt-oss-120b (0,35 / 0,75 USD), 20b ne, o LoRA nic. ([zdroj](https://inference-docs.cerebras.ai/models/openai-oss), přečteno 2026-09-27)
- **Baseten**: v Model APIs (po tokenech) je jen GPT OSS 120B (0,10 / 0,50 USD), 20b ne. ([zdroj](https://www.baseten.co/pricing/), přečteno 2026-09-27)
- **SambaNova**: gpt-oss-20b po tokenech jsem nenašel, nezařazeno.

## Technické pozadí (MoE a LoRA)

- vLLM původně LoRA pro gpt-oss neservíroval. Požadavek byl uzavřen přes PR #21229. ([zdroj](https://github.com/vllm-project/vllm/issues/23610), přečteno 2026-09-27)
- Od vLLM 0.15.0 funguje multi-LoRA i pro MoE (GPT-OSS, Qwen3-MoE). LoRA na expertech jde na projekce `gate_up` a `down`, typický rank 16–64. ([zdroj](https://vllm.ai/blog/2026-02-26-multi-lora), přečteno 2026-09-27)
- vLLM rozlišuje MoE adaptéry ve formátu 2D (po expertech, styl megatron) a 3D (sloučený tensor, styl PEFT); oba najednou jen s přepínačem `--enable-mixed-moe-lora-format`. ([zdroj](https://docs.vllm.ai/en/stable/features/lora/), přečteno 2026-09-27)
- OpenAI cookbook ladí gpt-oss-20b s `r=8, lora_alpha=16, target_modules="all-linear"` a experty přidává přes `target_parameters` (`N.mlp.experts.gate_up_proj`, `N.mlp.experts.down_proj`). Model načítá z MXFP4 dekvantovaný do bf16 a na konci slučuje `merge_and_unload()`. ([zdroj](https://developers.openai.com/cookbook/articles/gpt-oss/fine-tune-transfomers), přečteno 2026-09-27)

## Co z toho plyne pro trénink (T4)

Doporučený serverless poskytovatel neexistuje, takže adaptér má projít u co nejvíc služeb najednou. Nejbezpečnější společný jmenovatel:

- **Rank `r = 16`** (`lora_alpha = 32` je odhad podle běžné praxe 2×r). Šestnáctku přijme každý nalezený limit: W&B max. 16, Fireworks 4–64, Groq jen 8/16/32/64, Cloudflare ≤ 32, Nebius 8–128. Rank 8 projde všude taky; 16 je nejvyšší rank, který projde všude.
- **`target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"]`**, jen attention. Je to výchozí nastavení Together pro gpt-oss, všechny čtyři jsou na seznamu Fireworks a jsou to názvy, které čte každý server.
- **Bez expertů, routeru, `lm_head` a `embed_tokens`.** Experti gpt-oss nejsou běžné lineární vrstvy, PEFT je trénuje přes `target_parameters` a ukládá ve 3D formátu. Odhad: Fireworks by je odmítl (jeho seznam zná `up/down/gate_proj` a `w1/w2/w3`, ne `gate_up_proj`), a u ostatních to nikdo nedokumentuje. Cookbook experty doporučuje kvůli kvalitě – odhad: attention-only adaptér se naučí formát a styl výstupu hůř, než by se naučil s experty. Experty dává smysl zapnout jen tehdy, když se místo serverless zvolí sloučené váhy na dedikovaném GPU.
- **Export:** PEFT adresář s přesně dvěma soubory, `adapter_config.json` (`r`, `lora_alpha`, `target_modules`, `base_model_name_or_path: openai/gpt-oss-20b`) a `adapter_model.safetensors`. Váhy ve float16, protože Groq float16 výslovně vyžaduje a ostatní ho přijmou (odhad). Pro nahrání zabalit do `.zip` nebo `.tar.gz` se soubory v kořeni archivu (Together), velikost pod 300 MB (Cloudflare).
- **Odhad velikosti:** 24 vrstev, hidden 2880, 64 dotazových a 8 KV hlav po 64 → zhruba 8 M parametrů LoRA, tj. asi 16 MB ve fp16. Hluboko pod všemi limity.
- **Báze pro trénink:** bf16 (`unsloth/gpt-oss-20b-BF16`, případně MXFP4 dekvantované do bf16 jako v cookbooku), protože DeepInfra servíruje gpt-oss-20b v bf16 a Nebius trénuje nad bf16. Vedle adaptéru mít připravený i skript na sloučení do bf16 vah. Nebius i Bedrock Custom Model Import berou jen sloučené váhy (jen dedikovaně nebo za minuty, ne po tokenech).
- **Než se trénink spustí:** jediný levný krok, který může závěr otočit, je podívat se po přihlášení do formuláře LoRA na DeepInfra, jestli nabízí `openai/gpt-oss-20b` jako bázi. Pokud ano, cena vyjde 0,045 / 0,21 USD za 1M tokenů (báze + 50 %, výpočet).
