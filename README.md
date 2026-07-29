# Shopdart

Shoppable videos for Shopify. Merchants bring in reels from their own Instagram
account or upload video directly, tag the products that appear, and drop the
result onto their storefront as a gallery, carousel, stories bar, floating
player, product-page block or popup. Shoppers buy from inside the player.

Competing with ReelUp, Tolstoy, Quinn, Videowise and Vimotia.

## Stack

| Layer | Choice |
|---|---|
| App framework | React Router 7 (Shopify's official template) |
| Admin UI | Polaris web components via App Bridge |
| Database | Postgres + Prisma |
| Video hosting | Bunny Stream (encode, HLS + MP4, global delivery) |
| Widget config delivery | Bunny CDN pull zone |
| Storefront | Theme app extension (app block) |
| Hosting | Coolify |

## Getting started

```bash
cp .env.example .env      # then fill in the values

docker run --name shopdart-pg -e POSTGRES_PASSWORD=shopdart \
  -e POSTGRES_DB=shopdart -p 5432:5432 -d postgres:16

npm install
npx prisma migrate dev --name init
npm run dev
```

## Roadmap

- [x] **Phase 1 — Foundation.** Scaffold, Postgres data model, OAuth and session
      storage, shop provisioning on install/uninstall, admin shell.
- [ ] **Phase 2 — Video pipeline.** Bunny Stream ingest, transcode webhook,
      poster frames, library UI, plan-limit enforcement.
- [ ] **Phase 3 — Instagram.** Facebook Login, Business account linking, reel
      sync, per-shop token refresh.
- [ ] **Phase 4 — Tagging and widgets.** Product picker with timestamp ranges,
      six widget layouts, placement rules.
- [ ] **Phase 5 — Storefront.** Theme app extension and the player itself.
- [ ] **Phase 6 — Analytics and billing.** Event ingest, revenue attribution,
      Shopify Billing API, view-cap enforcement.

## Decisions worth knowing

**No TikTok.** Two reasons. India is ~31% of this market's installs and TikTok
has been banned there since 2020, alongside ten other countries. More
fundamentally, no official TikTok API returns a downloadable file — you only get
an embed iframe, which makes product tags, forced autoplay and in-player
add-to-cart impossible. The same limitation applies to YouTube Shorts. Only the
Instagram Graph API (`media_url`) and direct upload yield a real MP4 we can
re-host, which is why those are the two early sources. `VideoSource` is an
adapter boundary so embed-only sources can be added later as a degraded tier.

**No public-URL scraper.** ReelUp resolves arbitrary pasted Instagram links.
That requires an unofficial scraper with ongoing breakage and ToS risk. We sync
only accounts the merchant owns and authorises.

**Widget config is served from a CDN, not from our origin.** App metafields
would be free and outage-proof, but they are cached in Liquid for several hours
— a merchant changing a colour would not see it until the next day. Instead the
theme extension fetches a JSON payload from a Bunny pull zone, purged on save
and keyed on `Widget.configVersion`. Edits go live immediately, storefronts stay
up if our origin is down, and shoppers worldwide get an edge response.

**MP4 before HLS.** For clips under ~60s a progressive MP4 reaches first frame
faster than HLS and needs no `hls.js` payload outside iOS Safari. HLS is
lazy-loaded only for longer videos. Roughly 30KB less JavaScript on most stores.

**Attribution is deterministic, not modelled.** Web Pixels run sandboxed with no
DOM access, so they cannot observe our player. Player events go to our ingest
endpoint via `sendBeacon`; purchases are matched through cart attributes read
back in the `orders/create` webhook.

**Views are filtered before they are billed.** Bot traffic and repeat
impressions inflate metered counts, push merchants over plan caps they did not
earn, and produce exactly the one-star reviews this category is decided by.
Filtering is cheap now and expensive to retrofit after billing disputes start.
