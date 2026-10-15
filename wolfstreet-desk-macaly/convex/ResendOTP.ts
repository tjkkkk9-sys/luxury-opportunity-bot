import { Email } from "@convex-dev/auth/providers/Email"

function generateOTP(length: number): string {
  const digits = "0123456789"
  const array = new Uint32Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, (num) => digits[num % digits.length]).join("")
}

export const ResendOTP = Email({
  id: "resend-otp",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return generateOTP(6)
  },
  async sendVerificationRequest({ identifier: email, token }) {
    // Il desk muove denaro: il codice parte solo verso l'email del titolare.
    const owner = (process.env.DESK_OWNER_EMAIL ?? "").trim().toLowerCase()
    if (!owner || email.trim().toLowerCase() !== owner) {
      throw new Error("Accesso riservato al titolare del desk")
    }
    const response = await fetch(`${process.env.OTP_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        token,
        chatId: process.env.CHAT_ID,
        appName: process.env.APP_NAME || "Wolf Street Desk",
        secretKey: process.env.SECRET_KEY,
      }),
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.error || "Invio del codice non riuscito")
    }
  },
})
