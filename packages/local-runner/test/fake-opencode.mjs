// Pretends to be `opencode serve`: checks the password like the real server.
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (process.env.FAKE_FAIL) {
  console.error("boom: could not start");
  process.exit(3);
}
const want = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
createServer((req, res) => {
  if (req.headers.authorization !== want) {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy: true, cwd: process.cwd() }));
}).listen(port, "127.0.0.1", () => console.log(`server listening on http://127.0.0.1:${port}`));
