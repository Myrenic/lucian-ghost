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
/* every internal link the pages point at, checked once each at the end */
const internal = new Map()

for (const url_ of [...urls].sort()) {
  const url = url_
  const response = await fetch(url)
  const body = await response.text()
  const problems = []

  if (response.status !== 200) problems.push(`HTTP ${response.status}`)

  for (const check of CHECKS) {
    if (check.presence) continue
    const found = body.match(check.pattern)
    if (found) problems.push(`${check.what} (${found[0].slice(0, 40)})`)
  }

  /* Menu and footer links are the ones a reader clicks first, and they were all
     pointing at "/" once: {{url}} is a Ghost helper that returns the current
     page's URL, so it overrode the navigation item's own field. Distinctness is
     the check that catches it. */
  const navHrefs = [...body.matchAll(/<nav[\s\S]*?<\/nav>/g)]
    .flatMap(([nav]) => [...nav.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]))
  /* Concentration, not distinctness: the mobile menu repeats the desktop one, so
     a healthy nav has each destination twice. What is never healthy is one
     destination taking most of the links, which is how "every menu item points
     at the page you are on" looks. */
  const counts = {}
  for (const href of navHrefs) counts[href] = (counts[href] ?? 0) + 1
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (worst && worst[1] > Math.max(2, navHrefs.length / 2)) {
    problems.push(`${worst[1]} of ${navHrefs.length} menu links go to ${worst[0]}`)
  }
  if (navHrefs.some((href) => href === "" || href === "#")) {
    problems.push("a menu link is empty")
  }

  /* collect the links in the page itself, to check them once at the end */
  for (const [, href] of body.matchAll(/<a[^>]+href="([^"]+)"/g)) {
    if (/^(mailto:|tel:|#)/.test(href)) continue
    const url = href.startsWith("http") ? href : new URL(href, url_).href
    if (url.startsWith(base) && !internal.has(url)) internal.set(url, url_.replace(base, ""))
  }

  if (!body.includes("<header")) problems.push("no <header>")
  if (!body.includes("</footer>")) problems.push("no </footer>")
  if (!/<title>[^<]+<\/title>/.test(body)) problems.push("no <title>")

  results.push({ url: url.replace(base, ""), status: response.status, problems })
  if (problems.length) failures++
}

/* ------------------------------------------------- every link they point at */

const broken = []
for (const [url, from] of internal) {
  const response = await fetch(url, { redirect: "follow" })
  if (response.status !== 200) broken.push(`${url} (${response.status}) from ${from}`)
}
if (broken.length) {
  failures++
  for (const entry of broken.slice(0, 15)) console.log(`✗ broken link: ${entry}`)
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
    ? `\n${failures} problem${failures === 1 ? "" : "s"} across ${results.length} pages (404 path returned ${missing.status}, ${internal.size} internal links checked)`
    : `\n${results.length} pages, ${internal.size} internal links: no leaked template syntax, no undefined, no double-escaped entities, header and footer everywhere, no broken links`,
)

process.exit(failures ? 1 : 0)
