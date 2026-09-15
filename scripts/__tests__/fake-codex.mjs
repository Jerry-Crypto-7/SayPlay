// Falešný `codex exec` pro `codex-shim.test.ts`: node fake-codex.mjs <režim> <log> ...argumenty codexu
// Každé spuštění zapíše do logu jeden řádek – argumenty, pracovní adresář,
// jména proměnných prostředí a vstup –, takže test počítá spuštění a vidí, s čím.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';

const [mode, log, ...args] = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const record = { pid: process.pid, args, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()).length, envKeys: Object.keys(process.env), stdin };
  if (mode === 'hang') {
    // Vnuk stojí za nativní binárkou, kterou skutečný `codex.js` spouští jako dítě.
    // Na Windows `detached`: jinak ho libuv strčí do job objectu obalu a umře
    // s obalem sám – test by pak nepoznal, jestli most zabíjí celý strom, nebo
    // jen obal (mutace „jen `child.kill()`" jednou přežila, jednou ne).
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
    appendFileSync(log, `${JSON.stringify({ ...record, grandchild: grandchild.pid })}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  appendFileSync(log, `${JSON.stringify(record)}\n`);
  if (mode === 'ok') {
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 30 } })}\n`);
  } else if (mode === 'rejected') {
    process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } })}\n`);
  } else {
    process.stderr.write('boom\n');
    process.exitCode = 1;
  }
});
