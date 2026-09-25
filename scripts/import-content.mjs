#!/usr/bin/env node
/**
 * Seeds a Ghost instance with the client's site.
 *
 * Everything the site was rebuilt from lives in lucian-cs/webui/src/content:
 * pages.json is the WordPress import as an AST of blocks, site.json the brand,
 * the menu, the footer and the contact details. This script turns those into
 * Ghost objects:
 *
 *   pages.json      -> one Ghost page per path (the homepage is the theme's)
 *   site.json       -> title/description/locale/navigation/accent + the theme's
 *                      own settings (hero, contact block, social links)
 *   content/*.html  -> not used; articles are editor HTML, not templates
 *   old URLs        -> base/redirects.configmap.json, which the deployment drops
 *                      into Ghost's content directory
 *
 * Usage:
 *   GHOST_URL=https://lucian.example GHOST_KEY=<id>:<secret> \
 *     node scripts/import-content.mjs [--source <dir>] [--dry-run]
 *
 * The key needs to be a staff token (Ghost 6: Settings -> Staff -> your user ->
 * "Staff access token"). An integration key works for pages and uploads, but
 * Ghost's token allowlist refuses settings writes for integrations.
 *
 * Re-runnable: pages are matched on their slug and updated in place, settings
 * are overwritten. Nothing is deleted except Ghost's own starter page.
 */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { adminToken } from "./lib/ghost-admin.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..")

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const ghostUrl = process.env.GHOST_URL
const ghostKey = process.env.GHOST_KEY
const dryRun = flag("dry-run")
const source = resolve(option("source", join(repo, "..", "lucian-cs", "webui", "src", "content")))

if (!ghostUrl || !ghostKey) {
  console.error("GHOST_URL and GHOST_KEY are required (see the header of this file)")
  process.exit(1)
}

const pagesSource = JSON.parse(readFileSync(join(source, "pages.json"), "utf8"))
const site = JSON.parse(readFileSync(join(source, "site.json"), "utf8"))
const pages = pagesSource.pages ?? pagesSource

/* ------------------------------------------------------------ ghost client */

const base = ghostUrl.replace(/\/$/, "")
let token = null

const request = async (path, { method = "GET", body, form } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Ghost ${token}`,
      "accept-version": "v6.0",
      ...(form ? {} : body ? { "content-type": "application/json" } : {}),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

/** Upload one file to Ghost; returns the URL it will be served from. */
const MIME = {
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
}

/** Ghost's media endpoint accepts a fixed list of types, so the part carries it. */
const upload = async (kind, filename, bytes, ref, purpose) => {
  if (dryRun) return `(dry run: ${kind} ${filename})`
  const type = MIME[filename.slice(filename.lastIndexOf("."))] ?? "application/octet-stream"
  const form = new FormData()
  form.append("file", new Blob([bytes], { type }), filename)
  if (purpose) form.append("purpose", purpose)
  if (ref) form.append("ref", ref)
  const response = await request(`/ghost/api/admin/${kind}/upload/`, { method: "POST", form })
  const first = (response[kind] ?? response.media ?? [])[0]
  if (!first?.url) throw new Error(`${kind} upload for ${filename} returned ${JSON.stringify(response).slice(0, 200)}`)
  return first.url
}

/* ------------------------------------------------------------- html output */

const esc = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Source path (/a/b.html) -> the Ghost URL this import gives it. */
const urlFor = (path) => {
  if (path === "/" || path === "/index.html") return "/"
  const slug = path.replace(/^\//, "").replace(/\.html$/, "").split("/").filter(Boolean).pop()
  return `/${slug}/`
}

const pagesByPath = new Map(pages.map((page) => [page.path, page]))

/** Internal links keep working: the old path resolves to its new URL. */
const rewriteHref = (href) => {
  if (!href) return href
  if (/^(mailto:|tel:|https?:|\/\/|#)/i.test(href)) return href
  const [path, hash = ""] = href.split("#")
  const cleaned = path.endsWith("/index.html") ? path.replace(/index\.html$/, "") : path
  const known = pagesByPath.has(cleaned) ? cleaned : cleaned.endsWith(".html") ? cleaned : `${cleaned}.html`
  if (!pagesByPath.has(known)) return href
  return urlFor(known) + (hash ? `#${hash}` : "")
}

const inlinesToHtml = (nodes = []) =>
  nodes
    .map((node) => {
      if (node.t === "text") return esc(node.v)
      if (node.t === "br") return "<br>"
      if (node.t === "span") {
        const body = inlinesToHtml(node.c)
        // Ghost's editor keeps bold, italic and underline; the maroon and grey
        // runs the source used are lost, which is why the theme's stylesheet
        // carries that colour on the heading levels instead.
        if (node.marks.includes("strong")) return `<strong>${body}</strong>`
        if (node.marks.includes("em")) return `<em>${body}</em>`
        if (node.marks.includes("underline")) return `<u>${body}</u>`
        return body
      }
      if (node.t === "link") {
        const href = esc(rewriteHref(node.href))
        const target = node.external ? ' target="_blank" rel="noopener noreferrer"' : ""
        return `<a href="${href}"${target}>${inlinesToHtml(node.c)}</a>`
      }
      return ""
    })
    .join("")

/** A Ghost button card: the markup is part of Ghost's own card set, so it
    survives the editor round trip and picks up the theme's .kg-btn styles. */
const buttonCard = (node) =>
  `<div class="kg-card kg-button-card kg-align-left"><a class="kg-btn kg-btn-accent" href="${esc(
    rewriteHref(node.href),
  )}">${inlinesToHtml(node.c)}</a></div>`

const blockToHtml = (block) => {
  switch (block.t) {
    case "heading":
      return `<h${block.level}>${inlinesToHtml(block.c)}</h${block.level}>`
    case "paragraph": {
      const only = block.c.length === 1 ? block.c[0] : null
      if (only?.t === "link" && only.button) return buttonCard(only)
      return `<p>${inlinesToHtml(block.c)}</p>`
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul"
      const items = block.c.map((item) => `<li>${inlinesToHtml(item)}</li>`).join("")
      return `<${tag}>${items}</${tag}>`
    }
    case "divider":
      return "<hr>"
    default:
      // contactForm: the form is the contact page template's job, not content.
      return ""
  }
}

const headingText = (block) =>
  block.c
    .map((node) => node.v ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim()

const ownHeading = (page) => {
  for (const section of page.sections) {
    if (section.t !== "prose") continue
    for (const block of section.blocks) {
      if (block.t === "heading" && block.level === 1) {
        const text = block.c.map((node) => node.v ?? "").join("").trim()
        if (text) return text
      }
    }
  }
  return undefined
}

/** The h1 the page opened with becomes Ghost's title, so it is dropped from the
    body - otherwise every article would say its title twice. */
const isEmptyParagraph = (block) =>
  block.t === "paragraph" && block.c.every((node) => node.t === "br" || (node.t === "text" && !String(node.v).trim()))

const bodyHtml = (page) => {
  const blocks = page.sections.flatMap((section) => (section.t === "prose" ? section.blocks : []))

  // The contact page's form is the template's job (page-contact.hbs); all that
  // is left in the source is the heading that template draws itself.
  if (blocks.some((block) => block.t === "contactForm")) return ""

  const kept = blocks.filter((block) => !isEmptyParagraph(block))

  // An opening h1 that just names the page again is dropped - the theme's hero
  // prints that name, and the page should not say it twice. One that says
  // something else is the writer's own heading and stays.
  const first = kept[0]
  if (first?.t === "heading" && first.level === 1 && headingText(first) === titleFor(page)) kept.shift()

  return kept.map(blockToHtml).filter(Boolean).join("\n")
}

const shortTitle = (title) =>
  title.replace(/^LUCIAN\s*:\s*/i, "").replace(/\s*[|–—-]\s*LUCIAN\b.*$/i, "").trim() || title

const namePart = (text) => text.split(/[:|]/)[0].replace(/\s*>\s*/g, " · ").trim() || text

const navLabel = (path) => site.nav.find((item) => item.href === path)?.label

/** The name the page answers to in its own hero, as the static build showed it. */
const titleFor = (page) => {
  const fromNav = navLabel(page.path)
  if (fromNav) return fromNav
  const heading = ownHeading(page)
  return namePart(heading ?? shortTitle(page.title))
}

const slugFor = (path) =>
  path
    .replace(/^\//, "")
    .replace(/\.html$/, "")
    .split("/")
    .filter(Boolean)
    .pop()

/* ------------------------------------------------------------- the imports */

const log = (...parts) => console.log(...parts)

/** Everything this repo hands to Ghost: the photograph, the social card, the
    client's terms. Ghost's image endpoint refuses AVIF (the theme's own fallback
    copy stays AVIF) and its media endpoint refuses PDFs, so the terms go through
    the files endpoint. */
async function syncUploads() {
  const files = join(repo, "media")
  log("· uploads: hero, open graph, terms")
  return {
    hero: await upload("images", "hero-2000.jpg", readFileSync(join(files, "hero-2000.jpg")), "homepage", "image"),
    og: await upload("images", "og.jpg", readFileSync(join(files, "og.jpg")), "open-graph", "image"),
    terms: await upload("files", "AV.pdf", readFileSync(join(files, "AV.pdf")), "algemene-voorwaarden"),
  }
}

async function syncSettings({ hero, og, terms }) {
  const home = pagesByPath.get("/")

  const settings = [
    { key: "title", value: site.brand },
    { key: "description", value: home?.description ?? "" },
    { key: "locale", value: "nl" },
    // A client's business site does not belong in Ghost's public directory
    // unasked, and the nightly ping is the client's traffic, not ours.
    { key: "explore_ping", value: false },
    { key: "explore_ping_growth", value: false },
    { key: "timezone", value: "Europe/Amsterdam" },
    // No memberships, no tips, no recommendations: the client sells services,
    // not subscriptions. This also has Ghost stop offering a signup UI, which
    // is what pulls Portal in (the theme excludes it as well).
    { key: "members_signup_access", value: "none" },
    { key: "donations_enabled", value: false },
    { key: "recommendations_enabled", value: false },
    // The interior-page hero band uses the same photograph as the homepage;
    // Ghost's default cover is its own stock image.
    { key: "cover_image", value: hero },
    { key: "og_image", value: og },
    { key: "navigation", value: JSON.stringify(site.nav.map((item) => ({ label: item.label, url: urlFor(item.href) }))) },
    {
      key: "secondary_navigation",
      value: JSON.stringify([
        { label: "Acties", url: urlFor("/info/acties.html") },
        { label: "Kenniscentrum", url: urlFor("/info/kenniscentrum.html") },
        { label: "AV", url: terms },
        { label: "Disclaimer", url: urlFor("/info/disclaimer.html") },
      ]),
    },
    { key: "facebook", value: site.social.find((s) => s.name === "facebook")?.href ?? "" },
    { key: "twitter", value: site.social.find((s) => s.name === "twitter")?.href ?? "" },
    { key: "linkedin", value: site.social.find((s) => s.name === "linkedin")?.href ?? "" },
  ]

  log("· settings")
  if (!dryRun) await request("/ghost/api/admin/settings/", { method: "PUT", body: { settings } })
}

async function syncThemeSettings({ hero }) {
  const home = pagesByPath.get("/")

  const custom = [
    { key: "hero_heading", value: site.heroHeading },
    { key: "hero_lead", value: home?.description ?? "" },
    { key: "hero_image", value: hero },
    { key: "home_meta_title", value: "LUCIAN: ontzorger voor ondernemer en particulier" },
    { key: "statement", value: "Ontzorger voor ondernemer en particulier" },
    { key: "contact_name", value: site.contact.name },
    { key: "contact_street", value: site.contact.street },
    { key: "contact_postal_code", value: site.contact.postalCode },
    { key: "contact_city", value: site.contact.city },
    { key: "contact_email", value: site.contact.email },
    { key: "contact_phone", value: site.contact.phone },
    { key: "contact_url", value: urlFor("/contact.html") },
    { key: "footer_info_title", value: "Info" },
    { key: "social_facebook", value: site.social.find((s) => s.name === "facebook")?.href ?? "" },
    { key: "social_linkedin", value: site.social.find((s) => s.name === "linkedin")?.href ?? "" },
    { key: "social_twitter", value: site.social.find((s) => s.name === "twitter")?.href ?? "" },
  ]

  log("· theme settings")
  if (!dryRun) {
    const existing = (await request("/ghost/api/admin/custom_theme_settings/")).custom_theme_settings
    const known = new Set(existing.map((setting) => setting.key))
    const unknown = custom.filter((setting) => !known.has(setting.key))
    if (unknown.length) throw new Error(`theme does not declare: ${unknown.map((s) => s.key).join(", ")}`)
    await request("/ghost/api/admin/custom_theme_settings/", {
      method: "PUT",
      body: { custom_theme_settings: custom.filter((setting) => setting.value !== undefined) },
    })
  }
}

async function syncPages() {
  const existing = dryRun ? [] : (await request("/ghost/api/admin/pages/?limit=all&formats=html")).pages
  const bySlug = new Map(existing.map((page) => [page.slug, page]))

  for (const page of pages) {
    if (page.path === "/") continue
    const slug = slugFor(page.path)
    const payload = {
      title: titleFor(page),
      slug,
      html: bodyHtml(page),
      status: "published",
      published_at: "2026-09-18T15:16:43.000Z",
      meta_title: page.title,
      meta_description: page.description?.slice(0, 500) ?? "",
    }

    const current = bySlug.get(slug)
    if (current) {
      log(`· page ${slug} (update)`)
      if (!dryRun) {
        await request(`/ghost/api/admin/pages/${current.id}/?source=html`, {
          method: "PUT",
          // Ghost's optimistic lock: the update has to name the revision it
          // is based on, or it refuses to overwrite someone else's edit.
          body: { pages: [{ ...payload, updated_at: current.updated_at }] },
        })
      }
    } else {
      log(`· page ${slug} (create)`)
      if (!dryRun) {
        await request("/ghost/api/admin/pages/?source=html", { method: "POST", body: { pages: [payload] } })
      }
    }
  }

  await removeStarterContent(existing)
}

/** Ghost's own starter content is not part of the client's site. */
async function removeStarterContent(pages) {
  const starterPage = pages.find((page) => page.slug === "about")
  if (starterPage && !pagesByPath.has("/about.html")) {
    log("· removing Ghost's starter page (about)")
    if (!dryRun) await request(`/ghost/api/admin/pages/${starterPage.id}/`, { method: "DELETE" })
  }

  const posts = dryRun ? [] : (await request("/ghost/api/admin/posts/?limit=all")).posts
  for (const post of posts) {
    if (post.slug !== "coming-soon") continue
    log("· removing Ghost's starter post (coming-soon)")
    if (!dryRun) await request(`/ghost/api/admin/posts/${post.id}/`, { method: "DELETE" })
  }
}

/** The old WordPress URLs, so nothing that was linked to a .html page 404s, plus
    the route that turns written articles into a list at /artikelen/. */
function writeContentConfigMap() {
  const rules = []
  for (const page of pages) {
    if (page.path === "/") continue
    const target = urlFor(page.path)
    if (target === "/") continue
    rules.push({ from: page.path, to: target, permanent: true })
  }
  // WordPress' own front page shortlink.
  rules.push({ from: "^/index\\.html$", to: "/", permanent: true })

    // Ghost's default collection lives at "/", which this theme uses for the
  // homepage: articles need a home of their own or they exist only by URL.
  const routes = `# Moving the collection off "/" also moves the homepage off it:
# without the first line, "/" answers 404 and only /artikelen/ exists.
routes:
  /: home

collections:
  /artikelen/:
    permalink: /artikelen/{slug}/
    template: index
    filter: 'tag:-hash-none'
taxonomies:
  tag: /tag/{slug}/
  author: /author/{slug}/
`

  const contentManifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "lucian-ghost-content",
      namespace: "services",
      labels: { app: "lucian-ghost" },
    },
    data: { "redirects.json": JSON.stringify(rules, null, 2), "routes.yaml": routes },
  }

  const out = join(repo, "base", "content.configmap.json")
  writeFileSync(out, JSON.stringify(contentManifest, null, 2) + "\n")

  // routes.yaml and redirects.json are read when Ghost boots, so a change has to
  // roll the pod: the deployment carries a checksum of this ConfigMap. Without
  // it, applying new routing changes nothing until someone restarts Ghost - which
  // looks exactly like a broken route file.
  const checksum = createHash("sha256")
    .update(contentManifest.data["redirects.json"] + contentManifest.data["routes.yaml"])
    .digest("hex")
    .slice(0, 32)

  const deploymentPath = join(repo, "base", "deployment.yaml")
  const deployment = readFileSync(deploymentPath, "utf8")
  const stamped = deployment.replace(/checksum\/content: "[0-9a-f]*"/, `checksum/content: "${checksum}"`)
  if (stamped === deployment && !deployment.includes(`checksum/content: "${checksum}"`)) {
    throw new Error("base/deployment.yaml has no checksum/content annotation to stamp")
  }
  writeFileSync(deploymentPath, stamped)

  log(`· redirects: ${rules.length} rules and routes.yaml -> ${out} (checksum ${checksum.slice(0, 12)})`)
  return rules
}

async function verify() {
  const targets = pages.filter((page) => page.path !== "/").map((page) => urlFor(page.path))
  const failed = []
  for (const path of targets) {
    const response = await fetch(base + path)
    if (response.status !== 200) failed.push(`${path} -> ${response.status}`)
  }
  const response = await fetch(base + "/")
  if (response.status !== 200) failed.push(`/ -> ${response.status}`)
  log(`· verification: ${targets.length + 1} URLs, ${failed.length} failures`)
  for (const failure of failed) console.log("   ✗", failure)
  return failed
}

/** A fresh install serves Ghost's own starter theme; this one ships in the
    content volume, so it only needs to be selected. */
async function activateTheme() {
  log("· theme: activate lucian")
  if (!dryRun) await request("/ghost/api/admin/themes/lucian/activate/", { method: "PUT" })
}

/* ------------------------------------------------------------------- main */

token = adminToken(ghostKey)
log(`lucian-ghost import -> ${base}${dryRun ? " (dry run)" : ""}`)
log(`source: ${source}`)

await activateTheme()

const uploads = await syncUploads()
await syncSettings(uploads)
await syncThemeSettings(uploads)
await syncPages()
writeContentConfigMap()

if (!dryRun) {
  const failed = await verify()
  if (failed.length) process.exitCode = 1
}

log("done")
