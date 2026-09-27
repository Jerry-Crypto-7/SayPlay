# Demo bez domácího PC (P30A)

Nasazené demo nesmí volat nic, co běží na autorově počítači: žádný cloudflared tunel, žádný `codex-cli` (osobní předplatné), žádný `llama-server` na RTX 3090. Tady je, co ho nahrazuje, a jak to nasadit.

| Co | Dřív (PC za tunelem) | Teď |
|---|---|---|
| Režisér | astra přes codex-shim :18767 | gpt-oss-20b přes Together/Fireworks (`openai:<kořen>`), strop `WORLDSMITH_SPEND_CAP_USD` |
| Záloha režiséra | llama.cpp :8792 | astra přes OpenAI API, vlastní strop `WORLDSMITH_FALLBACK_SPEND_CAP_USD` |
| Panoramata | služba :8793 | předpečená knihovna `public/play/env` (`bake-panoramas.mjs`), nejbližší prostředí |
| Hlas | Kokoro :8794 | hostované Kokoro přes DeepInfra (`openai-speech:<kořen>`), cache ve sdíleném úložišti |

## Postup

1. **Účty a klíče** (ručně, platební údaje): Together nebo Fireworks, OpenAI API se stropem, DeepInfra. Klíče jen do Vercelu, nikdy do repa.
2. **Proměnné** podle `env.production.example` do Vercelu (Production). Sdílené úložiště dodá integrace Upstash jako `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. **Kontrola:** `vercel env pull .env.production --environment=production`, pak

   ```
   node scripts/cloud/check-env.mjs .env.production
   ```

   Vrátí 1 a vypíše jméno proměnné, když adresa míří na tunel, `127.0.0.1`, `localhost`, `codex-cli` nebo `llamacpp:`, když chybí některý dolarový strop nebo když je profil `subscription`. Hodnoty nevypisuje. `.env.production` pak smaž.
4. **Nasazení**, pak vypnout tunely a PC a zahrát na telefonu pět nových vět. Hotovo je až to, ne zelená kontrola.

## Nová panoramata

`node scripts/cloud/bake-panoramas.mjs --direct` dopeče prostředí ze `src/play/env/baked.json`, která ještě nemají soubor (na RTX 3090, pod GPU zámkem). Nové soubory v `public/` chtějí `node scripts/assets/register-disclosure.mjs` a `npm run disclosure` v témže commitu.
