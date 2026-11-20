// FILE: web/src/main.tsx
// Application entry point that mounts the React tree.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root was not found.");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
