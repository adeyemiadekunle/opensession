import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { config } from "./config"

const app = new Hono()

app.use(
  "/api/auth/*",
  cors({
    origin: config.trustedOrigins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["set-auth-jwt"],
    credentials: true,
  }),
)
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
app.get("/health", (c) => c.text("ok"))

console.log(`auth: listening on :${config.port} as ${config.baseURL}`)

export default { port: config.port, fetch: app.fetch }
