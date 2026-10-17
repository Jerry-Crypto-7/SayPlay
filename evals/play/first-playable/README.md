# Čas do první hratelné hry na `/play` (P49 T3)

Dvě čísla: **věta → hratelná hra** (od klepnutí na „Make it!“) a **sdílená hra →
hratelná** (od otevření odkazu `/play/<id>` v čistém prohlížeči). Obojí na
produkčním buildu lokálně, okamžitá verze hry; `report.json` nese každý běh.

## Naměřeno 17. 10. 2026

| metrika | medián | min – max | běhů hratelných |
|---|---|---|---|
| věta → hratelná | **2,1 s** (2061 ms) | 1,4 – 4,5 s | 15 / 15 |
| sdílená hra → hratelná | **2,2 s** (2189 ms) | 2,0 – 2,3 s | 3 / 3 |

Po větách (medián, min – max, 3 běhy):

| věta | medián | min – max |
|---|---|---|
| zombie shooter in a mall | 1795 ms | 1722 – 2917 |
| A space marine shoots alien bugs in a mining colony | 1522 ms | 1422 – 1530 |
| A knight must collect three keys in a haunted castle while dodging ghosts. | 1740 ms | 1734 – 2312 |
| A hamster escaping a supermarket while a giant Roomba hunts me | 2098 ms | 2061 – 4477 |
| A corgi runs through a park grabbing sausages and jumping over sprinklers | 2389 ms | 2075 – 3269 |

Ve vodopádu běhu s1-r2 (1722 ms) trvá uložení hry na serveru 128 ms a poslední
síťový požadavek před hratelností skončí v 1,2 s; zbytek je první snímek hry a
rozlišení sondy.

## Metoda

- **Sonda:** `scripts/measure/time-to-playable.mjs` (Playwright chromium 151,
  headless, GPU přes ANGLE D3D11, okno 1280×720). Spouští se s JSON configem:
  - věta: `url` = `/play`, `promptSelector` = `[data-testid=play-sentence]`,
    `submitSelector` = `[data-testid=play-create]`, `waitForUrl` =
    `/play/[a-f0-9]+(\?|$)`, `surfaceSelector` = `canvas`, `timeoutMs` = 120000;
  - sdílená hra: `url` = `/play/<id>` hry z prvního běhu první věty,
    `surfaceSelector` = `canvas`; každý běh nový prohlížeč a kontext.
- **Hratelná** = plátno hry změní ≥ 1 % pixelů do 500 ms po vstupu (klepnutí do
  středu, Space, držená šipka vpravo) **a hned další pokus reaguje znovu**; čas je
  první reakce té dvojice. Jedna reakce nestačí, protože první klepnutí smí jen
  schovat úvodní obrazovku. Na stránce tvorby už hraje doporučená hra; plochy,
  které existovaly před odesláním věty, sonda ignoruje.
- **Sada vět:** prvních 5 vět `evals/play/p30/dev.json`, 3 běhy každá, mezi běhy 2 s.
- **Server:** `npm run build` (webpack) a `next start` na 127.0.0.1, úložiště her
  v nové prázdné složce (`PLAY_STORE_DIR`), bez klíčů k modelům.
- **Důkazy:** HAR a snímky každého běhu leží mimo repo v
  `.claude/rea-pruzkum/raw/sayplay/` hlavního checkoutu (`sentence-sN-rM.har`,
  `shared-rM.har`, `shots/<běh>/surface-before.png`, `surface-after.png`,
  `surface-confirm.png`, `page.png`). `t0` a `tPlayable` v `report.json` jsou
  epoch ms, takže se dají odečíst přímo proti `startedDateTime` v HAR.

## P50: střídavé měření A/B (17. 10. 2026)

- **Nástroj:** `node scripts/measure/first-playable-ab.mjs <config.json>` – dva
  servery (A, B), stejné cíle, běhy po dvojicích těsně po sobě; strana, která
  jde první, se po dvojicích střídá (AB, BA, …), mezi běhy 5 s. Opakování je
  vnější smyčka, takže se tři běhy cíle rozloží přes celé měření.
- **Cíle:** věty `evals/play/p30/dev.json` [0..4] (věta → hra na `/play`) a
  sdílené hry z vět [5..9] (skript je publikuje přes `POST /api/play/games` na
  obou serverech a měří otevření `/play/<id>`). Před měřením se každá věta
  publikuje na obou serverech, takže každý běh věty najde hotovou hru.
- **Profily:** `desktop` (1280×720 jako výše) a `pixel7-cpu4` (Playwright
  `Pixel 7`, CPU 4× pomalejší přes CDP jako `e2e/p35-perf.spec.ts`).
- **Dvě metriky:** čas do hratelnosti (`ms`, sonda výše) a `firstFrameMs` – od
  t0 do konce prvního snímku, ve kterém plátno hry kreslilo (sonda obalí
  kreslicí volání WebGL a `requestAnimationFrame`). První snímek nemá zrnitost
  pokusů sondy (~0,6 s, na telefonu pod zátěží i několik sekund).
- **Úpravy sondy:** snímek plochy v CSS pixelech – na telefonu s hustotou 2,6
  a 4× CPU trval snímek v plném rozlišení přes 2 s a jeden pokus ~5 s; na
  desktopu s hustotou 1 beze změny. Navíc `device`, `cpuThrottle`, `firstFrameMs`.
- **Výstup:** medián, min, max po cíli, druhu cíle a profilu; `diffMedian` =
  medián B − medián A, `pairedDiffMedian` = medián rozdílů B − A uvnitř dvojic,
  kde hrály obě strany. Nehratelný běh je selhání, do časů se nepočítá. HAR
  každého běhu leží mimo repo v `.claude/p50-raw/<běh>/` hlavního checkoutu.

### Rozptyl: stejný kód na obou stranách (`p50-baseline.json`)

A = `origin/main` 04700849, B = větev v T1 (mění jen `scripts/measure`).
3 běhy × 10 cílů × 2 profily × 2 strany = 120 běhů, 30 dvojic na profil. Stroj
byl během měření vytížený jinými úlohami (CPU až 100 %).

| profil | metrika | medián A (min – max) | medián B (min – max) | B − A mediánů | B − A párů |
|---|---|---|---|---|---|
| desktop | hratelná | 2134 ms (1447 – 9927) | 2111 ms (1469 – 3034) | −23 | +37 |
| desktop | první snímek | 1191 ms (880 – 1679) | 1170 ms (884 – 1800) | −21 | +6 |
| pixel7-cpu4 | hratelná | 6333 ms (4515 – 42221) | 6436 ms (4442 – 17930) | +103 | −56 |
| pixel7-cpu4 | první snímek | 3917 ms (1656 – 36456) | 3503 ms (1643 – 6076) | −414 | +28 |

Telefon A má jedno selhání (hra nereagovala do 60 s). Po druzích cílů (15 dvojic)
je párový rozdíl širší: nejvíc −141 ms (telefon, sdílená hra, první snímek).

**Závěr:** dva stejné buildy se v mediánu liší až o 414 ms, v párech nejvýš o
56 ms. Rozdíl mediánů bez párování na rozhodnutí o 50 ms pod zátěží stroje nestačí.

### Rozhodnutí P50

- **Rozhoduje párový medián přes oba druhy cílů v profilu** (30 dvojic), ne
  rozdíl mediánů.
- **Práh skutečné změny** = větší z 50 ms a |A proti A| téže metriky a profilu:
  hratelná desktop 50 ms, telefon 56 ms; první snímek 50 ms na obou. Změna
  zůstane, když aspoň jedna metrika v aspoň jednom profilu klesne pod −práh a
  žádná nestoupne nad +práh; jinak se vrátí a zapíše níž do „Zkoušeno a vráceno“.
- **Srovnávací build A je poslední přijatý stav před úlohou**, ne pořád
  `origin/main` – o úloze rozhoduje její vlastní přínos. Proti `origin/main`
  měří až konečné měření.
- **T6: „data před prvním snímkem“ = detail hry `GET /api/play/games/:id`.** HAR
  T5 (120 běhů) ho ukazuje v každém běhu před prvním snímkem, kvůli jedinému
  údaji `bestDare` pro ducha. `/env` se ptá až po prvním snímku (`Panorama`
  začne v prvním `useFrame`) a v měřených hrách vůbec, `/voice` až po prvním
  vstupu hráče (vypravěč), `/upgrade` je štítek AI verze – nic z toho první
  snímek nečeká, proto zůstávají na klientovi.

### Přijato

Párový medián B − A (30 dvojic na profil), A = `origin/main`.

| Úloha | Změna | Hratelná desktop | Hratelná telefon | 1. snímek desktop | 1. snímek telefon | Proč zůstává |
|---|---|---|---|---|---|---|
| T6 | Nejlepší běh pro ducha (`bestDare`) jde se stránkou `/play/[id]`; klient ho použije pro první načtení ducha, další se ptá dveří znovu | +17 ms | **−195 ms** | −4 ms | −42,5 ms | Telefon pod prahem −56 ms, nic nad prahem. HAR před hratelností: detail hry A 60/60 běhů, B 0/60. |

### Zkoušeno a vráceno

Párový medián B − A (30 dvojic na profil), záporné = B rychlejší.

| Úloha | Změna | Hratelná desktop | Hratelná telefon | 1. snímek desktop | 1. snímek telefon | Proč vráceno |
|---|---|---|---|---|---|---|
| T2 | AO, SMAA a bloom až po prvním snímku (skládač s tónováním a laděním zůstal v prvním) | **+334 ms** | −263 ms | −319 ms | +28 ms | První snímek přijde dřív, ale překlad odložených efektů (~285 ms hlavního vlákna) padne přesně na start hry – na desktopu je hratelná později. |
| T3 | Plátno stojí, dokud `compileAsync` nepřeloží programy scény (nejdéle 300 ms) | −77 ms | **+438 ms** | **+232 ms** | −4 ms | Paralelní překlad v Chromu sondy první snímek nezkrátí, jen ho odsune o čekání; telefon měl 5/4 běhů přes limit 60 s (zatížený stroj). |
| T4 | Poctivá hláška (`honestyOf`) ve streamu stránky za `Suspense`, ne před prvním bajtem | – | – | – | – | Studený server (3 kola × 9 her, oba servery znovu spuštěné nad kopií téhož úložiště): první bajt A 470 ms, B 473 ms, párově −17 ms. `honestyOf` jsou synchronní svědecké běhy (169–2020 ms na hru) ve vlákně serveru – drží odeslání stránky i ve streamu, i když začnou až o úlohu později (shell je vykreslený s čekající hranicí, ale odejde až po nich). Standardní A/B to nevidí vůbec: hru zakládá týž server a hláška je v jeho paměti. Skutečná oprava: spočítat hlášku jednou při zveřejnění a uložit ji ke hře (změna schématu úložiště), nebo ji počítat mimo vlákno požadavku. |
| T5 | Chunky scény ohlášené v HTML (`<link rel="preload">` přes prázdný SSR díl `next/dynamic` v `ArcadePlay`) místo `import()` při načtení modulu | −32 ms | **+274,5 ms** | +12 ms | +26 ms | Druhá vlna začala s první, ale lokálně se chunk stáhne za ~10 ms – čas stojí v provádění JS, ne v síti. Vedlejší nález: na `main` stahuje scénu i mřížková hra (`ArcadePlay` je v `PlayShell` importovaný napevno a `import()` běží při načtení modulu); přínos přes internet (souběh se stahováním první vlny) lokální měření neukáže. |

## Co číslo neříká

- **AI verze neměřena.** Vylepšení od režiséra potřebuje klíče k modelu a lokálně
  neběží; čísla platí pro okamžitou verzi, kterou hráč dostane jako první.
- **Lokální síť.** Server běží na stejném stroji, takže chybí latence internetu a
  CDN. Nasazená verze bude pomalejší o síť; přenos do hratelnosti byl ~0,4 MB.
- **Stejná věta = stejná hra.** Okamžitá verze je deterministická, běhy 2 a 3
  každé věty uložily hru se stejným id. Uložení trvá ~0,1 s, na mediánu to nic
  podstatného nemění.
- **Rozlišení ~0,6 s.** Sonda zkouší vstup v cyklech; hra připravená uprostřed
  pokusu se pozná až v dalším. Všech 18 běhů zareagovalo hned na první pokus po
  objevení plátna a potvrdilo to druhým.
- **Plocha se hýbe i bez vstupu.** U 17 z 18 běhů se plátno po úspěchu měnilo
  samo (≥ 1 % za 300 ms – běžící hra, nepřátelé, kamera). Snímky před/po vstupu
  a potvrzovací snímek jsme prošli u běhů s nejnižší změnou a u nejpomalejšího:
  všechny ukazují spuštěnou hru (výstřel, posun zaměřovače, běžící čas), ne
  načítání.
