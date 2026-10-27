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
4. Ven z VR: systémové tlačítko Meta na pravém ovladači a odchod z relace. Stránka se vrátí do 2D, hra běží dál a „Enter VR“ je zpět. Panel „Exit VR“ uvnitř VR přidá úloha T5; tlačítko na 2D stránce v relaci nejde, protože ji brýle nekreslí.

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

### Postprocessing ve VR

Skládač postprocessingu scény kreslí přes celou obrazovku jedním trojúhelníkem, takže do obou očí dá tentýž obraz a stereo se rozpadne. Ve VR se proto scéna po skládači kreslí znovu napřímo (`XrRig.tsx`). Skládač ale dál běží naprázdno a stojí výkon GPU brýlí. Vypnout ho ve VR jde jen v `src/components/play/arcade/look/rig/Post.tsx`; to je úkol pro profil výkonu (T6), jakmile ten soubor půjde měnit.
