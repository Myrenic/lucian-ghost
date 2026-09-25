#!/usr/bin/env node
/**
 * Template checks that GScan does not make. GScan runs separately in CI.
 *
 * The one that matters came from taking the client's site down: Handlebars ends a
 * *short* comment ({{! ... }}) at the first closing brace pair, so a helper name
 * written inside one truncates it and the rest of the sentence is compiled as
 * template - in that case leaving a block that was never closed, so every page
 * answered 500. Long comments ({{!-- ... --}}) run to their own terminator and
 * may contain anything, which is exactly why the two forms are treated apart.
 *
 * Also checks that a template only asks for partials that exist: otherwise the
 * first page to reference one is a 500 rather than a failed build.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"

// The top-level templates are the ones that matter most - the comment that took
// the site down was in default.hbs - so they are listed, not assumed.
const templates = [
  ...readdirSync("theme").filter((name) => name.endsWith(".hbs")).map((name) => `theme/${name}`),
  ...readdirSync("theme/partials").filter((name) => name.endsWith(".hbs")).map((name) => `theme/partials/${name}`),
]

let failed = false
const fail = (file, message) => {
  console.log(`::error file=${file}::${message}`)
  failed = true
}
const squash = (text) => text.replace(/\s+/g, " ").trim().slice(0, 60)

/** Everything outside comments: what Handlebars actually compiles. */
const withoutComments = (source) =>
  source
    .replace(/\{\{!--[\s\S]*?--\}\}/g, "")
    .replace(/\{\{![\s\S]*?\}\}/g, "")

for (const file of templates) {
  const source = readFileSync(file, "utf8")

  /* ---- comments have to be what they look like -------------------------- */
  for (const match of source.matchAll(/\{\{!/g)) {
    const rest = source.slice(match.index)

    if (rest.startsWith("{{!--")) {
      if (!rest.includes("--}}")) fail(file, `a long comment is never closed: ${squash(rest.slice(5))}`)
      continue
    }

    const body = rest.slice(3, rest.indexOf("}}", 3))
    // A nested opening brace means the comment ended at the first "}}" and the
    // remainder of it is being compiled as template.
    if (body.includes("{{")) {
      fail(file, `a short comment contains an opening brace, so it ends early: ${squash(body)}`)
    }
  }

  const compiled = withoutComments(source)

  /* ---- blocks must be closed -------------------------------------------- */
  const opens = (compiled.match(/\{\{#(if|unless|foreach|get|post|match|is)\b/g) ?? []).length
  const closes = (compiled.match(/\{\{\//g) ?? []).length
  if (opens !== closes) fail(file, `${opens} block helpers open, ${closes} closed`)

  /* ---- partials must exist ---------------------------------------------- */
  for (const match of compiled.matchAll(/\{\{>\s*"([^"]+)"/g)) {
    if (!existsSync(`theme/partials/${match[1]}.hbs`)) fail(file, `partial "${match[1]}" does not exist`)
  }
}

console.log(
  failed
    ? `${templates.length} templates checked, with problems above`
    : `${templates.length} templates checked: comments, blocks and partials all sound`,
)
process.exit(failed ? 1 : 0)
