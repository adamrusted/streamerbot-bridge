# sb-bridge

Emulates the Streamer.bot WebSocket API so tools built for Streamer.bot (overlays, widgets, decks) run on top of Firebot (priority), Aitum Nexus, Mix It Up, SAMMI, or anything that can POST JSON. Source apps push events in; the bridge translates them into Streamer.bot events and requests. Connecting directly to streaming platforms (Twitch EventSub, YouTube, Kick) is out of scope: the bridge only talks to streaming apps.

## Shape

`adapters/*` → `core/Bridge` (event bus, action and global routing, trackers) → `sb/sb-websocket-server.ts` + `http/http-server.ts`. An adapter implements only the parts of `Adapter` (`src/core/types.ts`) its app supports. Request handlers talk only to `Bridge`, never to adapters.

Two inbound styles:

- **Firebot (pushed by our script):** `integrations/firebot/sb-bridge.js` (a Firebot startup script, CommonJS) wraps `eventManager.triggerEvent` and POSTs every event to `/ingest/firebot/event`. `firebot-mapper.ts` turns each into Streamer.bot events.
- **Webhook-style (the user builds a request in the app):** Aitum (Send Webhook → `/ingest/aitum/<platform>/<trigger>`), Mix It Up (Web Request → `/ingest/mixitup/<event>`), SAMMI (one button → `/ingest/sammi/event/<trigger type>` with the stringified trigger object). The app substitutes variables into the body as raw text, so bodies are often invalid JSON. `adapters/shared/webhook-fields.ts` (`parseLenient`, coercion, `normalizeKeys`) handles that. Route names and body keys are a **user-facing contract** documented in `docs/<app>.md`; change code and doc together.

Every adapter publishes through `Bridge.emit`, never `bus.publish` directly. `emit` runs `src/enrich/enricher.ts`, which fills missing Twitch detail (ids, colour, roles, subs, badge images, emotes) from public unauthenticated services (ivr.fi, 7TV, BTTV/FFZ). It waits at most `enrichment.timeoutMs`, then publishes in arrival order. Enrichment only fills gaps or upgrades defaults; it never overwrites what the source app sent. Public, unauthenticated lookups like these (and alejo.io pronouns) are in scope; anything needing a platform login is not.

Outbound, per app: Firebot presets / Aitum commands / Mix It Up commands / SAMMI configured webhooks+buttons are actions. Firebot custom variables / Aitum state / Mix It Up counters / SAMMI variables are globals. SAMMI can't enumerate buttons or variables, hence `sammi.actions` / `sammi.globals` in config and `Adapter.getGlobal`.

## Rules that aren't visible in the code

- **Superset payloads.** Streamer.bot 1.x and 0.2.x payload shapes differ, and widgets read both. Builders in `src/sb/payloads/` emit both sets of fields; when the two collide, 1.x wins. Add new events there, never ad hoc in an adapter.
- **Reference client.** The Nutty multichat overlay (widgets.nutty.gg/multichat-overlay) is the compatibility target. Its field paths are listed in `docs/protocol-notes.md`, and `test/firebot-mapper.test.ts` asserts them. A payload change that breaks those assertions breaks real users.
- **Never fail a widget's unguarded read.** `GetUserPronouns` always returns a `pronoun` object. Message `parts` only use types widgets know (`text|emote|cheer|mention`). Badges are only emitted with a real `imageUrl` (widgets render `<img src>` per badge).
- **Cheers emit Cheer only**, never ChatMessage as well, because widgets render the chat line from the Cheer event.
- **Stable fake ids.** When an app gives no user id, derive one from the login (`aitum-<login>`, `mixitup-<login>`, `sammi-<login>`), never `''`. Widgets group consecutive messages by `user.id`. The enricher recognises these prefixes and replaces them everywhere in the payload with the real id, so keep the prefix list in `enricher.ts` in sync.
- **Badges may be emitted without images** (e.g. SAMMI's name-only badge list) for the enricher to resolve. `stripImagelessBadges` runs on every emit, enrichment on or off.
- **Tests never reach real public APIs.** `startTestBridge` disables enrichment; `test/enrichment.test.ts` points the base URLs at `startFakeApi`.
- Firebot meta names and SAMMI whole-object keys are partly **assumed**. Read with fallbacks, and record confirmations in `docs/protocol-notes.md`.

## Working here

- TypeScript runs natively on Node ≥ 23.6 (type stripping, no build step). Use erasable syntax only: no enums, no parameter properties, no namespaces. Imports end in `.ts`. Type-only imports use `import type`.
- Use pnpm only; `npx` is rejected by `devEngines`. Done means `pnpm typecheck` and `pnpm test` both pass.
- `dev` is the working branch: branch from it and target PRs at it. Never commit to or open feature PRs against `main`; `main` only receives `dev` (as a merge commit) and the release-please PR. See `docs/releasing.md`.
- Commit messages and PR titles are conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …; `!` or a `BREAKING CHANGE:` footer for breaking changes). release-please derives the version and `CHANGELOG.md` from them, so never edit `version` in `package.json` or the changelog by hand. Breaking changes include the user-facing contract: route names, body keys, config keys.
- `test/streamerbot-client.test.ts` drives the bridge with the official `@streamerbot/client`, the same library widgets load. It is the strongest compatibility check; extend it when adding requests. Outbound adapter calls are tested against `startFakeApi` (`test/helpers.ts`).
- The developer's machine may have live Firebot at `:7472`. GETs against it are safe for verifying shapes. Anything that runs effects, presets, commands, buttons or chat acts on a live stream, so ask first. Mix It Up (`:8911`) and SAMMI (`:9450`) were not running when their adapters were written.

## Reference

- `docs/protocol-notes.md`: read before changing a payload, request, or adapter API call. It lists what is verified vs assumed, with sources.
- `README.md`: user setup and the cross-app capability table.
- `docs/aitum.md`, `docs/mixitup.md`, `docs/sammi.md`: per-app user guides (setup, a body per trigger/event, limitations). Update the matching guide when a route, key or limitation changes.
