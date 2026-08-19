import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host: true expose le serveur sur le réseau local (test depuis un téléphone).
// Le port vient de l'environnement quand l'outil de préversion en assigne un,
// sinon 5173 comme avant.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
  },
});
