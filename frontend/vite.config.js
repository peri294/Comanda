import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Escuchar en todas las interfaces de red, no solo localhost: los celulares
    // de la red local necesitan poder cargar el frontend (QR -> http://IP:5173).
    host: true,
  },
})
