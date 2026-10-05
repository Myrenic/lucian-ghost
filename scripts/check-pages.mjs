#!/usr/bin/env node
/**
 * Walks every page of a deployed site and reports what a reader would see but a
 * test suite would not.
 *
 * It exists because of a real bug: a malformed Handlebars comment ("{#-- ... --#}")
 * in the page hero printed itself as text at the top of all 39 interior pages.
 * Nothing checked the rendered HTML, so it went out twice. The sitemap is the
 * source of the page list, so this covers the whole site rather than a sample.
 *
 * Usage:
 *   node scripts/check-pages.mjs [https://lucian.example]
 *   GHOST_URL=... node scripts/check-pages.mjs
 *
 * Exits non-zero when anything is wrong, so it works as a gate after a deploy.
 */

const base = (process.argv[2] ?? process.env.GHOST_URL ?? "http://localhost:2368").replace(/\/$/, "")

const locs = async (url) => {
  const xml = await (await fetch(url)).text()
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
}

/* ------------------------------------------------------------------ urls */

const urls = new Set([`${base}/`, `${base}/artikelen/`])

try {
  const index = await locs(`${base}/sitemap.xml`)
  for (const child of index.filter((url) => url.endsWith(".xml"))) {
    for (const url of await locs(child)) if (!url.endsWith(".xml")) urls.add(url)
  }
} catch (error) {
  console.error(`could not read the sitemap from ${base}: ${error.message}`)
  process.exit(1)
}

/* ----------------------------------------------------------------- checks */

const CHECKS = [
  {
    what: "template syntax leaked into the page",
    pattern: /(?<!\{)\{#|--#\}|\{\{[a-zA-Z@/#]/,
  },
  {
    what: "a template printed undefined",
    pattern: />\s*undefined\s*</,
  },
  {
    what: "an entity was escaped twice",
    pattern: /&amp;(?:amp|lt|gt|quot|#\d+);/,
  },
  {
    what: "the header or footer is missing",
    // not a regex over the body: this one is checked below, as a presence test
    presence: true,
  },
]

let failures = 0
const results = []

for (const url of [...urls].sort()) {
  const response = await fetch(url)
  const body = await response.text()
  const problems = []

  if (response.status !== 200) problems.push(`HTTP ${response.status}`)

  for (const check of CHECKS) {
    if (check.presence) continue
    const found = body.match(check.pattern)
    if (found) problems.push(`${check.what} (${found[0].slice(0, 40)})`)
  }

  if (!body.includes("<header")) problems.push("no <header>")
  if (!body.includes("</footer>")) problems.push("no </footer>")
  if (!/<title>[^<]+<\/title>/.test(body)) problems.push("no <title>")

  results.push({ url: url.replace(base, ""), status: response.status, problems })
  if (problems.length) failures++
}

/* the not-found path should be a 404, not a 200 or a 500 */
const missing = await fetch(`${base}/deze-pagina-bestaat-niet-${Date.now()}`)
if (missing.status !== 404) failures++

/* ---------------------------------------------------------------- report */

for (const { url, status, problems } of results) {
  if (problems.length) console.log(`✗ ${url} [${status}] ${problems.join("; ")}`)
}

console.log(
  failures
    ? `\n${failures} of ${results.length} pages have problems (and the 404 path returned ${missing.status})`
    : `\n${results.length} pages checked: no leaked template syntax, no undefined, no double-escaped entities, header and footer on every one`,
)

process.exit(failures ? 1 : 0)
