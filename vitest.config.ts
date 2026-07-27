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
    // ratchet) are CPU-heavy and, on shared CI runners under worker contention,
    // legitimately exceed Vitest's 5s default — even light render tests get starved.
    // Give real headroom so a slow runner doesn't flake the suite (green locally).
    testTimeout: 20000,
    hookTimeout: 20000,
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
