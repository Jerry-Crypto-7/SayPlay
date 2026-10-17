# Čas do první hratelné hry na `/play` (P49 T3)

Dvě čísla: **věta → hratelná hra** (od klepnutí na „Make it!“) a **sdílená hra →
hratelná** (od otevření odkazu `/play/<id>` v čistém prohlížeči). Obojí na
produkčním buildu lokálně, okamžitá verze hry; `report.json` nese každý běh.

## Naměřeno 17. 10. 2026

| metrika | medián | min – max | běhů hratelných |
|---|---|---|---|
| věta → hratelná | **2,2 s** (2198 ms) | 1,3 – 4,1 s | 15 / 15 |
| sdílená hra → hratelná | **2,3 s** (2251 ms) | 2,1 – 2,4 s | 3 / 3 |

Po větách (medián, min – max, 3 běhy):

| věta | medián | min – max |
|---|---|---|
| zombie shooter in a mall | 2055 ms | 1856 – 2282 |
| A space marine shoots alien bugs in a mining colony | 1468 ms | 1339 – 1630 |
| A knight must collect three keys in a haunted castle while dodging ghosts. | 2072 ms | 2043 – 2357 |
| A hamster escaping a supermarket while a giant Roomba hunts me | 2261 ms | 2198 – 4141 |
| A corgi runs through a park grabbing sausages and jumping over sprinklers | 2350 ms | 2266 – 3269 |

Ve vodopádu prvního běhu (věta 1) trvá uložení hry na serveru 174 ms a poslední
síťový požadavek před hratelností skončí v 1,27 s; zbytek do 2,06 s je první
snímek hry a rozlišení sondy.

## Metoda

- **Sonda:** `scripts/measure/time-to-playable.mjs` (Playwright chromium 151,
  headless, GPU přes ANGLE D3D11, okno 1280×720). Spouští se s JSON configem:
  - věta: `url` = `/play`, `promptSelector` = `[data-testid=play-sentence]`,
    `submitSelector` = `[data-testid=play-create]`, `waitForUrl` =
    `/play/[a-f0-9]+(\?|$)`, `surfaceSelector` = `canvas`, `timeoutMs` = 120000;
  - sdílená hra: `url` = `/play/<id>` hry z prvního běhu první věty,
    `surfaceSelector` = `canvas`; každý běh nový prohlížeč a kontext.
- **Hratelná** = plátno hry změní ≥ 1 % pixelů do 500 ms po vstupu (klepnutí do
  středu, Space, držená šipka vpravo). Na stránce tvorby už hraje doporučená hra;
  plochy, které existovaly před odesláním věty, sonda ignoruje.
- **Sada vět:** prvních 5 vět `evals/play/p30/dev.json`, 3 běhy každá, mezi běhy 2 s.
- **Server:** `npm run build` (webpack) a `next start` na 127.0.0.1, úložiště her
  v nové prázdné složce (`PLAY_STORE_DIR`), bez klíčů k modelům.
- **Důkazy:** HAR a snímky každého běhu leží mimo repo v
  `.claude/rea-pruzkum/raw/sayplay/` hlavního checkoutu (`sentence-sN-rM.har`,
  `shared-rM.har`, `shots/<běh>/surface-before.png`, `surface-after.png`, `page.png`).
  `t0` a `tPlayable` v `report.json` jsou epoch ms, takže se dají odečíst přímo
  proti `startedDateTime` v HAR.

## Co číslo neříká

- **AI verze neměřena.** Vylepšení od režiséra potřebuje klíče k modelu a lokálně
  neběží; čísla platí pro okamžitou verzi, kterou hráč dostane jako první.
- **Lokální síť.** Server běží na stejném stroji, takže chybí latence internetu a
  CDN. Nasazená verze bude pomalejší o síť; přenos do hratelnosti byl ~0,4 MB.
- **Stejná věta = stejná hra.** Okamžitá verze je deterministická, běhy 2 a 3
  každé věty (a ověřovací běh první věty před sadou) uložily hru se stejným id.
  Uložení trvá ~0,2 s, na mediánu to nic podstatného nemění.
- **Rozlišení ~0,6 s.** Sonda zkouší vstup v cyklech; hra připravená uprostřed
  pokusu se pozná až v dalším. 6 z 18 běhů potřebovalo dva pokusy.
- **Plocha se hýbe i bez vstupu.** U 15 z 18 běhů se plátno po úspěchu měnilo
  samo (≥ 1 % za 300 ms – běžící hra, nepřátelé, kamera). Snímky před/po vstupu
  jsme prošli u běhů s nejnižší změnou po vstupu a u nejpomalejšího: všechny
  ukazují spuštěnou hru (výstřel, posun zaměřovače, běžící čas), ne načítání.
