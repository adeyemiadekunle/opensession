// The signed-in OpenSession account, for the profile menu (sidebar.tsx). Undefined when
// accounts are off (the app talks to a plain `opencode serve`).

import { createContext, useContext } from "solid-js"

export interface Account {
  name: string
  email: string
  signOut: () => void
}

export const AccountContext = createContext<Account | undefined>()

export const useAccount = () => useContext(AccountContext)
