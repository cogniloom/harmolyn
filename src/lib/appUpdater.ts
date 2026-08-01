import { isTauri } from '@tauri-apps/api/core';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export const AUTO_UPDATE_KEY = 'harmolyn:updates:auto';

export type AppUpdateResult =
  | { status: 'web' }
  | { status: 'current' }
  | { status: 'available'; version: string; notes?: string }
  | { status: 'ready'; version: string };

let updateOperation: Promise<AppUpdateResult> | null = null;
let downloadedUpdate: Update | null = null;

export function autoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, enabled ? 'true' : 'false');
  } catch {
    // An unavailable preference store must not disable security updates.
  }
}

export function pendingUpdateRestartVersion(): string | null {
  const version = downloadedUpdate?.version?.trim() ?? '';
  return version && version.length <= 64 ? version : null;
}

export async function checkForAppUpdate(): Promise<AppUpdateResult> {
  if (!isTauri()) return { status: 'web' };
  const pendingVersion = pendingUpdateRestartVersion();
  if (pendingVersion) return { status: 'ready', version: pendingVersion };
  const update = await check({ timeout: 15_000, allowDowngrades: false });
  if (!update) return { status: 'current' };
  const result: AppUpdateResult = {
    status: 'available',
    version: update.version,
    ...(update.body ? { notes: update.body } : {}),
  };
  await update.close();
  return result;
}

export async function downloadAppUpdate(
  onProgress?: (event: DownloadEvent) => void,
): Promise<AppUpdateResult> {
  if (updateOperation) return updateOperation;
  updateOperation = (async () => {
    if (!isTauri()) return { status: 'web' } as const;
    const pendingVersion = pendingUpdateRestartVersion();
    if (pendingVersion) return { status: 'ready', version: pendingVersion } as const;
    const update = await check({ timeout: 15_000, allowDowngrades: false });
    if (!update) return { status: 'current' } as const;
    const version = update.version;
    try {
      await update.download(onProgress, { timeout: 120_000 });
      // Keep the verified updater resource alive in this process. Installation
      // is deliberately deferred: on Windows Tauri's installer exits the app,
      // and an unconditional install could interrupt a call or lose a composer
      // draft. The user chooses the safe point in Settings -> About.
      downloadedUpdate = update;
      return { status: 'ready', version } as const;
    } catch (error) {
      await update.close().catch(() => undefined);
      throw error;
    }
  })().finally(() => {
    updateOperation = null;
  });
  return updateOperation;
}

export async function restartAfterAppUpdate(): Promise<void> {
  if (!isTauri()) return;
  const update = downloadedUpdate;
  if (!update) throw new Error('No downloaded update is ready to install.');
  try {
    // The updater replaces application files only. Harmolyn/Xorein identity,
    // settings, and state remain in platform data directories. Windows may exit
    // from install(); other platforms return and are relaunched here.
    await update.install();
    downloadedUpdate = null;
    await update.close().catch(() => undefined);
    await relaunch();
  } catch (error) {
    if (downloadedUpdate !== null) downloadedUpdate = update;
    throw error;
  }
}

/** Default-on signed native update download. Installation is an explicit safe
 * restart because platform installers may terminate the running process. */
export async function runAutomaticUpdate(): Promise<AppUpdateResult | null> {
  if (!autoUpdateEnabled() || !isTauri() || pendingUpdateRestartVersion()) return null;
  try {
    return await downloadAppUpdate();
  } catch {
    return null;
  }
}
