import { httpRouter } from "convex/server"
import { internal } from "./_generated/api"
import { httpAction } from "./_generated/server"
import { auth } from "./auth"

const http = httpRouter()

auth.addHttpRoutes(http)

// Messaggi dal bot Telegram. Telegram firma ogni chiamata con il secret_token registrato:
// il controllo del segreto e della chat del titolare avviene nell'azione, qui si risponde subito 200.
http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? ""
    const body = await req.text()
    if (secret && body.length < 20_000) await ctx.runAction(internal.desk.telegramUpdate, { secret, body })
    return new Response("ok", { status: 200 })
  }),
})

export default http
