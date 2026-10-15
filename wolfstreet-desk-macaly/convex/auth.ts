import { convexAuth } from "@convex-dev/auth/server"
import { ResendOTP } from "./ResendOTP"

// Accesso con codice via email, riservato al titolare (DESK_OWNER_EMAIL): vedi ResendOTP.ts.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [ResendOTP],
})
