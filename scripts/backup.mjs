#!/usr/bin/env node
/**
 * Nightly content export, run from the backup CronJob.
 *
 * It asks the running Ghost for its own export over the Admin API rather than
 * reading the content volume, for two reasons: that claim is ReadWriteOnce and
 * mounted by the Ghost pod, so a second pod cannot have it, and a second Ghost
 * process against the same SQLite file is not something to put on a schedule.
 * The export lands on a small volume of its own.
 *
 * What this protects: a bad edit, a page deleted by mistake, a setting nobody
 * can remember. What it does not: losing the volume Ghost runs on. Copy these
 * somewhere off the cluster if the content matters.
 *
 * The key comes from the CronJob's Secret and can be a plain integration key -
 * Ghost's token allowlist lets integrations read /db/.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { adminToken } from "./lib/ghost-admin.mjs"

const url = process.env.GHOST_URL?.replace(/\/$/, "")
const key = process.env.GHOST_ADMIN_KEY
const dir = process.env.BACKUP_DIR ?? "/backups"
const keep = Number(process.env.BACKUP_KEEP ?? "7")

if (!url || !key) {
  console.error("GHOST_URL and GHOST_ADMIN_KEY are required")
  process.exit(1)
}

const response = await fetch(`${url}/ghost/api/admin/db/`, {
  headers: { authorization: `Ghost ${adminToken(key)}`, "accept-version": "v6.0" },
})

if (!response.ok) {
  throw new Error(`export failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
}

const payload = await response.json()
if (!payload.db?.[0]?.data) throw new Error("the export came back without any data")

mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const file = join(dir, `${stamp}.json`)
writeFileSync(file, JSON.stringify(payload))

const exports_ = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time)

for (const old of exports_.slice(keep)) unlinkSync(join(dir, old.name))

console.log(`wrote ${file} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KiB), keeping ${Math.min(exports_.length, keep)}`)
