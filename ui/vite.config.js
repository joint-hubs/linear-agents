import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Port overrides for isolated runs (FOC-225 verification): the production
// installation may already occupy the defaults. Unset env = unchanged behavior.
const UI_PORT = parseInt(process.env.LA_UI_PORT, 10) || 5173;
const API_PORT = parseInt(process.env.LA_API_PORT, 10) || 7331;

export default defineConfig({
  plugins: [react()],
  server: {
    port: UI_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
