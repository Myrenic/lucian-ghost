#!/usr/bin/env node
/**
 * Builds the theme and packs it for the cluster.
 *
 *   1. Tailwind compiles theme/assets/css/screen.css -> assets/built/screen.css
 *   2. every theme file is gzipped and committed as base/theme.configmap.json
 *   3. the shell the pods run is packed the same way into base/scripts.configmap.json
 *   4. base/deployment.yaml gets a checksum of the result
 *
 * There is no image registry in this cluster, so the theme travels as a
 * ConfigMap and an initContainer unpacks it into the content volume - the same
 * arrangement lucian-cs uses for the static build. Two details matter:
 *
 *   - A ConfigMap key may not contain a slash, so "partials/header.hbs" is
 *     stored as "partials__header.hbs.gz"; the initContainer turns it back.
 *   - Everything goes in binaryData, base64 of gzip. Flux runs envsubst over
 *     every resource it applies; base64 has no "$" in its alphabet, so neither
 *     the theme nor the shell scripts can collide with a ${VARIABLE}, whatever
 *     someone writes in them later.
 *
 * The output is deterministic - no timestamps, sorted keys - because CI rebuilds
 * it and fails if the committed ConfigMap differs.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const themeDir = join(repo, "theme")

/* Not part of the theme Ghost runs: the dependency tree, the lockfile, and the
   Tailwind source (its compiled output in assets/built is what Ghost loads). */
const SKIP = new Set(["node_modules", "package-lock.json", ".git", ".DS_Store"])
const SKIP_PREFIXES = ["assets/css/"]

const walk = (dir) => {
  const found = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const relativePath = relative(themeDir, path) + (statSync(path).isDirectory() ? "/" : "")
    if (SKIP_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

/* ------------------------------------------------------------------- build */

console.log("· tailwind")
execFileSync("npm", ["run", "--silent", "build"], { cwd: themeDir, stdio: "inherit" })

/* --------------------------------------------------------------- pack it */

const files = walk(themeDir)
const binaryData = {}
const digest = createHash("sha256")

for (const file of files) {
  const name = relative(themeDir, file)
  const key = `${name.replaceAll("/", "__")}.gz`
  const bytes = readFileSync(file)
  digest.update(name)
  digest.update(bytes)
  binaryData[key] = gzipSync(bytes, { level: 9 }).toString("base64")
}

const manifest = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {
    name: "lucian-ghost-theme",
    namespace: "services",
    labels: { app: "lucian-ghost" },
  },
  binaryData,
}

const out = join(repo, "base", "theme.configmap.json")
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")

const bytes = Object.values(binaryData).reduce((total, value) => total + value.length, 0)
console.log(`· theme: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB base64 -> ${relative(repo, out)}`)

/* ------------------------------------------------ and the pod-side shell */

/* The init and backup scripts travel the same way and for the same reason: a
   shell script inline in a manifest is a pile of "$" signs for envsubst to eat.
   Keeping them as files also means they can be linted and run locally. */
const scriptFiles = ["install-theme.sh", "backup.mjs", "lib/ghost-admin.mjs"]
const scriptData = {}
for (const name of scriptFiles) {
  const bytes = readFileSync(join(repo, "scripts", name))
  digest.update(name)
  digest.update(bytes)
  // Same flattening as the theme: a ConfigMap key may not contain a slash, so
  // "lib/ghost-admin.mjs" is stored as "lib__ghost-admin.mjs.gz" and the
  // CronJob's initContainer turns it back before node runs it.
  scriptData[`${name.replaceAll("/", "__")}.gz`] = gzipSync(bytes, { level: 9 }).toString("base64")
}

const scriptsOut = join(repo, "base", "scripts.configmap.json")
writeFileSync(
  scriptsOut,
  JSON.stringify(
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "lucian-ghost-scripts",
        namespace: "services",
        labels: { app: "lucian-ghost" },
      },
      binaryData: scriptData,
    },
    null,
    2,
  ) + "\n",
)
console.log(`· scripts: ${scriptFiles.length} files -> ${relative(repo, scriptsOut)}`)

/* ------------------------------------------------- and stamp the checksum */

const checksum = digest.digest("hex").slice(0, 32)
const deploymentPath = join(repo, "base", "deployment.yaml")
const deployment = readFileSync(deploymentPath, "utf8")
const stamped = deployment.replace(
  /checksum\/theme: "[0-9a-f]*"/,
  `checksum/theme: "${checksum}"`,
)

if (stamped === deployment) {
  if (!deployment.includes(`checksum/theme: "${checksum}"`)) {
    throw new Error("base/deployment.yaml has no checksum/theme annotation to stamp")
  }
  console.log("· checksum unchanged")
} else {
  writeFileSync(deploymentPath, stamped)
  console.log(`· checksum/theme: ${checksum}`)
}
