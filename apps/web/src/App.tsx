import { Show, SignIn, useAuth, useClerk, useUser } from "@clerk/react";
import { CloudClient } from "@opensession/api-client";
import { CloudApp, type CloudAccount } from "@opensession/ui";
import { useMemo } from "react";
import { CliAuthorize } from "./CliAuthorize";
import { usePath } from "./router";

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8787";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <div className="os-signin">
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
  const { user } = useUser();
  const clerk = useClerk();
  const [path, go] = usePath();
  // Clerk session tokens are short-lived; getToken() returns a fresh one each call.
  const client = useMemo(() => new CloudClient({ gatewayUrl: GATEWAY_URL, getToken: () => getToken() }), [getToken]);
  if (path === "/cli-auth") return <CliAuthorize client={client} />;
  const email = user?.primaryEmailAddress?.emailAddress;
  const account: CloudAccount = {
    name: user?.fullName || email || "Account",
    detail: email,
    items: [{ id: "profile", label: "Profile", onSelect: () => clerk.openUserProfile() }],
    onSignOut: () => void clerk.signOut(),
  };
  return <CloudApp client={client} path={path} go={go} account={account} />;
}
