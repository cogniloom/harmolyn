import { spawn } from "node:child_process";
import process from "node:process";

const env = { ...process.env };

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
