/**
 * Vlastní panorama pro prostředí, které knihovna nezná (P29C T7).
 *
 * Služba `ops/env/server.py` generuje panorama na lokální kartě za klíčem
 * `X-Env-Key`. Klíč zůstává tady na serveru: prohlížeč se ptá na stav i na
 * soubory přes `GET /api/play/games/:id/env` a ta se ptá služby.
 *
 * **Bez vlastního stavu.** Služba drží jednu úlohu na prostředí
 * (`POST /panorama` s týmž prostředím vrátí tutéž úlohu, hotové bere z cache
 * na disku), takže route jen zopakuje `POST` a přečte úlohu – na serverless
 * není co ztratit mezi instancemi.
 *
 * Bez služby, po chybě nebo po vypršení času zůstává knihovní panorama:
 * nic odsud hru nezdrží ani nerozbije.
 */

import { after } from 'next/server';

import { settingInLibrary } from '@/play/arcade/look/env';

/** Kolik smí trvat jeden dotaz na službu; déle = služba není. */
const SERVICE_TIMEOUT_MS = 3_000;

interface Service {
  readonly endpoint: string;
  readonly key: string;
}

function serviceFromEnv(env: NodeJS.ProcessEnv = process.env): Service | null {
  const endpoint = env.PLAY_ENV_ENDPOINT?.trim().replace(/\/+$/, '');
  const key = env.PLAY_ENV_KEY?.trim();
  return endpoint && key ? { endpoint, key } : null;
}

/**
 * Prostředí ve tvaru, který služba přijme (`^[a-z0-9][a-z0-9 ,'-]{0,79}$`):
 * malá písmena, ostatní znaky jako mezera, nejvýš 80 znaků. `null` = nic nezbylo.
 */
export function serviceSetting(setting: string): string | null {
  const text = setting
    .toLowerCase()
    .replace(/[^a-z0-9 ,'-]+/g, ' ')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return text === '' ? null : text;
}

/** Potřebuje hra vlastní panorama? Jen když knihovna prostředí nezná a zbyde co poslat. */
export function needsCustomEnv(setting: string): boolean {
  return !settingInLibrary(setting) && serviceSetting(setting) !== null;
}

async function call(service: Service, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${service.endpoint}${path}`, {
    ...init,
    headers: { ...init.headers, 'x-env-key': service.key },
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    cache: 'no-store',
  });
}

async function submit(service: Service, setting: string): Promise<string | null> {
  const response = await call(service, '/panorama', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setting }) });
  if (!response.ok) return null;
  const body = (await response.json()) as { jobId?: unknown };
  return typeof body.jobId === 'string' && /^[a-f0-9]{1,64}$/.test(body.jobId) ? body.jobId : null;
}

interface JobView {
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly id?: string;
  readonly file?: string;
  readonly low?: string;
  readonly horizon?: string;
}

const FILE_NAME = /^[a-z0-9-]+\.webp$/;
const HORIZON = /^#[0-9a-f]{6}$/i;

async function job(service: Service, setting: string): Promise<JobView | null> {
  const id = await submit(service, setting);
  if (id === null) return null;
  const response = await call(service, `/jobs/${id}`);
  if (!response.ok) return null;
  const view = (await response.json()) as JobView;
  if (view.status !== 'done') return { status: view.status };
  // Hotová úloha bez platných jmen souborů je porucha služby, ne panorama.
  if (typeof view.file !== 'string' || !FILE_NAME.test(view.file) || typeof view.low !== 'string' || !FILE_NAME.test(view.low)) return { status: 'failed' };
  return { status: 'done', id: view.id, file: view.file, low: view.low, horizon: typeof view.horizon === 'string' && HORIZON.test(view.horizon) ? view.horizon : undefined };
}

/**
 * Po publikaci hry: založ úlohu, ať panorama vzniká, zatímco hráč hraje.
 * Neblokuje – `after()` jako u upgradu, bez něj (test volá handler přímo)
 * doběhne sama. Chyba služby se jen zapíše.
 */
export function startCustomEnv(setting: string): void {
  const service = serviceFromEnv();
  const text = serviceSetting(setting);
  if (service === null || text === null || settingInLibrary(setting)) return;
  const work = submit(service, text).then(
    () => undefined,
    (error: unknown) => console.warn(`[play] env service refused "${text}": ${String(error)}`),
  );
  try {
    after(work);
  } catch {
    void work;
  }
}

export type CustomEnvState =
  | { readonly status: 'library' | 'unavailable' | 'pending' | 'failed' }
  | { readonly status: 'ready'; readonly id: string; readonly horizon: string | null };

/** Stav vlastního panoramatu pro prostředí hry. Chyba i ticho služby = `unavailable`. */
export async function customEnvState(setting: string): Promise<CustomEnvState> {
  const text = serviceSetting(setting);
  if (settingInLibrary(setting) || text === null) return { status: 'library' };
  const service = serviceFromEnv();
  if (service === null) return { status: 'unavailable' };
  try {
    const view = await job(service, text);
    if (view === null) return { status: 'unavailable' };
    if (view.status === 'failed') return { status: 'failed' };
    if (view.status !== 'done') return { status: 'pending' };
    return { status: 'ready', id: `custom-${view.id ?? text.replace(/[^a-z0-9]+/g, '-')}`, horizon: view.horizon ?? null };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Soubor hotového panoramatu (`full` 2048×1024, `low` náhled) ze služby, nebo `null`. */
export async function customEnvFile(setting: string, size: 'full' | 'low'): Promise<Response | null> {
  const text = serviceSetting(setting);
  const service = serviceFromEnv();
  if (service === null || text === null || settingInLibrary(setting)) return null;
  try {
    const view = await job(service, text);
    const name = size === 'full' ? view?.file : view?.low;
    if (view?.status !== 'done' || name === undefined) return null;
    const file = await call(service, `/files/${name}`);
    if (!file.ok || file.body === null) return null;
    return new Response(file.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' } });
  } catch {
    return null;
  }
}
