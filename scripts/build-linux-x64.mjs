import { spawn } from "node:child_process";
import process from "node:process";

if (process.platform !== "linux" || process.arch !== "x64") {
  console.error("build:linux:x64 must be run on a Linux x64 machine.");
  process.exit(1);
}

const child = spawn(process.execPath, [
  "./scripts/tauri-build.mjs",
  "--target",
  "x86_64-unknown-linux-gnu",
  "--bundles",
  "deb,appimage",
], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
