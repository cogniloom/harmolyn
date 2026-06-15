import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const triples = {
  "linux:x64": "x86_64-unknown-linux-gnu",
  "linux:arm64": "aarch64-unknown-linux-gnu",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
  "win32:arm64": "aarch64-pc-windows-msvc",
};

const goTargets = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};

const triple = triples[`${process.platform}:${process.arch}`];
const goos = goTargets[process.platform];

if (!triple || !goos) {
  console.error(`Unsupported sidecar build platform: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const extension = process.platform === "win32" ? ".exe" : "";
const repoRoot = resolve("..");
const output = resolve("src-tauri", "binaries", `xorein-${triple}${extension}`);

mkdirSync(dirname(output), { recursive: true });

const defaultCgo = process.platform === "linux" ? "1" : "0";

const result = spawnSync("go", ["build", "-trimpath", "-o", output, "./cmd/aether"], {
  cwd: resolve(repoRoot, "xorein"),
  env: {
    ...process.env,
    // Linux AppImage bundling runs ldd over external binaries. A fully-static
    // Go sidecar makes linuxdeploy abort, so use the platform libc on Linux.
    CGO_ENABLED: process.env.CGO_ENABLED ?? defaultCgo,
    GOOS: goos,
    GOARCH: process.arch === "x64" ? "amd64" : process.arch,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
