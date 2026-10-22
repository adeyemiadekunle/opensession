import { betterAuth } from "better-auth"
import { jwt } from "better-auth/plugins"
import { Pool } from "pg"
import { config } from "./config"

// Sign-in lives here; the gateway never sees passwords or cookies. The web app trades its session
// for a short-lived JWT (GET /api/auth/token) and sends that to the gateway, which checks it
// against /api/auth/jwks. The JWT's `sub` is the user id the gateway stores everything under.
export const auth = betterAuth({
  baseURL: config.baseURL,
  secret: config.secret,
  database: new Pool({ connectionString: config.databaseURL }),
  trustedOrigins: config.trustedOrigins,
  emailAndPassword: { enabled: true },
  user: {
    // There is no email service yet, so no address is ever verified, and Better Auth lets an
    // unverified address change at once. Once verification emails exist, require them here
    // (sendChangeEmailConfirmation) instead.
    changeEmail: { enabled: true, updateEmailWithoutVerification: true },
  },
  socialProviders: {
    ...(config.github && { github: config.github }),
    ...(config.google && { google: config.google }),
  },
  plugins: [
    jwt({
      jwt: {
        definePayload: ({ user }) => ({ email: user.email, name: user.name }),
      },
    }),
  ],
})
