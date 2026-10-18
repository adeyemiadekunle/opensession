import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@opensession/ui/styles.css";
import { initTheme } from "@opensession/ui";
import { App } from "./App";

initTheme();

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!publishableKey) {
  root.render(
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-6">
      <div className="rounded-lg border border-border bg-card p-[18px] [&>h2]:mb-1 [&>h2]:text-base [&>p]:mb-2.5">
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
