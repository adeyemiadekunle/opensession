import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@opensession/ui/styles.css";
import { initTheme } from "@opensession/ui";
import { App } from "./App";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
