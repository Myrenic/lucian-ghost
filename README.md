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
  The URL follows the title; Ghost's own SEO fields are on the right. All 40
  imported pages are native editor content - paragraphs, headings, lists, rules,
  one button card, and not a single raw-HTML block - so they edit like anything
  written in Ghost.
- **Articles** are the other half: Posts -> New post writes to `/artikelen/`, and
  the homepage lists the three newest once any exist. Ghost keeps the two apart
  on purpose (a page is a standing page, a post is a dated article), and this
  site's existing content is all pages.
- **Menu**: Settings -> Design -> Navigation (the header) and Secondary
  navigation (the footer's Info column). Both are Ghost settings, so no deploy.
- **Hero text, statement, contact block, social links**: Settings -> Design ->
  the theme's own settings groups (`homepage`, `site-wide`). The values in
  `theme/package.json` are only defaults. `contact_kvk` and `contact_btw` are two
  more: empty, and the footer's legal line is the name and the place; filled in,
  it reads `© LUCIAN · Winschoten · KvK ... · BTW ...`.
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

The database and the uploads land in `content/`, which is git-ignored. The
initContainer also installs two files into that directory, and locally they have
to be put there by hand or the article list and the old URLs simply do not exist:

```sh
# routes.yaml goes in settings, redirects.json in data - Ghost reads them from
# two different places and fails silently if they are in the wrong one.
mkdir -p content/settings
jq -r '.data."routes.yaml"'    base/content.configmap.json > content/settings/routes.yaml
jq -r '.data."redirects.json"' base/content.configmap.json > content/data/redirects.json
```

Then restart the container (`docker restart ghost-dev`): Ghost reads both at boot.

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
2. Settings -> Staff -> your user -> *Staff access token*, key `id:secret`, then
   run the import above against the public URL. It activates the theme as well:
   a fresh install serves Ghost's starter theme, and ours is only *present* in
   the volume until something selects it.

## Signing in

Ghost admin is at `https://lucian.<domain>/ghost/`, and the Traefik route keeps
that path on the LAN - a CMS admin reachable from the internet is a liability
nobody asked for. The owner account is `info@luciancs.nl`; its password was
generated when the instance was bootstrapped and handed over with it.

Ghost 6 emails a six-digit code for every login after a user's first, so without
mail nobody can sign in at all. `security__staffDeviceVerification` is therefore
`false` on the deployment: the password is the only factor until an SMTP Secret
exists, which is defensible behind a LAN-only route and should be revisited at
go-live. Removing that env var restores the default.

Adding a second staff member is an **invite**, and invites are emails, so that
needs the mail Secret too - there is no other path in Ghost's admin. Until then,
automation can use API keys: staff tokens for full access, integration keys for
content.

## Operations

- **Backups**: a CronJob asks Ghost for its own export over the Admin API
  (`/ghost/api/admin/db/`) and keeps a week on a small claim of its own - it
  deliberately does not mount the content volume, which is ReadWriteOnce and held
  by the Ghost pod, and which a second Ghost process against the same SQLite file
  should not touch. It ships **suspended**: run it once by hand, confirm it leaves
  a JSON file, then drop the `suspend: true`. That covers a bad edit or a wrong
  deletion; it does not cover losing the volume, and the copies sit on the same
  cluster, so copy them off it if the content matters. Restore by importing the
  JSON in Ghost admin.
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

## Checking a deploy

After the pin is bumped and Flux has rolled the pod, crawl what is actually
served:

```sh
node scripts/check-pages.mjs https://lucian.<domain>
```

It reads the sitemap, so it walks every page, and it fails on the things a unit
test cannot see: template syntax that leaked into the HTML, a template that
printed `undefined`, an entity escaped twice, a page without a header or footer,
a page that is not 200, and a 404 path that is not a 404. It exists because a
malformed comment (`{#-- ... --#}`) printed itself at the top of all 39 interior
pages and nothing was looking at the rendered output.

## Search engines

Everything Ghost generates is in place and carries the import's own SEO data:
per-page titles, meta descriptions, canonicals, Open Graph, Twitter cards, JSON-LD
and a sitemap. On top of it the theme states the business itself - an
`AccountingService` (schema.org's type for a bookkeeping firm) with the address
and phone from the theme settings - which is what a local search result is built
from.

`lucian.<domain>` is deliberately **not indexable**: Traefik sends
`X-Robots-Tag: noindex, nofollow`, so this preview cannot compete with the
client's own site in a result. Lighthouse scores the site 66 for SEO on that
single audit, and 100 on everything else.

Going live on the client's domain, in order:

1. Add the domain and its certificate to the cluster (the same way the current
   one is served: a `domain-N-prod-tls` secret and a route host).
2. Point Ghost at it: set `url` on the Deployment (and the CronJob) to
   `https://<their-domain>` - Ghost builds canonicals, the sitemap and every
   absolute link from it, so this is the step that must not be skipped.
3. Drop the `noindex` middleware from the route in
   `nebula/kubernetes/apps/network/exposure/lucian.yaml`, and decide about
   `/ghost`: leave it LAN-only (the office is on this network), put it behind
   `oauth2-proxy-auth`, or accept Ghost's own sign-in and make it public.
4. Re-run the import against the new URL, so the redirects point at the client's
   host rather than this one.
5. Check `robots.txt` and `sitemap.xml` answer on the new host, and that a
   handful of old `.html` URLs 301 where they should.

The article list used to title itself with the site name, because a collection
written in `routes.yaml` renders with an *empty* context and no `{{#is}}` can
single it out. `{{url}}` is set on every route instead, so `default.hbs` names
that page by URL: `Artikelen - LUCIAN`. (Ghost's `match` helper compares a bare
`{{url}}` as an object and always says no; the subexpression - `{{#match (url)}}`
- is what unwraps it.) Checked on the collection itself, and on the tag, author,
page and 404 routes, which keep Ghost's own titles.

## How this compares with the client's current site

The first version of this theme modernised the design; the client then compared it
with the WordPress site they have today and asked for the layout to line up. What
was measured from `www.luciancs.nl` and matched:

| | their site | here |
|---|---|---|
| hero band | 460px, text centred | 460px, text centred |
| hero heading | 46px, weight 700, white | 46px, weight 700, white |
| hero veil | `rgba(100,33,33,.63)` over the photograph | the same colour, the same photograph |
| quote band veil | `.mbr-overlay`: `#500000` at 60% over the city photograph | the same colour, the same photograph |
| statement band | 24px, muted grey, centred, between two 278px rules | 24px, muted grey, centred, between two 278px rules |
| article body | 16px, grey | 16px, grey |
| article headings | maroon, bold (h1 22.4px) | maroon, bold (h1 22.4px, h2 20px, h3 16px) |
| header height | 77px | 77px |
| footer columns | Adres, Contact, Info, Trending | the same four |

Still deliberately different, and worth a decision rather than a guess:

- **The chrome.** Their header and footer are flat light grey (#eee) with dark
  text; this theme keeps a sticky, blurred near-white header and the dark footer
  from the rebuild. Matching theirs is a colour change in two files.
- **The service panels.** Theirs are flat and centred - no white panel, no ring,
  an 80px icon, centred grey text with a maroon title. This theme draws them as
  cards: a 32px maroon icon and a 16px title over a 14px list, left-aligned, with
  the lists bottom-aligned so the rules inside the four of them line up.
- **The hero on interior pages.** Theirs repeats the homepage slogan on every page
  at 460px and puts the page's own name inside the article. Here the hero names
  the page, in the same band as the homepage on a phone but 368px from `sm` up: a
  one-line page title does not need a whole 460px band on all 42 of them, and
  there is nothing else in that band.
- **Content heading sizes.** Their h2 and h3 are the same 16px, which leaves
  headings indistinguishable from body text. This theme keeps h2 at 20px so the
  outline is visible.

## Differences from the static build, on purpose

- Every interior page shows its name in the hero band; the static build only did
  that for pages whose article had no `h1` of its own. The name is dropped from
  the body when it repeats the title, so nothing is said twice.
- Content headings: the source marked 216 of its 258 headings maroon and left the
  rest dark, and the split cannot survive Ghost's editor (it strips classes and
  inline styles). `h1`/`h2` and the smaller `h3`/`h4` are all maroon, which is
  what most of the source looked like anyway.
- Text alignment, per-heading font sizes and the maroon runs inside paragraphs
  are lost in the same way. The writer can re-align in the editor.
- The homepage gains a Kenniscentrum band listing the three newest posts, once
  the client writes any. There are no posts to import today: their WordPress
  blog holds one artefact page, not articles.
- 404 pages, the article list at `/artikelen/` and the contact form's mailto
  behaviour are new; the form still does not store anything anywhere.
- Interaction the static build did not have: a skip link as the page's first tab
  stop, 44px touch targets for the header button, the drawer links, the footer
  links and the social icons, and the menu from `lg` rather than `md` - the seven
  items need 716px, so at 768-819 a bar wider than the viewport panned the whole
  page sideways. A keyboard-focused service card draws the ring around the panel.
