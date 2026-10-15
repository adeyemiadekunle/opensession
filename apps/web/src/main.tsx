import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@opensession/ui/styles.css";
import { App } from "./App";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!publishableKey) {
  root.render(
    <div className="os-settings">
      <div className="os-card">
        <h2>Missing configuration</h2>
        <p>
          Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> and <code>VITE_GATEWAY_URL</code> in <code>apps/web/.env</code>{" "}
          (see <code>.env.example</code>).
        </p>
      </div>
    </div>,
  );
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
