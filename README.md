# sb-bridge

A drop-in Streamer.bot WebSocket server for people who use **Firebot**, **Aitum Nexus**, **Mix It Up** or **SAMMI**. Overlays and tools that connect to Streamer.bot's WebSocket (for example the [Nutty multichat overlay](https://widgets.nutty.gg/multichat-overlay/settings/)) connect to sb-bridge instead and receive Streamer.bot-style events.

```
Firebot ─────(startup script)──┐
Aitum Nexus ─(Send Webhook)────┤
Mix It Up ───(Web Request)─────┼──► sb-bridge ──► ws://127.0.0.1:8080/  (Streamer.bot API) ──► overlays/tools
SAMMI ───────(HTTP Request)────┤
anything ────(POST /ingest)────┘
```

## Quick start

Requires Node.js 23.6 or newer and pnpm.

```sh
pnpm install
pnpm start
```

### Standalone executable

To run without Node installed, build a single executable:

```sh
pnpm build:exe
```

This writes `dist/sb-bridge.exe` (or `dist/sb-bridge` on macOS/Linux) along with `sb-bridge.config.example.json` and the `integrations/` folder. Copy the `dist` folder wherever you like. The executable looks for `sb-bridge.config.json` in the working directory first, then next to the executable. The build only targets the OS it runs on. CI builds Windows x64, macOS (Apple Silicon and Intel) and Linux (x64 and arm64), and every GitHub release has all five attached.

sb-bridge listens on `ws://127.0.0.1:8080/`, the Streamer.bot default, so tools work without changing their settings. **Close Streamer.bot first** if it is installed, because both can't use port 8080.

### Connect Firebot

1. In Firebot open **Settings → Scripts**, enable custom scripts, then **Manage Startup Scripts → Add New Script**.
2. Pick `integrations/firebot/sb-bridge.js` from this folder. Keep the default bridge URL `http://127.0.0.1:8080` unless you changed the port.
3. Restart Firebot (or save the script). The sb-bridge console should log `Firebot script connected`.

sb-bridge also talks to Firebot's HTTP API (`http://127.0.0.1:7472`) for actions, globals and chat. Firebot is on by default.

### Connect Aitum Nexus, Mix It Up or SAMMI

Each has its own guide with ready-made request bodies:

| App | Turn on in `sb-bridge.config.json` | Guide |
|---|---|---|
| Aitum Nexus | `"aitum": { "enabled": true }` | [docs/aitum.md](docs/aitum.md): a Send Webhook action per trigger |
| Mix It Up | `"mixitup": { "enabled": true }` | [docs/mixitup.md](docs/mixitup.md): a Web Request action per event |
| SAMMI | `"sammi": { "enabled": true }` | [docs/sammi.md](docs/sammi.md): one forwarding button for every trigger |

### Connect an overlay

Point the tool at host `127.0.0.1`, port `8080`. If you set a password, enter the same one in the tool. For the Nutty multichat overlay, the defaults already match.

**Kick:** sb-bridge doesn't connect to Kick itself. Kick chat and events reach it through Firebot when you also run the Firebot Kick script (from the Firebot-Scripts project): its events become `Kick.ChatMessage`, `Kick.Follow` and the rest. Overlays like the Nutty multichat also connect to Kick themselves for subs, gifts, redemptions and deletions, once Streamer.bot tells them your channel. Set it in the config:

```json
{ "broadcaster": { "kick": { "login": "yourkickname" } } }
```

To test without going live, use Firebot's event simulator (**Events → Simulate Event**) or the PowerShell examples in each guide.

## What maps to what

| Streamer.bot | Firebot | Aitum Nexus | Mix It Up | SAMMI |
|---|---|---|---|---|
| Twitch events (`ChatMessage`, `Follow`, `Cheer`, `Sub`, `ReSub`, `GiftSub`, `GiftBomb`, `Raid`, `RewardRedemption`, hype trains…) | ✓ all | ✓ most | ✓ most | ✓ most |
| `ChatMessageDeleted`, `UserBanned`, `UserTimedOut`, `ChatCleared` | ✓ | — | ✓ | ✓ |
| YouTube (`Message`, `SuperChat`, `SuperSticker`, `NewSponsor`, `MemberMileStone`…) | — | ✓ | ✓ | ✓ |
| Donations (`Streamlabs.Donation`, `StreamElements.Tip`, …) | ✓ | — | — | — |
| Kick (`ChatMessage`, `FirstWords`, `Follow`, `Subscription`, `Resubscription`, `GiftSubscription`, `MassGiftSubscription`, `UserBanned`, `UserTimedOut`, `StreamOnline`/`StreamOffline`, `ChannelUpdate`) | ✓ with the Firebot Kick script | — | — | — |
| OBS (`Obs.SceneChanged`, streaming/recording) | ✓ | — | — | via `General.Custom` |
| `GetActions` / `DoAction` | Preset effect lists | Commands | Commands (args → special identifiers) | Configured webhook triggers / buttons |
| `GetGlobals` / `GetGlobal` | Custom variables | State variables | Counters | Configured variables (any name via `GetGlobal`) |
| `SendMessage` | Twitch | — | Twitch, YouTube, Kick | — |
| `General.Custom` | "Broadcast Custom Event" effect | POST to `/ingest/aitum` | POST to `/ingest/event` | Unmapped triggers |

Chat detail varies by app: Firebot and SAMMI send the most, Mix It Up sends IDs, colours and roles, and Aitum sends only names. sb-bridge fills the gaps from public lookups (next section), so overlays look much the same whichever app you use. Each guide's *Limitations* section lists what's still missing.

## Filling in missing detail

When an app doesn't send something, sb-bridge looks it up from public services that need no login. These are the same kind of services overlays already use, like the alejo.io pronoun lookup Streamer.bot uses.

| Filled in | From | Mainly helps |
|---|---|---|
| Real Twitch user ID, name colour, avatar (`user.profileImageUrl`) | [ivr.fi](https://api.ivr.fi/v2/docs) | Aitum |
| Moderator / VIP status | ivr.fi (your channel's mod and VIP lists) | Aitum |
| Sub status, tier and months | ivr.fi | Aitum |
| Badge images: broadcaster/mod/VIP, and your channel's own sub badge for the user's months and tier | ivr.fi | Aitum, Mix It Up, SAMMI |
| Emotes as images: Twitch (common globals and your channel's emotes), 7TV, BTTV, FFZ | ivr.fi, 7tv.io, betterttv.net | Aitum, Mix It Up; 7TV/BTTV/FFZ for all |
| Cheermote images | Twitch's image CDN | All |
| Broadcaster ID and partner/affiliate status in `GetBroadcaster` | ivr.fi | Aitum, Mix It Up, SAMMI |
| Pronouns (`GetUserPronouns`) | alejo.io | All |

- **It only fills gaps.** Information the app did send is never overwritten.
- **Set your Twitch channel name** if you don't use Firebot (Firebot reports it automatically). Roles, subs, channel badges and channel emotes need it: `"broadcaster": { "twitch": { "login": "yourname" } }`.
- **It's fast after the first message.** Lookups are cached (users for 6 hours, mod lists for 10 minutes, emotes for 30 minutes), and an event waits at most `enrichment.timeoutMs` (1.5 s) before going out as-is. Events always reach overlays in the order they arrived.
- **Everything is optional.** Set `"enrichment": { "enabled": false }` to turn lookups off, or switch off parts with `users`, `rolesAndSubs`, `badges` and `emotes`.
- **These are community services,** not official Twitch APIs. If one is down, events still go out without that detail.

sb-bridge answers these requests itself: `GetInfo`, `GetEvents`, `Subscribe`/`UnSubscribe`, `GetBroadcaster`, `GetActiveViewers` (built from recent chatters), `GetCredits`/`TestCredits`/`ClearCredits` (built from events), and `GetUserPronouns` (looked up on alejo.io). `GetCommands`, code triggers, emotes and per-user globals return empty results.

Payloads include both the Streamer.bot 1.x fields and the older 0.2.x fields, so widgets written for either version keep working.

## Sending events from anything else

| Route | Body | Result |
|---|---|---|
| `POST /ingest/event` | `{"event":{"source":"Kofi","type":"Donation"},"data":{...}}`, or an array of these | That exact event |
| `POST /ingest/custom` | any JSON | `General.Custom` with the body as `data` |
| `POST /ingest/aitum/<platform>/<trigger>` | flat Aitum trigger variables | See [docs/aitum.md](docs/aitum.md) |
| `POST /ingest/aitum` | same as `/ingest/event`, or any JSON | That event, or `General.Custom` |
| `POST /ingest/mixitup/<event>` | Mix It Up special identifiers | See [docs/mixitup.md](docs/mixitup.md) |
| `POST /ingest/sammi/event/<trigger type>` | stringified SAMMI trigger object | See [docs/sammi.md](docs/sammi.md) |
| `POST /ingest/firebot/event` | `{"sourceId","eventId","meta"}` | Mapped Firebot event (the script uses this) |

If `ingestToken` is set, send it in the `x-bridge-token` header or as `?token=` in the URL.

sb-bridge also emulates Streamer.bot's HTTP server on port 7474: `POST /DoAction` with `{"action":{"name":"..."},"args":{}}`, and `GET /GetActions`.

## Configuration

Copy `sb-bridge.config.example.json` to `sb-bridge.config.json` and keep only the keys you want to change. Environment overrides: `SB_BRIDGE_PORT`, `SB_BRIDGE_HOST`, `SB_BRIDGE_PASSWORD` (also turns auth on), `SB_BRIDGE_LOG_LEVEL`, `FIREBOT_URL`, `AITUM_URL`, `MIXITUP_URL`, `SAMMI_URL`, `SAMMI_PASSWORD`, `SB_BRIDGE_CONFIG` (config file path).

| Key | Default | Notes |
|---|---|---|
| `websocket.port` / `host` / `endpoint` | `8080` / `127.0.0.1` / `/` | Use host `0.0.0.0` to reach the bridge from another PC |
| `websocket.authentication` | off | Streamer.bot's salt/challenge scheme |
| `broadcaster.twitch.login` | — | Only needed if the Firebot script can't report the streamer |
| `broadcaster.kick.login` | — | Lets overlays with their own Kick connection find your channel |
| `firebot.enabled` / `emitUnmappedAsCustom` | `true` / `false` | The second forwards unknown Firebot events as `General.Custom` |
| `aitum.enabled` | `false` | |
| `mixitup.enabled` / `ignoreRequirements` | `false` / `true` | The second lets `DoAction` skip Mix It Up cooldowns and costs |
| `sammi.enabled` / `password` / `actions` / `globals` | `false` / `""` / `[]` / `[]` | See [docs/sammi.md](docs/sammi.md#4-let-tools-control-sammi) |
| `enrichment.enabled` / `timeoutMs` | `true` / `1500` | Public lookups that fill in missing detail (see above). `users`, `rolesAndSubs`, `badges`, `emotes` toggle each part |
| `instance.version` | `1.0.1` | The Streamer.bot version reported to clients |
| `logLevel` | `info` | Use `debug` to log every raw incoming event and every delivery |

## Troubleshooting

- **A field is missing in an overlay.** Run with `SB_BRIDGE_LOG_LEVEL=debug`, trigger the event, and compare the raw data (logged) with what the overlay reads. Some field names are best guesses; see `docs/protocol-notes.md`.
- **Port 8080 in use.** Streamer.bot (or another app) is running. Close it, or change `websocket.port` and the tool's port setting.
- **Duplicate events.** Two apps are forwarding the same platform (e.g. Firebot and Mix It Up both sending Twitch chat). Forward each platform from one app only.

## Development

`pnpm test` runs the tests, including an end-to-end test that drives the bridge with the official `@streamerbot/client`. `pnpm typecheck` checks types. `pnpm dev` restarts on change. See `AGENTS.md` for architecture and conventions.

PR titles must be [conventional commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`). PRs are squash-merged, and the titles drive version bumps and the changelog. See [docs/releasing.md](docs/releasing.md) for how CI, auto-merge and releases work.
