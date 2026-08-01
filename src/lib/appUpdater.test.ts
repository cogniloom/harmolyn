import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));

import {
  AUTO_UPDATE_KEY,
  autoUpdateEnabled,
  checkForAppUpdate,
  downloadAppUpdate,
  pendingUpdateRestartVersion,
  restartAfterAppUpdate,
  setAutoUpdateEnabled,
} from './appUpdater.js';

describe('signed native application updates', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.isTauri.mockReset();
    mocks.check.mockReset();
    mocks.relaunch.mockReset();
  });

  it('keeps automatic security updates default-on and user configurable', () => {
    expect(autoUpdateEnabled()).toBe(true);
    setAutoUpdateEnabled(false);
    expect(localStorage.getItem(AUTO_UPDATE_KEY)).toBe('false');
    expect(autoUpdateEnabled()).toBe(false);
  });

  it('does not invoke the native updater in a browser build', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(checkForAppUpdate()).resolves.toEqual({ status: 'web' });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('downloads in the background and installs only after explicit restart', async () => {
    mocks.isTauri.mockReturnValue(true);
    const update = {
      version: '1.1.0',
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.check.mockResolvedValue(update);
    mocks.relaunch.mockResolvedValue(undefined);

    await expect(downloadAppUpdate()).resolves.toEqual({ status: 'ready', version: '1.1.0' });
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(update.close).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(pendingUpdateRestartVersion()).toBe('1.1.0');

    await expect(downloadAppUpdate()).resolves.toEqual({ status: 'ready', version: '1.1.0' });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();

    await restartAfterAppUpdate();
    expect(update.install).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(pendingUpdateRestartVersion()).toBeNull();
  });
});
