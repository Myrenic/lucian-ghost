/**
 * Minimal Ghost Admin API client.
 *
 * Ghost's Admin API takes a JWT, not the `id:secret` pair the admin UI hands
 * out: the token carries the key id in its `kid` header, the API path in `aud`
 * and is signed with the key's secret (hex-decoded) using HS256. Ghost checks
 * all three, so the helper below mints a short-lived token per request. No
 * dependencies - node:crypto does HMAC.
 */

import { createHmac } from "node:crypto"

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/**
 * @param {string} apiKey  "<id>:<secret>" as shown in Ghost's custom integration
 * @param {string} [aud]   API root the token is valid for
 */
export function adminToken(apiKey, aud = "/admin/") {
  const [id, secret] = apiKey.split(":")
  if (!id || !secret) throw new Error("GHOST_ADMIN_KEY must look like <id>:<secret>")

  const iat = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }))
  const payload = b64url(JSON.stringify({ iat, exp: iat + 300, aud }))
  const signature = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

  return `${header}.${payload}.${signature}`
}

/** A tiny JSON client for one Ghost instance. */
export function ghostClient({ url, key }) {
  const base = url.replace(/\/$/, "")

  const request = async (path, { method = "GET", body, headers = {}, raw = false } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Ghost ${adminToken(key)}`,
        "accept-version": "v6.0",
        ...(raw ? {} : body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 500)}`)
    }

    return text ? JSON.parse(text) : null
  }

  return { base, request }
}
