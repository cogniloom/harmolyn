import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const env = { ...process.env };

// linuxdeploy's bundled strip may not understand modern RELR ELF sections on
// rolling Linux distros. Disabling that extra strip step keeps AppImage builds
// reproducible while Rust still strips the app binary via Cargo profile config.
if (process.platform === "linux" && !env.NO_STRIP) {
  env.NO_STRIP = "1";
}

const tauriArgs = process.argv.slice(2);

if (process.platform === "linux" && buildMayNeedAppImage(tauriArgs)) {
  patchLinuxDeployGtkPlugin();
}

const firstBuild = await runTauriBuild(tauriArgs);
if (firstBuild.signal) {
  process.kill(process.pid, firstBuild.signal);
} else if (firstBuild.code === 0) {
  process.exit(0);
} else if (process.platform === "linux" && buildMayNeedAppImage(tauriArgs) && finalizeAppImageFallback()) {
  process.exit(0);
} else {
  process.exit(firstBuild.code ?? 1);
}

function runTauriBuild(args) {
  const child = spawn("npm", ["exec", "--", "tauri", "build", ...args], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

function buildMayNeedAppImage(args) {
  const bundleIndex = args.findIndex((arg) => arg === "--bundles" || arg === "-b" || arg.startsWith("--bundles="));
  if (bundleIndex === -1) {
    return true;
  }
  const bundles = args[bundleIndex]?.startsWith("--bundles=")
    ? args[bundleIndex].slice("--bundles=".length)
    : args[bundleIndex + 1] ?? "";
  return bundles.split(",").map((bundle) => bundle.trim().toLowerCase()).includes("appimage");
}

function patchLinuxDeployGtkPlugin() {
  const pluginPath = join(homedir(), ".cache", "tauri", "linuxdeploy-plugin-gtk.sh");
  if (!existsSync(pluginPath)) {
    return false;
  }

  const original = readFileSync(pluginPath, "utf8");
  const targetDir = "/tmp/harmolyn-tauri-linuxdeploy";
  const targetPath = join(targetDir, "linuxdeploy-plugin-gtk.sh");
  const existingPath = env.PATH ?? process.env.PATH ?? "";
  env.PATH = existingPath.startsWith(`${targetDir}:`) ? existingPath : `${targetDir}:${existingPath}`;

  const bulkDeploy = 'env LINUXDEPLOY_PLUGIN_MODE=1 "$LINUXDEPLOY" --appdir="$APPDIR" "${LIBRARIES[@]}"';
  if (!original.includes(bulkDeploy) && !original.includes("Harmolyn workaround: deploy libraries one at a time")) {
    return false;
  }

  const patchedBase = original.includes("Harmolyn workaround: skip redundant bulk library pass")
    ? original
    : original.replace(bulkDeploy, `# Harmolyn workaround: skip redundant bulk library pass.
# Tauri invokes linuxdeploy before this GTK plugin runs, so the app, WebKit, GTK,
# and application dependency graph is already deployed. On some rolling Linux
# systems the plugin's second all-at-once library pass aborts with exit 127.
# Keep the GTK schemas/modules/hooks work below, but avoid the duplicate pass.
true`);
  const patched = patchedBase.replaceAll("ln $verbose -s ", "ln $verbose -sf ");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, patched, { mode: 0o755 });
  return true;
}

function finalizeAppImageFallback() {
  if (!patchLinuxDeployGtkPlugin()) {
    return false;
  }

  const appDir = join(process.cwd(), "src-tauri", "target", "release", "bundle", "appimage", "Harmolyn.AppDir");
  if (!existsSync(appDir)) {
    return false;
  }

  const extracted = extractLinuxDeploy();
  if (!extracted) {
    return false;
  }

  const plugin = "/tmp/harmolyn-tauri-linuxdeploy/linuxdeploy-plugin-gtk.sh";
  const pluginResult = spawnSync(plugin, ["--appdir", appDir], {
    env: {
      ...env,
      LINUXDEPLOY: join(extracted, "AppRun"),
    },
    stdio: "inherit",
  });
  if (pluginResult.status !== 0) {
    return false;
  }

  const appImageTool = join(extracted, "plugins", "linuxdeploy-plugin-appimage", "appimagetool-prefix", "usr", "bin", "appimagetool");
  const appImageToolLib = join(extracted, "plugins", "linuxdeploy-plugin-appimage", "appimagetool-prefix", "usr", "lib");
  const output = join(process.cwd(), "src-tauri", "target", "release", "bundle", "appimage", "Harmolyn_0.1.0_amd64.AppImage");
  const appImageResult = spawnSync(appImageTool, [appDir, output], {
    env: {
      ...env,
      ARCH: process.arch === "x64" ? "x86_64" : process.arch,
      LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ? `${appImageToolLib}:${env.LD_LIBRARY_PATH}` : appImageToolLib,
    },
    stdio: "inherit",
  });
  return appImageResult.status === 0 && existsSync(output);
}

function extractLinuxDeploy() {
  const targetDir = "/tmp/harmolyn-linuxdeploy-extracted";
  const extracted = join(targetDir, "squashfs-root");
  const appRun = join(extracted, "AppRun");
  if (existsSync(appRun)) {
    return extracted;
  }

  mkdirSync(targetDir, { recursive: true });
  const linuxDeploy = join(homedir(), ".cache", "tauri", "linuxdeploy-x86_64.AppImage");
  if (!existsSync(linuxDeploy)) {
    return null;
  }
  const result = spawnSync(linuxDeploy, ["--appimage-extract"], {
    cwd: targetDir,
    env,
    stdio: "ignore",
  });
  return result.status === 0 && existsSync(appRun) ? extracted : null;
}
