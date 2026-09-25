#!/bin/sh
# Nightly content export, run from the backup CronJob.
#
# Like install-theme.sh, this ships as gzipped base64 in a ConfigMap rather than
# inline in the manifest: Flux builds the cluster with envsubst, and a shell
# script in a YAML block scalar is mostly "$" signs.

set -eu

DIR=/var/lib/ghost/content/backups
KEEP=7

mkdir -p "$DIR"
cd /var/lib/ghost

# The whole site - pages, settings, which theme is active - as JSON next to the
# database. It is the thing to re-import after a bad edit.
ghost export "$DIR/$(date +%Y-%m-%dT%H%M%S).json" --no-prompt

# Keep a week; older exports are noise nobody reads.
count=$(ls -1 "$DIR"/*.json | wc -l)
if [ "$count" -gt "$KEEP" ]; then
  ls -1t "$DIR"/*.json | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
  done
fi

echo "kept $(ls -1 "$DIR"/*.json | wc -l) exports"
