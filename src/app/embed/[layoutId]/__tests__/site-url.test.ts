/**
 * Pořadí zdrojů adresy je rozhodnutí o bezpečnosti, ne o pohodlí.
 *
 * `x-forwarded-host` si pošle kdokoli. Když ho odpověď převezme do `og:image`,
 * nese sdílený náhled odkazu cizí adresu — a za sdílenou vyrovnávací pamětí ji
 * dostane každý další čtenář. Nastavená `SITE_URL` proto hlavičky nečte vůbec.
 */

import { describe, expect, it } from 'vitest';

import { siteUrlFrom } from '../site-url';

const forged = new Headers({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' });

describe('siteUrlFrom', () => {
  it('nastavená SITE_URL přebíjí podvrženou hlavičku', () => {
    expect(siteUrlFrom({ SITE_URL: 'https://worldsmith.example' }, forged)).toBe('https://worldsmith.example');
  });

  it('prázdná SITE_URL se chová jako nenastavená, ne jako prázdná adresa', () => {
    // `new URL('')` je výjimka, takže prázdný řetězec by shodil vykreslení
    // metadat — a `SITE_URL=` je přesně to, co vyrobí nasazení s prázdným polem.
    expect(siteUrlFrom({ SITE_URL: '' }, new Headers({ host: 'demo.example' }))).toBe('https://demo.example');
  });

  it('koncové lomítko se ubírá, aby adresa nenesla dvojité', () => {
    expect(siteUrlFrom({ SITE_URL: 'https://demo.example/' }, forged)).toBe('https://demo.example');
  });

  it('bez SITE_URL platí hlavička požadavku — na tom stojí vývoj i e2e', () => {
    expect(siteUrlFrom({}, new Headers({ 'x-forwarded-host': 'demo.example', 'x-forwarded-proto': 'https' }))).toBe(
      'https://demo.example',
    );
  });

  it('loopback jede po http, cizí host po https', () => {
    expect(siteUrlFrom({}, new Headers({ host: '127.0.0.1:3100' }))).toBe('http://127.0.0.1:3100');
    expect(siteUrlFrom({}, new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(siteUrlFrom({}, new Headers({ host: 'demo.example' }))).toBe('https://demo.example');
  });

  it('bez hlavičky i bez proměnné zbývá loopback, ne prázdná adresa', () => {
    expect(siteUrlFrom({}, new Headers())).toBe('http://127.0.0.1:3100');
  });
});
