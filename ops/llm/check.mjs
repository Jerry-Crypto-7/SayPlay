// Checks that llama.cpp binaries and the chosen GGUF models are installed.
// Usage: node ops/llm/check.mjs   (env LLAMA_CPP_DIR, GGUF_DIR override the defaults)
import { existsSync } from "node:fs";
import { join } from "node:path";

const llamaDir = process.env.LLAMA_CPP_DIR ?? "D:/tools/llama.cpp";
const ggufDir = process.env.GGUF_DIR ?? "D:/caches/gguf";
const exe = process.platform === "win32" ? ".exe" : "";

const items = [
  ["llama-server", join(llamaDir, `llama-server${exe}`)],
  ["llama-bench", join(llamaDir, `llama-bench${exe}`)],
  ["reader", join(ggufDir, "Qwen3-4B-Instruct-2507-Q5_K_M.gguf")],
  ["fallback gpt-oss-20b", join(ggufDir, "gpt-oss-20b-MXFP4.gguf")],
  ["fallback qwen3.6-35b-a3b", join(ggufDir, "Qwen3.6-35B-A3B-UD-IQ3_S.gguf")],
];

let missing = 0;
for (const [name, path] of items) {
  const ok = existsSync(path);
  if (!ok) missing++;
  console.log(`${ok ? "ok     " : "MISSING"} ${name.padEnd(26)} ${path}`);
}
if (missing) {
  console.error(`${missing} missing – run: powershell -ExecutionPolicy Bypass -File ops/llm/install.ps1`);
  process.exit(1);
}
