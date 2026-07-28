import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./i18n"; // initialize i18next (side-effect) before first render
import "./index.css";
import { resolveRootElement } from "./lib/bootstrapRoot";
import { registerServiceWorker } from "./lib/registerServiceWorker";

const rootElement = resolveRootElement();

if (rootElement) {
  createRoot(rootElement).render(<App />);
}

registerServiceWorker();
