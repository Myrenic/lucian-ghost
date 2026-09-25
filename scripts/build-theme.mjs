#!/usr/bin/env node
/**
 * Builds the theme and packs it for the cluster.
 *
 *   1. Tailwind compiles theme/assets/css/screen.css -> assets/built/screen.css
 *   2. every theme file is gzipped and committed as base/theme.configmap.json
 *   3. the shell and node the pods run is packed the same way into
 *      base/scripts.configmap.json
 *   4. base/deployment.yaml gets a checksum of both
 *
 * There is no image registry in this cluster, so the theme and the scripts travel
 * as ConfigMaps and an initContainer unpacks them - the same arrangement
 * lucian-cs uses for the static build. Three details matter:
 *
 *   - A ConfigMap key may not contain a slash, so "partials/header.hbs" is stored
 *     as "partials__header.hbs.gz"; the pods turn it back.
 *   - Everything goes in binaryData, base64 of gzip. Flux runs envsubst over
 *     every resource it applies; base64 has no "$" in its alphabet, so neither a
 *     template nor a shell script can collide with a ${VARIABLE}.
 *   - The pod template carries the checksum, so a theme or script change is also
 *     a rollout: an initContainer only unpacks on pod start.
 *
 * `--check` verifies the committed ConfigMaps instead of writing them: same keys,
 * and every payload decompresses to the file it was packed from. It compares
 * decoded bytes on purpose - gzip output differs between zlib versions, so a byte
 * comparison would fail in CI for a theme nobody touched.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const themeDir = join(repo, "theme")
const check = process.argv.includes("--check")

/* Not part of the theme Ghost runs: the dependency tree, the lockfile, and the
   Tailwind source (its compiled output in assets/built is what Ghost loads). */
const SKIP = new Set(["node_modules", "package-lock.json", ".git", ".DS_Store"])
const SKIP_PREFIXES = ["assets/css/"]

const walk = (dir) => {
  const found = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const isDirectory = statSync(path).isDirectory()
    const relativePath = relative(themeDir, path) + (isDirectory ? "/" : "")
    if (SKIP_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue
    if (isDirectory) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

/* ------------------------------------------------------------------- build */

if (!check) {
  console.log("· tailwind")
  execFileSync("npm", ["run", "--silent", "build"], { cwd: themeDir, stdio: "inherit" })
}

/* ------------------------------------------------------------------- pack */

/* theme/ is the theme; everything else the pods need ships as a second ConfigMap,
   because a script inline in a manifest is a pile of "$" signs for Flux's
   envsubst to substitute away. Keeping them as files also means they are linted
   and testable. */
const themeFiles = walk(themeDir).map((path) => ({ name: relative(themeDir, path), path }))
const scriptFiles = ["install-theme.sh", "backup.mjs", "lib/ghost-admin.mjs"].map((name) => ({
  name,
  path: join(repo, "scripts", name),
}))

const payloads = new Map()
const digest = createHash("sha256")

const pack = (entries) => {
  const binaryData = {}
  for (const { name, path } of entries) {
    // A ConfigMap key may not contain a slash: "lib/ghost-admin.mjs" is stored as
    // "lib__ghost-admin.mjs.gz" and the CronJob's initContainer turns it back.
    const key = `${name.replaceAll("/", "__")}.gz`
    const bytes = readFileSync(path)
    digest.update(name)
    digest.update(bytes)
    payloads.set(key, bytes)
    binaryData[key] = gzipSync(bytes, { level: 9 }).toString("base64")
  }
  return binaryData
}

const themeData = pack(themeFiles)
const scriptData = pack(scriptFiles)
const checksum = digest.digest("hex").slice(0, 32)

const manifestFor = (name, binaryData) => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name, namespace: "services", labels: { app: "lucian-ghost" } },
  binaryData,
})

const themeOut = join(repo, "base", "theme.configmap.json")
const scriptsOut = join(repo, "base", "scripts.configmap.json")
const deploymentPath = join(repo, "base", "deployment.yaml")

/* -------------------------------------------------------- verify, or write */

if (check) {
  let problem = false
  const complain = (message) => {
    console.log(`::error::${message}`)
    problem = true
  }

  for (const [path, expected] of [
    [themeOut, manifestFor("lucian-ghost-theme", themeData)],
    [scriptsOut, manifestFor("lucian-ghost-scripts", scriptData)],
  ]) {
    const committed = JSON.parse(readFileSync(path, "utf8"))
    const keys = Object.keys(expected.binaryData).sort()
    const committedKeys = Object.keys(committed.binaryData ?? {}).sort()

    if (keys.join(",") !== committedKeys.join(",")) {
      complain(`${relative(repo, path)} packs a different set of files than the repository`)
      continue
    }

    for (const key of keys) {
      const packed = gunzipSync(Buffer.from(committed.binaryData[key], "base64"))
      if (!packed.equals(payloads.get(key))) {
        complain(`${relative(repo, path)} is stale for ${key.replaceAll("__", "/")}`)
      }
    }
  }

  if (!readFileSync(deploymentPath, "utf8").includes(`checksum/theme: "${checksum}"`)) {
    complain("base/deployment.yaml does not carry the current checksum/theme")
  }

  if (problem) {
    console.log("Run scripts/build-theme.mjs and commit the result.")
    process.exit(1)
  }

  console.log(`· theme and scripts match the repository (${themeFiles.length + scriptFiles.length} files, checksum ${checksum.slice(0, 12)})`)
  process.exit(0)
}

writeFileSync(themeOut, JSON.stringify(manifestFor("lucian-ghost-theme", themeData), null, 2) + "\n")
writeFileSync(scriptsOut, JSON.stringify(manifestFor("lucian-ghost-scripts", scriptData), null, 2) + "\n")

const base64Bytes = Object.values(themeData).reduce((total, value) => total + value.length, 0)
console.log(`· theme: ${themeFiles.length} files, ${(base64Bytes / 1024).toFixed(0)} KiB base64 -> ${relative(repo, themeOut)}`)
console.log(`· scripts: ${scriptFiles.length} files -> ${relative(repo, scriptsOut)}`)

const deployment = readFileSync(deploymentPath, "utf8")
const stamped = deployment.replace(/checksum\/theme: "[0-9a-f]*"/, `checksum/theme: "${checksum}"`)

if (stamped === deployment) {
  if (!deployment.includes(`checksum/theme: "${checksum}"`)) {
    throw new Error("base/deployment.yaml has no checksum/theme annotation to stamp")
  }
  console.log("· checksum unchanged")
} else {
  writeFileSync(deploymentPath, stamped)
  console.log(`· checksum/theme: ${checksum}`)
}
