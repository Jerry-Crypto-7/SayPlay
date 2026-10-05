# Demo walkthrough – WORLDSTREAM PLAY

Stav 29. 9. 2026. Průchod pro porotce i pro natáčení videa. Veřejná adresa je `demoUrl` v [submission.json](submission.json); provoz běží aspoň do 31. 12. 2026. Ověření na telefonu s vypnutým autorovým počítačem (P31 T4) se sem zapíše s datem, až proběhne.

## Průchod na veřejné adrese

1. Otevři `/play` (kořen `/` sem přesměruje). Napiš vlastní anglickou větu, nebo vyber jednu z osmi startovních karet, a stiskni **Play it**.
2. Za 1–2 s stojí hratelná hra: slovní draft složený ze slov věty, přeložený kompilátorem a ověřený robotem (vyhraje a přehraje se na stejný hash stavu). Adresa se změní na `/play/<id>`.
3. Zahraj si ji. Mřížka se ovládá klepnutím na cíl, arkádové hry šipkami nebo dotykem podle ovládání (runner, platform, flap, steer, arena, shooter, throw, timing, rhythm, duel).
4. Na pozadí zatím AI režisér (gpt-oss u hostovaného poskytovatele, záloha gpt-6-astra přes OpenAI API) zvolí ovládání, doplňky, vzhled, prostředí, role a cíl. Když je hotovo, stránka nabídne AI verzi („The AI version is ready – play it“) jako novou hru s odkazem na draft. Když AI není dostupná, hra zůstane draftem a stránka to napíše.
5. Po výhře nebo prohře: znovu, remixový čip („Make it harder“, „Swap the enemy“, …) nebo vlastní remixová věta. Remix je nová hra s odkazem na rodiče; původní hra se nemění.
6. **Share** zkopíruje odkaz s náhledovým obrázkem; odkaz otevřený v anonymním okně nebo na telefonu hraje totéž bez účtu.
7. Feed ukazuje AI verze her po jedné na obrazovku; posun prstem nebo kolečkem.

## Co porotce uvidí, když něco chybí

- **AI nedostupná nebo strop útraty vyčerpaný:** každá hra zůstane slovním draftem, stránka to přizná. Nic se nezastaví.
- **Sloveso, které draft nezná:** bez AI verze z věty vznikne sběrná hra s výchozími předměty.
- **Neznámá věc:** scéna použije nejbližší model z knihovny nebo náhradu (balónek → míč); měření ji počítá jako nenakreslenou.

## Místní spuštění

```powershell
npm ci
npm run build
node node_modules/next/dist/bin/next start
```

Otevři `http://localhost:3000/play`. Bez konfigurace modelu je každá hra draft. AI verze potřebuje serverové proměnné z `.env.example` (`WORLDSMITH_BRANCH=live`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_MODEL_KEY`, `WORLDSMITH_MODEL`, `WORLDSMITH_SPEND_CAP_USD`). Stavěj přes webpack (`npm run build`), ne Turbopack – pod ním má stránka hry a API každá vlastní úložiště.

Podrobnosti: [README](../../README.md), [režisér](../play/director.md), [arkáda](../play/ARCADE.md), [feed](../play/feed.md).
