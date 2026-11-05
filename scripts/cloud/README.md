# Demo bez domácího PC (P30A)

Nasazené demo nesmí volat nic, co běží na autorově počítači: žádný cloudflared tunel, žádný `codex-cli` (osobní předplatné), žádný `llama-server` na RTX 3090. Tady je, co ho nahrazuje, a jak to nasadit.

| Co | Dřív (PC za tunelem) | Teď |
|---|---|---|
| Režisér | astra přes codex-shim :18767 | gpt-6-astra přes placené OpenAI API (`openai:https://api.openai.com`), strop `WORLDSMITH_SPEND_CAP_USD` (P71A) |
| Záloha režiséra | llama.cpp :8792 | vypnutá: všechny `WORLDSMITH_FALLBACK_*` prázdné (P71A) |
| Panoramata | služba :8793 | předpečená knihovna `public/play/env` (`bake-panoramas.mjs`), nejbližší prostředí |
| Hlas | Kokoro :8794 | hostované Kokoro přes DeepInfra (`openai-speech:<kořen>`), cache ve sdíleném úložišti |

## Postup

1. **Účty a klíče** (ručně, platební údaje): Together nebo Fireworks, OpenAI API se stropem, DeepInfra. Klíče jen do Vercelu, nikdy do repa.
2. **Proměnné** podle `env.production.example` do Vercelu, **jen Production** – Vercel předškrtává i Preview a Development; preview s týmž klíčem by dostalo vlastní knihu (`<předpona>:preview`) s plnými stropy navíc a součet 70 USD by neplatil. Sdílené úložiště dodá integrace Upstash jako `KV_REST_API_URL` / `KV_REST_API_TOKEN`.

   **Stropy jsou součtové za celou dobu knihy, ne měsíční.** Kniha (`WORLDSMITH_SPEND_STORE_PREFIX`, v produkci `sayplay`) sčítá útratu od prvního volání a sama se nevynuluje: režisér 60, čtečka 10, celkem `PLAY_TOTAL_SPEND_CAP_USD=70`, z režiséra 40 USD drží rezerva poroty do `PLAY_JUDGING_FROM`. Další měsíc = vyšší strop a redeploy. Předponu v provozu neměň: klíčuje i publikované hry, feed a cache, takže nová předpona rozbije každý dřívější odkaz `/play/<id>`. Záloha režiséra je vypnutá tím, že jsou všechny `WORLDSMITH_FALLBACK_*` prázdné; vyplněná jen část kontrolu shodí.
3. **Kontrola:** `vercel env pull .env.production --environment=production`, pak

   ```
   node scripts/cloud/check-env.mjs .env.production
   ```

   Vrátí 1 a vypíše jméno proměnné, když adresa míří na tunel, `127.0.0.1`, `localhost`, `codex-cli` nebo `llamacpp:`, když chybí některý dolarový strop, když je profil `subscription`, když chybí předpona knihy, když je záloha vyplněná jen zčásti, když součet stropů přeleze `PLAY_TOTAL_SPEND_CAP_USD`, nebo když strop počtu volání (`WORLDSMITH_CALL_CAP`, `PLAY_READER_CALL_CAP`) chybí či kousne dřív než dolarový strop. Hodnoty nevypisuje. `.env.production` pak smaž.

   **Co kontrola nevidí:** pojmenovaný cloudflared tunel na vlastní doméně (vypadá jako běžná adresa), hodnoty označené ve Vercelu jako *sensitive* (`vercel env pull` je vrátí prázdné) a prázdné klíče (ty se sem nepíšou záměrně). Poslední slovo má proto krok 4.
4. **Nasazení**, pak vypnout tunely a PC a zahrát na telefonu pět nových vět. Hotovo je až to, ne zelená kontrola.

## Nová panoramata

`node scripts/cloud/bake-panoramas.mjs --direct` dopeče prostředí ze `src/play/env/baked.json`, která ještě nemají soubor (na RTX 3090, pod GPU zámkem). Nové soubory v `public/` chtějí `node scripts/assets/register-disclosure.mjs` a `npm run disclosure` v témže commitu.
