import path from 'path';
import { readFileSync } from 'fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { componentTagger } from 'lovable-tagger';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: process.env.TAURI_ENV_PLATFORM ? './' : '/',
      // Real app version, sourced from package.json at build time (shown in Settings
      // → About, and useful in bug reports). Not a secret.
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
      },
      server: {
        port: 8080,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        mode === 'development' && componentTagger(),
      ].filter(Boolean),
      // SECURITY: Never inject secret API keys into client bundles via define.
      // Use edge functions / backend proxies for any external API calls.
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            p0test: path.resolve(__dirname, 'p0-test.html'),
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
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
