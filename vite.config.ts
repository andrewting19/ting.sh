import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolveServerPort } from './src/serverPort'

const wsPort = process.env.TING_WS_PORT ?? String(resolveServerPort())

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.VITE_PORT ?? '4321'),
    host: true, // bind to 0.0.0.0 so Tailscale (and LAN) can reach the dev server
    allowedHosts: true, // allow any hostname (Tailscale hostnames, etc.)
    proxy: {
      '/ws': { target: `ws://localhost:${wsPort}`, ws: true },
      '/api': { target: `http://localhost:${wsPort}` },
    },
  },
  build: {
    outDir: 'dist',
  },
})
