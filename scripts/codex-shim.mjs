#!/usr/bin/env node
/**
 * P16 T6 – most z formátu Anthropic Messages na `codex exec`. Veřejné demo na
 * Vercelu Codex CLI nemá, astra ale jde jen přes něj a přes předplatné
 * přihlášené na tomhle počítači. Vercel sem proto volá tunelem cloudflared –
 * a tím je most **veřejně dosažitelný**, drží klíč a spouští proces na cizím
 * předplatném. Odtud každá mez níž.
 *
 * Volání codexu je totéž jako `generateViaCodexCli()` v `src/server/upstream.ts`
 * (tytéž přepínače, prompt `system + "\n\n" + user`, poslední `agent_message`),
 * s pěti rozdíly z debaty 15. 9. 2026 (`.claude/debate/codex-shim-decision.md`):
 *
 *   - model a úsilí jen z `CODEX_SHIM_MODEL` / `CODEX_SHIM_EFFORT`, pole `model`
 *     v požadavku se ignoruje;
 *   - codex běží v prázdném dočasném adresáři a s prostředím z allowlistu, ne
 *     v kořeni repozitáře s jeho interními dokumenty a klíči;
 *   - časový strop hlídá vlastní časovač a zabíjí **celý strom** (`taskkill /T`):
 *     `codex.js` spouští nativní binárku jako dítě a timeout `execFile` by
 *     zabil jen obal;
 *   - odpojený volající strom zabije taky – jinak by codex dál pálil předplatné
 *     pro odpověď, kterou už nikdo nečte;
 *   - denní strop spuštění v souboru. Počítadlo volání na Vercelu je jiná mez:
 *     tady je jediné místo, které vidí každé skutečné spuštění, a běží na
 *     jednom stroji, takže soubor je doopravdy globální.
 *
 *   CODEX_SHIM_KEY=… CODEX_SHIM_MODEL=gpt-6-astra CODEX_SHIM_EFFORT=high node scripts/codex-shim.mjs
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Co codex potřebuje ke spuštění a k přihlášení v `~/.codex` – nic víc, žádné klíče aplikace. */
const ENV_ALLOWLIST = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'CODEX_HOME'];

/** Jako `codexCommand()` v `src/server/upstream.ts`, jen bez přepisu z prostředí. */
function codexCommand() {
  return process.platform === 'win32'
    ? { file: process.execPath, prefix: [join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] }
    : { file: 'codex', prefix: [] };
}

/**
 * Nástroje, které codex v `exec` nabízí i s vypnutým shellem – naměřeno 15. 9.
 * 2026 kanárkem přes skutečný most: skriptovací hostitel (`functions.exec`
 * s `apply_patch`, `view_image`, `image_gen`) a podagenti. Soubor mimo pracovní
 * adresář nepřečetl ani jeden, ale `view_image` umí otevřít obrázek z disku
 * a generování obrázků i podagenti pálí předplatné. Přepínače platí jen
 * **za** `exec` – před ním je codex tiše ignoruje. Podagenti (`collaboration.*`)
 * zůstávají i s `multi_agent=false`; drží je jen strop času a denní strop.
 */
const TOOL_SWITCHES = ['view_image', 'image_generation', 'code_mode_host', 'multi_agent', 'browser_use', 'computer_use', 'plugins', 'goals']
  .flatMap((feature) => ['-c', `features.${feature}=false`]);

function codexArgs(model, effort, cwd) {
  return [
    'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
    '-c', `model_reasoning_effort="${effort}"`,
    '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"',
    ...TOOL_SWITCHES,
    '--cd', cwd, '--model', model, '--json', '-',
  ];
}

/** Na Windows `taskkill /T` přes PID obalu, dokud obal žije; jinde celá skupina procesů. */
function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* skupina už neexistuje */
    }
  }
}

const digest = (value) => createHash('sha256').update(value).digest();

/** Počítá **spuštění**, ne úspěchy: spálené předplatné je spálené i u selhání. */
function takeRun(file, limit, now) {
  const day = new Date(now()).toISOString().slice(0, 10);
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const runs = saved?.day === day ? saved.runs : 0;
  if (runs >= limit) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ day, runs: runs + 1 }));
  return true;
}

function promptOf(body) {
  const message = Array.isArray(body?.messages) ? body.messages.find((entry) => entry?.role === 'user') : undefined;
  const content = message?.content;
  const user = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    : '';
  if (user === '') return null;
  return typeof body.system === 'string' && body.system !== '' ? `${body.system}\n\n${user}` : user;
}

/** Týž výklad proudu událostí jako `generateViaCodexCli()`. */
function answerOf(stdout) {
  let events;
  try {
    events = stdout.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch {
    return { error: 'codex_malformed' };
  }
  if (events.some((event) => event.type === 'turn.failed' || event.type === 'error')) return { error: 'codex_rejected' };
  const completion = events.find((event) => event.type === 'turn.completed');
  const text = [...events].reverse().find((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item?.text;
  if (completion === undefined || typeof text !== 'string') return { error: 'codex_malformed' };
  const usage = completion.usage;
  return {
    text,
    usage: Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens)
      ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
      : null,
  };
}

export function createShim({
  key, model, effort, runsFile, dailyRuns = 150,
  command = codexCommand(), maxConcurrent = 2, timeoutMs = 280_000, maxBodyBytes = 1024 * 1024,
  now = Date.now, log = console.log,
}) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('CODEX_SHIM_KEY must be at least 32 characters');
  if (typeof model !== 'string' || model.trim() === '') throw new Error('CODEX_SHIM_MODEL is required');
  if (!EFFORTS.includes(effort)) throw new Error(`CODEX_SHIM_EFFORT must be one of ${EFFORTS.join(', ')}`);
  const keyDigest = digest(key);
  let running = 0;

  return createServer((req, res) => {
    const started = now();
    const send = (status, body) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 200 ? {} : { connection: 'close' }) });
      res.end(JSON.stringify(body));
      log(`${status}  ${now() - started} ms`);
    };
    // Tělo odmítnutého požadavku se dočte naprázdno, aby klient dostal odpověď
    // místo přerušeného spojení; nikam se neukládá.
    const refuse = (status, type, message) => {
      req.resume();
      send(status, { type: 'error', error: { type, message } });
    };

    if (req.method !== 'POST' || req.url !== '/v1/messages') return refuse(404, 'not_found_error', 'not_found');
    const offered = req.headers['x-api-key'];
    if (typeof offered !== 'string' || !timingSafeEqual(digest(offered), keyDigest)) return refuse(401, 'authentication_error', 'invalid_key');

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return send(413, { type: 'error', error: { type: 'request_too_large', message: 'body_over_limit' } });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'body_not_json' } });
      }
      const prompt = promptOf(body);
      if (prompt === null) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'no_user_text' } });
      // Souběh před rozpočtem: odmítnutí kvůli plnému mostu nesmí spálit denní spuštění.
      if (running >= maxConcurrent) return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'busy' } });
      if (!takeRun(runsFile, dailyRuns, now)) return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'SHIM_BUDGET_EXHAUSTED' } });
      run(prompt);
    });

    function run(prompt) {
      running += 1;
      const cwd = mkdtempSync(join(tmpdir(), 'codex-shim-'));
      const child = spawn(command.file, [...command.prefix, ...codexArgs(model, effort, cwd)], {
        cwd,
        env: Object.fromEntries(ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let outputBytes = 0;
      let cut = null;
      let done = false;
      const stop = (why) => {
        cut ??= why;
        killTree(child);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      res.on('close', () => {
        if (!res.writableFinished) stop('disconnected');
      });
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) stop('output');
        else stdout += chunk;
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);

      // `close`, ne `exit`: přijde, až pustí roury všichni v stromu – slot se
      // vrací teprve po doložitelném konci, ne po smrti obalu.
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        running -= 1;
        rmSync(cwd, { recursive: true, force: true });
        if (cut === 'disconnected') return log(`disconnected  ${now() - started} ms`);
        if (cut === 'timeout') return send(504, { type: 'error', error: { type: 'timeout_error', message: 'codex_timeout' } });
        if (cut === 'output' || code !== 0) return send(502, { type: 'error', error: { type: 'api_error', message: 'codex_failed' } });
        const answer = answerOf(stdout);
        if (answer.error !== undefined) return send(502, { type: 'error', error: { type: 'api_error', message: answer.error } });
        send(200, {
          id: `msg_shim_${randomBytes(8).toString('hex')}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: answer.text }],
          stop_reason: 'end_turn',
          ...(answer.usage === null ? {} : { usage: answer.usage }),
        });
      };
      child.on('close', finish);
      child.on('error', () => {
        if (child.pid === undefined) finish(-1);
      });
    }
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const dailyRuns = Number(env.CODEX_SHIM_DAILY_RUNS ?? 150);
  const port = Number(env.CODEX_SHIM_PORT ?? 18767);
  const server = createShim({
    key: env.CODEX_SHIM_KEY,
    model: env.CODEX_SHIM_MODEL,
    effort: env.CODEX_SHIM_EFFORT,
    dailyRuns,
    runsFile: join(tmpdir(), 'codex-shim', 'runs.json'),
  });
  server.listen(port, '127.0.0.1', () => console.log(`codex shim  http://127.0.0.1:${port}/v1/messages  ${env.CODEX_SHIM_MODEL}@${env.CODEX_SHIM_EFFORT}  ${dailyRuns} runs/day`));
}
