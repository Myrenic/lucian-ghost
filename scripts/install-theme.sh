#!/bin/sh
# Installs the site into Ghost's content volume, before Ghost itself starts.
#
# Run by an initContainer as plain "/bin/sh /scripts/install-theme.sh" - the
# script travels as gzipped base64 in a ConfigMap rather than as a YAML block
# scalar, because Flux runs envsubst over every resource it applies and this file
# is nothing but shell variables.
#
# Volumes, as mounted by base/deployment.yaml:
#   /theme      lucian-ghost-theme     the packed theme, keys flattened with __
#   /scripts    lucian-ghost-scripts   this file and backup.sh
#   /content-dir lucian-ghost-content  redirects.json (old URLs) and routes.yaml
#   /content    the claim              Ghost's content directory

set -eu

THEME=/content/themes/lucian

# The theme is ours and code-owned, so it is replaced wholesale: a template
# deleted in the repository has to disappear here too.
rm -rf "$THEME"
mkdir -p "$THEME"
cd "$THEME"

# A ConfigMap key may not contain a slash, so "partials/header.hbs" arrives as
# "partials__header.hbs.gz" and every file is gzipped. Turn both back.
for file in /theme/*; do
  name=$(basename "$file")
  out=$(printf '%s' "$name" | sed -e 's/\.gz$//' -e 's/__/\//g')
  mkdir -p "$(dirname "$out")"
  gunzip -c "$file" > "$out"
done

# Ghost reads both of these from the content directory: redirects.json carries
# the old WordPress .html URLs, routes.yaml puts written articles on /artikelen/.
# Both are written by scripts/import-content.mjs.
mkdir -p /content/data
cp /content-dir/redirects.json /content/data/redirects.json
cp /content-dir/routes.yaml /content/data/routes.yaml

echo "installed $(find . -type f | wc -l) theme files"
