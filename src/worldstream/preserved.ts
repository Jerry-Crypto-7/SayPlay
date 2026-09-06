/**
 * **Co změna nechá být** — jediný výpočet pro obojí dveře, kterými se porotci
 * ta věta ukáže: preview druhé věty (`/api/worldstream/sessions/:id/changes`)
 * a vývojářská harness `/dev/refine`.
 *
 * ⚠ **Bydlí to tady, protože dvě kopie se rozešly.** Do 6. 9. 2026 route
 * počítala seznam z operací a `/dev/refine` z holého „všechno kromě cíle";
 * druhá tedy tvrdila přesně tu nepravdu, kterou blokující nález nezávislé
 * revize v routě zavřel. Opravuje se ten rozpor (`T35-preservedattr`), ne to,
 * kde která z kopií stála.
 */

import type { WorldDoc } from '@/ir/worlddoc';

/** Tolik z operace, kolik tenhle výpočet čte. Zbytek emise je mu jedno. */
export interface PreservedOperation {
  readonly op: string;
  readonly path: string;
}

/** Tolik z plánu změny, kolik tenhle výpočet čte. */
export interface PreservedChange {
  /** Cíl věty. Ten je dotčený vždycky, i když ho žádná operace nejmenuje. */
  readonly stableId: string;
  readonly behavior: readonly PreservedOperation[];
  readonly appearance: readonly PreservedOperation[];
  /** Nový tvar, nebo `null`. Jména uvnitř něj jsou taky část změny. */
  readonly shape: unknown;
}

/**
 * Co změna **nechá být** — spočítané z jejích operací, ne z toho, koho věta
 * jmenovala jako cíl.
 *
 * ⚠ **Rozdíl je naměřený a byl to blokující nález nezávislé revize
 * 6. 9. 2026.** „Všechno kromě cíle" je nepravda vždycky, když emise sáhne
 * i vedle: vlajková změna dema (`c04`/`r02`) míří na kupoli, ale zapisuje
 * `/look/modules/splayedSupportLegs/params/splay` a čtyři `/sim/collisionAabb/
 * splayedSupportLegs/*`. Panel tedy porotci tvrdil „Untouched: the three
 * splayed legs" a odpověď commitu hned nato vypsala tytéž nohy mezi změněnými
 * listy. Produkt si odporoval uvnitř jednoho průchodu, před porotcem.
 *
 * Objekt se počítá za dotčený, když se jeho `stableId` objeví jako **celý
 * segment** kterékoli cesty, jako segment `from` u `move`/`copy`, nebo
 * kdekoli uvnitř zapisované hodnoty — pravidlo se dá do světa přidat celé
 * a cizí objekt v něm jmenovat, aniž se objeví v cestě. Segment, ne
 * podřetězec: jméno socketu (`leftLegPad`) není jméno objektu.
 *
 * **Zápis nad celým poddokumentem seznam vyprázdní** (`replace /sim/entities`).
 * Cesta o dvou segmentech nejmenuje objekt, ale přepisuje je všechny, takže
 * jediná pravdivá odpověď je „neslibuju nic".
 *
 * ## Socket patří tomu, kdo si ho nárokuje — a materiálová role nikomu
 *
 * `/sim/sockets/observatoryPad` neobsahuje jméno objektu, ale kupole na tom
 * socketu stojí; `sim.entities[*].socket` tu vazbu nese, tak se čte
 * (`T35-preservedattr`). Nenárokovaný socket zůstává nepřiřazený a je to
 * **vědomé, ne opomenutí** — přísné pravidlo „nepřiřaditelná operace ⇒
 * neslibuj nic" vyprázdní **2 z 5** uvařených seznamů včetně vlajkového
 * `c04`/`r02`, který dva takové sockety posouvá. Naměřeno 6. 9. 2026 nad
 * `authored-worlds.json`, ne odhadnuto.
 *
 * ⚠ **Zbytek třídy je otevřený a `T35-preservedattr` ho zavřít nemohl, protože
 * ho měření vyvrátilo.** Plán předepisoval mapu i pro paletu (přes
 * `look.materialRoles`) a světla (přes `lights[*].entity`), a doplnění
 * chybějících vazeb při kompilaci. Nad skutečnými jedenácti světy neplatí ani
 * jedno: **30 ze 33** klíčů `materialRoles` neodpovídá roli žádné entity
 * (`c27` má klíč `deep water`, tedy větu, ne jméno), `look.lightRig` je plochý
 * objekt **bez pole `lights`** ve všech jedenácti, a vynucení nárokovaného
 * socketu při kompilaci by odmítlo **5 z 11** uložených světů — z toho `c15`
 * má nenárokovaný socket `observationPad` použitý v `/sim/rules/win/event/zone`,
 * takže ho nejde ani zahodit.
 *
 * Proto se ta věta v panelu jmenuje **„Not named by this change"**, ne
 * „Untouched", a **smí se přejmenovat teprve tehdy, až bude přiřazení úplné.**
 * Dnes úplné není a žádná z předepsaných cest ho úplným neudělá.
 */
export function preservedBy(
  objects: readonly { readonly stableId: string; readonly label: string }[],
  change: PreservedChange,
  doc: WorldDoc,
): readonly string[] {
  const touched = new Set<string>([change.stableId]);
  const ownerOfSocket = socketOwners(doc);

  for (const operation of [...change.behavior, ...change.appearance]) {
    const path = operation.path.split('/').filter((segment) => segment !== '');
    // `/sim/entities` přepíše všechny entity naráz; `/sim/entities/x/state` ne.
    if (path.length < 3) return [];

    for (const segment of path) touched.add(segment);
    if (path[0] === 'sim' && path[1] === 'sockets') {
      const owner = ownerOfSocket.get(path[2]);
      if (owner !== undefined) touched.add(owner);
    }
    // **`remove` nemá `value`, a přesto umí jmenovat cizí objekt** — smazané
    // pravidlo ho jmenuje ve svém **uloženém** těle. Patch to nenese, dokument
    // ano, tak se to přečte odtamtud. (Žádná z pěti uvařených změn `remove`
    // nepoužívá; je to díra, kterou otevře první živá emise.)
    if (operation.op === 'remove')
      for (const name of namesWithin(valueAt(doc, path))) touched.add(name);
    // `from` má jen `move`/`copy`, `value` jen zápisové operace — typ je
    // rozlišuje, ale ptát se na obojí je levnější než dvě větve podle `op`.
    //
    // ⚠ **`typeof`, ne `?? ''` — nález třetího kola nezávislé revize
    // 6. 9. 2026, a byl to pád, který jsem sem přinesl sám.** `readOperations`
    // schválně soudí jen `path` a tvar operace nechává routeru, takže sem
    // `{ op: 'move', from: 7 }` doopravdy dojde; `7 ?? ''` je `7` a `.split`
    // spadne. Nad `withRequest` není žádný `catch`, takže by porotce místo
    // odmítnutí dostal holou pětistovku bez `requestId` — a to až **po**
    // zaplaceném volání modelu.
    const wide = operation as { readonly from?: unknown; readonly value?: unknown };
    if (typeof wide.from === 'string')
      for (const segment of wide.from.split('/')) touched.add(segment);
    for (const name of namesWithin(wide.value)) touched.add(name);
  }

  // **Nový tvar je taky část změny.** Jméno materiálu nebo kotvy se smí rovnat
  // `stableId` jiného objektu, a pak ho změna jmenuje, aniž se objeví
  // v jediné operaci (třetí kolo nezávislé revize). Nad dnešním skladem to
  // neubere ani jeden objekt z pěti seznamů — měřeno, ne odhadnuto.
  for (const name of namesWithin(change.shape)) touched.add(name);

  return objects.filter((object) => !touched.has(object.stableId)).map((object) => object.label);
}

/**
 * Socket → objekt, který na něm stojí. Jediná vazba téhle třídy, kterou
 * dokument doopravdy nese.
 *
 * ⚠ **`sim.entities` je ve schématu `present`, tedy `unknown`** — projde tudy
 * i `{"visitor": 7}` nebo `{"visitor": {"socket": []}}`. Čte se proto po
 * jednom typu; cizí tvar se přeskočí a socket zůstane nepřiřazený, což je
 * konzervativní směr: objekt navíc vypadne z „nedotčených", nikdy naopak.
 */
function socketOwners(doc: WorldDoc): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const entities = doc.sim.entities;
  if (entities === null || typeof entities !== 'object' || Array.isArray(entities)) return owners;

  for (const [stableId, entity] of Object.entries(entities)) {
    if (entity === null || typeof entity !== 'object') continue;
    const socket = (entity as { readonly socket?: unknown }).socket;
    // První nárok vyhrává. Dva objekty na jednom socketu je vada světa, ne
    // tohohle výpočtu, a hádat mezi nimi by znamenalo tvrdit víc, než se ví.
    if (typeof socket === 'string' && !owners.has(socket)) owners.set(socket, stableId);
  }

  return owners;
}

/**
 * Co v dokumentu stojí na téhle cestě, nebo `undefined`.
 *
 * ⚠ **Segmenty cesty jsou nedůvěryhodný vstup** — `readOperations` schválně
 * soudí jen tvar cesty, ne její obsah, takže sem dojde `/sim/rules/__proto__`
 * i cesta stotisíc segmentů dlouhá. Čte se proto jen **vlastní** klíč
 * (`Object.hasOwn`), nikdy zděděný, a smyčkou, ne rekurzí — týž důvod jako
 * u `namesWithin()` níž.
 */
function valueAt(doc: WorldDoc, path: readonly string[]): unknown {
  let current: unknown = doc;

  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      // Index pole je řetězec číslic, nic jiného; `length` ani metody sem
      // nepatří, i když je `Object.hasOwn` u pole nad `length` pravdivé.
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Každý řetězec a každý klíč uvnitř hodnoty. Jména objektů jsou obojí.
 *
 * ⚠ **Průchod je smyčkou, ne rekurzí, a je to oprava pádu — čtvrté kolo
 * nezávislé revize 6. 9. 2026.** `JSON.parse` je ve V8 iterativní a hodnotu
 * zanořenou stotisíckrát rozparsuje bez mrknutí; rekurzivní procházka nad ní
 * vyčerpá zásobník kolem pěti tisíc. `readOperations` soudí jen `path`, takže
 * `{ op: 'add', path: '/sim/entities/x/state/q', value: [[[…]]] }` sem dojde
 * celé — a pět tisíc závorek se vejde do osmitisícového stropu emise.
 * `RangeError` uvnitř `withRequest` nevrátí `Response` vůbec, takže by porotce
 * dostal holou pětistovku bez `requestId`, a to až po zaplaceném volání.
 *
 * Vlastní zásobník žádnou hloubkovou mez nepotřebuje: velikost emise shora
 * omezuje strop výstupu modelu, takže se sem nedostane hodnota, kterou by
 * nešlo projít.
 */
function namesWithin(value: unknown): readonly string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') found.push(item);
    // `push(...item)` by u dlouhého pole přeteklo seznamem argumentů, tedy táž
    // třída pádu o patro níž. Prvek po prvku.
    else if (Array.isArray(item)) for (const nested of item) pending.push(nested);
    else if (item !== null && typeof item === 'object')
      for (const [key, nested] of Object.entries(item)) {
        found.push(key);
        pending.push(nested);
      }
  }

  return found;
}
