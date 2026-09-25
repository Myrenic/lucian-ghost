# lucian-ghost

The LUCIAN site as a Ghost theme, plus what the cluster needs to run it.

Ghost replaces the static rebuild that lives in
[`lucian-cs`](https://github.com/Myrenic/lucian-cs): the design, the content and
the URLs are the same, but the client's writer now edits pages in Ghost's editor
instead of asking a developer to change JSX. The static build stays where it is,
as the design reference and the fallback the theme was ported from.

```
theme/                 the Ghost theme (Handlebars + Tailwind), installed by Ghost
  assets/css/screen.css   the design tokens, copied value for value from lucian-cs
  assets/js/main.js       the small-screen menu and the contact form, ~150 lines
media/                 files the importer uploads into Ghost (photograph, social card, terms)
scripts/build-theme.mjs    compiles the CSS and packs the theme into the cluster ConfigMap
scripts/import-content.mjs seeds a Ghost instance with the site (pages, menu, settings, redirects)
base/                  the Kubernetes manifests and the two generated ConfigMaps
```

## What the client can change without a developer

Everything that used to be a page is now a **Ghost page** - 40 of them, imported
with their text, headings, lists and internal links intact.

- **Add or edit a page**: Ghost admin -> Pages -> New page. Write, then Publish.
  The URL follows the title; Ghost's own SEO fields are on the right.
- **Menu**: Settings -> Design -> Navigation (the header) and Secondary
  navigation (the footer's Info column). Both are Ghost settings, so no deploy.
- **Hero text, statement, contact block, social links**: Settings -> Design ->
  the theme's own settings groups (`homepage`, `site-wide`). The values in
  `theme/package.json` are only defaults.
- **Contact page**: slug `contact` picks `page-contact.hbs`, which draws the form.
  Add the message text above the form in the editor and it appears (the template
  renders the form itself, so nothing in the page body is needed for it).

Still a developer's job: the homepage's four service panels and three quotes
(`theme/partials/services.hbs`, `theme/partials/testimonials.hbs`), because they
are a fixed grid of hand-written copy and nothing in the client's workflow
changes them.

## Working on the theme

Ghost serves a theme from its content directory. For a fast loop, run Ghost
locally with the theme bound in:

```sh
docker run -d --name ghost-dev -p 2368:2368 \
  -v "$PWD/content:/var/lib/ghost/content" \
  -v "$PWD/theme:/var/lib/ghost/content/themes/lucian" \
  -e NODE_ENV=development -e url=http://localhost:2368 \
  -e database__client=sqlite3 -e database__connection__filename=content/data/ghost.db \
  ghost:6-alpine
```

`NODE_ENV=development` makes Ghost re-read templates on every request. Rebuild the
stylesheet after changing `screen.css` or a template's classes:

```sh
npm --prefix theme run build     # or: npm --prefix theme run watch
```

Note that Ghost 6 sends a sign-in verification code by email, so a second login
needs working mail (local `Mailpit`, or SMTP in the pod's `lucian-ghost-mail`
Secret). The **first** login after an install skips the code, which is how the
bootstrap below gets in without mail.

## Importing the content (re-runnable)

`scripts/import-content.mjs` reads `lucian-cs/webui/src/content/{pages,site}.json`
- the WordPress import behind the static build - and writes it into a Ghost
instance: pages, the menu and footer navigation, the theme's settings, the
images, the terms PDF, and `base/redirects.configmap.json` for the old URLs. It
matches pages on slug, so running it again updates rather than duplicates. It
ends by fetching every page and reporting failures.

```sh
GHOST_URL=http://localhost:2368 GHOST_KEY=<id>:<secret> node scripts/import-content.mjs
GHOST_URL=https://lucian.example GHOST_KEY=... node scripts/import-content.mjs --dry-run
```

The key has to be a **staff token** - Ghost admin -> Settings -> Staff -> your
user -> *Staff access token*. An integration key can create pages and upload
images, but Ghost's token allowlist refuses `PUT /settings/` for integrations, so
the navigation and the theme's settings would silently not be written.

## Deploying

Push to `main`. Flux applies `base/`, which does not include an image: the theme
is committed as a ConfigMap (`scripts/build-theme.mjs`, run by CI on every push)
and an initContainer unpacks it into the content volume before Ghost starts. The
pod template carries a checksum of the theme, so a theme change is also a rollout.

Bootstrapping a fresh install, once:

1. `https://lucian.<domain>/ghost` -> create the owner account (name, email,
   password). This is Ghost's own setup screen.
2. Settings -> Integrations -> new custom integration, or Staff -> Staff access
   token, and run the import above against the public URL.
3. Confirm the theme is active: Settings -> Design. It ships in the volume, so it
   is already there and already selected.

## Operations

- **Backups**: a nightly CronJob writes `ghost export` JSON into
  `content/backups/` on the same volume and keeps a week. That covers a bad edit
  or a wrong deletion. It does not cover losing the volume - this cluster has no
  off-cluster copy, so if the content matters, copy that directory (or the claim)
  somewhere else. Restore by importing the JSON in Ghost admin.
- **Mail**: optional Secret `lucian-ghost-mail`, keys are Ghost's own config
  names (`mail__transport`, `mail__options__host`, `mail__options__port`,
  `mail__options__auth__user`, `mail__options__auth__pass`, `mail__from`). Only
  needed for sign-in verification codes from a new device, and for newsletters.
  Absent, the site runs - staff just cannot complete a login from a new device.
- **Database**: SQLite on the content volume, one replica. That is the simple
  end of Ghost's supported range: fine for one writer and a read-mostly site, not
  for concurrent staff or heavy traffic. Moving to MySQL 8 later means standing up
  a database (the cluster already runs one for `mushroom-finder`) and pointing
  `database__client` at it; the import script can re-seed it.
- **URLs**: the old WordPress URLs (`/administratiekantoor/quickscan.html`) 301 to
  the Ghost ones (`/quickscan/`) via `content/data/redirects.json`, which the
  initContainer installs. Ghost cannot nest page slugs, so everything is flat.
  Regenerate after a content change with the import script.
- **Preview host**: `lucian.<domain>` is unlisted and served with
  `X-Robots-Tag: noindex` from the Traefik route in nebula. Ghost's own
  `robots.txt` allows crawling, which is correct once the site is on the client's
  own domain.

## Differences from the static build, on purpose

- Every interior page shows its name in the hero band; the static build only did
  that for pages whose article had no `h1` of its own. The name is dropped from
  the body when it repeats the title, so nothing is said twice.
- Content headings: the source marked 216 of its 258 headings maroon and left the
  rest dark, and the split cannot survive Ghost's editor (it strips classes and
  inline styles). `h1`/`h2` - the section headings - are maroon, `h3`/`h4` take
  the body colour.
- Text alignment, per-heading font sizes and the maroon runs inside paragraphs
  are lost in the same way. The writer can re-align in the editor.
- The homepage gains a Kenniscentrum band listing the three newest posts, once
  the client writes any. There are no posts to import today: their WordPress
  blog holds one artefact page, not articles.
- 404 pages, the article list at `/artikelen/` and the contact form's mailto
  behaviour are new; the form still does not store anything anywhere.
