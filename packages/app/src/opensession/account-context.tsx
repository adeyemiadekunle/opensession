// The signed-in OpenSession account, for the profile menu (sidebar.tsx). Undefined when
// accounts are off (the app talks to a plain `opencode serve`).

import { createContext, useContext } from "solid-js"

export interface Account {
  // Reactive: the profile page updates them.
  readonly name: string
  readonly email: string
  signOut: () => void
  /** After a profile change: what the app shows and remembers. */
  update: (patch: { name?: string; email?: string }) => void
}

export const AccountContext = createContext<Account | undefined>()

export const useAccount = () => useContext(AccountContext)
