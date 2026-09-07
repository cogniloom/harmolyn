import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./i18n";
import "./index.css";
import "./styles/stabilization.css";
import "./styles/appearance.css";
import "./styles/palette-transitions.css";
import "./styles/conversation.css";
import { initializeAppearance } from "./lib/appearance/store";
import { resolveRootElement } from "./lib/bootstrapRoot";
import { registerServiceWorker } from "./lib/registerServiceWorker";

const disposeAppearance = initializeAppearance();
if (import.meta.hot) import.meta.hot.dispose(disposeAppearance);

const rootElement = resolveRootElement();
if (rootElement) createRoot(rootElement).render(<App />);
registerServiceWorker();
