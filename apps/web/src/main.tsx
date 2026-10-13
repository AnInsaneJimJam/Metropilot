import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api, HOSTED_PRIVY_APP_ID } from "./api.ts";
import { setEditorModels } from "./catalog.ts";
import { App } from "./App.tsx";
import "@fontsource-variable/dm-sans/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
// Load approved model metadata before Blockly creates its initial dropdowns.
// Keep native/offline editing available when the local control API is unavailable.
try {
  if (!HOSTED_PRIVY_APP_ID) await api('/session', { signal: AbortSignal.timeout(1500) });
  const response = await api<{ catalog?: { modelProfiles?: unknown } }>('/catalog', { signal: AbortSignal.timeout(1500) });
  setEditorModels(response.catalog?.modelProfiles);
} catch {
  // EditorPage owns the visible API connection status and reconnect guidance.
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
