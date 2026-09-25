#!/usr/bin/env node
/**
 * First-run setup for a fresh Ghost: create the owner account, sign in, and hand
 * back a staff token for scripts/import-content.mjs.
 *
 * Two things make this worth a script rather than a click-through:
 *
 *   - The first login of a user skips the emailed sign-in code, so this works
 *     before any mail is configured. Every later login from a new device needs
 *     mail, which is why the token gets collected here and reused.
 *   - The token it prints is a *staff* token (an admin key bound to the owner).
 *     Ghost's allowlist refuses settings writes for plain integration keys, and
 *     a theme is useless until its settings are set.
 *
 * A fresh install also serves Ghost's bundled "source" theme, which does not live
 * in the content volume, so the homepage errors until the theme in that volume is
 * activated - import-content.mjs does that, right after this.
 *
 * Usage:
 *   GHOST_URL=http://localhost:2368 GHOST_OWNER_PASSWORD=... \
 *     node scripts/bootstrap-ghost.mjs [--name "Andries Luchies"] [--email info@luciancs.nl]
 */

import { adminToken } from "./lib/ghost-admin.mjs"

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const url = process.env.GHOST_URL?.replace(/\/$/, "")
const password = process.env.GHOST_OWNER_PASSWORD
const name = option("name", "Andries Luchies")
const email = option("email", "info@luciancs.nl")

if (!url || !password) {
  console.error("GHOST_URL and GHOST_OWNER_PASSWORD are required")
  process.exit(1)
}

const json = { "content-type": "application/json", "accept-version": "v6.0" }

const setup = await fetch(`${url}/ghost/api/admin/authentication/setup/`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ setup: [{ name, email, password, blogTitle: "LUCIAN" }] }),
})
const body = await setup.json()

if (setup.status !== 201) {
  console.error(`setup refused (${setup.status}):`, JSON.stringify(body).slice(0, 300))
  console.error("If this instance already has an owner, use Staff -> Staff access token instead.")
  process.exit(1)
}
const ownerId = body.users[0].id
console.log(`· owner created: ${email} (${ownerId})`)

const login = await fetch(`${url}/ghost/api/admin/session/`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ username: email, password }),
})
if (login.status !== 201) {
  throw new Error(`login failed (${login.status}): ${(await login.text()).slice(0, 200)}`)
}
const cookie = login.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ")
console.log("· signed in")

const tokenResponse = await fetch(`${url}/ghost/api/admin/users/${ownerId}/token/`, {
  headers: { ...json, cookie },
})
const tokenBody = await tokenResponse.json()
const apiKey = tokenBody.apiKey ?? tokenBody.api_keys?.[0]
if (tokenResponse.status !== 200 || !apiKey) {
  throw new Error(`staff token failed (${tokenResponse.status}): ${JSON.stringify(tokenBody).slice(0, 300)}`)
}

// Prove the token works before handing it over: an integration-shaped key would
// pass this and still be refused a settings write.
const probe = await fetch(`${url}/ghost/api/admin/custom_theme_settings/`, {
  headers: { authorization: `Ghost ${adminToken(`${apiKey.id}:${apiKey.secret}`)}`, "accept-version": "v6.0" },
})
if (probe.status !== 200) throw new Error(`staff token rejected (${probe.status})`)

console.log(`\nGHOST_KEY=${apiKey.id}:${apiKey.secret}\n`)
