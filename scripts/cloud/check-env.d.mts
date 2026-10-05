/** Typy ke `check-env.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare function checkEnv(vars: Readonly<Record<string, string>>): { name: string; reason: string }[];

export declare function parseEnvFile(text: string): Record<string, string>;
