import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  clearScreen: false,
  plugins: [solid()],
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
  },
})
