import { spawn } from "node:child_process";
import process from "node:process";

const env = { ...process.env };

const sidecarBuild = spawn("node", ["./scripts/build-xorein-sidecar.mjs"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const sidecarExitCode = await new Promise((resolve) => {
  sidecarBuild.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    resolve(code ?? 1);
  });
});

if (sidecarExitCode !== 0) {
  process.exit(sidecarExitCode);
}

const child = spawn("npm", ["exec", "--", "tauri", "dev", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
