type NavigatorInfo = {
  deviceMemory: number | null;
  hardwareConcurrency: number | null;
};

export function safeNavigatorInfo(): NavigatorInfo {
  let nav: Navigator | null = null;
  try {
    nav = (globalThis as typeof globalThis & { navigator?: Navigator }).navigator ?? null;
  } catch {
    return {
      deviceMemory: null,
      hardwareConcurrency: null,
    };
  }

  if (!nav) {
    return {
      deviceMemory: null,
      hardwareConcurrency: null,
    };
  }

  let deviceMemory: number | null = null;
  try {
    const value = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
    deviceMemory = typeof value === "number" ? value : null;
  } catch {
    deviceMemory = null;
  }

  let hardwareConcurrency: number | null = null;
  try {
    const value = nav.hardwareConcurrency;
    hardwareConcurrency = typeof value === "number" ? value : null;
  } catch {
    hardwareConcurrency = null;
  }

  return {
    deviceMemory,
    hardwareConcurrency,
  };
}
