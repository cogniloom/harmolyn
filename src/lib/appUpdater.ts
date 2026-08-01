import { isTauri } from '@tauri-apps/api/core';
import { check, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export const AUTO_UPDATE_KEY = 'harmolyn:updates:auto';

export type AppUpdateResult =
  | { status: 'web' }
  | { status: 'current' }
  | { status: 'available'; version: string; notes?: string }
  | { status: 'installed'; version: string };

let updateOperation: Promise<AppUpdateResult> | null = null;

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

export async function checkForAppUpdate(): Promise<AppUpdateResult> {
  if (!isTauri()) return { status: 'web' };
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

export async function installAppUpdate(
  onProgress?: (event: DownloadEvent) => void,
): Promise<AppUpdateResult> {
  if (updateOperation) return updateOperation;
  updateOperation = (async () => {
    if (!isTauri()) return { status: 'web' } as const;
    const update = await check({ timeout: 15_000, allowDowngrades: false });
    if (!update) return { status: 'current' } as const;
    const version = update.version;
    try {
      await update.downloadAndInstall(onProgress, { timeout: 120_000 });
    } finally {
      await update.close().catch(() => undefined);
    }
    // The installer replaces application files only. Harmolyn/Xorein identity,
    // settings, and state remain in their platform data directories.
    await relaunch();
    return { status: 'installed', version } as const;
  })().finally(() => {
    updateOperation = null;
  });
  return updateOperation;
}

/** Default-on native auto-update. Errors are intentionally non-fatal: manual
 * checking remains available in Settings -> About. */
export async function runAutomaticUpdate(): Promise<AppUpdateResult | null> {
  if (!autoUpdateEnabled() || !isTauri()) return null;
  try {
    return await installAppUpdate();
  } catch {
    return null;
  }
}
