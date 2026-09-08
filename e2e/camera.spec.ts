import { expect, test } from '@playwright/test';

/**
 * Oracle úlohy T4 — **kamera drží hru v záběru**.
 *
 * Ptá se na tři věci a každou shodí jiná vada:
 *
 * - **Kdykoli postava chvíli stojí, kamera na ní musí dosedět přesně.** Tohle je
 *   jediná aserce, která doopravdy tvrdí „kamera sleduje". Kamera přišroubovaná
 *   na pevnou pozici sedí vedle o dráhu, kterou postava mezitím ušla; líná
 *   kamera sedí vedle o svůj nedojezd. Je to psané na klid **uprostřed** běhu,
 *   ne na jeho konec — jestli postava na konci zrovna stojí, je vlastnost světa,
 *   ne kamery, a test na ní stát nesmí. Předchází jí kontrola, že se postava za
 *   běh vůbec hnula: ve světě, kde stojí, sedí na navrženém odstupu i kamera,
 *   která nikoho nesleduje.
 * - **Vzdálenost v pásmu ⟨6, 14⟩ ve všech sta vzorcích** — požadavek AC.
 * - **Kamera nad podlahou ve všech sta vzorcích.** Pohled zespodu je stejně
 *   nepoužitelný jako pohled zdálky a žádná aserce o vzdálenosti ho nezachytí.
 *
 * **Naměřeno 19. 8. 2026 a je to důvod, proč test vypadá takhle:** pásmo
 * vzdálenosti ⟨6, 14⟩ samo o sobě přišroubovanou kameru NEZACHYTÍ. Mutace
 * „kamera se po prvním snímku přestane hýbat" jím prošla zeleně, protože se
 * postava po mřížce nevzdálí dost na to, aby se kamera z pásma vysunula. Pásmo
 * tu tedy je kvůli AC; důkaz sledování nese dosednutí za klidu.
 *
 * **Naměřeno 28. 8. 2026 a je to oprava lhoucího měřidla:** pásmo vzdálenosti
 * se do té doby měřilo proti **tikové** poloze postavy, zatímco kamera sleduje
 * **nakreslenou**. Rozdíl je za chůze nula, ale hned po tahu `moveTo` je dvanáct
 * jednotek — a test tak jednou za běh ohlásil vzdálenost 15,37 u kamery, která
 * doopravdy držela 9,60. Vada je stará a s rámováním nesouvisí: naměřeno
 * s oběma odstupy, starým `{0, 6, 7.5}` i novým, na tiku 654 vyšlo **totéž
 * číslo na patnáct desetinných míst**, protože obě mají tutéž délku. Měří se
 * proto `drawn()`, což je přísnější pozorování, ne volnější: hlídá, co kamera
 * doopravdy dělá, místo aby jí přičítalo dojezd entity.
 *
 * **Co tu naopak NENÍ a proč:** paušální strop na odchylku odstupu za chůze.
 * Byl tu a shodil ho vlastní svět — `moveTo` postavu nepřesune o políčko, ale
 * rovnou o dvanáct jednotek, takže po takovém skoku kamera zákonitě chvíli
 * dojíždí a každý strop kalibrovaný na chůzi je buď falešně červený, nebo tak
 * volný, že netvrdí nic. Přechodný výkyv hlídá pásmo z AC, ustálený stav
 * dosednutí.
 *
 * Vzorkuje se sto vzorků, jak žádá AC, ale **rozprostřených přes celý svědkův
 * běh**, ne přes prvních sto tiků. Důvod je naměřený a je to nejdražší zjištění
 * téhle úlohy: postavou ve zmrazených světech hýbe **jenom** tah `moveTo` a těch
 * je v celém svědkovi pár. `C01` je má na ticích 0 a 268, mezi nimi jen sbírání,
 * takže okno prvních sta tiků zachytí přesně nula pohybů a test by byl zelený,
 * i kdyby kamera nesledovala vůbec nic. Kratší okno tuhle vlastnost prokázat
 * neumí; delší ano, a je to přísnější pozorování, ne volnější.
 *
 * Svět je proto `C03` — skutečná certifikovaná emise ze zmrazeného korpusu, ne
 * fixtura autorovaná vedle testu, a ze všech zmrazených světů ten s nejvíc tahy
 * `moveTo`: na ticích 0, 420 a 640. Střídá tedy chůzi a dlouhý klid, což je
 * přesně to, na čem se sledování pozná.
 */

const PROMPT = 'C03';
const SAMPLES = 100;

/**
 * Kolik tiků připadne na jeden vzorek.
 *
 * Sto vzorků krát sedm pokryje svědkův běh `C03` celý (`L_witness` = 640), takže
 * do okna spadnou oba pohyby, které jdou zachytit — ten na tiku 0 se stane dřív,
 * než se stihne odebrat první vzorek, a proto se na něj nespoléhá.
 */
const TICKS_PER_SAMPLE = 7;
const MIN_DISTANCE = 6;
const MAX_DISTANCE = 14;

/**
 * Jak přesně musí kamera sedět, když postava chvíli stojí.
 *
 * Tohle je ta ostrá aserce. Dojezd ubere 35 % zbytku za tik, takže po pár
 * tikách klidu je chyba prakticky nula — desetina políčka je velkorysá.
 * Kamera, která nesleduje, tady sedí vedle o celou dosavadní dráhu postavy.
 */
const SETTLED_TOLERANCE = 0.1;

/** Kolik vzorků po sobě musí postava stát, než se čeká, že kamera dosedla. */
const REST_SAMPLES = 6;

/** Kolik takových klidových vzorků musí běh nabídnout, aby test něco tvrdil. */
const MIN_SETTLED = 10;

/**
 * Odstup, na který je kamera navržená — musí sedět s `FollowCamera.tsx`.
 *
 * **Pohnulo se to v P14 T8 a tady je proč.** Do té doby stálo `{0, 6, 7.5}`,
 * což je osa klopená o 38,7° pod vodorovnou — při svislém poloúhlu 22,5° tím
 * obzor vyjel nad horní hranu snímku a hra se hrála v jámě bez oblohy. T8 tutéž
 * vzdálenost (9,6047, beze změny, aby pásmo 6–14 platilo dál) rozdělila jinak:
 * osa klesá o 9,41°, paprsek k postavě o 17,27°, takže obzor spadl do obrazu a
 * postava na spodní třetinu.
 *
 * Kopie, ne import, schválně: kdyby se `followSeat` přepočítala jinak, tenhle
 * test se ozve. Import by tiše souhlasil s čímkoli.
 */
const OFFSET = { x: 0, y: 2.8512, z: 9.1717 };

/**
 * Jak daleko se musí postava hnout, aby test něco dokazoval.
 *
 * Musí to být znatelně víc než `SETTLED_TOLERANCE`, jinak by aserce o dosednutí
 * prošla i kameře, která stojí — a test by byl zelený, aniž by o sledování
 * cokoli tvrdil. `moveTo` je jeden krok po mřížce, takže jeden zachycený pohyb
 * je 1,0.
 */
const MIN_TRAVEL = 0.5;

interface Sample {
  readonly tick: number;
  readonly distance: number;
  readonly cameraY: number;
  readonly hasAvatar: boolean;
  /** Kam se kamera dívá zpoza postavy — `kamera − postava`. */
  readonly offset: { x: number; y: number; z: number };
  /** Buňka postavy, podle které se pozná klid. */
  readonly cell: string;
  /** Jak daleko je postava od místa, kde začala. */
  readonly travel: number;
}

function offsetError(sample: Sample): number {
  return Math.hypot(
    sample.offset.x - OFFSET.x,
    sample.offset.y - OFFSET.y,
    sample.offset.z - OFFSET.z,
  );
}

test('kamera sleduje postavu a nespadne pod podlahu', async ({ page, request }) => {
  test.setTimeout(120_000);

  const response = await request.post('/api/emit', { data: { promptId: PROMPT } });
  expect(response.status(), `emit ${PROMPT} musí odpovědět 200`).toBe(200);
  expect((await response.json()).outcome, `${PROMPT} musí být certifikovaný`).toBe('CERTIFIED');

  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.entities().length > 0, undefined, {
    timeout: 60_000,
  });

  const samples = await page.evaluate(async ({ count, stride }): Promise<Sample[]> => {
    const viewer = window.__viewer!;

    /** Počká na dva vykreslené snímky — kamera se hýbe uvnitř smyčky plátna. */
    const settle = async (): Promise<void> => {
      const from = viewer.frames();
      while (viewer.frames() < from + 2) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    };

    const out: Sample[] = [];
    await settle();
    const first = viewer.entities().find((entity) => entity.visual === 'avatar');
    const origin = first === undefined ? { x: 0, y: 0, z: 0 } : first.position;
    for (let i = 0; i < count; i += 1) {
      viewer.step(stride);
      await settle();

      const avatar = viewer.entities().find((entity) => entity.visual === 'avatar');
      // **Odstup se měří proti NAKRESLENÉ postavě, ne proti tikové.** Kamera
      // sleduje `drawn()` — přesně proto, aby mezi dvěma tiky pod postavou
      // neposkakovala. Tikový stav je jinde: `moveTo` postavu přesune rovnou
      // o dvanáct jednotek a nakreslená se tam teprve sune, takže hned po
      // takovém skoku vyjde odstup o dvanáct větší, než jaký kamera doopravdy
      // drží.
      const seen = viewer.drawn().find((entity) => entity.visual === 'avatar') ?? avatar;
      const camera = viewer.camera();
      out.push({
        tick: viewer.tick(),
        hasAvatar: avatar !== undefined,
        cameraY: camera.y,
        cell: avatar === undefined ? '' : avatar.cell.join(','),
        distance:
          seen === undefined
            ? Number.NaN
            : Math.hypot(
                camera.x - seen.position.x,
                camera.y - seen.position.y,
                camera.z - seen.position.z,
              ),
        offset:
          seen === undefined
            ? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
            : {
                x: camera.x - seen.position.x,
                y: camera.y - seen.position.y,
                z: camera.z - seen.position.z,
              },
        travel:
          avatar === undefined
            ? Number.NaN
            : Math.hypot(
                avatar.position.x - origin.x,
                avatar.position.y - origin.y,
                avatar.position.z - origin.z,
              ),
      });
    }
    return out;
  }, { count: SAMPLES, stride: TICKS_PER_SAMPLE });

  expect(samples, 'sto vzorků, jeden na tik').toHaveLength(SAMPLES);
  expect(
    samples.every((sample) => sample.hasAvatar),
    'svět bez postavy nemá o čem tvrdit, že to kamera sleduje',
  ).toBe(true);

  // Nejdřív se ptá test sám sebe, jestli má o čem mluvit. Ve světě, kde postava
  // nikam nejde, jsou všechny aserce níž splnitelné i kamerou, která nesleduje.
  const maxTravel = Math.max(...samples.map((sample) => sample.travel));
  const cells = [...new Set(samples.map((sample) => sample.cell))];
  const span = `tiky ${samples[0].tick}–${samples[samples.length - 1].tick}, buňky ${JSON.stringify(cells)}`;
  expect(
    maxTravel,
    `postava ušla jen ${maxTravel.toFixed(2)} (${span}) — na tomhle světě se sledování nedá dokázat`,
  ).toBeGreaterThan(MIN_TRAVEL);
  expect(
    maxTravel,
    'dráha postavy musí být znatelně větší než přesnost dosednutí, jinak aserce níž nic netvrdí',
  ).toBeGreaterThan(SETTLED_TOLERANCE * 3);

  // Klidové vzorky: postava stojí `REST_SAMPLES` vzorků na téže buňce, takže
  // dobře napsaná kamera měla čas dosednout přesně na navržený odstup. Tohle
  // shodí kameru, která se nehýbe, i kameru, která dojíždí příliš líně.
  const settled = samples.filter((sample, i) => {
    if (i < REST_SAMPLES) return false;
    return samples.slice(i - REST_SAMPLES, i + 1).every((prev) => prev.cell === sample.cell);
  });
  expect(
    settled.length,
    `běh nabídl jen ${settled.length} klidových vzorků — dosednutí se nedá změřit`,
  ).toBeGreaterThanOrEqual(MIN_SETTLED);

  const notSeated = settled
    .filter((sample) => offsetError(sample) > SETTLED_TOLERANCE)
    .map((sample) => ({ tick: sample.tick, offset: sample.offset, err: offsetError(sample) }));
  expect(notSeated.slice(0, 3), 'kamera na stojící postavě nedosedla na navržený odstup').toEqual([]);

  // Pojmenovat konkrétní vzorek, ne jen „něco je mimo" — jinak se z červeného
  // testu nedá poznat, jestli kamera zůstala stát, nebo odletěla.
  const tooFar = samples.filter((sample) => sample.distance > MAX_DISTANCE);
  const tooClose = samples.filter((sample) => sample.distance < MIN_DISTANCE);
  expect(
    tooFar,
    `kamera se vzdálila víc než ${MAX_DISTANCE}: ${JSON.stringify(tooFar.slice(0, 3))}`,
  ).toEqual([]);
  expect(
    tooClose,
    `kamera se přiblížila víc než na ${MIN_DISTANCE}: ${JSON.stringify(tooClose.slice(0, 3))}`,
  ).toEqual([]);

  const underFloor = samples.filter((sample) => sample.cameraY <= 0);
  expect(
    underFloor,
    `kamera prošla podlahou: ${JSON.stringify(underFloor.slice(0, 3))}`,
  ).toEqual([]);
});
