import { getMigrations } from "better-auth/db/migration"
import { auth } from "./auth"

// Creates or updates Better Auth's tables (user, session, account, verification, jwks).
// They share the gateway's database; none of the gateway's table names overlap.
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options)
if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log("auth: database is up to date")
} else {
  await runMigrations()
  console.log(`auth: created ${toBeCreated.length} table(s), updated ${toBeAdded.length}`)
}
process.exit(0)
