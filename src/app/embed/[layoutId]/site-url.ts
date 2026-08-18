/**
 * Kde artefakt běží — absolutní adresa pro `og:image`.
 *
 * Relativní `og:image` je pro sdílení k ničemu: čtečka odkazů ho nemá proti čemu
 * rozvinout. Absolutní adresa se ale nesmí brát z `NEXT_PUBLIC_SITE_URL` — Next
 * takovou proměnnou zapéká při **buildu**, a zapečetěný build z tagu
 * (`scripts/build-from-tag.mjs`) vidí jen jména z `ops/build-env.allow`.
 * Nasazený artefakt by nesl adresu, se kterou se build postavil, tedy loopback
 * z e2e, a každý sdílený odkaz by mířil na `127.0.0.1`.
 *
 * ## Pořadí je bezpečnostní vlastnost, ne pohodlí
 *
 * `SITE_URL` je **serverová** proměnná čtená za běhu, ne při buildu, takže
 * zapečetěný strom ji nekryje a nasazení ji nastavit může. Když je nastavená,
 * hlavičky požadavku se **vůbec nečtou**.
 *
 * Teprve bez ní se sáhne na hlavičku. `x-forwarded-host` si smí poslat kdokoli,
 * kdo umí poslat požadavek — a odpověď pak nese cizí adresu v `og:image`. Za
 * sdílenou vyrovnávací pamětí je to otrávený náhled odkazu pro každého dalšího
 * čtenáře. Nasazení proto `SITE_URL` nastavit **musí**; hlavička je záchrana pro
 * vývoj a e2e, kde žádná sdílená paměť ani cizí čtenář není.
 */
export function siteUrlFrom(env: Record<string, string | undefined>, incoming: Headers): string {
  const configured = env.SITE_URL;
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');

  const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? '127.0.0.1:3100';
  const local = host.startsWith('127.0.0.1') || host.startsWith('localhost');
  const proto = incoming.get('x-forwarded-proto') ?? (local ? 'http' : 'https');

  return `${proto}://${host}`;
}
