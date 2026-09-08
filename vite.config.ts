import path from 'path';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
      base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
      // Real app version, sourced from package.json at build time (shown in Settings
      // → About, and useful in bug reports). Not a secret.
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
      },
      server: {
        port: 8080,
        host: '0.0.0.0',
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()'
        },
      },
      plugins: [react(), {
        name: 'harmolyn-browser-dependency-boundary',
        generateBundle(_options, bundle) {
          const forbidden = new Set<string>();
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            for (const [id, info] of Object.entries(output.modules)) {
              // React Native / Metro are installed through a libp2p peer dependency,
              // but must never enter a browser or Tauri frontend artifact.
              const match = id.replace(/\\/g, '/').match(/\/node_modules\/(image-size|metro(?:-[^/]+)?|react-native(?:-[^/]+)?)\//);
              if (match && info.renderedLength > 0) forbidden.add(match[1]);
            }
          }
          if (forbidden.size) this.error(`Non-browser image/native tooling entered the frontend: ${[...forbidden].join(', ')}`);
          this.emitFile({ type: 'asset', fileName: 'dependency-boundary.json', source: JSON.stringify({ forbiddenModulesBundled: [], checked: ['image-size', 'metro*', 'react-native*'] }) });
        },
      }],
      // SECURITY: Never inject secret API keys into client bundles via define.
      // Use edge functions / backend proxies for any external API calls.
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(import.meta.dirname, 'index.html'),
          },
          output: {
            manualChunks(id: string) {
              if (id.includes('node_modules')) {
                if (id.includes('react-dom') || id.includes('/react/') || id.includes('/scheduler/')) {
                  return 'react-vendor';
                }
                if (id.includes('framer-motion')) {
                  return 'motion-vendor';
                }
                if (id.includes('lucide-react')) {
                  return 'icons-vendor';
                }
                if (id.includes('@tanstack')) {
                  return 'query-vendor';
                }
                return 'vendor';
              }
            },
          },
        },
      },
      resolve: {
        alias: {
          '@': path.resolve(import.meta.dirname, './src'),
        }
      }
});
