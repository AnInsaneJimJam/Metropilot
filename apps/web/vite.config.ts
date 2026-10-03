import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript source; Vite transpiles them like local files.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
