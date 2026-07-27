import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  // Mirror vite.config.ts's build-time define so components referencing the
  // injected app version compile under Vitest too.
  define: {
    __APP_VERSION__: JSON.stringify("1.0.0-rc.1-test"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Post-quantum crypto tests (ML-KEM-768 / ML-DSA-65 keygen+sign, X3DH, double
    // ratchet) are CPU-heavy. With Vitest fanning ~100 files across many workers on a
    // 2-core CI runner, a single crypto file's wall-clock balloons under contention
    // and blows the 5s default (one file even exceeded 20s). Two independent knobs fix
    // it: cap workers on CI so each heavy test actually gets a core, and keep a
    // generous timeout as headroom. Locally (uncapped) the full suite stays ~fast.
    testTimeout: 30000,
    hookTimeout: 30000,
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/protocol/**",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
