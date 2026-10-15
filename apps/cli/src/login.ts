import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";

/** Open a URL in the user's browser (best effort). */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed too */
  }
}

/**
 * Browser login: listen once on 127.0.0.1, send the user to the web app's /cli-auth
 * page, and receive the access token on /callback. The state value guards against
 * other pages posting a token to this listener.
 */
export async function browserLogin(
  webUrl: string,
  opts: { timeoutMs?: number; open?: (url: string) => void; log?: (s: string) => void } = {},
): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const token = u.searchParams.get("token") ?? "";
      if (u.searchParams.get("state") !== state || !token.startsWith("osk_")) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Login failed: unexpected response. Run `opensession login` again.");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<html><body style='font-family:sans-serif'><h3>OpenSession CLI signed in.</h3>You can close this tab.</body></html>");
      clearTimeout(timer);
      server.close();
      resolve(token);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("login timed out"));
    }, opts.timeoutMs ?? 5 * 60_000);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = new URL("/cli-auth", webUrl);
      url.searchParams.set("port", String(port));
      url.searchParams.set("state", state);
      url.searchParams.set("name", hostname().slice(0, 40));
      opts.log?.(`Opening ${url}\nIf the browser doesn't open, paste that link into it.`);
      (opts.open ?? openBrowser)(url.toString());
    });
  });
}
