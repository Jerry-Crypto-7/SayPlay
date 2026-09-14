#!/usr/bin/env node
/**
 * **Zapojení `.githooks` – a tiché přeskočení tam, kde žádný git není.**
 *
 * `npm install` pouští `prepare`, a ten do 14. 9. 2026 volal `git config
 * core.hooksPath .githooks` přímo z `package.json`. Na vývojářském stroji to
 * projde; **ve stavěcím kontejneru Vercelu ne** – zdroják se tam rozbalí bez
 * `.git`, git vrátí 128 („not in a git directory“) a npm na tom celý build
 * položí. Naměřeno prvním nasazením 14. 9. 2026, `dpl_pyrk3x82e`:
 * `npm error command sh -c git config core.hooksPath .githooks` →
 * `Command "npm install" exited with 128`, build spadl po 43 s.
 *
 * **Proč skript a ne `|| exit 0` v `package.json`.** To by spolklo i skutečné
 * selhání na stroji, kde git je – a tichá věta „hooky se nenainstalovaly“ je
 * přesně ta, kvůli které pak projde commit kolem `guard-rails.mjs`. Tady se
 * rozlišuje: **není repozitář** je v pořádku a končí nulou, **je repozitář a
 * `git config` selhal** je chyba a končí nenulově.
 */
import { spawnSync } from 'node:child_process';

const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore', shell: false });

if (inRepo.error !== undefined || inRepo.status !== 0) {
  // Žádný git, nebo git vůbec není nainstalovaný: stavěcí kontejner, rozbalený
  // tarball, kontejner CI. Hooky nemají co hlídat, protože se odsud necommituje.
  console.log('install-git-hooks: mimo git repozitář, hooky se nezapojují');
  process.exit(0);
}

const applied = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
  shell: false,
});

if (applied.status !== 0) {
  console.error('install-git-hooks: `git config core.hooksPath .githooks` selhal v repozitáři, kde git je');
  process.exit(applied.status === null ? 1 : applied.status);
}
