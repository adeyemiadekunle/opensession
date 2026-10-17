import { Show, SignIn, useAuth, useClerk, useUser } from "@clerk/react";
import { CloudClient } from "@opensession/api-client";
import { CloudApp, DownloadPage, type CloudAccount } from "@opensession/ui";
import { useMemo } from "react";
import { CliAuthorize } from "./CliAuthorize";
import { usePath } from "./router";

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8787";
// The GitHub repository whose releases carry the desktop installers and the CLI.
const RELEASES_REPO = (import.meta.env.VITE_RELEASES_REPO as string | undefined) || "adeyemiadekunle/opensession";
const downloads = { repo: RELEASES_REPO, gatewayUrl: GATEWAY_URL };

export function App() {
  const [path, go] = usePath();
  // The Download page is public: people get the apps before they have an account.
  if (path === "/download") {
    return <DownloadPage repo={RELEASES_REPO} gatewayUrl={GATEWAY_URL} origin={window.location.origin} onBack={() => go("/")} />;
  }
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
    email,
    onManage: () => clerk.openUserProfile(),
    onSignOut: () => void clerk.signOut(),
  };
  return <CloudApp client={client} path={path} go={go} account={account} downloads={downloads} />;
}
