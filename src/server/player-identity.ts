/**
 * Anonymní identita zařízení pro žebříček (P44B T2). Náhodné 128bitové id
 * podepsané HMAC-SHA256 v cookie `sp_player=<id>.<podpis>` – žádný účet, žádné
 * heslo; smazáním cookie identita zmizí. Rozhodnutí a nesouhlasy: debata
 * `.claude/debate/2026-10-07-p44b-device-identity.md`.
 *
 * Tajemství: `PLAY_IDENTITY_SECRET` (≥ 32 znaků). Bez něj mimo Vercel soubor
 * `identity-secret` vedle souborového úložiště her (přežije restart jako hry),
 * bez zapisovatelného adresáře náhodné tajemství procesu (pomíjivé jako paměťové
 * úložiště). **Na Vercelu bez tajemství je identita vypnutá** – tajemství
 * náhodné na instanci by se mezi instancemi lišilo a cookie by „blikaly“.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writableDir } from '@/play/version/file-store';
import { fileStoreDirFromEnv } from '@/play/version/store';
import { sharedStoreFromEnv } from '@/server/spend-store';

export const PLAYER_COOKIE = 'sp_player';
export const MIN_SECRET_CHARS = 32;
/** Delší hodnota cookie se ani nerozebírá. Platná má 22 + 1 + 43 znaků. */
export const MAX_COOKIE_VALUE_CHARS = 200;
/** 400 dní – strop, který prohlížeče cookie dovolí. */
export const PLAYER_COOKIE_MAX_AGE_SECONDS = 34_560_000;

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SECRET_FILE = 'identity-secret';

/** Tajemství ze souboru po adresářích a tajemství procesu – na `globalThis` jako okna stropu (`rate-limit.ts`): Next umí víc grafů modulů. */
const HOLDER_KEY = '__sayplayIdentitySecrets';
function secrets(): Map<string, string> {
  const holder = globalThis as Record<string, unknown>;
  holder[HOLDER_KEY] ??= new Map<string, string>();
  return holder[HOLDER_KEY] as Map<string, string>;
}

const freshSecret = (): string => randomBytes(32).toString('base64url');

/**
 * Tajemství ze souboru; `null` = soubor je, ale krátký. Krátký se nepřepisuje: může to být
 * soubor, který jiný proces právě založil a ještě nedopsal (nález revize T2-1) – přepis by
 * dal dvěma procesům dvě tajemství a cookie by mezi nimi „blikaly“.
 */
function fileSecret(dir: string): string | null {
  const path = join(dir, SECRET_FILE);
  const known = secrets().get(path);
  if (known !== undefined) return known;
  let secret = freshSecret();
  try {
    // `wx`: dva procesy nad týmž adresářem si tajemství nepřepíšou; druhý přečte prvního.
    // Práva 0600 platí jen mimo Windows – tam soubor dědí práva adresáře úložiště.
    writeFileSync(path, secret, { mode: 0o600, flag: 'wx' });
  } catch {
    // Soubor už je (restart, jiný proces).
    secret = readFileSync(path, 'utf8').trim();
    if (secret.length < MIN_SECRET_CHARS) return null;
  }
  secrets().set(path, secret);
  return secret;
}

/** `null` = identita vypnutá. Prázdná proměnná je jako chybějící (`.env.example` ji tak nese). */
export function identitySecret(env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.PLAY_IDENTITY_SECRET;
  if (configured !== undefined && configured !== '') {
    if (configured.length >= MIN_SECRET_CHARS) return configured;
    console.warn(`[play] PLAY_IDENTITY_SECRET is shorter than ${MIN_SECRET_CHARS} characters: player identity is off`);
    return null;
  }
  // Se sdíleným úložištěm běží instancí víc i mimo Vercel; tajemství každé z nich by se lišilo (nález revize T2-1).
  if (env.VERCEL !== undefined || sharedStoreFromEnv(env) !== null) return null;
  const dir = fileStoreDirFromEnv(env);
  if (dir !== null && writableDir(dir)) {
    try {
      const secret = fileSecret(dir);
      if (secret !== null) return secret;
    } catch {
      // Nečitelný soubor: jako bez adresáře.
    }
  }
  const memo = secrets();
  if (!memo.has('')) memo.set('', freshSecret());
  return memo.get('') as string;
}

const signatureOf = (secret: string, id: string): string => createHmac('sha256', secret).update(`sp1:${id}`).digest('base64url');

/** Nová identita: id a hodnota cookie. */
export function issuePlayer(secret: string): { readonly id: string; readonly value: string } {
  const id = randomBytes(16).toString('base64url');
  return { id, value: `${id}.${signatureOf(secret, id)}` };
}

/** Hodnoty cookie `sp_player` z hlavičky `cookie`, v pořadí. */
function cookieValues(request: Request): string[] {
  const header = request.headers.get('cookie');
  if (header === null) return [];
  return header.split(';').flatMap((pair) => {
    const eq = pair.indexOf('=');
    return eq !== -1 && pair.slice(0, eq).trim() === PLAYER_COOKIE ? [pair.slice(eq + 1).trim()] : [];
  });
}

/** Id hráče z platně podepsané cookie, jinak `null` – i při dvou cookie, kdy nejde říct, která platí. */
export function playerOf(request: Request, env: Record<string, string | undefined> = process.env): string | null {
  const values = cookieValues(request);
  if (values.length !== 1) return null;
  const value = values[0] as string;
  if (value.length > MAX_COOKIE_VALUE_CHARS) return null;
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const id = value.slice(0, dot);
  if (!ID_PATTERN.test(id)) return null;
  const secret = identitySecret(env);
  if (secret === null) return null;
  const supplied = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(signatureOf(secret, id));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? id : null;
}

/**
 * Hodnota hlavičky `set-cookie`; `Secure` jen na https – na `http://` v místní síti by ji prohlížeč zahodil.
 * Https končící v proxy před `next start` (tunel) pozná `x-forwarded-proto` (nález revize T2-1); podvržená
 * hlavička uškodí jen tomu, kdo ji poslal – jeho cookie pak po http nepůjde.
 */
export function playerCookie(value: string, request: Request): string {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const secure = new URL(request.url).protocol === 'https:' || forwarded === 'https' ? '; Secure' : '';
  return `${PLAYER_COOKIE}=${value}; Path=/; Max-Age=${PLAYER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}
