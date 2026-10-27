# PLAY ve VR (Quest 2)

Jak pustit hru z PLAY v brýlích Meta Quest 2 připojených k počítači kabelem a změřit, jak plynule běží.

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
node node_modules/next/dist/bin/next start -p 3165
```

Server nech běžet ve vlastním terminálu. Port 3165 je pevný, skript s ním počítá.

### 5. Otevření hry v brýlích

Ve druhém terminálu:

```
node scripts/quest-dev.mjs
```

Skript:

1. najde adb;
2. ověří, že brýle jsou připojené a ladění povolily (jinak napíše, co udělat);
3. přesměruje port 3165, takže brýle vidí server počítače jako `localhost:3165`. To je nutné: vstup do VR v prohlížeči funguje jen na zabezpečené adrese a `localhost` mezi ně patří;
4. otevře v prohlížeči brýlí `http://localhost:3165/play?vr=1&vrhud=1`.

### 6. V brýlích

1. Stránka se otevře sama, s `?vr=1&vrhud=1` v adrese.
2. Stiskni „Enter VR“.
3. Hraj. FPS panel (`?vrhud=1`) přidá úloha T6, do té doby ukazuje FPS jen měření níž.
4. Ven z VR: tlačítko „Exit VR“ na panelu hry (paprsek pravého ovladače a spoušť, viz „Panely ve VR“ níž), nebo systémové tlačítko Meta na pravém ovladači. Stránka se vrátí do 2D, hra běží dál a „Enter VR“ je zpět. Tlačítko na 2D stránce v relaci nejde, protože ji brýle nekreslí.

### 7. Měření FPS

```
node scripts/quest-dev.mjs --fps 60
```

Skript udělá kroky z bodu 5, pak počká. Až jsi ve VR a hra běží, stiskni v terminálu Enter. Následujících 60 sekund čte z brýlí systémový záznam snímků (jeden údaj za sekundu) a výsledek zapíše do `evals/vr/quest2-fps.json`. Číslo za `--fps` je délka měření v sekundách.

Když za celou dobu nepřijde jediný údaj, skript nic nezapíše a skončí chybou. Nula v souboru by vypadala jako změřená hra, která nejede.

### 8. Jak číst `evals/vr/quest2-fps.json`

```json
{
  "measuredAt": "2026-10-27T14:03:11.482Z",
  "url": "http://localhost:3165/play?vr=1&vrhud=1",
  "seconds": 60,
  "median": 72,
  "p5": 68,
  "samples": 60
}
```

- `median` – typická sekunda: polovina sekund měla víc snímků, polovina méně.
- `p5` – nejhorší chvíle: 5 % sekund mělo tolik snímků nebo méně. Právě tyhle propady jsou v brýlích cítit jako trhání.
- `samples` – kolik sekund se změřilo. Výrazně méně než `seconds` znamená, že brýle část doby nehrály (sundané, uspané, mimo VR).

Cíl: **`median` ≥ 72 a `p5` ≥ 65**. Quest 2 obnovuje obraz 72× za sekundu, takže 72 je plynulý chod.

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

### Hry na stole (diorama)

Ostatních 15 her se ve VR hraje jako zmenšený svět na stole: runner, platformer, flap, timing, rhythm, duel, arena, voyage, quest, catch, defense, hop, crowd, merge a push.

- **Stůl:** deska 1,2 × 1,2 m, její střed 0,9 m před hráčem, ve výšce 0,8 m. Nad deskou je 0,75 m prostoru. Co leží mimo tento prostor, se nekreslí, takže trať končí na kraji stolu a ne v pokoji.
- **Měřítko:** spočte se z velikosti hřiště, aby se celá šířka hrací plochy vešla na 1,2 m. Malá hřiště se nezvětší víc než na 1:12. Aréna se měří podle svých stěn, ne podle toho, kde zrovna leží věci.
- **Trať se posouvá, hlava stojí:** u tratí (runner, voyage, crowd, flap, hop) i u vysokých her (věž v timing) jede svět pod hrdinou. Hrdina zůstává v bližší třetině stolu, zbytek stolu ukazuje, co přijde. Hřiště, které se na stůl vejde celé (aréna, push, merge), stojí na místě.
- **Levý grip nese stůl:** stiskni levý grip a posuň nebo otoč rukou. Stůl jde s rukou: posun do všech stran (i výš a níž, třeba vsedě) a otočení kolem svislé osy. Je to jen pohled, hra o něm neví. Pravý grip dál slouží hře.

**Ověření (T4):**

- `e2e/vr-diorama.spec.ts` hraje každou z 15 her dvakrát po 5 s týmž skriptem: jednou ve 2D skutečnou klávesnicí, jednou ve VR páčkou a spouští. Obě hry skončí ve stejném stavu (stejné vstupy, stejný hash) a hrdina se pohne nebo se změní počítadlo.
- Každých 30 tiků se hrdina promítne do kamery obou očí. Jeho střed musí být uvnitř obrazu a nad deskou. Hlava stojí ve výšce 1,6 m a dívá se na střed stolu.
- U questu test navíc ověří, že levý grip posune stůl o 20 cm a do hry nic nepošle, a že pravý grip dál dělá „použít“.
- `src/play/xr/__tests__/diorama-scale.test.ts` nechá robota dohrát každou živou hru (mimo čtyři hry rukou) a v každém tiku ověří, že hrdina je na stole a v zorném poli hlavy.
- **Mutace:** stůl, který za hrdinou na trati nejede, test pozná (37 testů červených). Test sám obsahuje i kontrolu se zamrzlým stolem, která musí hrdinu ztratit.

### Panely ve VR (cíl, počítadla, výsledek)

Stránka 2D se v brýlích nekreslí, proto HUD hry ve VR tvoří 3D panely podle kitu Sayplay: papírová karta s inkoustovým obrysem a tvrdým stínem, písmo Roboto, jedno rajčatové tlačítko na panel. Ukazují totéž co 2D HUD a výsledek: cíl hry, počítadla s popisky jako ve 2D (`HUD_COUNTER_LABELS`, u věty s počtem slovo věty, třeba `keys`) a životy.

| Panel | Kdy | Hry na stole | Hry rukou |
|---|---|---|---|
| cíl a počítadla, „Exit VR“ | během hry | tabule za vzdáleným okrajem stolu, nad scénou | nad levým zápěstím |
| výsledek „You did it!“ / „So close.“, „Again“, „Exit VR“ | po konci hry | stojí na bližší polovině stolu | nad levým zápěstím místo cíle |
| „AI version ready“ | příchod AI verze | visí z bližšího okraje stolu | nad levým zápěstím |

- **Ovládání:** paprsek pravého (nebo levého) ovladače na tlačítko a spoušť: stisknout a pustit. Tlačítko pod paprskem má silnější obrys, stisknuté se zamáčkne. Spoušť stisknutá na tlačítku do hry nejde, ani když paprsek mezitím z tlačítka sjede. Stisk, který začal mimo panely, patří hře.
- **„Again“** začne hru znovu od začátku. Hra pak čeká na první pohyb ovladače, stejně jako po „Play again“ ve 2D.
- **„Exit VR“** ukončí relaci. Stránka ukáže 2D výsledek hry, odkud jde sdílet (Dare, Copy link) a remixovat („Remix it“).
- **„AI version ready“:** když stránka sama přejde na hru podle věty, panel to na 3 s oznámí. Když je hotová verze s plnými detaily, panel nabídne „Play it“, stejně jako tlačítko „Full detail“ ve 2D. Hra se vymění bez opuštění VR.
- **Čitelnost:** text má od očí úhlovou velikost jako text kitu na 1 m (1 px kitu = 2 mm na 1 m). Tabule je od očí asi 1,7 m, proto je 1,75× větší. Výsledek je zvětšený 1,1×, zápěstí je blízko, proto 0,45×. Panely se natáčejí k hlavě a kreslí se přes scénu, takže je kulisa nezakryje.
- **Stůl zůstává po konci hry:** výsledek leží na zamrzlé scéně. Dřív se po konci hry svět vrátil do výchozí polohy bez ořezu stolu.

**Ověření (T5):** `e2e/vr-hud.spec.ts` v emulátoru IWER, klikání skutečným paprskem a spouští:

- Stolní hra z věty „A knight must collect three keys…“: tabule s cílem a počítadlem `0/3 keys` je celá v obraze obou očí a čitelná. Robot vyhraje, výsledek „You did it!“ je v obraze. „Again“ vrátí hru na tik 0 bez vstupu. Druhá výhra a „Exit VR“ vrátí 2D výsledek, z něj funguje sdílení (odkaz ve schránce) i „Remix it“.
- Spoušť na tlačítku nejde do hry: stisk na „Exit VR“, paprsek z tlačítka pryč, puštění, hra nedostala nic. Týž stisk mimo panely do hry jde (kontrola, že test měří spoušť).
- Střílečka: panel na levém zápěstí v obraze, prohra ukáže „So close.“, „Again“ hru restartuje.
- AI verze: panel „AI version ready“ s „Play it“ vymění hru a relace trvá. Přechod na hru podle věty ukáže panel krátce bez tlačítka.
- Unit: `src/play/xr/__tests__/input-map.test.ts` drží, komu patří spoušť (panel, nebo hra).

## Měření a známá omezení

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
  - **Oprava patří do `Ambient.tsx` (P62):** v `placeLife` vzít nejlepší pokus i tehdy, když žádný není v obraze, nebo ve VR život nerozmisťovat. Ověřit v T6 nebo T8.

### Postprocessing ve VR

Skládač postprocessingu scény kreslí přes celou obrazovku jedním trojúhelníkem, takže do obou očí dá tentýž obraz a stereo se rozpadne. Ve VR se proto scéna po skládači kreslí znovu napřímo (`XrRig.tsx`). Skládač ale dál běží naprázdno a stojí výkon GPU brýlí. Vypnout ho ve VR jde jen v `src/components/play/arcade/look/rig/Post.tsx`; to je úkol pro profil výkonu (T6), jakmile ten soubor půjde měnit.
