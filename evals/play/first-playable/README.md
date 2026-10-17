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
