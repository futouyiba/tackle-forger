import vinext from "vinext";
import { defineConfig } from "vite";

// The formal runtime is the Node/Vinext process deployed to the internal R730.
// Keep the polling fallback for Codex's macOS sandbox, but do not load any
// platform-specific build adapter or runtime binding here.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext()],
});
