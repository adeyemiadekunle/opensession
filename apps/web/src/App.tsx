import { Show, SignIn, UserButton, useAuth } from "@clerk/react";
import { CloudClient } from "@opensession/api-client";
import { CloudApp, useTheme } from "@opensession/ui";
import { useMemo } from "react";
import { CliAuthorize } from "./CliAuthorize";
import { usePath } from "./router";

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8787";

export function App() {
  useTheme(); // dark/light on <html>, following the OS unless chosen
  return (
    <>
      <Show when="signed-out">
        <div className="os-legacy os-signin">
          <div className="os-brand">OpenSession</div>
          <SignIn routing="hash" />
        </div>
      </Show>
      <Show when="signed-in">
        <SignedInApp />
      </Show>
    </>
  );
}

function SignedInApp() {
  const { getToken } = useAuth();
  const [path, go] = usePath();
  // Clerk session tokens are short-lived; getToken() returns a fresh one each call.
  const client = useMemo(() => new CloudClient({ gatewayUrl: GATEWAY_URL, getToken: () => getToken() }), [getToken]);
  if (path === "/cli-auth") return <CliAuthorize client={client} />;
  return <CloudApp client={client} path={path} go={go} headerEnd={<UserButton />} />;
}
