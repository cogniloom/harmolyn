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
  installAppUpdate,
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

  it('downloads, installs, and relaunches only through the signed Tauri updater', async () => {
    mocks.isTauri.mockReturnValue(true);
    const update = {
      version: '1.1.0',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.check.mockResolvedValue(update);
    mocks.relaunch.mockResolvedValue(undefined);

    await expect(installAppUpdate()).resolves.toEqual({ status: 'installed', version: '1.1.0' });
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
