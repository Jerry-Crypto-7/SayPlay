# Sayplay ve VR (Meta Quest 2)

Sayplay jde hrát v brýlích Meta Quest přímo v jejich prohlížeči, bez obchodu a bez instalace. Hráč v brýlích vybere nebo řekne větu, zahraje si hru z ní, listuje feedem dalších her, vymění hru za AI verzi a pošle kamarádovi odkaz přes QR kód. Brýle přitom celou dobu nesundá.

**Stav k 29. 10. 2026:** všechno v tomhle dokumentu je ověřené v emulátoru brýlí na počítači (IWER – emulátor Questu od Mety, který běží v prohlížeči testů a dělá, že je to Quest 2 s ovladači). Na skutečném Questu 2 to ještě nikdo nehrál. To udělá majitel v oddílu „Kolo majitele v brýlích“. Co ověřené není, shrnuje oddíl „Známá omezení“.

K vyzkoušení stačí první tři oddíly a „Známá omezení“. Zbytek jsou podrobnosti o ovládání, měření a rozhodnutích.

## Celé kolo v brýlích

1. **Vstup do VR.** Tlačítko „Enter VR“ vidí jen prohlížeč, který VR umí (brýle). Telefon a počítač ho nedostanou a kód pro VR ani nestáhnou. Dvě cesty:
   - na domově `/play` vpravo nahoře – brýle začnou **lobby**: kartou s větami metr před hráčem;
   - ve **feedu** na `/play`: ťuknout na hru, aby ji hráč převzal od robota, a pak „Enter VR“ v liště hry – brýle začnou touto hrou.
2. **Hra.** Ovladače dělají totéž co klávesnice: páčka = šipky, spoušť = mezerník. Podle druhu hry stojí svět na stole, na velkém pódiu před hráčem, na podlaze kolem hráče, nebo se hraje rukou (oddíl „Ovládání ovladači“).
3. **Výsledek.** Po konci kola visí panel „You did it!“ nebo „So close.“ s tlačítky: „Again“ (znovu), „Next“ (další hra z feedu), „New game“ (lobby), „Share“ (QR kód), „Comfort“ (pohodlí) a „Exit VR“. Tlačítko se mačká paprskem z ovladače a spouští.
4. **Feed.** „Next“ vede do feedu odkudkoli: ve feedu na další kartu, ze hry z věty nebo z AI verze na feed domova. Tam hned hraje robot první karty a hráč ho vidí v brýlích. Pravá páčka mávnutím nahoru = další hra, dolů = předchozí. Spoušť převezme hru od robota, jako ťuk na telefonu.
5. **Hra z věty.** „New game“ otevře lobby: šest karet s větami, „Type“ (klávesnice ve vzduchu) a „Say it“ (hlas, jen když prohlížeč umí diktovat). „Make it!“ udělá hru a za pár sekund běží v brýlích.
6. **AI verze.** Hra z věty se nejdřív hraje v rychlé verzi. Když server dopočítá AI verzi, objeví se panel „AI version ready“ s tlačítkem „Play it“ a hra se vymění bez opuštění VR.
7. **Sdílení.** „Share“ ukáže QR kód odkazu na hru. Kamarád ho naskenuje telefonem. Po výhře odkaz nese výzvu: kamarád vidí skóre, které má překonat.
8. **Konec.** „Exit VR“ na panelu nebo systémové tlačítko Meta na pravém ovladači. Stránka se vrátí do 2D a hra běží dál.

Kolo jde projít v libovolném pořadí bez sundání brýlí: lobby → hra z věty → „Next“ → feed → „New game“ → lobby a znovu. Test celého kola jde v pořadí z cíle plánu (oddíl „Celá smyčka v jedné relaci“).

## Quest 2 – návod krok za krokem

### 1. Jednou: vývojářský režim

1. V telefonu otevři aplikaci Meta Horizon, ve které máš brýle spárované.
2. Menu → Devices → tvoje brýle → Headset settings → Developer mode → zapnout.
3. Když přepínač chybí, založ si zdarma vývojářskou organizaci na [developers.meta.com](https://developers.meta.com) (účet musí být ověřený) a vrať se k bodu 2.
4. Brýle restartuj.

### 2. Jednou: nástroj adb v počítači

adb (Android Debug Bridge) je nástroj, kterým počítač mluví s brýlemi přes USB. Instalace ve Windows:

```
winget install Google.PlatformTools
```

Pak otevři nový terminál, starý o instalaci neví. Skript níž adb najde sám, a když chybí, vypíše přesně tenhle příkaz.

### 3. Připojení brýlí

1. Připoj Quest 2 k počítači kabelem USB-C. Musí to být datový kabel, kabel jen na nabíjení brýle neukáže.
2. Nasaď brýle. Objeví se dotaz „Allow USB debugging?“. Zaškrtni „Always allow from this computer“ a potvrď. Bez toho počítač brýle vidí, ale nesmí s nimi nic dělat.
3. Dotaz nepřišel? Odpoj kabel a připoj ho znovu.

### 4. Build a server

V kořeni repozitáře:

```
npm run build
node node_modules/next/dist/bin/next start -p 3168
```

Server nech běžet ve vlastním terminálu. Skript v dalším kroku bez volby počítá s portem 3165, proto se mu port 3168 říká volbou `--port` (tak to chce i kolo majitele níž).

### 5. Otevření hry v brýlích

Ve druhém terminálu:

```
node scripts/quest-dev.mjs --port 3168
```

Skript:

1. najde adb;
2. ověří, že brýle jsou připojené a ladění povolily (jinak napíše, co udělat);
3. přesměruje port 3168, takže brýle vidí server počítače jako `localhost:3168`. To je nutné: vstup do VR v prohlížeči funguje jen na zabezpečené adrese a `localhost` mezi ně patří;
4. otevře v prohlížeči brýlí `http://localhost:3168/play?vrhud=1`.

### 6. V brýlích

1. Stránka se otevře sama, s `?vrhud=1` v adrese. „Enter VR“ nabídne každý prohlížeč, který VR umí; `?vr=0` v adrese VR vypne (pro ladění).
2. Stiskni „Enter VR“ vpravo nahoře. Začne lobby s větami (oddíl „Hra z věty ve VR“). Do feedu vede „Next“ na výsledku hry; rovnou z feedu se začíná ťuknutím na hru ve feedu a „Enter VR“ v liště hry.
3. Hraj. Vlevo dole v zorném poli visí malý panel FPS (zapíná ho `?vrhud=1` v adrese). Ukazuje za poslední sekundu:
   - `fps` – kolik snímků brýle nakreslily; plynulý chod je 72;
   - `worst ms` – nejdelší mezera mezi dvěma snímky; nad 14 ms je to cuknutí;
   - `cpu ms` – kolik ms stál snímek procesor (medián); nad 14 ms nestačí sám procesor, ne grafika.
4. Ven z VR: tlačítko „Exit VR“ na panelu hry (paprsek pravého ovladače a spoušť, viz „Panely ve VR“ níž), nebo systémové tlačítko Meta na pravém ovladači. Stránka se vrátí do 2D, hra běží dál a „Enter VR“ je zpět. Tlačítko na 2D stránce v relaci nejde, protože ji brýle nekreslí.

### 7. Měření FPS

```
node scripts/quest-dev.mjs --port 3168 --fps 60
```

Skript udělá kroky z bodu 5, pak počká. Až jsi ve VR a hra běží, stiskni v terminálu Enter. Následujících 60 sekund čte z brýlí systémový záznam snímků (jeden údaj za sekundu) a výsledek zapíše do `evals/vr/quest2-fps.json`. Číslo za `--fps` je délka měření v sekundách.

Když za celou dobu nepřijde jediný údaj, skript nic nezapíše a skončí chybou. Nula v souboru by vypadala jako změřená hra, která nejede.

### 8. Jak číst `evals/vr/quest2-fps.json`

```json
{
  "connected": true,
  "measuredAt": "2026-10-27T14:03:11.482Z",
  "base": "http://localhost:3165",
  "seconds": 60,
  "tour": false,
  "gate": { "median": 72, "p5": 65 },
  "genres": [
    { "id": "by-hand", "fps": [72, 72, 71, "…"], "median": 72, "p5": 68, "samples": 60, "enterVr": "by-hand" }
  ]
}
```

- `genres` – jeden řádek na měřenou hru. Ruční měření (`--fps`) má jeden řádek `by-hand`, prohlídka (`--tour`, bod 10) řádek na každý z 19 žánrů.
- `fps` – snímky v každé sekundě měření, jak je hlásí systém brýlí. Z nich test přepočítá medián a percentil.
- `median` – typická sekunda: polovina sekund měla víc snímků, polovina méně.
- `p5` – nejhorší chvíle: 5 % sekund mělo tolik snímků nebo méně. Právě tyhle propady jsou v brýlích cítit jako trhání.
- `samples` – kolik sekund se změřilo. Výrazně méně než `seconds` znamená, že brýle část doby nehrály (sundané, uspané, mimo VR).

Cíl: **`median` ≥ 72 a `p5` ≥ 65** na každém řádku. Quest 2 obnovuje obraz 72× za sekundu, takže 72 je plynulý chod. Hlídá to `evals/vr/__tests__/budget.test.ts`: když soubor říká `connected: true`, spočte medián a percentil znovu z `fps` a hru pod cílem shodí.

Když se v brýlích neměřilo, soubor má `connected: false`, větu „neměřeno …“ a důvod (`reason`, třeba „brýle spí“). Brána se pak nepočítá.

### 9. Ostrost proti plynulosti (`?vrscale`)

Hra ve VR kreslí v plném rozlišení prohlížeče Questu. Když některá hra nedrží 72, zkus ji s nižším rozlišením: v adrese v brýlích připiš `&vrscale=0.8` a změř znovu. Rozsah je 0,8–1,0 (`0.9` je mezi). Pokud je při 0,8 hra plynulá a text na panelech pořád čitelný, napiš to do zápisu brány – profil se pak přepne na 0,8.

Quest 3 a 3S kreslí na 1,2 a cílí na 90 FPS (oddíl „Profil Questu 3“ níž). Když tam hra 90 nedrží, `&vrscale=1` vrátí rozlišení Questu 2; frekvence zůstane 90. Výš než profil `vrscale` nejde.

### 10. Brýle bez člověka (`--cdp`)

```
node scripts/quest-dev.mjs --port 3168 --cdp
node scripts/quest-dev.mjs --port 3168 --cdp --probe
```

- `--cdp` přesměruje ladicí rozhraní prohlížeče brýlí (Chrome DevTools Protocol) na `localhost:9222` počítače. Skript pak vidí otevřené stránky a smí v nich spustit kód nebo klepnout. Klepnutí přes toto rozhraní bere prohlížeč jako klepnutí člověka, takže otevře i VR relaci.
- `--probe` zjistí, co prohlížeč Questu umí, a zapíše to do `evals/vr/quest-caps.json`: verzi prohlížeče, immersive VR, diktování (Web Speech API), sdílení odkazu, service worker, a po vstupu do VR obnovovací frekvence a vibrace ovladačů. Na serveru vytvoří jednu rychlou hru z věty (bez modelu, bez útraty), relaci po měření ukončí a přesměrování portů zruší.
- Bez připojených brýlí sonda zapíše `{"connected": false}` a skončí bez chyby.
- Skript nic neinstaluje do brýlí, nemění jejich nastavení a nemaže data prohlížeče. Diktování jen zkusí spustit a za 3 s zruší; když prohlížeč chce povolit mikrofon, dotaz zůstane bez odpovědi.

**Prohlídka všech žánrů bez člověka (`--tour`, P67 T13):**

```
npm run build
PLAY_STORE_DIR=D:/caches/p67/store node node_modules/next/dist/bin/next start -p 3168
node scripts/quest-dev.mjs --port 3168 --cdp --tour 30
```

1. Skript nejdřív jen čte: jsou brýle vzhůru (`dumpsys power`)? Spící brýle nebudí – po probuzení bez člověka drží popředí systémový dialog. Zapíše „neměřeno“ s důvodem a skončí bez chyby.
2. Přesměruje port 3168, v prohlížeči brýlí otevře `/play` a připojí se k němu přes ladicí rozhraní. Když se stránka do 30 s neukáže, zapíše „neměřeno“ a co bylo v popředí.
3. Na serveru počítače publikuje hru každého z 19 žánrů. Jsou to tytéž hry, které měří rozpočet v emulátoru (`evals/vr/budget.mjs --publish`, bez modelu a bez útraty).
4. Každou hru otevře, klepne na „Enter VR“, pustí robota, který hraje za hráče, 3 s počká a pak 30 s čte FPS ze systémového záznamu brýlí. V půlce uloží snímek obrazovky brýlí do `D:/caches/p67/quest/<žánr>.png` (jinam `--shots <složka>`). Pak relaci ukončí a jde na další hru.
5. Medián a 5. percentil každého žánru zapíše do `evals/vr/quest2-fps.json` (bod 8) a vypíše žánry pod cílem. Na konci zruší obě přesměrování portů.

Celá prohlídka trvá asi 19 × 35 s, tedy 11 minut. Brýle musí být vzhůru a v nich prohlížeč – stačí je mít na hlavě nebo zakrýt čidlo nad nosem. Kolo, které robot dohraje dřív než za 30 s, zůstane na panelu výsledku; sloupec `runState` v souboru to přizná.

### 11. Sayplay jako aplikace v knihovně Questu

1. V prohlížeči brýlí otevři Sayplay (`/play`).
2. V menu prohlížeče (tři tečky vpravo nahoře) zvol „Install app“ nebo „Add to library“. Ikona Sayplay se objeví v knihovně aplikací (Library → Unknown sources nebo přímo mezi aplikacemi, podle verze systému).
3. Sayplay z knihovny startuje rovnou na `/play` v okně bez adresního řádku.

- **Co instalaci umožní:** manifest `public/manifest.webmanifest` (`id`, `start_url` a `scope` `/play`, režim `standalone`, ikony 192 a 512 px) a service worker `public/play-sw.js`.
- **Worker nic neukládá a do požadavků nevstupuje.** Má jen prázdný posluchač `fetch`, který prohlížeč k instalaci chce; každý požadavek vyřídí prohlížeč sám, jako bez workeru. Aplikace tak vždy ukáže aktuální verzi hry. Bez sítě Sayplay nepoběží, stejně jako v prohlížeči.
- **Proč prázdný posluchač:** první verze posílala požadavky na síť sama (`fetch(event.request)`). E2E pak ukázalo, že takové požadavky obejdou odposlech sítě v testech: podvržený příchod AI verze v `vr-enter.spec.ts` nedorazil. Prázdný posluchač je i rychlejší, protože prohlížeč worker u požadavků vůbec nebudí.
- **Ověření:** `src/play/xr/__tests__/pwa.test.ts` (manifest, worker bez cache a bez převzetí odpovědi, registrace jen s immersive VR) a `e2e/vr-pwa.spec.ts` (IWER: worker je zaregistrovaný, stránka i API pod ním běží, cache je prázdná; Chromium bez VR: žádný worker).
- **Instalaci na skutečném Questu tento běh neověřil** (brýle nikdo neměl na hlavě); patří do ruční brány T15.
- **Registruje ho jen prohlížeč, který umí immersive VR.** Telefon a desktop žádný worker nedostanou, chovají se jako dřív. Registraci volá kód XR (`XrRoot`), který se stahuje jen tam, kde VR je; s `?vr=0` se proto worker nezaregistruje.
- **Orientace není zamčená.** Manifest nemá `orientation`, protože by zamkl i telefon, který si Sayplay nainstaluje; Quest ji nepotřebuje.
- **Proč `play-sw.js`, ne `sw.js`:** cesta `public/sw.js` je v `.gitignore` pro vygenerované workery jiných nástrojů.

### 12. Na konci

1. Server zastav v jeho terminálu (Ctrl+C).
2. Přesměrování portu zruš: `adb reverse --remove tcp:3168`. Prohlídka `--tour` a sonda `--probe` to dělají samy, ruční kroky 5 a 7 ne.

## Kolo majitele v brýlích (ruční brána)

Rozhoduje člověk v brýlích: hraje se to, ovládání sedí, text je čitelný a nikomu není špatně. Emulátor nic z toho posoudit neumí.

**Příprava:** kroky 1–6 návodu výš (server na portu 3168), pak místo kroku 5:

```
node scripts/quest-dev.mjs --port 3168 --fps 60
```

Až jsi ve VR a hraješ, stiskni v terminálu Enter. Skript 60 s měří FPS a zapíše je do `evals/vr/quest2-fps.json` (bod 8).

**V brýlích projdi** (u každého bodu si poznamenej „OK“, nebo co vadí):

1. **Hra z věty:** na `/play` stiskni „Enter VR“ vpravo nahoře. V lobby vyber kartu, nebo stiskni „Say it“ a řekni anglickou větu (když „Say it“ chybí, prohlížeč Questu diktovat neumí – pak „Type“ a klávesnice). „Make it!“ a hru zahraj.
2. **Again** po konci hry z věty.
3. **Feed:** po dalším konci kola „Next“. Brýle ukážou feed s robotem na první kartě. Pravou páčkou nahoru (další hra) a dolů (předchozí), spouští převezmi hru od robota a dohraj kolo.
4. **Share:** na výsledku „Share“, QR kód naskenuj telefonem. Telefon má otevřít tutéž hru (po výhře s výzvou). Kód se může ukázat až po ~12 s (oddíl „Známá omezení“).
5. **Svět kolem tebe:** aréna, obrana a chytání. Adresy her všech žánrů vypíše `node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs --base http://127.0.0.1:3168 --publish`; otevři je v prohlížeči brýlí jako `localhost:3168/play/<id>` a „Enter VR“.
6. **Trať na pódiu:** jedna z runner, platformer, flap, voyage, hop, crowd (adresy z téhož příkazu).
7. **Comfort:** „Seated“ a „Standing“, „Recenter“, velikost světa, vibrace, vinětace.

**Zápis:** do `evals/vr/README.md` (oddíl „Ruční brána“) řádek `Ruční brána P67: OK <datum>`, nebo seznam vad: co, ve které hře a jak se to projevilo. Vada znamená opravu před vydáním, ne vydání.

## Ovládání ovladači

Ovladače dělají totéž co klávesnice: páčka = šipky, spoušť = mezerník. Obě ruce platí stejně; páčka levého ovladače má přednost, když je vychýlená. Drift páčky pod 0,15 se nepočítá, jako šipka páčka platí až za polovinou výchylky. Výjimkou je grip: pravý grip je použití (`interact`), levý grip nese stůl s hrou (viz „Hry na stole“ níž).

| Ovládání hry | Páčka | Spoušť | A / X |
|---|---|---|---|
| runner | do strany = pruh, dolů = skluz, nahoru = skok | skok | skok |
| platform | běh vlevo a vpravo | skok | skok |
| flap, timing, rhythm | nahoru = ťuk | ťuk | ťuk |
| steer | plynulé zatáčení, dolů = brzda | stoupání (`land`) nebo střelba (`shoot`) | – |
| move_free, fight, push | směr pohybu | akce | střelba (E) |
| shooter | míření vlevo a vpravo | výstřel | výstřel |
| throw | nahoru a dolů = úhel | držet = nabíjení, pustit = hod | – |
| duel | dolů = úhyb | úder | úhyb |
| lanes, crowd, catch, whack, defense, slice | do strany = pruh | ťuk a držení | ťuk |
| hop | skok do čtyř směrů | ťuk | ťuk |
| merge | posun dávkovače | pustit předmět, až je připravený | – |
| glide, walker | do strany = zatáčení, nahoru a dolů = výška | střelba (glide s blasterem) | plachtění (glide) |

Pro všechny hry: schopnosti hrdiny jsou na A/X a B/Y, blaster na B/Y, úder v souboji na A/X a použití (`interact`) na pravém gripu. Míč (`ball`) zatím umí jen spoušť.

### Hry, které se hrají rukou

Čtyři hry se ve VR hrají pohybem pravého ovladače. Páčka a spoušť z tabulky výše fungují dál.

| Hra | Kde hráč stojí | Jak se hraje |
|---|---|---|
| shooter | v plné velikosti, 5,5 m za hrdinou | paprsek z pravého ovladače míří a zaměřovač je tam, kam paprsek dopadne; spoušť = výstřel |
| throw | v plné velikosti, 3 m za hrdinou, čelem ke hřišti | stisknout spoušť, máchnout dopředu a pustit; rychlost ruky = síla, směr ruky = úhel (5°–85°) |
| whack | díry v dosahu ruky, ve výšce pasu | úder ovladačem dolů nad dírou, nebo paprsek na díru a spoušť |
| slice | pruhy v dosahu ruky, ve výšce pasu | švih ovladačem nad pruhem, kterýmkoli směrem |

- **Prahy rychlosti ruky:**
  - hod začíná na 1 m/s, plnou sílu má od 6 m/s;
  - úder dolů od 1,2 m/s;
  - švih od 1,5 m/s.

  Jeden švih sekne jednou. Další sekne až po zpomalení ruky pod polovinu prahu.
- **Hod po puštění:** když se spoušť pustí dřív, než se míček nabil na sílu švihu, hod počká, až se nabití dokončí.
- **Vibrace:** při zásahu (přibydou body nebo zásah) pravý ovladač krátce zavibruje.
- **Odkud je rychlost ruky:** hlásí ji brýle. Kde ji nehlásí, spočte se z poloh ovladače mezi dvěma snímky.
- **Co se teprve ověří:** prahy se doladí v ruční bráně T8. Emulátor ověří, že ovladač pohne hrou, ale ne, jak se švih cítí v ruce.

**Ověření (T3):** `e2e/vr-native.spec.ts` hraje každou ze čtyř her dvakrát s robotem, který říká, co stisknout. Jednou ve 2D prstem, jednou ve VR skriptovaným ovladačem. Po 5 s mají obě hry stejné body i zásahy.

**Mutace (T2):** otočená osa páčky (8 testů červených), ztracená mrtvá zóna (2) a spoušť na špatném tlačítku (10) – `src/play/xr/__tests__/input-map.test.ts`.

### Hry kolem hráče (aréna, obrana, chytání)

Tři hry stojí ve VR na podlaze pokoje kolem hráče, ne na stole. Hráč stojí, hrdina se hýbe. Svět se za hry sám nikdy nepohne: kde stál na začátku, tam stojí až do konce. Otočí ho jen hráč tlačítkem „Recenter“ v panelu „Comfort“.

| Hra | Měřítko | Kde hráč stojí | Jak se hraje |
|---|---|---|---|
| arena | 1:2,5 (aréna 40 × 40 m) | ve středu arény, stěny 8 m od něj | levá páčka vede hrdinu jako dřív, hráč se za ním jen otáčí hlavou |
| defense | 1:1 | 1,5 m za hrdinou, za hradbou; nepřátelé jdou pruhy k němu | paprsek pravého ovladače na pruh a spoušť = výstřel do pruhu (jako ťuk prstem) |
| catch | 1:3 | před pruhy, do kterých věci padají (pruhy 1,2 m před ním) | koš (hrdina) jezdí pod pravou rukou: ruka nad pruhem drží ten pruh jako tažený prst |

- **Měřítko arény** se počítá ze stěn: stěny smí být nejvýš 8 m od hráče, svět ale nikdy menší než 1:3 (menší už je diorama).
- **Chytání 1:3:** pruhy jsou 0,67 m od sebe, krajní pruh začíná 1 m od středu. Na krajní pruhy stačí natažená ruka a půlkrok. Páčka do strany posune koš jen na jeden tik, ruka ho vrátí pod sebe; když brýle ruku ztratí, vede koš zase páčka.
- **Okolí:** za hranou hrací plochy je podlaha v barvě země prostředí hry (podle sady prostředí scény, jen čtení). Mlha scény ve VR nepůsobí (nález T7), podlaha proto sahá až k obloze. Nebe nad hráčem je obloha scény, ta se ve VR kreslí kolem hlavy v každém měřítku.
- **Panely** (cíl, počítadla, výsledek) jsou nad levým zápěstím jako u her rukou.
- **Co se ověří v brýlích (T8):**
  - u obrany kryje hradba (1 m vysoko, 3–4 m před hráčem) zem pruhů asi do 11 m, nepřátelé jsou nad ní vidět od pasu nahoru;
  - u chytání je koš ve výšce kolen (lapací čára 0,4 m) a věci padají z 2,8 m – hráč kouká víc dolů než u ostatních her;
  - v aréně startuje hrdina hráči u nohou.

**Ověření (P67 T6):**

- `e2e/vr-room.spec.ts` v emulátoru IWER: aréna – levá páčka doprava a hrdina ujede hráči doprava (ve skutečném prostoru); obrana – paprsek na krajní levý pruh, spoušť, ťuk do toho pruhu a hrdina v něm; chytání – ruka vlevo a pak vpravo za hranicí krajního pruhu a koš pod ní. U všech: stůl žádný, svět po hře stojí, kde stál, podlaha okolí má sadu prostředí scény.
- `src/play/xr/__tests__/xr-replay.test.ts`: aréna páčkou, obrana paprskem a chytání rukou dají přehráním vstupů bez XR týž hash. Chytání rukou navíc dá přesně tytéž vstupy a týž hash jako prst tažený po týchž pruzích.
- `src/play/xr/__tests__/modes.test.ts`: tabulka režimů má každý z 19 žánrů, neznámý žánr jde na stůl, žánr se pozná ze světa hry a čtyři hry rukou jsou přesně ty jako dřív; aréna má stěny nejvýš 8 m od hráče, obrana stojí 1:1, chytání 1:3.
- **Mutace:** chytání, které pošle polohu ruky rovnou jako osu (bez převodu na pruh), shodí test „ruka = prst“ v `xr-replay.test.ts`.

### Hry na stole (diorama)

Šest her se ve VR hraje jako zmenšený svět na stole: timing, rhythm, duel, quest, merge a push. Na stole jsou i hry ze staršího ovládání bez žánru (`glide`, `walker`, `ball`). Tratě mají od P67 T7 vlastní velké pódium (oddíl „Tratě na pódiu“ níž).

- **Stůl:** deska 1,2 × 1,2 m, její střed 0,9 m před hráčem, ve výšce 0,8 m. Nad deskou je 0,75 m prostoru. Co leží mimo tento prostor, se nekreslí, takže svět končí na kraji stolu a ne v pokoji.
- **Měřítko:** spočte se z velikosti hřiště, aby se celá šířka hrací plochy vešla na 1,2 m. Malá hřiště se nezvětší víc než na 1:12. Aréna se měří podle svých stěn, ne podle toho, kde zrovna leží věci.
- **Vysoká hra se posouvá, hlava stojí:** u věže v timing jede svět pod hrdinou nahoru. Hřiště, které se na stůl vejde celé (quest, push, merge), stojí na místě.
- **Levý grip nese stůl:** stiskni levý grip a posuň nebo otoč rukou. Stůl jde s rukou: posun do všech stran (i výš a níž, třeba vsedě) a otočení kolem svislé osy. Je to jen pohled, hra o něm neví. Pravý grip dál slouží hře.

**Ověření (T4):**

- `e2e/vr-diorama.spec.ts` hraje každou z 12 her (šest na stole, šest tratí na pódiu; do P67 T6 15, i s arénou, obranou a chytáním) dvakrát po 5 s týmž skriptem: jednou ve 2D skutečnou klávesnicí, jednou ve VR páčkou a spouští. Obě hry skončí ve stejném stavu (stejné vstupy, stejný hash) a hrdina se pohne nebo se změní počítadlo.
- Každých 30 tiků se hrdina promítne do kamery obou očí. Jeho střed musí být uvnitř obrazu a nad deskou. Hlava stojí ve výšce 1,6 m a dívá se na střed stolu.
- U questu test navíc ověří, že levý grip posune stůl o 20 cm a do hry nic nepošle, a že pravý grip dál dělá „použít“.
- `src/play/xr/__tests__/diorama-scale.test.ts` nechá robota dohrát každou živou hru (mimo čtyři hry rukou) a v každém tiku ověří, že hrdina je na stole a v zorném poli hlavy.
- **Mutace:** stůl, který za hrdinou na trati nejede, test pozná (37 testů červených). Test sám obsahuje i kontrolu se zamrzlým stolem, která musí hrdinu ztratit.

### Tratě na pódiu (runner, platformer, flap, voyage, hop, crowd)

Šest tratí se ve VR hraje jako velká diorama na pódiu před hráčem (P67 T7). Hráč stojí a hlava se nehýbe; trať jede k němu.

- **Pódium:** 2 m široké a 3,8 m hluboké. Bližší kraj je 0,9 m před hráčem, vzdálený 4,7 m, střed 2,8 m. Zem světa leží 0,4 m nad podlahou na tmavém soklu, nad ní je 1,1 m prostoru. Horní hrana je tedy ve výšce 1,5 m, pod očima stojícího hráče. Hlava, která se dívá na střed pódia, vidí celé pódium (kontrola počítá se zorným polem 80°).
- **Měřítko 1:4 až 1:8:** šířka hrací plochy na šířku pódia a celá výška pod horní hranu, kde to 1:8 dovolí.

| Hra | Měřítko | Proč |
|---|---|---|
| runner, crowd | 1:4 | trať 8 m a 4,6 m široká, víc se zvětšit nesmí |
| platformer | 1:7,6 | věž 8,4 m vysoká se celá vejde pod horní hranu |
| hop | 1:7,8 | 15,6 m šířky na 2 m |
| flap, voyage | 1:8 | flap 10,5 m vysoký, závod 22 m široký; menší už pódium nedovolí |

- **Svět jede k hráči:** hrdina je v bližší čtvrtině pódia, zbylé tři čtvrtiny ukazují, co přijde (u běžce asi 11 m trati, na stole bylo 10 m). Závod je i při 1:8 širší než pódium (22 m trati); když hrdina dojede k pětině šířky od kraje, svět se posune i do strany.
- **Vzdálený konec mizí v mlze:** zhruba poslední třetina pódia přechází do barvy obzoru prostředí hry a vzdálený kraj je v mlze celý. Řez světa na kraji tak není vidět a překážky z mlhy vyjíždějí. Kolem pódia leží podlaha v barvě země prostředí, jako u her kolem hráče.
- **Vinětace:** když svět jede, ztmaví se okraj obrazu a střed zůstane čistý. Síla roste s rychlostí světa: od 0,2 m/s, plná od 1,5 m/s (běžec jede ~2,5 m/s, závod ~2,6 m/s, flap ~0,7 m/s, plošinovka ~0,5 m/s, hop pod prahem). Po zastavení světa okraj do vteřiny zesvětlá. Vypnout ji jde v panelu „Comfort“ (oddíl „Pohodlí ve VR“ níž); výchozí je zapnuto.
- **Panely:** tabule s cílem a počítadly stojí nad vzdáleným koncem pódia, výš než cokoli na trati, takže nic nezakryje. „AI version ready“ visí z téhož místa dolů přes mlhu. Výsledek stojí na bližší části pódia. Všechny mají od očí stejnou úhlovou velikost jako na stole, proto jsou větší (tabule ~5×, výsledek ~1,8×).
- **Levý grip nese pódium** jako stůl (i níž pro hráče vsedě). Sokl sahá vždy až k podlaze. Mlha se počítá pro pódium ve výchozí poloze.

**Ověření (P67 T7):**

- `src/play/xr/__tests__/diorama-scale.test.ts`: pódium 1,5–3 m před hráčem, horní hrana pod očima, celé v zorném poli hlavy (a o 10 cm širší už ne); každá živá trať 1:4 až 1:8; robot dohraje každou živou trať a hrdina je po celou dobu na pódiu a v pohledu hlavy; trať jede k hráči a hrdina zůstává v bližší čtvrtině; vzdálená stěna je celá za koncem mlhy, pás hrdiny celý před jejím začátkem. Kontrola se zamrzlým pódiem musí běžce ztratit.
- `e2e/vr-diorama.spec.ts` (IWER): šest tratí na pódiu – poloha a měřítko pódia, celé v zorném poli hlavy (80°), mlha a podlaha okolí, hrdina každých 30 tiků v obraze obou očí a na pódiu, u běžce, závodu a davu se při jízdě ztmaví okraj obrazu. Na stole mlha ani vinětace nejsou.

### Panely ve VR (cíl, počítadla, výsledek)

Stránka 2D se v brýlích nekreslí, proto HUD hry ve VR tvoří 3D panely podle kitu Sayplay: papírová karta s inkoustovým obrysem a tvrdým stínem, písmo Roboto, jedno rajčatové tlačítko na panel. Ukazují totéž co 2D HUD a výsledek: cíl hry, počítadla s popisky jako ve 2D (`HUD_COUNTER_LABELS`, u věty s počtem slovo věty, třeba `keys`) a životy.

| Panel | Kdy | Hry na stole | Hry rukou |
|---|---|---|---|
| cíl a počítadla, „Exit VR“ | během hry | tabule za vzdáleným okrajem stolu, nad scénou | nad levým zápěstím |
| výsledek „You did it!“ / „So close.“, „Again“, „New game“, „Exit VR“, „Comfort“, „Share“ | po konci hry | stojí na bližší polovině stolu | nad levým zápěstím místo cíle |
| „AI version ready“ | příchod AI verze | visí z bližšího okraje stolu | nad levým zápěstím |

- **Ovládání:** paprsek pravého (nebo levého) ovladače na tlačítko a spoušť: stisknout a pustit. Tlačítko pod paprskem má silnější obrys, stisknuté se zamáčkne. Spoušť stisknutá na tlačítku do hry nejde, ani když paprsek mezitím z tlačítka sjede. Stisk, který začal mimo panely, patří hře.
- **„Again“** začne hru znovu od začátku. Hra pak čeká na první pohyb ovladače, stejně jako po „Play again“ ve 2D.
- **„New game“** otevře VR lobby (viz další oddíl) a z něj vznikne nová hra z věty, pořád ve VR.
- **„Exit VR“** ukončí relaci. Stránka ukáže 2D výsledek hry, odkud jde sdílet (Dare, Copy link) a remixovat („Remix it“).
- **„AI version ready“:** když stránka sama přejde na hru podle věty, panel to na 3 s oznámí. Když je hotová verze s plnými detaily, panel nabídne „Play it“, stejně jako tlačítko „Full detail“ ve 2D. Hra se vymění bez opuštění VR.
- **Čitelnost:** text má od očí úhlovou velikost jako text kitu na 1 m (1 px kitu = 2 mm na 1 m). Tabule je od očí asi 1,7 m, proto je 1,75× větší. Výsledek je zvětšený 1,1×, zápěstí je blízko, proto 0,45×. Panely se natáčejí k hlavě a kreslí se přes scénu, takže je kulisa nezakryje.
- **Stůl zůstává po konci hry:** výsledek leží na zamrzlé scéně. Dřív se po konci hry svět vrátil do výchozí polohy bez ořezu stolu.

**Ověření (T5):** `e2e/vr-hud.spec.ts` v emulátoru IWER, klikání skutečným paprskem a spouští:

- Stolní hra z věty „A knight must light three candles…“ (quest; do P67 T6 sběr klíčů v aréně, ta je teď kolem hráče): tabule s cílem a počítadlem `0/3 candles` je celá v obraze obou očí a čitelná. Robot vyhraje, výsledek „You did it!“ je v obraze. „Again“ vrátí hru na tik 0 bez vstupu. Druhá výhra a „Exit VR“ vrátí 2D výsledek, z něj funguje sdílení (odkaz ve schránce) i „Remix it“.
- Spoušť na tlačítku nejde do hry: stisk na „Exit VR“, paprsek z tlačítka pryč, puštění, hra nedostala nic. Týž stisk mimo panely do hry jde (kontrola, že test měří spoušť).
- Střílečka: panel na levém zápěstí v obraze, prohra ukáže „So close.“, „Again“ hru restartuje.
- AI verze: panel „AI version ready“ s „Play it“ vymění hru a relace trvá. Přechod na hru podle věty ukáže panel krátce bez tlačítka.
- Unit: `src/play/xr/__tests__/input-map.test.ts` drží, komu patří spoušť (panel, nebo hra).

### Zvuk a vibrace ve VR

- **Zvuk z místa události.** Sebrání, zásah, zánik, dopad, power-up a další zvuky hry zní ve VR z místa, kde se věc stala: z desky dioramy, z pruhu pod rukou, ze stěny arény. Směr i výšku dává HRTF (prostorový zvuk pro sluchátka), posluchač je hlava. Hudba, vypravěč, skok a zvuky akcí hráče zní jako dřív, bez polohy.
- **Vibrace ovladačů** podle druhu události (`src/play/xr/haptics.ts`):

| Událost | Síla | Délka | Ruka |
|---|---|---|---|
| zásah (`hit`) | 0,6 | 40 ms | pravá |
| sebrání (`pickup`) | 0,3 | 20 ms | pravá |
| zánik (`death`) | 0,45 | 30 ms | pravá |
| růst komba (`comboUp`) | 0,35 | 25 ms | pravá |
| blízké minutí (`nearMiss`) | 0,2 | 25 ms | obě |
| power-up | 0,5 | 80 ms | obě |
| padlý boss | 1 | 160 ms | obě |
| výhra | 0,5 | 140 ms | obě |
| prohra | 0,8 | 220 ms | obě |

Dopad hrdiny, zrod těla, změna stavu cíle a zásah akcí nevibrují (dějí se pořád nebo je už nese zásah). Za jeden tik dostane každá ruka jen nejsilnější pulz. Vypnout vibrace jde v panelu „Comfort“ (oddíl „Pohodlí ve VR“ níž).

### Hra z věty ve VR (lobby)

Novou hru jde udělat bez sundání brýlí. Na domově `/play` je vpravo nahoře „Enter VR“ (jen v prohlížeči, který VR umí). Ten začne relaci VR lobby: kartou kitu metr před hráčem, horní hranou v úrovni očí. „Enter VR“ na hře z feedu dál začne tou hrou.

| Na kartě | Co dělá |
|---|---|
| šest karet vět | vloží větu do náhledu nahoře; hru ještě nespustí (jako karty nápadů na domově) |
| „More ideas“ | dalších šest vět, pak zase první; pořadí je pevné (nápady domova, pak startovní věty) |
| „Type“ | otevře pod kartou klávesnici: číslice, QWERTY, `' , . -`, „Space“, „Delete“, „Done“ |
| „Say it“ | jen v prohlížeči, který umí diktovat: poslouchá jednu větu a vloží ji do náhledu; hru ještě nespustí |
| „Make it!“ | udělá hru z věty v náhledu, stejně jako „Make it!“ na domově; mezitím „Making…“ |
| „Comfort“ | otevře panel pohodlí (oddíl „Pohodlí ve VR“ níž); „Done“ vrátí lobby i s rozepsanou větou |

- **Klávesnice:** paprsek na klávesu a spoušť. Píše se vždy na konec věty, první písmeno je velké, mezera nikdy na začátku ani dvakrát za sebou. Nad 140 znaků (strop věty) už nic nepřibude, „Delete“ maže vždy. Náhled s kurzorem `|` a počítadlo `n/140` jsou na kartě nad klávesnicí, vedle „Make it!“.
- **Diktování („Say it“):** tlačítko je na kartě vět i vedle klávesnice, ale jen když prohlížeč diktování umí (Web Speech API). Rozhoduje se za běhu v prohlížeči, ne podle seznamu brýlí. Prohlížeč, který ho neumí, tlačítko vůbec nedostane.
  - Po stisku je místo titulku „Listening…“ a na tlačítku „Cancel“. Řekněte jednu větu anglicky; poslech skončí sám, jakmile domluvíte, a věta nahradí náhled (jako karta nápadu, takže druhý pokus po špatném přepisu nemusíte mazat). Delší věta se zkrátí na 140 znaků.
  - „Cancel“ poslech ukončí a nic z něj do náhledu nedá.
  - Zablokovaný mikrofon nebo jiná chyba ukáže na kartě větu kitu („The microphone is blocked for this page. You can type instead.“), tlačítko se vrátí na „Say it“.
  - Přepis dělá prohlížeč sám. Stránka nic neposílá: žádná placená služba ani vlastní server.
- **Chyba:** když dveře hru nepostaví, karta ukáže větu kitu červeně pod náhledem („Couldn't build that. Try fewer rules.“, „Couldn't send your idea. Try again.“). Prázdný náhled a „Make it!“ řekne, co napsat, jako na domově.
- **Brýle zůstanou ve VR:** „Make it!“ přejde na stránku nové hry (`/play/<id>`). Relace s tím neskončí, protože relace i plátno patří layoutu `/play`, ne stránce. Karta zmizí, až je na stole (nebo v ruce) nová hra.
- **Z výsledku:** „New game“ na panelu výsledku otevře lobby nad dohranou hrou. Lobby zmizí, až přijde hra, kterou udělalo.
- **Hra pod lobby:** hra z feedu nebo dohraná hra zůstane vidět za kartou. Její HUD je schovaný a ovladače do ní nejdou, dokud je lobby otevřené.
- **Odchod z VR** lobby zavře. Další „Enter VR“ ze hry začne hrou.

**Ověření (P67 T2):** `e2e/vr-lobby.spec.ts` v emulátoru IWER, klikání paprskem a spouští:

- `/play` → „Enter VR“ → lobby místo HUD hry z feedu. Šest karet v pevném pořadí, „More ideas“ tam a zpět, karta celá v obraze obou očí, text anglicky.
- „Type“: `c a t`, dvakrát mezera, `s`, „Delete“ → náhled `Cat |` a `4/140`; „Done“ klávesnici zavře a věta zůstane.
- Karta vloží větu a adresa je pořád `/play`. Podvržená chyba dveří (422) ukáže „Couldn't build that. Try fewer rules.“ na kartě. Pak „Making…“ a přechod na `/play/<id>`: HUD nové hry, hrdina ve stavu hry, kreslené snímky.
- Dohraná hra → „New game“ → další karta → „Make it!“ → druhá hra na `/play/<id2>`.
- Po celou dobu jedna relace: stránka si o relaci řekla jednou a žádná neskončila.
- Prohlížeč bez VR nemá „Enter VR“ na domově a nestáhne žádný skript s kódem lobby.
- Unit: `src/play/xr/__tests__/keyboard.test.ts` (rozložení, strop, mazání, mezery), `src/components/play/__tests__/create-game.test.ts` (věta → hra pro formulář i lobby: adresa, chyby dveří, bez sítě).

**Ověření (P67 T3):** `e2e/vr-lobby.spec.ts` s podvrženým rozpoznávačem řeči prohlížeče (`webkitSpeechRecognition`):

- karta má „More ideas“, „Type“, „Say it“, „Make it!“, celá v obraze obou očí, anglicky;
- „Say it“ → „Listening…“ a „Cancel“; „Cancel“ → zpátky „Say it“ a přepis, který prohlížeč pošle až po zastavení, se do náhledu nedostane;
- zamítnutý mikrofon → věta kitu na kartě, tlačítko zpátky na „Say it“;
- přepis „zombies attack my house“ → v náhledu (chyba zmizí) → „Make it!“ → hra na `/play/<id>` v téže relaci;
- od prvního stisku „Say it“ po přepis stránka neudělala jediný síťový požadavek;
- prohlížeč bez Web Speech (test T2) tlačítko „Say it“ nemá. Chromium testů rozhraní `webkitSpeechRecognition` má (jen nepřepisuje), proto ho test schová, jako by šlo o Firefox.

### Feed ve VR (listování her)

Feed na `/play` jde procházet bez sundání brýlí. Do VR se vstoupí „Enter VR“ v HUD hry na kartě feedu (je vidět, jakmile hraje hráč, ne robot). Hra karty se pak kreslí v brýlích, a když hráč přejde na jinou kartu, brýle ukážou její hru. Relace po celou dobu trvá.

Do feedu se jde i z relace, která začala jinde (P67 T14a): „Next“ na výsledku hry z věty, sdílené hry nebo AI verze otevře feed na `/play`. Robot první karty hraje v brýlích hned, bez ťuknutí na stránku; spoušť ho převezme jako ve feedu výš.

| Ovládání | Kdy | Co dělá |
|---|---|---|
| pravá páčka mávnutím nahoru | mimo běžící kolo | další karta |
| pravá páčka mávnutím dolů | mimo běžící kolo | předchozí karta |
| spoušť (paprsek mimo panely) nebo A/X | robot hraje náhled | hru převezme hráč, jako ťuk na scénu na telefonu |
| „Next“ na panelu výsledku | po konci kola | ve feedu další karta, jinde feed na `/play` |
| „Again“ na panelu výsledku | po konci kola | nové kolo téže hry |

- **Mimo běžící kolo** znamená náhled robota, výsledek a kartu, která se ještě načítá. Když hraje hráč, páčka patří hře, i když hra čeká na první pohyb.
- **Mávnutí** je výchylka páčky svisle aspoň na 70 %. Další mávnutí platí až po návratu páčky pod polovinu výchylky, takže páčka držená nahoře nelistuje dokola.
- **Panel výsledku:** „New game“, „Exit VR“, „Comfort“ a „Share“ nahoře, „Next“ a rajčatové „Again“ dole – ve feedu i mimo něj stejně, „Next“ jen vede jinam.
- **Úzké okno prohlížeče** (pod 1024 px): feed na `/play` leží pod formulářem a karta, kterou feed nevidí aspoň z poloviny, nehraje. Po příchodu do feedu z „Next“ se proto feed sám posune do obrazu (`XrFeed.tsx`), dokud na něm žádná hra nehraje. Bez toho by brýle po „Next“ ukázaly prázdný svět bez panelu (naměřeno v okně 800 × 900: robot karty nehrál, test červený).
- **Další karta je načtená dopředu:** feed stahuje detail aktivní karty a sousedů (+1, +2, −1), takže hra další karty se po přechodu postaví bez čekání na síť.

**Ověření (P67 T4):** `e2e/vr-feed.spec.ts` v emulátoru IWER:

- feed → převzetí klávesou → „Enter VR“ → kolo karty se kreslí v brýlích (hrdina ve scéně relace, snímky přibývají);
- mávnutí nahoru v kole feed neposune;
- konec kola → panel výsledku `New game`, `Exit VR`, `Next`, `Again`; detail další karty už je stažený;
- „Next“ → jiná hra (jiné `versionId` v sondě feedu) v téže relaci; páčka dolů → původní hra;
- spoušť převezme náhled; „Again“ → nové kolo téže hry od tiku 0; páčka nahoru na výsledku → další karta;
- po celou dobu jedna relace: stránka si o ni řekla jednou a žádná neskončila.
- Unit: `src/play/xr/__tests__/input-map.test.ts` drží mávnutí (jednou za výchylku, převážně svisle).

### Pohodlí ve VR (Comfort)

Panel „Comfort“ se otevře tlačítkem „Comfort“ na lobby nebo na výsledku hry. Je to karta metr před hráčem, kousek pod úrovní očí, a stojí místo lobby nebo výsledku, dokud ji „Done“ nezavře. Ovládá se paprskem a spouští jako ostatní panely.

| Tlačítko | Co dělá |
|---|---|
| „Standing“ / „Seated“ | vsedě klesne stůl, pódium tratí, svět kolem hráče i podlaha okolí o 40 cm, takže hráč vsedě vidí totéž co vestoje |
| „Recenter“ | svět se otočí tam, kam se hráč právě dívá, a postaví se před něj |
| „Small“ / „Medium“ / „Large“ | velikost světa: 0,75×, 1× a 1,25× stolu i pódia. „Small“ navíc dá tratě a hry kolem hráče (aréna, obrana, chytání) na stůl. „Large“ zvětší i svět kolem hráče, nejvýš na 1:1 |
| „Haptics on“ / „Haptics off“ | vibrace ovladačů |
| „Vignette on“ / „Vignette off“ | ztmavení okraje obrazu, když jede trať na pódiu |
| „Done“ | zavře panel (jediné rajčatové tlačítko) |

- **Vybraná volba** je vyplněná inkoustem s krémovým textem (jako vybraný čip kitu). Vypínače mají stav i v textu.
- **Volby se pamatují** v prohlížeči (`localStorage`, klíč `sp-vr-comfort`) a platí i po novém načtení stránky a v další relaci. Když prohlížeč úložiště nedovolí (soukromé okno, zakázané cookies), platí výchozí volby: vestoje, „Medium“, vibrace i vinětace zapnuté. Změna pak platí do zavření stránky.
- **„Recenter“ se nepamatuje.** Platí do konce relace, protože každá relace má vlastní počátek prostoru. Hlava se nikdy nehne sama: svět se otočí jen na stisk a hned, bez animace.
- **Stůl posunutý levým gripem** se po změně „Seated“ / „Standing“ nebo po „Recenter“ vrátí na výchozí místo.
- **Hry rukou** (střílečka, hod, bouchání, krájení) vsedě nemění výšku: jejich svět je v dosahu ruky nebo 1:1 na podlaze. „Recenter“ je otočí taky.
- **Do hry nic z toho nejde.** Volby jsou jen kresba a vibrace, mimo hashovaný stav hry. Ovladače do hry nejdou, dokud je panel otevřený.

**Ověření (P67 T9):**

- `e2e/vr-hud.spec.ts` v emulátoru IWER, hra na stole: výsledek → „Comfort“ → karta celá v obraze obou očí (i s hlavou skloněnou ke stolu), text aspoň 0,9°, anglicky. „Seated“ → deska o 40 cm níž a hrdina s ní (na desce stojí, kde stál). „Large“ → svět na stole 1,25× větší. „Haptics“ a „Vignette“ → popisky „off“ a hra čte vypnuté vypínače. Záznam v `localStorage` nese všechny čtyři volby. Hlava otočená o čtvrt kruhu doleva a „Recenter“ → stůl stojí vlevo před ní a je k ní otočený. „Done“ → zpátky výsledek. Nové načtení stránky a vstup do VR → stůl rovnou nízko, vibrace a vinětace vypnuté, „Recenter“ zapomenutý.
- `e2e/vr-lobby.spec.ts`: lobby → „Comfort“ → „Done“ → lobby s rozepsanou větou.
- `src/play/xr/__tests__/comfort.test.ts`: uložení a načtení, výchozí volby při chybě úložiště (přístup, čtení, zápis, poškozený záznam), co rig z voleb postaví (výška a otočení desky, režim a měřítko podle velikosti).

### Sdílení z VR (QR kód)

„Share“ na panelu výsledku dá na jeho místo kartu „Share“ s QR kódem odkazu na hru a větou „Scan with your phone“. Kód přečte fotoaparát telefonu, třeba z obrazu brýlí promítaného na telefon nebo televizi.

- **Po výhře** odkaz nese výzvu (`&dare=…`) jako „Dare a friend to beat it“ ve 2D: kamarád hraje tutéž hru a vidí skóre, které má překonat. Server běh jen přehraje a uloží, AI se nevolá a nic se neplatí.
- **Po prohře** je to obyčejný odkaz na hru.
- **Než je odkaz hotový,** karta říká „Getting your link…“. Obvykle je to chvilka, nejvýš asi 12 s (viz níže). Když výzva nevyjde, karta ukáže odkaz bez výzvy a větu „Couldn't attach your score, so the link opens just the game.“
- **„Share link“** pošle odkaz do nabídky sdílení prohlížeče. Je jen tam, kde ji prohlížeč má.
- **„Done“** (jediné rajčatové tlačítko) vrátí výsledek. Nové kolo nebo jiná karta feedu kartu zavře.
- **Ve feedu** karta drží výsledek, dokud je otevřená. Jinak se výsledek bez dotyku stránky po 10 s vrací do náhledu robota.

**Ověření (P67 T5):**

- `e2e/vr-feed.spec.ts` v emulátoru IWER: výhra ve feedu → „Share“ → „Getting your link…“ → karta s kódem, odkaz `…/play/<verze>?via=share&dare=<id>` s id, které vrátil server. Karta je celá v obraze obou očí, anglicky. „Share link“ pošle tentýž odkaz do nabídky sdílení. Bez nabídky sdílení má karta jen „Done“. Karta drží výsledek i po 11 s. Od „Share“ dál stránka poslala jen čtení, uložení výzvy a událost sdílení, žádné volání AI.
- `src/play/xr/__tests__/qr.test.ts`: kód nakreslený do plátna přečte zpátky nezávislý dekodér (`jsqr`, jen pro testy) a dostane přesně týž odkaz, i nejdelší možný. Tmavé na světlém, tichá zóna 4 moduly, moduly nezrcadlené.

## Měření – souhrn

Stav 29. 10. 2026. Všechno kromě posledního řádku je z emulátoru IWER na počítači, ne z brýlí.

| Co | Výsledek | Kde podrobně |
|---|---|---|
| celé kolo v jedné relaci v pořadí z cíle (karta lobby, hra, Again, Next do feedu, Next a zpět, klávesnice, AI verze, QR kód) | 3 běhy ze 3 zelené, ~28 s na kolo, pořád tatáž relace | „Celá smyčka v jedné relaci“ níž, `evals/vr/README.md` |
| rozpočet snímku Questu 2 (≤ 150 draw callů, ≤ 300 tisíc trojúhelníků) | všech 19 žánrů i všechny panely pod ním; nejtěsnější závod `voyage` (rezerva 4,6 %) | „Rozpočet snímku ve všech režimech“ |
| „Next“ ve feedu → první snímek další hry | medián 119–122 ms (první návštěva karty 0,5–0,9 s) | „Feed ve VR“ |
| první JS telefonu (`/play`, Pixel 7) proti `main` | +984 B, limit ±1 kB splněný | „Celá smyčka v jedné relaci“ |
| zvuk mimo VR | bit po bitu stejný jako před VR | „Zvuk a vibrace“ |
| FPS na skutečném Questu 2 | **neměřeno** – brýle nikdo neměl na hlavě | kolo majitele v brýlích |

Draw call = jeden příkaz grafické kartě „nakresli tenhle objekt“; Quest 2 jich zvládne zhruba 150 za snímek. Trojúhelníky jsou plošky, ze kterých jsou modely složené.

## Známá omezení

**Neověřeno na skutečných brýlích** (všechno patří do kola majitele v brýlích):

- FPS žádné hry na Questu 2. Prohlídka všech žánrů v brýlích (`quest-dev.mjs --tour`) na brýlích ještě nikdy neběžela.
- Ovládání, čitelnost panelů, pohodlí, zvuk a vibrace.
- Diktování („Say it“): jestli ho prohlížeč Questu umí, jestli se dotaz na mikrofon ukáže uvnitř VR a jestli stisk spouště stačí jako gesto, které diktování potřebuje. Když prohlížeč diktovat neumí, tlačítko se samo neukáže a zbývá klávesnice.
- Quest 3 (vyšší rozlišení a 90 Hz) – žádný nebyl k dispozici.
- Instalace jako aplikace a „Share link“ (nabídka sdílení prohlížeče) v brýlích; jak dobře telefon přečte QR kód z obrazu brýlí.

**Známé slabiny:**

- **„Next“ ze hry mimo feed otevře feed od první karty.** Feed dává čerstvé hry na každé třetí místo, takže hráč může svou právě udělanou hru potkat znovu.
- **„Enter VR“ ve feedu až po převzetí hry od robota.** Během náhledu robota lišta s tlačítkem není.
- **Odkaz pro sdílení až za ~12 s.** Server pouští jednu výzvu za 10 s a 2D výsledek ji uloží hned po výhře; VR to pak zkouší znovu po 3 s. Oprava je jeden řádek v souboru jiného plánu, zatím ne.
- **Výsledek ve feedu se po 10 s bez dotyku stránky vrátí do náhledu robota** – ovladače se za dotyk nepočítají. Karta „Share“ to drží, dokud je otevřená.
- **Flap na pódiu 1:8 ořízne horních 1,7 m trubek.** Hrdina létá níž, ale vršky trubek nejsou vidět.
- **Mlha scény ve VR nepůsobí.** Pódium tratí má vlastní; u her kolem hráče sahá podlaha až k obloze.
- **Na brýlích mimo VR dvě grafická plátna:** feed a skryté plátno pro VR (1 px, nekreslí). Paměť navíc, obraz stejný.
- **Řetěz mikroher nemá ve VR panely cíle a výsledku** – jen „AI version ready“.
- **Časovač ve VR chybí**; panel ukazuje cíl, počítadla a životy.
- **Ve VR nejsou rostliny a obrysy nepřátel**, kvůli rozpočtu snímku.
- **Občasná chyba života na pozadí scény ve VR** (`Ambient.tsx`): snímek s chybou se zahodí, v brýlích to může být cuknutí.
- **Výsledek her hraných rukou** (střílečka, hod, krtci, krájení) je nad levým zápěstím, ne před hráčem.
- **Nové žánry z jiného plánu** (survivor, hole, steal, sort, arrows) se po přistání do `main` budou hrát na stole, dokud nedostanou vlastní režim.
- **Počítač s nastaveným OpenXR runtime** (třeba SteamVR) hlásí VR i bez brýlí, takže desktop dostane „Enter VR“ a stáhne kód VR.
- **Rezerva prvního JS telefonu je 16 B.** Další kód na cestě telefonu se do limitu ±1 kB vejde jen s úsporou jinde.

## Podrobnosti měření a rozhodnutí

### Celá smyčka v jedné relaci (P67 T14 a T14a, 29. 10. 2026, emulátor)

`e2e/vr-loop.spec.ts` v IWER (Quest 2) projde celé kolo bez opuštění VR v pořadí z cíle plánu. Jediné klepnutí mimo VR je „Enter VR“ vpravo nahoře na `/play`, všechno další dělají ovladače:

1. lobby → karta s větou → „Make it!“ → hra z věty na `/play/<id>`;
2. robot kolo vyhraje (sonda `handPlay`) → výsledek s „Next“ i mimo feed → „Again“ → nové kolo od tiku 0;
3. konec kola → „Next“ → feed na `/play`: robot první karty hraje a kreslí se v brýlích hned, bez ťuknutí na stránku (kontejner plátna relace visí v kartě, ne v úschovně; hrdina ve scéně, snímky přibývají);
4. spoušť převezme kartu → konec kola → „Next“ → další karta; pravá páčka dolů → předchozí;
5. spoušť převezme kartu → konec kola → „New game“ → „Type“ → klávesnice „zombies attack my house“ → „Make it!“ → hra z věty; její AI verze (podvržená odpověď `GET …/upgrade`, cíl je hra z fixtur) → panel „AI version ready“ → „Play it“ → AI verze běží;
6. výhra → „Share“ → karta s QR kódem odkazu `…/play/<verze>?via=share&dare=<id>`.

Klávesnice je v kole most k AI verzi: feed AI verzi nehlídá (karta feedu ji nečeká), čeká na ni jen čerstvá hra z věty.

Test běží v okně 800 × 900, užším než 1024 px. Tam leží feed pod formulářem a „Next“ do feedu ho musí sám posunout do obrazu (oddíl „Feed ve VR“). Bez toho posunu test v kroku 3 zčervená: robot první karty nehraje. Široké okno hlídají `vr-feed` (1440 × 900) a `vr-lobby` (1280 × 720); celé kolo v okně 1440 × 900 prošlo na tomtéž buildu jednou zeleně.

Po každém kroku test ověří tutéž relaci: stránka si o ni řekla jednou, žádná neskončila a renderer dál bere snímky přímo od toho objektu `XRSession` (počítadlo na jeho `requestAnimationFrame`). Útrata 0: každý dotaz na AI verzi odpověděl test, takže server práci režiséra nespustil; kromě čtení stránka poslala jen dvě rychlé hry z vět, uložení výzvy a události. Výsledek T14a: 3 běhy ze 3 zelené, 27–30 s na kolo (časy kroků v `evals/vr/README.md`).

**Do T14a** kolo začínalo ve feedu: ze hry z věty do feedu cesta nevedla, „Next“ byl jen na výsledku ve feedu. Od T14a „Next“ na výsledku mimo feed otevře feed na `/play` (`XrHud.tsx`); navigace zůstává v layoutu `/play`, takže relace žije dál, stejně jako u „Make it!“.

**`vr-lobby` už nekolísá.** Příčina: feed za lobby si dělá snímky karet pro náhledy (`captureFrame` v `src/components/play/feed/snapshot-cache.ts`) a kreslil přitom snímek navíc mimo snímek XR relace. V takovém snímku ovladače nemají polohu, paprsek na chvíli sjel z tlačítka a stisk spouště právě v tu chvíli se ztratil. Ve VR se teď snímek karty nedělá (plátno relace obraz brýlí stejně nenese); hlídá to unit test. Druhá oprava v testu: kontrola „při diktování žádný požadavek“ nepočítá soubory scény z vlastního serveru (`/assets/`, `/_next/static/`), které si hra feedu za lobby dotahuje. `vr-lobby` sám: 6 běhů po sobě zelených, v sadě všech `vr-*` zelený.

**Regrese (build větve, server 3168, 29. 10. 2026):**

| Test | Výsledek |
|---|---|
| `play-phone` (Chromium, Pixel 7, iPhone) | 18/18 |
| `play-perf` | 1/1 |
| `interface-language` | 4/4 |
| `play-hud` | soubor v repozitáři není |
| `vr-diorama`, `vr-enter`, `vr-feed`, `vr-hud`, `vr-native`, `vr-pwa`, `vr-room`, `vr-loop` | 35/35 |
| `vr-lobby` sám, naposled | 3/3 |
| zvuk mimo VR bit po bitu (`src/play/audio/__tests__/positional.test.ts`) | 17/17 |
| rozpočet a tabulky měření (`evals/vr/__tests__/budget.test.ts`) | 12/12 |

`origin/main` se od začátku větve nepohnul (`e661855c`), slučovat nebylo co.

**První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 635 B rozbaleně, **+984 B** proti `main` (4 215 651 B), přenesené +1 390 B, žádný kód XR. Oprava `captureFrame` přidala 53 B. Rezerva do limitu ±1 kB je 16 B.

**Regrese T14a (build větve, server 3168, 29. 10. 2026):** `vr-loop` 3/3, `vr-diorama`, `vr-enter`, `vr-feed`, `vr-hud`, `vr-native`, `vr-pwa`, `vr-room` a `interface-language` 38/38, `vr-lobby` sám naposled 3/3. T14a mění jen `XrHud.tsx` a `XrFeed.tsx`, které načítá jen kód XR (`XrRoot`), takže první JS telefonu zůstává +984 B; znovu neměřeno.

### „Enter VR“ podle schopnosti prohlížeče (P67 T1, 29. 10. 2026)

„Enter VR“ dostane každý prohlížeč, který hlásí `immersive-vr`, i ve feedu. Rozhoduje jediná funkce `xrGateOpen` v `src/play/xr/flag.ts`; `?vr=0` VR vypne.

**První JS telefonu** (Pixel 7 v Chromiu, `/play`, všechny skripty načtené při otevření stránky, produkční build):

| | Skriptů | Rozbalené | Přenesené | Kód XR |
|---|---|---|---|---|
| `main` (`e661855c`) | 39 | 4 215 651 B | 1 236 252 B | ne |
| větev (T1 + T11) | 39 | 4 216 059 B | 1 236 754 B | ne |
| rozdíl | 0 | +408 B | +502 B | – |

Cíl ±1 kB je splněný. Rozdíl je brána bez `?vr=1` a registrace service workeru (T11).

- **Počítač s OpenXR runtime hlásí VR i bez brýlí.** Na měřicím počítači je jako runtime nastavený SteamVR. Chromium pak na `immersive-vr` odpoví „ano“, i když žádné brýle nejsou připojené. Takový desktop dostane „Enter VR“ a stáhne kód XR (+139 kB rozbaleně), jako by byl brýlemi. Telefon OpenXR runtime nemá.
- **E2E proto běží bez OpenXR** (`--disable-features=OpenXR` v `playwright.config.ts`). Brýle v testech hraje emulátor IWER, který `navigator.xr` nahradí celý, takže se ho volba netýká.
- **`play-phone`:** test „the hero is its model from the first frame: castle arena“ na Pixelu 7 padá i na `main` (2 ze 2 běhů), ve větvi 1 ze 2. Není to regrese brány.

**Sonda Questu 2 (`--cdp --probe`, 29. 10. 2026):** brýle byly připojené a ladění povolené, ale nikdo je neměl na hlavě. Po probuzení držel popředí systémový dialog (`com.oculus.firsttimenux/.FirstTimeNuxExclusiveSystemDialogActivity`), prohlížeč zůstal na pozadí a ladicí rozhraní stránku neukázalo. Sonda proto zapsala `reached: false` a nic nezměřila (`evals/vr/quest-caps.json`). Diktování, sdílení a obnovovací frekvence Questu se změří, až budou brýle nasazené (T3, T13, ruční brána T15).

### VR lobby (P67 T2, 29. 10. 2026)

**Relace přežije navigaci.** `/play` → `/play/<id>` po „Make it!“ i `/play/<a>` → `/play/<b>` po „New game“: stránka si o XR relaci řekla jednou, žádná neskončila a brýle kreslí novou hru (`e2e/vr-lobby.spec.ts`, IWER). Náhradní cesta z plánu (výměna hry bez navigace přes `XrHostContext`) proto není potřeba.

**První JS telefonu** (Pixel 7 v Chromiu, `/play`, jako u T1):

| | Skriptů | Rozbalené | Přenesené | Kód XR |
|---|---|---|---|---|
| `main` (`e661855c`) | 39 | 4 215 651 B | 1 236 252 B | ne |
| větev (T1 + T11 + T2) | 39 | 4 216 359 B | 1 236 881 B | ne |
| rozdíl | 0 | +708 B | +629 B | – |

Cíl ±1 kB je splněný; T2 sama přidala ~300 B (tlačítko „Enter VR“ na domově a `createGame`). Stav lobby, karty, klávesnice i měď lobby jsou jen v chunku XR. Ten se stahuje až v prohlížeči, který VR umí; test to drží řetězcem „More ideas“.

- **Proč stav lobby není v `xr-context.ts`:** ten modul je v prvním JS dvakrát (v chunku layoutu i feedu). Stav lobby v něm stál ~500 B rozbaleně navíc (naměřeno: +1 207 B proti `main`, po přesunu +708 B), proto je v `xr/xr-lobby.ts`, který načítá jen kód XR.
- **Velikost a čitelnost v emulátoru** (hlava 1,6 m, pohled 19° dolů): karta lobby je v obraze obou očí celá. Nejmenší písmo kitu (13 px) má od očí 1,16°, klávesnice 1,08°, nad 0,9° z pravidel plánu. Text karet vět (18 px) má ~1,6°.
- **Cena stisku klávesy:** každý stisk překreslí texturu karty lobby (náhled a počítadlo) a nahraje ji do GPU, stejně jako tabule HUD při změně počítadla. Na Questu to může být jeden pomalejší snímek na stisk; brýle v T13 nikdo nenasadil, změří se v T15.
- **Draw cally:** do T13 přidalo otevřené lobby jednu síť na tlačítko (9 na kartě, 43 na klávesnici) ke hře pod ním; s klávesnicí nad střílečkou to bylo 194 volání ze 150. Od T13 se tlačítka v klidu kreslí na kartu a lobby s klávesnicí stojí 2–6 volání (oddíl „Rozpočet snímku ve všech režimech“).
- **Skutečné brýle:** lobby na Questu 2 tento běh neověřil, brýle nikdo neměl na hlavě. Patří do ruční brány T15.

### Diktování v lobby (P67 T3, 29. 10. 2026, emulátor)

**Rozhodnutí, která plán nechal otevřená:**

- **Přepis náhled nahradí, nepřidá se k němu.** Na telefonu se přidává k napsanému. V brýlích je mazání pracné (klávesa po klávese), takže druhý pokus po špatném přepisu by musel nejdřív smazat ten první. Karta nápadu náhled taky nahrazuje.
- **Poslech není rajčatový.** Kit při nahrávání mikrofon zbarví rajčatově, jenže na kartě lobby je rajčatové „Make it!“ a rajčatová akce smí být na panelu jen jedna. Mikrofon je proto `sun` (barva mikrofonu v kitu) a poslech ukazuje „Listening…“ místo titulku a „Cancel“ na tlačítku.
- **Řada čtyř tlačítek:** stejná šířka platí, dokud se do ní vejde každý popisek. Se „Say it“ by se „More ideas“ do čtvrtiny řady nevešlo, proto má každé tlačítko šířku podle popisku a zbytek řady se rozdělí rovným dílem (`XrPanel.tsx`). Panely, kterým se popisky vejdou (výsledek, HUD), se nemění (`vr-hud`, `vr-feed` zelené).

**První JS telefonu** (Pixel 7 v Chromiu, `/play`, jako u T1):

| | Skriptů | Rozbalené | Přenesené | Kód XR |
|---|---|---|---|---|
| `main` (`e661855c`) | 39 | 4 215 651 B | 1 236 252 B | ne |
| větev (do T3) | 39 | 4 216 498 B | 1 236 981 B | ne |
| rozdíl | 0 | +847 B | +729 B | – |

T3 nemění žádný soubor na cestě telefonu: tlačítko, stav poslechu i jeho věty jsou jen v chunku XR (`xr/XrMic.tsx`). Společná funkce pro věty chyb v `src/input/speech.ts` by přidala 30 B, proto jsou věty i v `XrMic.tsx`.

**Sonda Questu 2 (29. 10. 2026):** brýle připojené (`adb devices`: `device`), ale spaly (`mWakefulness=Asleep`) a nikdo je neměl na hlavě. Ladicí soket prohlížeče existoval, jenže relaci VR bez nasazených brýlí otevřít nejde, takže `startDictation` uvnitř relace sonda nezkusila. Zapsáno v `evals/vr/quest-caps.json` (`dictationInSession.reached: false`).

Na Questu zůstává neověřené (ruční brána T15):

- jestli prohlížeč Questu vystavuje `webkitSpeechRecognition`. Když ne, tlačítko se neukáže samo;
- jestli se dotaz na mikrofon ukáže uvnitř relace VR, nebo ji přeruší;
- jestli stisk spouště na panelu prohlížeč bere jako gesto uživatele, které rozpoznávač řeči potřebuje.

### Svět kolem hráče (P67 T6, 29. 10. 2026, emulátor)

**Rozpočet snímku** (IWER Quest 2, obě oči, hlava rovně, nejhorší snímek z 10 s hry robota; `evals/vr/budget.json`):

| Hra | Měřítko | Draw cally | Trojúhelníky | Na stole před T6 |
|---|---|---|---|---|
| arena | 1:2,5 | 44 | 103 328 | 48 / 72 446 |
| catch | 1:3 | 56 | 23 720 | 58 / 23 672 |
| defense | 1:1 | 90 | 51 376 | 98 / 22 184 |

- **Aréna byla nad rozpočtem:** s prstencem rostlin za stěnami 316 656 trojúhelníků. Profil XR teď prstenec nekreslí nikde (na stole ho už dřív skrývaly roviny řezu), za stěnami leží podlaha okolí. Data scény se nezměnila.
- **První JS telefonu** (`/play`, Pixel 7): 39 skriptů, 4 216 351 B rozbaleně, žádný kód XR – o 8 B méně než po T2. Nové moduly (`xr/modes.ts`, `XrRoom`, `XrSky`) jsou jen v chunku XR.

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Žánr se pozná z robota světa.** Svět hry žánr nenese a spec do vrstvy XR nedojde; každý žánr má vlastního robota (`genreOfWorld` v `src/play/xr/modes.ts`). Hry skládané ze staršího ovládání (`glide`, `walker`, `ball`) žánr nemají a hrají se na stole jako dřív.
- **Chytání 1:3, ne 1:1.** Při 1:1 jsou pruhy 2 m od sebe a krajní pruhy by byly 4 m od středu, mimo dosah ruky. 1:3 je nejmenší měřítko režimu; krajní pruh pak začíná 1 m od středu.
- **Aréna: stěny 8 m podél os,** rohy jsou dál (11 m). Aby byly 8 m i rohy, musela by být aréna menší než 1:3.
- **Kopule = obloha scény.** Obloha scény se kreslí jen podle natočení hlavy, takže ve VR stojí kolem hráče v každém měřítku (ověřeno snímkem z emulátoru). Druhá kopule by pod ní nikdy nebyla vidět, proto `XrSky` kreslí jen podlahu okolí.
- **Barvy okolí ze sady scény:** plátno XR leží v místě scény, která ho vlastní, a ta nese `data-look`. Bere se základní sada (země `ground`); noční nebo počasím upravená barva scény se nepřebírá.
- **Tratě (`surround`, T7)** jsou v tabulce režimů, ale do T7 se hrají na stole.
- **Test HUD na stole** (`e2e/vr-hud.spec.ts`) hraje quest „A knight must light three candles…“: věta s klíči dělá arénu, ta je teď kolem hráče. Věta „open three chests“ dělá na serveru řetěz mikroher bez ručních hodin, proto svíčky.

### Tratě na pódiu (P67 T7, 29. 10. 2026, emulátor)

**Rozpočet snímku** (IWER Quest 2, obě oči, hlava se dívá na střed pódia, nejhorší snímek z 10 s hry robota; `evals/vr/budget.json`):

| Hra | Měřítko | Draw cally | Trojúhelníky | Na stole před T7 |
|---|---|---|---|---|
| runner | 1:4 | 50 | 114 708 | 46 / 119 112 |
| platformer | 1:7,6 | 62 | 68 562 | 40 / 66 598 |
| flap | 1:8 | 66 | 26 060 | 50 / 21 372 |
| voyage | 1:8 | 54 | 281 438 | 52 / 281 754 |
| hop | 1:7,8 | 48 | 175 256 | 44 / 175 160 |
| crowd | 1:4 | 50 | 43 516 | 48 / 43 416 |

- **Všechno pod rozpočtem** (150 volání, 300 000 trojúhelníků), srážet nebylo třeba. Závod má rezervu 6 % jako na stole.
- **Vinětace v e2e** (nejsilnější za 5 s hry): běžec 0,97, závod 0,97, dav 0,95, plošinovka 0,41, flap 0,30, hop 0. Na stole žádná.
- **Snímky z emulátoru** (běžec, závod, flap, výsledek davu): pódium, sokl, podlaha okolí, mlha na konci trati, ztmavený okraj a panely jsou vidět tak, jak je popisuje oddíl „Tratě na pódiu“ výš.
- **První JS telefonu** se neměřil: T7 nezměnila žádný soubor, který telefon stahuje. Pódium, mlha, vinětace i nové kotvy panelů jsou jen v kódu XR (`diorama-scale.ts`, `Diorama`, `XrVignette`, `XrHud`, `XrRig`).

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Pódium je kvádr, ne lichoběžník.** 2 × 3,8 m: širší pódium by bližší rohy dostalo z pohledu hlavy (test hlídá i o 10 cm širší). Vzdálený konec by unesl víc šířky, ale svět se kreslí do kvádru řezu jako na stole.
- **Střed 2,8 m, zem 0,4 m.** Plán chce střed 1,5–3 m a horní hranu pod očima. Hluboké pódium dá výhled ~11 m trati běžce (na stole 10 m); nižší zem dovolí 1,1 m prostoru, ve kterém se celá vejde plošinovka.
- **Flap 1:8 a seříznuté trubky.** Flap je 10,5 m vysoký, při 1:8 by měl 1,31 m, prostor nad pódiem má 1,1 m. Horní 1,7 m trubek proto řeže horní rovina (v pohledu těsně pod úrovní očí). Hrdina létá ve 2,1–4,7 m, svět se kvůli němu nahoru ani dolů nehýbe.
- **Mlha jen na pódiu.** Scéna nese mlhu v metrech scény a ve VR ji three nepoužije: `<fog>` scény visí na obalu světa, ne na kořeni (e2e: na stole žádná mlha). Pódium dá kořeni vlastní mlhu v metrech od očí a po odchodu ji vrátí. Mlha měří hloubku po ose pohledu, takže když se hráč otočí stranou, je vzdálený řez vidět víc. Barva je obzor základní sady prostředí, jako u podlahy okolí.
- **Vinětace podle rychlosti světa, ne podle pohybu hrdiny.** Svět jede jen tehdy, když jede okno; u hopu se okno posouvá po skocích tak pomalu (~0,2 m/s), že vinětace nezačne.
- **Vinětace pod panely.** Text panelů neztmaví; paprsek ovladače také ne.
- **Vypínač vinětace** je `setVignetteOn` v `src/components/play/xr/XrVignette.tsx` (kód XR), ne v `xr-context.ts`, protože ten stahuje i telefon. Od T9 ho nastavuje rig z uložených voleb panelu „Comfort“.
- **Levý grip nese i pódium** (hráč vsedě si ho sníží). Sokl sahá vždy k podlaze, mlha zůstává spočtená pro výchozí polohu.
- **Stolní hry beze změny.** Měřítko stolu (`dioramaScale`) zůstává, jak bylo; plán chtěl jen „dorovnat podle `diorama-scale.ts`“, a to platí.
- **Nález pro hry kolem hráče (T6):** ze stejného důvodu ani jejich podlaha okolí do mlhy nemizí, sahá až k obloze (150 m). Pódium to řeší vlastní mlhou; arény, obrany a chytání se T7 netýká.

### Zvuk a vibrace (P67 T8, 29. 10. 2026, emulátor)

**V emulátoru IWER** (`e2e/vr-native.spec.ts`, kontext zvuku běží po kliknutí na „Enter VR“, hlava 1,6 m):

| Hra | Pulzů pravé ruky | Zvuků přes panner | Poslední zvuk (m) |
|---|---|---|---|
| shooter | 7 (zásah 0,6 / 40 ms) | 25 | 19 m vlevo, 33 m vpředu |
| throw | 3 (zásah) | 10 | 20 m vpředu |
| whack | 3 (zánik 0,45 / 30 ms) | 4 | 0,4 m vlevo, 0,5 m vpředu, výška pasu |
| slice | 2 (sebrání 0,3 / 20 ms) | 4 | 0,2 m vpravo, 0,4 m vpředu |

**První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 511 B rozbaleně, +860 B proti `main` (T8 sama +160 B), přenesené +701 B, žádný kód XR. Do prvního JS jde jen volitelná poloha v `playSfx`, háček `spatial.route` v `src/play/audio/index.ts` a `busEventOf` v `effects/sound.ts`. Panner, posluchač, tabulka vibrací a druhá sběrnice jsou v chunku XR.

**Zvuk telefonu se nezměnil:** `src/play/audio/__tests__/positional.test.ts` porovnává otisk vyrenderovaných vzorků dvou presetů s otiskem naměřeným před T8, mimo VR s polohou i bez ní a ve VR bez polohy.

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Poloha je bod události v osách jádra,** do světa XR ji převede až kód XR maticí obalu světa (`soundPointOf` v `src/play/xr/spatial-sound.ts`). Matici staví režim rigu (deska, svět kolem hráče, VR-nativní žánr), takže převod nemá vlastní větev pro každý režim. Trať běžce se ohne stejně jako částice.
- **Polohovaný zvuk přebije týž bez polohy z téhož tiku.** Efekty jádra (`ArcadePlay`) ohlásí sebrání, zásah, výhru a prohru dřív než sběrnice a jejich zvuk bez polohy už hraje. Ve VR ho stejný zvuk s polohou utne ještě v téže úloze, než cokoli zazní. Mimo VR platí okno opakování 30 ms jako dřív a `ArcadePlay` zůstává beze změny.
- **Útlum:** do 1 m plná hlasitost, pak `inverse` s faktorem 0,3 (8 m ~32 %, 20 m ~15 %). Silnější útlum by vzdálené zásahy ve střílečce skoro umlčel.
- **Hudba, vypravěč, skok a zvuky akcí hráče** zůstávají bez polohy: nemají místo ve světě, nebo je dělá sám hráč.
- **Vibrace mají vlastní sběrnici v kódu XR** (`createEffectsBus` + `subscribe`). Sběrnice `Effects` není zvenku vidět a vytáhnout ji by znamenalo sahat do prvního JS. Druhá sběrnice stav jen čte, náklad je výpočet událostí jednoho tiku.
- **Vibrace nezávisí na ztlumení zvuku** (na telefonu ztlumení vypne i vibraci). Ve VR je ztlumení M nedosažitelné a ovladač je hlavní zpětná vazba; vypínač je v panelu „Comfort“ (T9, `setHapticsOn` v `src/play/xr/haptics.ts`, uložený v `localStorage`).
- **Prohlížeč bez parametrů posluchače** (Gecko, Wolvic) dostane starší `setPosition` / `setOrientation`.
- **Skutečné brýle:** zvuk ani vibrace na Questu 2 tento běh neověřil. Patří do ruční brány T15.

### Profil Questu 3 (P67 T10, 29. 10. 2026, emulátor)

Quest 3 a 3S kreslí v rozlišení 1,2 a na 90 Hz (11,1 ms na snímek). Quest 2 a neznámé brýle mají profil Questu 2 beze změny: 72 Hz, foveace 1, rozlišení 1, nejvýš 500 částic.

**Neověřeno na skutečném Questu 3** – žádný nebyl k dispozici. Nikdo neměřil, jestli hry na 1,2 drží 90 FPS. Když ne, `&vrscale=1` vrátí rozlišení 1 (bod 9 návodu) a profil se sníží v `QUEST3_QUALITY` (`src/play/xr/headset.ts`).

- **Jak se brýle poznají:** prohlížeč Questu má model v `navigator.userAgent` („Quest 3“, „Quest 3S“). Rozhoduje `profileFor` v `src/play/xr/headset.ts`. 90 Hz si stránka řekne jen tehdy, když ho relace nabízí v `supportedFrameRates`; jinak zůstane frekvence Questu 2 a rozlišení 1,2.
- **V emulátoru IWER 2.6.0** (`e2e/vr-enter.spec.ts`): brýle `metaQuest3` nabízejí 72, 80, 90 a 120 Hz. Stránka si řekla o 90 Hz a rozlišení vrstvy 1,2 a relace hlásí 90 Hz. Quest 2 si ve stejném souboru řekl o 72 Hz a rozlišení 1 jako dřív.
- **Proč test čte žádost, ne jen výsledek:** Quest 3 v IWER startuje na 90 Hz sám a rozlišení vrstvy emulátor nepoužije (kreslí do plátna stránky). Kontrola jen frekvence relace by prošla i bez profilu.
- **Rozpočet snímku** (`evals/vr/budget.json`) se nemění: draw cally a trojúhelníky na rozlišení nezávisí. Vyšší rozlišení a frekvence zdražují kreslení pixelů, a to emulátor neměří.
- **První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 516 B rozbaleně, +865 B proti `main` (T10 sama +5 B), přenesené +714 B, žádný kód XR.

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Profil je v `headset.ts`, ne v `quality.ts`.** `quality.ts` je v prvním JS telefonu, protože z něj `Effects.tsx` bere strop částic. Profil by tam stál asi 200 B (odhad z minifikovaného kódu) a větev by přešla limit ±1 kB. `headset.ts` načítá jen kód XR. V `quality.ts` přibyl jen cíl frekvence u `nearestRate` a výchozí rozlišení u `framebufferScaleOf`.
- **Quest 3S jako Quest 3:** má stejný čip.
- **Quest Pro a prohlížeč v režimu „stránka pro počítač“** (UA počítače) dostanou profil Questu 2 jako neznámé brýle.
- **Foveace a strop částic** zůstávají jako na Questu 2.
- **`?vrscale` jen snižuje**, i na Questu 3 (rozsah 0,8–1,0).

### Pohodlí (P67 T9, 29. 10. 2026, emulátor)

- **V emulátoru IWER** (`e2e/vr-hud.spec.ts`, quest na stole, hlava 1,6 m skloněná ke středu stolu): deska vestoje 0,80 m, po „Seated“ 0,40 m, hrdina o 0,40 m níž a na desce na stejném místě. „Large“ zvětšil měřítko světa přesně 1,25×. Po „Recenter“ s hlavou otočenou doleva stojí deska 0,9 m vlevo, otočená o 90°. Po novém načtení stránky deska rovnou 0,40 m a vypínače vypnuté. Karta „Comfort“ je celá v obraze obou očí.
- **První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 495 B rozbaleně, +844 B proti `main` (před T9 +847 B), přenesené +730 B, žádný kód XR. T9 nezměnila žádný soubor, který telefon stahuje.
- **Skutečné brýle:** neověřeno. Patří do ruční brány T15 (bod „Comfort“).

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Stav voleb je v `src/play/xr/comfort.ts`, ne v `xr-context.ts`.** Plán chtěl `xr-context.ts`, ten je ale v prvním JS telefonu dvakrát (layout i feed). `comfort.ts` načítá jen kód XR.
- **„Seated“ = svět o 40 cm níž**, ne vyšší hlava. Výška očí vsedě ~1,2 m proti 1,6 m vestoje; stůl, pódium, svět kolem hráče i podlaha okolí klesnou o rozdíl, takže zorné pole, mlha pódia a velikost panelů platí beze změny. Hry rukou se nemění: pruhy krájení a bouchání jsou u ruky, střílečka a hod 1:1 na podlaze.
- **„Recenter“ otočí i posune.** Svět se otočí ke směru pohledu (bez sklonu hlavy) a postaví se před hlavu tam, kde hráč právě stojí, jako „Recenter“ systému Questu. Neukládá se, nová relace začíná bez něj. Stůl posunutý gripem se vrátí na výchozí místo.
- **Velikost světa ve třech stupních:** 0,75×, 1× a 1,25× měřítka stolu a pódia. „Small“ dá tratě a hry kolem hráče na stůl: plán počítal s tím, že panel pohodlí umí vrátit arénu na stůl, když 1:1–1:3 dělá nevolno. „Large“ zvětší i svět kolem hráče, nejvýš na 1:1 (obrana už 1:1 je).
- **Karta „Comfort“ stojí metr před hráčem jako lobby, ne na místě výsledku.** Na stole, pódiu i zápěstí je pak stejně velká a čitelná a tři tlačítka v řadě se do ní vejdou. Horní hrana 10 cm pod očima, aby byla vidět i od stolu.
- **Řada tlačítek panelu se zalomí,** když se nevejde (`layoutOf`): lobby s „Comfort“ a „Say it“ má pět tlačítek, „Make it!“ pak stojí samo přes celou šířku. Panely, kterým řada stačila, se nezměnily.
- **„Comfort“ na výsledku** je třetí vedlejší tlačítko pod „New game“ a „Exit VR“; tři vedle sebe by se do karty 300 px nevešly.

### Sdílení z VR (P67 T5, 29. 10. 2026, emulátor)

- **Kód v obraze brýlí se dá přečíst:** snímek stereo pohledu IWER z `e2e/vr-feed.spec.ts` (karta „Share“ na pódiu tratě, kód asi 100 px široký v každém oku) přečetl `jsqr` z výřezu levého oka a dal přesně odkaz s výzvou. Jednorázová kontrola, test ji nedělá.
- **Knihovna:** `uqr` 0.1.3 (MIT, vydaná 3. 4. 2026, bez závislostí, port kodéru Nayuki), jen v kódu XR. Na kartě je kód 200 px kitu i s tichou zónou. Nejdelší možný odkaz (id verze 64 znaků, dlouhá adresa náhledu nasazení) má modul aspoň 12 px plátna.
- **První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 494 B rozbaleně, **+843 B** proti `main` (před T5 +844 B), žádný kód XR. Kód QR i karta sdílení jsou jen v chunku XR. Uživatelské rozhraní sdílení ze 2D (`ShareButton`) v něm není podruhé: `publishDare` se bere z chunku stránky, který už je načtený.
- **Mutační zkouška** (`qr.test.ts`, každá chyba zvlášť, soubor pak vrácený ze zálohy): kód bez světlého podkladu (tichou zónu by nakreslila jen karta) → test zčervenal. Obrácené barvy → zčervenal. Moduly přehozené podle úhlopříčky (zrcadlený kód) → `jsqr` ho přečetl dál. Proto přibyl test, že střed každého modulu odpovídá matici kodéru, a ten zčervenal.
- **Skutečné brýle:** neověřeno. Jestli Quest Browser v relaci pustí nabídku sdílení („Share link“), a jak dobře telefon čte kód z promítaného obrazu, patří do ruční brány T15.

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **VR posílá výzvu sama a po odmítnutí ji zkusí znovu po 3 s, nejvýš čtyřikrát.** Výsledek 2D (`ArcadePlay`) posílá výzvu sám hned po výhře, jenže panel VR to z `XrHudView` nevidí. Druhé poslání vrátí totéž id výzvy (id je hash běhu), ale produkce pouští jednoho volajícího na 1 výzvu za 10 s. První poslání z VR do 10 s po výhře proto server odmítne a další pokus po 3 s okno přečká (nejvýš ~12 s čekání). Lepší cesta: `ArcadePlay` předá svou výzvu v `XrHudView` (jeden řádek, `dare`). Pravidla běhu P67 ale v `ArcadePlay.tsx` povolují jen řádek s „Enter VR“, proto zatím takhle.
- **Hraná verze je z adresy:** stránka hry `/play/<id>`, ve feedu `?g=<id>`. Feed adresu drží s aktivní kartou. Z jiné adresy (lobby bez hry) se „Share“ nenabídne.
- **„Share“ i po prohře,** s odkazem bez výzvy, jako 2D výsledek. Prohraný běh se jako výzva neposílá: server by ho odmítl a vzal volajícímu okno.
- **Karta drží výsledek ve feedu umělým stiskem na okně každé 2 s.** Feed vrací výsledek po 10 s bez stisku na stránce do náhledu robota a ovladače se za stisk nepočítají. Stisk nemá cíl, takže ho hra ani feed nepřevezmou. Po „Done“ běží 10 s znovu.
- **„Done“ je jediné rajčatové tlačítko karty,** stejně jako na kartě „Comfort“. „Share link“ je vedlejší, kód je hlavní cesta.
- **Oprava chyb `L` se zvýšením** (`boostEcc`): z plochy, kterou má karta, dá největší moduly. Kde verze kódu unese víc, oprava se zvýší bez zvětšení kódu.
- **Událost `share`** se počítá jen po „Share link“, které opravdu odešlo, jako ve 2D. Zobrazený kód se nepočítá: nikdo neví, jestli ho někdo naskenoval.

### Feed ve VR (P67 T4, 29. 10. 2026, emulátor)

**Přechod „Next“ do prvního snímku nové hry** (IWER Quest 2 na počítači s GPU, `e2e/vr-feed.spec.ts`): od mávnutí páčkou po první snímek relace, ve kterém je hrdina nové karty ve scéně a po něm se nakreslil další snímek. Pět přechodů střídavě mezi dvěma kartami:

| Běh | 1 | 2 | 3 | 4 | 5 | Medián (ms) |
|---|---|---|---|---|---|---|
| první | 906 | 160 | 66 | 119 | 67 | **119** |
| druhý (finální build) | 472 | 181 | 79 | 122 | 84 | **122** |

- **První přechod na kartu, která ještě nehrála, je nejdelší:** nová scéna se poprvé nakreslí až s přeloženými shadery (`DrawWhenCompiled`, nejvýš 1 s). Mezitím brýle ukazují poslední snímek předchozí scény. Další přechody jsou rychlejší, protože trvalé plátno relace drží přeložené programy (`keepPrograms`) – to je odhad, zvlášť se neměřilo.
- **Bez brány.** Quest 2 je pomalejší než počítač; změří se v T13 a v ruční bráně T15.

**Plátno hry ve VR:** `StageHost` už od P65 T1 nedělá vlastní plátno, když je na stránce VR, a hru karty předá trvalému plátnu relace z layoutu (od T4a jen od „Enter VR“ do konce relace, viz níž). Feed ve VR proto nepotřeboval náhradní cestu přes `router.push` z plánu a `StageHost.tsx` se neměnil.

**Mutační zkouška** (`e2e/vr-feed.spec.ts`, každá chyba zvlášť, po ní soubor vrácený ze zálohy):

| Úmyslná chyba | Test zčervenal na |
|---|---|
| `StageHost` bez větve XR (feed má vždy vlastní plátno) | „Enter VR“ se na kartě feedu vůbec neukáže: plátno relace nemá kde viset, nepřipojí se a brýle by nedostaly ani snímek |
| páčka listuje i v běžícím kole | mávnutí v kole přepnulo na další kartu |
| spoušť náhled nepřevezme | karta zůstala v náhledu robota |

**Tři testy feedu na tomhle počítači červené, ale ne kvůli T4:** `play-feed-phone` („ten swipes up“, „ten wheel moves“) a `play-feed-reels` („twenty moves keep one canvas“) hlásí dvě plátna místo jednoho. Tyhle soubory si přepisují `launchOptions` a s nimi i `--disable-features=OpenXR` z konfigurace, takže Chromium na tomhle počítači (SteamVR) hlásí VR a feed načte kód XR. Do té doby feed kreslí do vlastního plátna, pak přejde na plátno relace. S `XR_RUNTIME_JSON` mířícím na neexistující soubor (OpenXR runtime vypnutý jen pro ten běh) jsou všechny tři zelené. Telefon OpenXR runtime nemá. Brýle druhé plátno dostanou od T1; opravené v T4a.

### Feed mimo relaci: jedno plátno (P67 T4a, 29. 10. 2026)

**Příčina (naměřeno sondou na tomhle počítači, Chromium s OpenXR runtime):** kód XR se načítá až po prvním snímku stránky. Feed mezitím kreslí do vlastního plátna (desktop od 544 ms) a po načtení kódu XR (1 499 ms) ho `StageHost` vyměnil za plátno relace: druhý kontext WebGL, scéna se postavila znovu. Na brýlích neměřeno; prohlížeč Questu hlásí VR vždy, takže by feed měnil plátno při každém otevření `/play`. Na `main` se kód XR ve feedu nenačítal.

**Oprava:**

- Hry dostanou plátno relace až od „Enter VR“ do konce relace (`onHosting` v `XrRoot.tsx`, kontext v `XrGate.tsx`). Mimo relaci kreslí do vlastního plátna jako na telefonu.
- Plátno relace mezitím čeká ve skrytém kontejneru 1 px (`xr-parking`): R3F plátno bez rozměru nezaloží, `<XR>` by se nepřipojilo a „Enter VR“ by se neukázalo. Když ho hra pustí, vrátí se tam.
- „Enter VR“ nejdřív přestěhuje hru do plátna relace a relaci začne o snímek později. Plátno pak v relaci visí v místě hry jako dřív: z něj čte sadu prostředí `lookIdOf` a emulátor si ho tam po relaci vrátí.

**Cena:** na brýlích mimo relaci dva kontexty WebGL (feed a skryté plátno 1 px, které nekreslí). Při vstupu do VR se scéna hry v plátně relace staví znovu (nejvýš 1 s `DrawWhenCompiled`), po odchodu z VR dostane hra nové vlastní plátno.

**Test:** `e2e/vr-feed.spec.ts` „outside the session…“ pozdrží bránu VR, dokud feed nehraje náhled, pak ji pustí a počítá plátna, která byla ve feedu kdy vidět. S opravou 1, s vrácenou opravou (hry mají plátno relace hned) 2 – test zčervená. Spec soubory s vlastními `launchOptions` (`play-feed`, `play-feed-reels`, `play-feed-phone`, `play-feed-perf`) mají `--disable-features=OpenXR`, ať nezávisí na runtime VR počítače.

**První JS telefonu** (Pixel 7, `/play`): 39 skriptů, **+931 B** rozbaleně proti `main` (T4a +88 B v `XrGate`), přenesené +1 373 B, žádný kód XR.

**`vr-lobby` kolísá i bez T4a:** klik paprskem na panel lobby občas propadne (`lobby:idea-1` zůstane „aimed“, nebo text karty nedostane větu). Stejné podpisy chyb jsou v bězích T9 a na buildu s vrácenou opravou T4a (1 ze 3 testů červený ve 2 bězích ze 2). S opravou 1 běh 3/3 zelený, 3 běhy 1/3. Příčinu našla a opravila T14 (oddíl „Celá smyčka v jedné relaci“).

**První JS telefonu** (Pixel 7, `/play`): 39 skriptů, 4 216 426 B rozbaleně, **+775 B** proti `main`, přenesené +697 B, žádný kód XR.

- T4 sama přidala +269 B: `FeedPrev` vedle `FeedNext`, krok zpět a ohlášení listování pro kód XR v `ReelFeed.tsx` a `feed-next.ts`.
- Tím by větev byla +1 134 B, nad limitem ±1 kB. Registrace service workeru (T11) proto odešla z layoutu do kódu XR (`XrRoot`): −359 B. Registruje se dál jen v prohlížeči s immersive VR (`e2e/vr-pwa.spec.ts`).

**Výchozí volby (žádná nečekala na rozhodnutí):**

- **Listování jde do kódu XR přes `feedSteps`, ne přes kontext.** Plátno XR je vlastní React kořen v layoutu a kontexty feedu (`FeedNext`, `FeedPrev`) do něj nedosáhnou. `FeedPrev` je v `feed-next.ts` a `ReelFeed` ho poskytuje jako `FeedNext`.
- **Převzetí náhledu spouští ve VR stejný ťuk na scénu jako na telefonu.** Kód XR pošle na scénu aktivní karty stisk a puštění na místě; `ReelFeed` ťuk zopakuje a `ArcadePlay` hru převezme. Do vstupů hry ťuk nejde. `ArcadePlay.tsx` patří souběžným plánům, proto převzetí nemá vlastní funkci.
- **„Enter VR“ ve feedu je jen u hry, kterou hraje hráč.** Lišta HUD s tlačítkem se během náhledu robota nekreslí (`ArcadePlay`), a to se v T4 neměnilo. Na domově `/play` začíná „Enter VR“ v liště lobby (T2).
- **Kolo běží i tehdy, když hra po „Again“ čeká na první pohyb.** Páčka pak patří hře, první pohyb kolo pustí.
- **„Again“ zůstává jedinou rajčatovou akcí panelu,** „Next“ je vedlejší, jako „Next game“ ve 2D.
- **Výsledek bez dotyku 10 s vrátí kartu do náhledu robota** jako na telefonu. Ovladače se za dotyk stránky nepočítají, takže ve VR se to stane i hráči, který jen čte panel. Další mávnutí nebo spoušť pokračuje dál.
- **„Next“ na poslední kartě nic neudělá.** Feed dotahuje další stránku, když jsou do konce tři karty.
- **Skutečné brýle:** feed na Questu 2 tento běh neověřil. Patří do ruční brány T15.

### Rozpočet snímku ve všech režimech (P67 T13, 29. 10. 2026, emulátor)

Všech 19 žánrů ve svých režimech, nad každým panel výsledku, karta sdílení s QR kódem, „Comfort“ a lobby z „New game“ s otevřenou klávesnicí, k tomu lobby na domově a feed ve VR. Rozpočet Questu 2 je ≤ 150 draw callů a ≤ 300 000 trojúhelníků za snímek (obě oči). Nejhorší snímek v každém režimu:

| režim | nejvíc volání | kde | nejvíc trojúhelníků | kde |
|---|---|---|---|---|
| native | 114 | `shooter.default` | 72946 | `shooter.default` |
| room | 88 | `defense.default` | 98588 | `arena.escape` |
| surround | 64 | `flap.default` | 286270 | `voyage.race` |
| diorama | 76 | `quest.spatial` | 104414 | `quest.spatial` |
| lobby | 56 | `lobby` | 82664 | `lobby` |
| feed | 78 | `feed` | 82660 | `feed` |

Všechno je pod rozpočtem. Nejtěsnější je závod `voyage` na pódiu: 286 tisíc trojúhelníků, rezerva 4,6 %. Čísla všech žánrů a panelů jsou v `evals/vr/README.md`; obě tabulky hlídá `evals/vr/__tests__/budget.test.ts` proti měření.

- **Co bylo nad rozpočtem a co se srazilo:** lobby z „New game“ s otevřenou klávesnicí. Každé tlačítko panelu byla vlastní síť, 2 volání na tlačítko. Nad střílečkou to dělalo 194 volání, nad questem 158. Tlačítka v klidu se teď kreslí do textury karty a vlastní síť kreslí jen tlačítko s paprskem nebo stisknuté (`XrPanel.tsx`). Střílečka s klávesnicí má 104 volání, lobby na domově 56 místo 142. Vypadá to stejně: tlačítko s paprskem i stisknuté kreslí síť jako dřív.
- **Lobby a feed v měření** mají za sebou tytéž tři hry z fixtur (běžec, flap, plošinovka). Těžší hra na první kartě feedu přidá svá volání; nejtěžší hra s lobby je řádek střílečky (104).
- **Chyba `Ambient.tsx` ve VR** (oddíl „Panely HUD“) se v tomto běhu ozvala u 4 žánrů (střílečka, aréna, plošinovka, závod) a ve feedu. Snímek s ní se zahodí; v brýlích to bude cuknutí.

**FPS v brýlích:** neměřeno – brýle nepřipojené/nenasazené, měří se v T15. Quest 2 byl 29. 10. na USB s povoleným laděním, ale spal (`mWakefulness=Asleep`), nikdo ho neměl na hlavě. Prohlídka (`--tour`, bod 10 návodu) ho nebudila, nic nepřesměrovala a do `evals/vr/quest2-fps.json` zapsala důvod.

### Nové žánry P66 (P67 T12, 29. 10. 2026)

- **P66 ještě není v `main`** (`origin/main` = `e661855c`, `GENRES` bez survivor, hole, steal, sort a arrows). Nové žánry dostanou `desk` z výchozí hodnoty tabulky `src/play/xr/modes.ts`, tedy hrají se na stole jako ostatní deskové hry.
- Výchozí hodnotu hlídá `src/play/xr/__tests__/modes.test.ts` („an unknown genre plays on the desk“). Až P66 přistane, test „každý žánr z `GENRES` má záznam“ zčervená a žánry dostanou režim podle plánu: survivor, hole a steal `room`, sort a arrows `desk` s klepnutím paprskem.

### První JS bez `?vr=1` (27. 10. 2026)

Součet skriptů, které stránka načte hned (`<script src>` v HTML), na produkčním buildu:

| Stránka | Před VR | S VR bránou | Rozdíl |
|---|---|---|---|
| `/play` | 3 364 852 B | 3 368 635 B | +3,8 kB |
| `/play/<id>` | 3 160 938 B | 3 164 709 B | +3,8 kB |

- Knihovna XR (`@react-three/xr`, `three` WebXR) v prvním JS není. Načte se dynamickým importem až s `?vr=1` a prohlížečem, který umí `immersive-vr`.
- Rozdíl tvoří brána sama: `XrGate` v layoutu `/play` (+1,4 kB), mapa líně načítaných kusů v runtime webpacku (+0,6 kB) a tlačítko „Enter VR“ se sdíleným plátnem v kusech hry (+0,8 a +0,9 kB).
- Cíl ±1 kB tím není splněný. Menší rozdíl by znamenal bránu mimo layout, a pak by VR relace nepřežila příchod AI verze (ta je navigace na jinou `/play/<id>`).

### Měřítko dioramy (27. 10. 2026, emulátor)

Aréna, catch a defense se od P67 T6 hrají kolem hráče, tratě (runner, platformer, flap, voyage, hop, crowd) od T7 na pódiu (oddíly výš); jejich řádky platí, jen kdyby se vrátily na stůl.

| Hra | Měřítko |
|---|---|
| runner, platformer, timing, rhythm, duel, catch, defense, crowd, merge, push | 1:12 |
| hop | 1:13 |
| flap | 1:14 |
| voyage (závod) | 1:27 |
| arena, quest | 1:33 |

- **Pod 1:25 jdou velká hřiště:** arény mají stěny ±20 m a závodní trať voyage je široká 22 m. Aby se celá šířka vešla na 1,2 m, vychází měřítko až 1:33. Hrdina je pak velký asi 3 cm. Jestli je to v brýlích čitelné, ukáže ruční brána T8.
- **Výhled dopředu na trati:** při 1:12 ukáže stůl asi 10 m trati před hrdinou. Na obrazovce je vidět dál, takže ve VR je na překážky méně času. Doladí se v T8, případně delším stolem pro tratě.
- **Tratě jsou vidět zezadu:** hráč stojí tam, kde ve 2D stojí kamera běžce, tedy za hrdinou. Flap a platformer mají na obrazovce boční pohled, na stole je hráč vidí zezadu. Otočení stolu o 90° pro tyto dvě hry je možnost pro T8.
- **Výška stolu je pevná:** 0,8 m pro stojícího hráče. Kdo hraje vsedě, posune si stůl levým gripem níž.
- **Ořez nových věcí:** prostor nad stolem se ořezává rovinami řezu na materiálech světa. Nový kus (vystřelená věc, dotažený model) dostane ořez do 10 snímků, do té doby může být krátce vidět i mimo stůl. Materiál s vlastním shaderem, který ořez nepodporuje, se neořeže vůbec. Které to ve scénách jsou, emulátor neměřil; ukáže to pohled v brýlích (T8).
- **Nález v T4:** emulátor ukázal, že VR v merge nepustilo předmět, který už na pust čekal (hodiny pod nulou). Klávesnice ho pustila hned. Opraveno v `src/play/xr/input-map.ts`, pokryto testem.

### Panely HUD (27. 10. 2026, emulátor)

- **Řetěz mikroher nemá panely cíle a výsledku.** Hra z věty, která je řetězem kol (`ChainPlay`), má ve VR jen panel „AI version ready“. Počítadlo kol a výsledek řetězu kreslí jen 2D HUD; přenést je do VR je samostatná úloha.
- **Časovač ve VR chybí.** Panel ukazuje cíl, počítadla a životy, ne uběhlý čas ani odpočet. Jestli ho hry na čas ve VR potřebují, ukáže T8.
- **Výsledek her rukou je na zápěstí.** Hráč střílečky, hodu, krtků a krájení ho uvidí, až se podívá na levou ruku. Jestli to stačí, nebo má výsledek stát před hráčem, rozhodne T8.
- **Text je obrázek na ploše.** Karta se kreslí do plátna 2D (asi 2000 px na metr) a ve scéně je to textura. Ostrost v brýlích ověří T8.
- **Klik do 1 s.** Stisk a puštění spouště na tlačítku musí být do 1 s, jinak se klik nepočítá (výchozí 0,3 s bylo na chod spouště Questu málo).
- **Nález v T5 (opraveno):**
  - Ovladač pouštěl hodiny jen v prvním běhu. Po „Again“ by hra čekala navždy, protože ve VR není dotyk ani klávesa. Teď vstup ovladače pustí každý běh, který čeká.
  - Po konci hry hra přestala ohlašovat, že hraje, a stolní svět skočil do výchozí polohy (1:15) bez ořezu stolu – celá trať by se rozložila po pokoji. Teď stůl, měřítko i ořez zůstávají, dokud je hra na obrazovce; ovladače do skončené hry dál nic neposílají.
- **Nález v T5 (neopraveno, soubor P62): život na pozadí padá ve VR.** `src/components/play/arcade/look/Ambient.tsx` rozmisťuje život kolem orientačního bodu podle kamery. Ve VR je kamerou hlava. Když žádný pokus o umístění neleží v jejím obraze, `placeLife` vrátí v poli `null` (`best!`) a `writeLife` spadne na `l.x`. Výjimka ve snímku VR dřív zastavila kreslení relace natrvalo: obraz zamrzl, panely ani ovladače nereagovaly. Emulátor to ukázal asi v každém čtvrtém běhu střílečky (`e2e/vr-hud.spec.ts`) a nejspíš to stálo i za občasnými pády `vr-native`.
  - **Pojistka v `XrRoot.tsx` (T5):** snímek s výjimkou se zahodí a relace kreslí dál.
  - **Co zbývá:** dokud `Ambient` padá, vypadne každý 10. snímek, protože tolikrát se pokus opakuje. V brýlích to bude cuknutí asi 7× za sekundu.
  - **Oprava patří do `Ambient.tsx` (P62):** v `placeLife` vzít nejlepší pokus i tehdy, když žádný není v obraze, nebo ve VR život nerozmisťovat. Ověřit v T8.
  - **T6:** v měření všech 19 her (po 10 s hry) se výjimka do konzole neozvala ani jednou (`errors` v `evals/vr/budget.json`). Chyba je ale náhodná, takže to opravu nenahrazuje.

### Postprocessing ve VR

Skládač postprocessingu scény kreslí přes celou obrazovku jedním trojúhelníkem, takže do obou očí dá tentýž obraz a stereo se rozpadne. Ve VR se proto scéna po skládači kreslí znovu napřímo (`XrRig.tsx`).

- **Od T6 skládač ve VR nekreslí.** `XrQuality` v `XrRoot.tsx` po dobu relace přeskočí jeho kresbu i změnu velikosti cílů; po odchodu z VR jede jako dřív.
- **Je to přepsaná metoda knihovny `postprocessing`.** Čisté místo je `src/components/play/arcade/look/rig/Post.tsx` (P62): `enabled={!presenting}` u `EffectComposer`. Až ten soubor půjde měnit, přepis zmizí.
- **Cíle skládače zůstávají v paměti** ve velikosti 2D obrazovky, i když se nekreslí. Uvolnit je jde také jen v `Post.tsx`.

### Profil Questu 2 a rozpočet snímku (T6, 27. 10. 2026, emulátor)

Podrobnosti, čísla všech her a návod na měření jsou v `evals/vr/README.md`. Ve VR (mimo VR se nic nemění):

- **Bez skládače a bez stínů.** Skládač kreslil celou scénu podruhé a stínový průchod potřetí. Jen tohle srazilo draw cally 4–10×.
- **Rozpočet:** ≤ 150 draw callů a ≤ 300 tisíc trojúhelníků za snímek, obě oči dohromady. Je to odhad z doporučení Mety pro Quest 2, ruční brána T8 ho upřesní. Hlídá ho `evals/vr/__tests__/budget.test.ts` nad měřením.
- **Nejhorší hry po profilu:** hod 112 volání, závod 282 tisíc trojúhelníků. Před T6 bylo nejhorší 1182 volání (střílečka) a 29 milionů trojúhelníků (běžec).
- **Ve VR nejsou rostliny.** Vegetace si vybírá rostliny podle kamery hry ve 2D. Ve VR bez stínového průchodu kreslila všechny rostliny svého okna: 0,74–1,37 milionu trojúhelníků. Oprava patří do `src/components/play/arcade/look/Vegetation.tsx` (P62): výběr počítat z hlavy hráče převedené do souřadnic scény. Pak se rostliny do VR vrátí.
- **Bez obrysů nepřátel.** Obrys kreslil každý díl postavy podruhé. Obrys hrdiny zůstal.
- **Na stole se nekreslí, co je mimo něj.** Kulisy za okrajem desky by roviny řezu stejně ořízly. Prstenec rostlin za stěnami arény se ve VR nekreslí vůbec (od P67 T6 i v aréně kolem hráče, kde stál nad rozpočtem).
- **Stejné díly se kreslí najednou.** Aspoň 4 sítě se stejnou geometrií a materiálem kreslí jedna instancovaná síť (díly nepřátel střílečky).
- **Částice:** nejvýš 500 živých, jako telefon na nejnižší úrovni kvality.
- **Co emulátor neměří:** FPS, rozlišení relace a foveaci (IWER je přejde). Profil startuje na rozlišení 1,0 a foveaci 1 (Quest 3 a 3S na 1,2, oddíl „Profil Questu 3“); porovnání s 0,8 je v bodě 9 návodu výš.
