# P71C T5 – oracle v prohlížeči (golfová kamera, scény, karty)

5. 11. 2026, commit `a64b9f24` (build `next build` 19:01), `next start` na portu 3012, Chromium přes ANGLE/D3D11 s `--disable-features=OpenXR`. AI verze lokálně není („Couldn't make the full-detail version“), testovaná je rychlá verze.

- Golf: `e2e/play-minigolf.spec.ts`, test `minigolf camera: …` (beze změny), projekty `chromium` (1280×720) a `pixel7-touch` (412×839, dotyk). Jeden odpal na hru: ručně vyrobená hra testu (`fixture`) a tři věty z QA. Záznam kamery po snímcích je v `golf-<hra>-camera-<desk|phone>.json`, snímky jsou `golf-<hra>-<start|before|during|after>-<desk|phone>.png` (test je ukládá jako `<hra>-<projekt>-<start|aim|during|after>.png`, tady jsou přejmenované).
- Timing, rhythm, drawsave a karty: `scene-oracle.mjs` → `scene-oracle.json` a PNG. Hry vyrábí `make-games.mjs` (`games.json`) na běžícím serveru. Rámečky postav jsou obrysy skutečných vrcholů sítí (žába `toyHero`, lano `rope`, příšera `goal`) promítnuté živou kamerou, v CSS px.
- `handPlay('end')` / `idleRun()` vrací tik, sekundy jsou tik / 60.

## Výsledky

Prahy golfu (P71C T1/T2): míření ≤ 0,05 m za snímek a ≤ 0,3 m celkem; první 3 snímky po puštění ≤ 0,1 m a ≤ 1°; houpnutí ≤ 0,02 m; v klidu ≤ 0,005 m za snímek; klidový pohled na ose míček → cíl (> 0,995).
U všech 8 golfových řádků platí: míření 0,000 m za snímek i celkem, houpnutí 0,000 m, pohyb v klidu 0,000 m za snímek, osa 1,000, start karta nekryje míček ani jamku, chyby stránky 0.
„Špička“ je největší pohyb jednoho snímku vydělený větším ze sousedů (1,0 = hladká křivka).

| Kontrola | Věta | Viewport | Výsledek | Naměřeno |
|---|---|---|---|---|
| golf kamera | `golf` | desk 1280×720 | pass | puštění max 0,049 m / 0,08°; vrchol 3,54 m za snímek 60 Hz, špička 1,10, 0 obratů; výška 78,6 → 2,2 → 10,8 m; míček jel 1,42 s |
| golf kamera | `play mini golf` | desk 1280×720 | pass | 0,028 m / 0,07°; vrchol 2,20 m, špička 1,12, 0 obratů; 48,2 → 2,2 → 5,2 m; 1,40 s |
| golf kamera | `a golf ball rolls into the hole` | desk 1280×720 | pass | 0,032 m / 0,08°; vrchol 2,22 m, špička 1,07, 0 obratů; 50,8 → 2,2 → 9,7 m; 1,38 s; karta nahoře, hřiště pod ní (`golf-ball-start-desk.png`) |
| golf kamera | fixture testu | desk 1280×720 | pass | 0,024 m / 0,09°; vrchol 1,68 m, špička 1,28, 0 obratů; 36,6 → 2,2 → 10,3 m; 1,37 s |
| golf kamera | `golf` | phone 412×839 | pass | 0,022 m / 0,08°; vrchol 1,58 m, špička 1,39, 0 obratů; 38,1 → 2,1 → 24,5 m; 1,38 s |
| golf kamera | `play mini golf` | phone 412×839 | pass | 0,018 m / 0,11°; vrchol 0,99 m, špička 1,17; 1 obrat o 1 cm v okamžiku zastavení (sledování dopředu → stoupání do klidu), houpnutí 0; 23,5 → 3,1 → 9,6 m; 1,38 s |
| golf kamera | `a golf ball rolls into the hole` | phone 412×839 | pass | 0,014 m / 0,08°; vrchol 1,06 m, špička 1,12, 0 obratů; 24,7 → 2,1 → 14,4 m; 1,42 s |
| golf kamera | fixture testu | phone 412×839 | pass | 0,012 m / 0,08°; vrchol 1,04 m, špička 1,72 (0,25 / 0,45 / 0,26 m, 8. snímek sestupu), 0 obratů; 22,1 → 2,6 → 14,6 m; 1,38 s |
| timing: lano a příšera | `cut the rope at the right moment to feed the monster` | phone 390×844 | pass | lano 12×161 px (x 32–43, y 190–351), příšera 46×66 px (x 172–218, y 351–418) – obojí v okně; spodních 9 px příšery pod start kartou (karta od y 409); bonbon na laně při startu přečuhuje 50 px za levý okraj (x −50…123); `handPlay` won 30,0 s, `idleRun` lost 15,1 s |
| timing: lano a příšera | totéž | desk 1280×800 | pass | lano 24×256 px (x 384–408, y 51–308), příšera 64×92 px (x 608–672, y 322–414), spodních 32 px pod start kartou (karta od y 382); bonbon celý v okně (x 243–536); won 30,0 s, lost 15,1 s |
| timing | `tap at the right time to stop the moving platform` | desk 1280×800 | pass | won 30,0 s, lost 15,1 s |
| timing | `stack pancakes as high as you can` | desk 1280×800 | pass | won 30,0 s, lost 15,1 s |
| rhythm: žába v záběru | `A drummer frog plays on lily pads and the pond lights up with the beat` | phone 390×844 | pass, s výhradou | při hraní celá v okně: 18 vzorků za 3,5 s hry, nejmenší okraj vpravo 7 px (1 vzorek pod cílem 8 px, ostatní 8–12 px); snímek `input` x 289–378, y 455–533; 4 vzorky vynechané, žába po minutí bliká. Při startu x 289–382, y 401–482, ale skoro celá pod start kartou (karta x 16–374, y 378–594). Po `handPlay` je kamera jinde a žába je 25 px za pravým okrajem, kryje ji ale karta výsledku. Po „Play again“ x 278–360, opět pod start kartou. `handPlay` won 35,8 s, `idleRun` lost 7,1 s |
| drawsave: mřížka | `draw walls to save a puppy from bees` | desk 1280×800 | pass | mřížka 8×12, 534 px z 720 px plochy hry = 74,2 % (66,8 % z okna 800 px), buňka 44,4 px; po vstupu 72,6 %; tah myší zapsal 62 vstupů HOLD, zeď je na `drawsave-desk-input.png`; won 16,0 s, lost 7,5 s |
| karta: start | rope + drawsave | desk 1280×800 | pass | tažení myší přes kartu označí 0 znaků (oba případy), `user-select: none`; kontrola: stejné tažení přes obyčejný text ve stejném místě označí 244 znaků. Stisk myši na kartě hru spustí a karta zmizí – i tak 0 znaků |
| karta: prohra | rope + drawsave | desk 1280×800 | pass | po `idleRun` tažení přes `play-postrun` označí 0 znaků, `user-select: none`, karta zůstane vidět; kontrola 244 znaků |

## Mimo kontroly

- Golf: kamera se po odpalu pořád spouští z přehledu (22–79 m) na 2–3 m za míček a po zastavení zase stoupá (5–25 m). Teď je to jeden plynulý přechod tam a jeden zpět, bez houpání a bez skoku. (Úsudek: vzorec „spuštění a návrat“, který popsala QA, zůstal, jen je hladký.)
- Golf na telefonu: při startu banner „Couldn't make the full-detail version…“ překrývá počítadlo „0 strokes · par 4“ (`golf-golf-start-phone.png`).
- Timing rope: bonbon je dlouhý červený kvádr přes šířku lišty (~290×50 px na desktopu), ne tvar bonbonu.
- Rhythm na telefonu: velký šedý pás přes spodní třetinu pruhů (`rhythm-phone-input.png`, y ≈ 678–750 CSS px).
- Golfový test dělá snímek „during“ 150 ms po puštění a ten zdrží vykreslení až o 200 ms. Pohyby jsou proto přepočtené na snímek 60 Hz; syrové skoky 5–9 m za snímek v JSON jsou tyhle mezery.

## Zopakování

```
npm run build
npx next start -p 3012 --hostname 127.0.0.1
node evals/play/p71/golf/make-games.mjs http://127.0.0.1:3012
E2E_PORT=3012 FALLBACK_SMOKE_URL=http://127.0.0.1:3012 P71_GOLF_URLS="golf=<url>,mini=<url>,ball=<url>" P71_GOLF_OUT=evals/play/p71/golf \
  npx playwright test e2e/play-minigolf.spec.ts --project=chromium --project=pixel7-touch -g "minigolf camera"
node evals/play/p71/golf/scene-oracle.mjs http://127.0.0.1:3012
```
