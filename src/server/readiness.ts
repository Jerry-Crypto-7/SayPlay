/**
 * Readiness — **skutečný zápis, ne ping.**
 *
 * Naivní readiness se ptá, jestli cesta existuje, a odpoví „ano" i tehdy, když
 * je svazek připojený jen pro čtení, když je disk plný nebo když kvóta došla.
 * Ve všech třech případech proces běží, port poslouchá, a **první požadavek,
 * který potřebuje něco zapsat, selže** — tedy přesně ve chvíli, kdy už na něj
 * vyvažovač poslal provoz, protože readiness řekla, že je připraveno.
 *
 * Tahle sonda proto projde celý cyklus, který produkční cesta dělá taky:
 * **zapíše, přečte zpátky, porovná, uklidí.** Každý ze čtyř kroků má vlastní
 * důvod:
 *
 * | Krok | Co odhalí, co ping neodhalí |
 * |---|---|
 * | zápis | svazek jen pro čtení, plný disk, vyčerpaná kvóta, chybějící právo |
 * | čtení zpátky | zápis, který se tvářil úspěšně a nic neuložil |
 * | porovnání | vrstva, která vrací cizí nebo zastaralý obsah |
 * | úklid | adresář, do kterého sonda zapisuje a nemaže — sama ho zaplní |
 *
 * Poslední řádek není puntičkářství. Readiness se volá každých pár vteřin po
 * celou dobu běhu, takže sonda, která po sobě neuklidí, je jediný komponent
 * s jistotou, že disk dřív nebo později zaplní.
 *
 * ## Selhání se vrací, nevyhazuje
 *
 * Volající je obslužná rutina zdravotní kontroly. Ta musí odpovědět vždycky —
 * výjimka z readiness by se vykreslila jako 500 a od 503 ji nikdo nerozliší,
 * přitom je to jiný stav: 503 znamená „běžím a nejsem připraven", 500 znamená
 * „jsem rozbitý". Sonda proto vrací verdikt a nevyhazuje nikdy.
 */

/**
 * Co zápis prokázal — **a co neprokázal.**
 *
 * Krok trvanlivosti se na některých svazcích přeskočí (viz `syncIfSupported`).
 * Zápis se povede, takže verdikt bude `ready: true`, jenže jedna ze čtyř tříd,
 * kvůli kterým tahle sonda existuje, zůstane neověřená. Verdikt to musí unést
 * dál, jinak sonda trvale hlásí záruku, kterou přestala kontrolovat.
 */
export interface WriteOutcome {
  /** `true` = zápis se vynutil na zařízení. `false` = svazek `fsync` neumí. */
  readonly durabilityVerified: boolean;
}

/** Souborové operace, které sonda potřebuje. Parametr, aby šlo testovat selhání. */
export interface ReadinessFs {
  write(path: string, bytes: string): Promise<WriteOutcome>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export type ReadinessFailure =
  /** Zápis neprošel — svazek jen pro čtení, plný disk, chybějící právo. */
  | 'WRITE_FAILED'
  /** Zapsané se nedá přečíst zpátky. */
  | 'READ_FAILED'
  /** Přečetlo se něco jiného, než co se zapsalo. */
  | 'READBACK_MISMATCH'
  /** Zápis i čtení prošly, ale sonda po sobě neumí uklidit. */
  | 'CLEANUP_FAILED';

export interface Ready {
  readonly ready: true;
  readonly probePath: string;
  readonly elapsedMs: number;
  /**
   * Jestli sonda ověřila i trvanlivost, nebo jen zápis do cache stránek.
   *
   * **`false` není chyba a nesmí vyřadit instanci** — svazek, který `fsync`
   * neumí, je zdravý, jen jiného druhu. Je to ale slabší kontrola než plná, a
   * z verdiktu se to musí dát poznat: bez tohohle pole hlásí sonda tutéž větu
   * o zdraví v obou případech, a rozdíl mezi „ověřeno" a „neověřeno" zmizí.
   */
  readonly durabilityVerified: boolean;
}

export interface NotReady {
  readonly ready: false;
  readonly probePath: string;
  readonly elapsedMs: number;
  readonly reason: ReadinessFailure;
  /** Co k tomu řekl souborový systém. Jde do logu, ne do odpovědi. */
  readonly detail: string;
}

export type Readiness = Ready | NotReady;

export interface ReadinessDeps {
  readonly fs: ReadinessFs;
  /** Nástěnné hodiny. Readiness není na replay cestě, měřit dobu tu smí. */
  readonly now: () => number;
  /**
   * Odlišení souběžných sond. Dvě sondy nad týmž adresářem si jinak přepíšou
   * soubor a jedna z nich přečte cizí obsah — tedy `READBACK_MISMATCH` na
   * zdravém disku, což je horší než žádná kontrola.
   */
  readonly nonce: () => string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Projde cyklus zápis → čtení → porovnání → úklid nad `directory`.
 *
 * Uklízí i po neúspěšném porovnání: soubor v tu chvíli existuje a nechat ho
 * tam by znamenalo, že rozbitý svazek se zaplní rychleji než zdravý.
 */
export async function checkReadiness(directory: string, deps: ReadinessDeps): Promise<Readiness> {
  const started = deps.now();
  const token = deps.nonce();
  const probePath = `${directory}/readiness-${token}.probe`;
  const payload = `worldsmith readiness ${token}`;
  const elapsed = (): number => deps.now() - started;

  let written: WriteOutcome;
  try {
    written = await deps.fs.write(probePath, payload);
  } catch (error) {
    // Uklízí se i tady, a není to opatrnost navíc. `ENOSPC` i vyčerpaná kvóta
    // položku **nejdřív založí** a teprve pak selžou, takže bez tohohle by sonda
    // na plném disku nechávala soubor při každém volání — tedy přesně ten
    // scénář, kvůli kterému je úklid součástí cyklu.
    await deps.fs.remove(probePath).catch(() => undefined);
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'WRITE_FAILED', detail: message(error) };
  }

  let readBack: string;
  try {
    readBack = await deps.fs.read(probePath);
  } catch (error) {
    await deps.fs.remove(probePath).catch(() => undefined);
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'READ_FAILED', detail: message(error) };
  }

  const matched = readBack === payload;

  try {
    await deps.fs.remove(probePath);
  } catch (error) {
    return { ready: false, probePath, elapsedMs: elapsed(), reason: 'CLEANUP_FAILED', detail: message(error) };
  }

  if (!matched) {
    return {
      ready: false,
      probePath,
      elapsedMs: elapsed(),
      reason: 'READBACK_MISMATCH',
      detail: `zapsáno ${payload.length} B, přečteno ${readBack.length} B`,
    };
  }

  return { ready: true, probePath, elapsedMs: elapsed(), durabilityVerified: written.durabilityVerified };
}

/**
 * Sonda nad skutečným souborovým systémem.
 *
 * Bez tohohle adaptéru je `checkReadiness` splněná jen tvarem: jediná
 * implementace `ReadinessFs` by byla `Map` v testu, takže tvrzení „provede
 * skutečný zápis" by nikdy žádný zápis neprovedlo. Testy proti němu sahají na
 * opravdový dočasný adresář.
 */
export function nodeReadinessFs(): ReadinessFs {
  return {
    /**
     * Zápis se **vynutí na zařízení**, ne jen do cache stránek.
     *
     * `writeFile` následované `readFile` přečte to, co drží jádro v paměti, a
     * to se povede i tehdy, když se na disk nedostalo nic. Třída „zápis se
     * tvářil úspěšně a nic neuložil" — tedy jedna ze čtyř, kvůli kterým tahle
     * sonda existuje — byla proti skutečnému souborovému systému nezjistitelná
     * a ověřovala se jen proti `Map` v testu. `sync()` je to, co ji vrátí do
     * hry: plný disk a vyčerpaná kvóta se na řadě souborových systémů ohlásí
     * teprve tady.
     */
    async write(path, bytes) {
      const { open } = await import('node:fs/promises');
      const handle = await open(path, 'w');
      try {
        await handle.write(bytes, 0, 'utf-8');
        return { durabilityVerified: await syncIfSupported(handle) };
      } finally {
        await handle.close();
      }
    },
    async read(path) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf-8');
    },
    async remove(path) {
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
    },
  };
}

/**
 * Souborové systémy, které `fsync` neimplementují, ho odmítnou těmihle kódy.
 * Není to zpráva o zdraví svazku, je to zpráva o jeho druhu.
 */
const SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Vynutí zápis na zařízení — **a rozliší „nepodporuji" od „nepovedlo se".**
 *
 * Bez tohohle rozlišení je `sync()` nebezpečnější než jeho absence: sdílené
 * svazky pod kontejnerem a některé síťové disky `fsync` neimplementují a vrátí
 * `EINVAL`, takže by sonda hlásila `WRITE_FAILED` na dokonale zapisovatelném
 * svazku — tedy trvalou 503 a vyřazení instance z vyvažovače kvůli druhu disku.
 *
 * `EIO` a `ENOSPC` se naopak propouštějí dál schválně: to je přesně ta třída
 * „zápis se tvářil úspěšně a nic neuložil", kvůli které tu `sync()` je.
 *
 * **Vrací, jestli se to povedlo, a to je ta druhá půlka rozlišení.** Spolknout
 * `EINVAL` a mlčet znamená, že přeskočený krok vypadá zvenčí stejně jako
 * provedený — sonda pak hlásí záruku, kterou přestala kontrolovat. `false`
 * jde až do verdiktu, viz `Ready.durabilityVerified`.
 */
export async function syncIfSupported(handle: { sync: () => Promise<void> }): Promise<boolean> {
  try {
    await handle.sync();
    return true;
  } catch (error) {
    // `error` nemusí být objekt — export téhle funkce ji otevřel i handlerům,
    // které nejsou `fs`, a `Promise.reject(null)` by na čtení `.code` shodil
    // `TypeError` PŘES původní chybu. Neznámý tvar se propouští dál: neznámé se
    // nepovažuje za neškodné.
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    // `typeof code !== 'string'` je zúžení typu, ne druhá kontrola: `Set<string>`
    // by neznámý tvar stejně nenašel. Rozhoduje řádek nad ním.
    if (typeof code !== 'string' || !SYNC_UNSUPPORTED.has(code)) throw error;
    return false;
  }
}

/** Odlišení sond v tomhle procesu. Roste, nikdy se neopakuje. */
let probesIssued = 0;

/**
 * Kompletní závislosti sondy nad skutečným souborovým systémem — **včetně
 * nonce, který je pokaždé jiný.**
 *
 * `ReadinessDeps` si o jedinečný nonce říká v dokumentaci, ale `nodeReadinessFs()`
 * k němu žádnou továrnu nedodával, takže každý příklad v repu použil konstantu.
 * Naměřeno proti skutečnému disku: dvě souběžné sondy se sdíleným nonce míří na
 * tentýž soubor, jedna ho smaže první a druhá skončí na `CLEANUP_FAILED
 * (ENOENT unlink)`. Sonda volaná vyvažovačem každých pár vteřin by tak na
 * zdravém železe blikala 503.
 *
 * `pid` odlišuje procesy, čítač sondy uvnitř jednoho.
 */
export function nodeReadinessDeps(): ReadinessDeps {
  return {
    fs: nodeReadinessFs(),
    now: () => Date.now(),
    nonce: () => `${process.pid}-${(probesIssued += 1)}`,
  };
}
