import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { medServer } from './server/vitePlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // medServer: the backend (server/) runs inside this dev server, on the same
  // port, so `vite` starts the client and the API together
  plugins: [vue(), medServer()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 8082,
  },
})
