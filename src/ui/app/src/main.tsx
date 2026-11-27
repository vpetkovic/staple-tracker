import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startTheme } from "./lib/theme";
// React Flow's own sheet (G2). Imported BEFORE app.css so staple's overrides — which are
// token re-points, not rewrites — land on top of it rather than under it. Vite inlines
// both into the one bundled stylesheet, which is why @xyflow/react stays a devDependency:
// nothing is resolved at `staple ui` time.
import "@xyflow/react/dist/style.css";
import "./styles/app.css";

// The theme follows the system (or the person's pick) for the page's life, whatever is on screen.
startTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
