# Protocol notes

Research behind the bridge, with confidence levels. **Verified** = checked against a primary source or a live instance; **assumed** = inferred, not yet observed. When you confirm or refute an assumption, update this file.

## Streamer.bot WebSocket API

Sources: docs.streamer.bot/api/websocket, github.com/Streamerbot/client (`packages/client/src/ws/types`).

- **Verified** — Hello on connect: `{timestamp, session, request:"Hello", info:{instanceId,name,os,osVersion,version,mode,darkMode,source}, authentication?:{salt,challenge}}`. `authentication` present only when auth is on.
- **Verified** — Auth: `base64(sha256(base64(sha256(password + salt)) + challenge))`, sent as `{request:"Authenticate", id, authentication}`. The official client accepts our `{id, status:"ok"}` reply (end-to-end test).
- **Verified** — Requests carry `request` + `id`; responses carry `id` + `status` (`ok`|`error`, error adds `error`). Payload fields sit at top level next to `id`/`status`.
- **Verified** — Events: `{timeStamp, event:{source,type}, data}`. The client routes by `source.type`; `.on()` sends `Subscribe` with `{events:{Source:[Type]}}`.
- **Verified** — `GetCredits` returns the credits object at top level: `events` (keys: cheers, follows, gameupdates, giftbombs, giftsubs, goalcontributions, hypetrains, pyramids, raided, resubs, rewardredemptions, subs), `hypeTrain`, `users`, `top`, `groups`, `custom`.
- **Verified** — Event catalog: `StreamerbotEvents` in `events.const.ts` (copied to `src/sb/events-catalog.ts`).
- **Assumed** — Exact error strings and close codes for auth failure. The bridge closes with 4001.

## Payload shapes: 1.x vs 0.2.x

The legacy typings in `twitch.types.ts` (e.g. ChatMessage = `{message:{msgId,userId,username,...}}`, numeric `subTier`) describe 0.2.x. Current widgets read 1.x fields. Field paths the Nutty overlay reads (verified from its `script.js`):

- ChatMessage: `messageId, text, parts[], user{id,login,name,color,role,subscribed,badges[{name,imageUrl}]}, meta{firstMessage,isMe}, isReply, reply{userName,msgBody}, isFromSharedChatGuest, sharedChatSource{name,login}`.
- `parts[]` types: `text`, `emote` (`imageUrl`), `cheer` (`bits`, optional `imageUrl`), `mention`, `gif`. Unknown types render as `<img src=imageUrl>`, so every emitted part must be one of these.
- Cheer: same as ChatMessage + `bits`. The overlay renders the chat line itself, so a cheer must not also emit ChatMessage.
- Follow: `targetUser{name,login}`. Sub: `user`, `subTier`/`sub_tier` as a **string** ("1000"; it calls `.charAt(0)`), `isPrime`/`is_prime`. ReSub: `subTier, isPrime, cumulativeMonths, text`. GiftSub: `user, recipient{name}, subTier, cumlativeTotal` (sic).
- RewardRedemption: `user_login|user.login, user_name|user.name, user_input|userInput, reward{title,cost}`. Raid: `from_broadcaster_user_{login,name}, viewers`.
- ChatMessageDeleted: `messageId`. UserBanned/UserTimedOut: `targetUser.id`. ChatCleared: no fields.
- Streamlabs.Donation: `from, formattedAmount, currency, message`. StreamElements.Tip: `username, amount, currency, message`.
- Requests used: `GetBroadcaster` (`platforms.twitch.broadcastUserName`, `platforms.kick.broadcasterLogin`), `GetUserPronouns` (`pronoun.userFound/pronounSubject/pronounObject`, read without a null check).

## Firebot

- **Verified (live)** — HTTP API at `:7472/api/v1`. `GET /status` → `{connections:{chat}}`. `GET /effects/preset` → `[{id,name,args:string[]}]`. `GET /custom-variables` → `{name:{t,v,meta:{persist?}}}`.
- **Verified (wiki)** — `POST /effects/preset/:id` body `{args}`. `POST /effects` body `{effects:{list:[{type:"firebot:chat",message,chatter}]}}`.
- **Verified (source)** — `EventManager.triggerEvent(sourceId, eventId, meta, isManual, isRetrigger, isSimulation)` is the single entry point for events. Its `"event-triggered"` emit fires only in some paths, which is why the script wraps `triggerEvent` instead of listening.
- **Verified (types)** — Script modules include `eventManager`, `effectManager`, `logger`. CustomScript has `run`, `getScriptManifest`, `getDefaultParameters`, `parametersUpdated?`, `stop?`.
- **Assumed** — Event meta field names in `firebot-mapper.ts` (`chatMessage.parts/badges/roles/isFirstChat/isCheer/isAnnouncement/isSharedChatMessage`, `gifterUsername`, `giftReceivers`, `subPlan`, `totalMonths`, …) and event ids (`twitch:banned`, `twitch:timeout`, `obs:scene-changed`, …). Also assumed: `runRequest.firebot.accounts.streamer`.
- Firebot's own WebSocket (`ws://:7472`, `invoke subscribe-events`) exists but its event list is undocumented; it is unused.
- **Kick via Firebot** — The Firebot Kick script (Firebot-Scripts' `src/kick`, event source `rustyy-kick`) uses Twitch's metadata names. Its chat events also carry Kick's raw `badges` (`{type, text, count}`) and the Firebot chat message (`chatMessage.parts` with `third-party-emote` parts, origin `Kick`). `userId` is Kick's plain id; `chatMessage.userId` is prefixed `kick-`.
- **Kick payloads (assumed)** — Streamer.bot publishes no Kick schema. `src/sb/payloads/kick.ts` follows its Twitch shapes plus Nutty's reads: `Kick.ChatMessage` `text, parts, messageId, isReply, reply.userName, reply.msgBody, user.id/login/name/color/badges`, `Kick.Follow` `user.name, user.id`. Nutty matches Kick badges by `id` (`broadcaster`, `moderator`, `vip`, `subscriber` with `count`) or `type` (`og`), using its own icons when `imageUrl` is empty, so Kick badges are sent without images (unlike Twitch's). Nutty takes Kick subs, gifts, redemptions, hosts, deletions and bans from Kick's socket itself, not from Streamer.bot.

## Aitum Nexus

- **Verified (docs)** — `http://localhost:7777/aitum`. `GET /commands/` → `{status:"OK", data:{name:id}}`. `GET /commands/:id` runs one. `GET /state/` → `data:[{_id,name,type,value}]`.
- **Verified (docs)** — `GET /twitch/hypetrain/` → `{active, level, progress}` and `GET /twitch/poll/` → `{active, title, choices[{text,votes}]}`, at base `http://localhost:7777/twitch`. Unused so far; polling these could emit hype train/poll events without user setup.
- No event stream in the public API. Events arrive via Aitum's **Send Webhook** action (app.aitum.help/devices/aitum/actions/send-webhook). It has only Endpoint and Body fields: no method, headers or content type (hence `?token=`). The body must be valid JSON, and both fields allow string templating.
- **Verified (docs)** — Template syntax is `{TWITCH:username}`, inserted via the Local/Global dropdowns (app.aitum.help/commands/actions). **Assumed** — token names other than `{TWITCH:username}`; docs/aitum.md tells users to insert from the dropdown.
- **Verified (docs)** — Variables per trigger come from the app.aitum.help/devices/{twitch,youtube}/triggers/* pages. Aitum provides display names only (no user ids, badges, colours or roles), no sub months, and no gift recipients.
- **Assumed** — Aitum substitutes variables as raw text without JSON escaping. `parseLenient` (`adapters/shared/webhook-fields.ts`) recovers from this.
- `aitum.js` / `aitum-cc` (github.com/Aitum) might offer a native event route; not investigated.

## Enrichment sources (public, unauthenticated)

All verified live on 2026-10-28 with read-only GETs. Used by `src/enrich/twitch-directory.ts`.

- **ivr.fi** (`https://api.ivr.fi/v2`):
  - `GET /twitch/user?login=a,b` → array of `{id, login, displayName, chatColor|null, logo, roles:{isPartner,isAffiliate,…}, …}`. An unknown login gives `[]`.
  - `GET /twitch/modvip/{channel}` → `{mods:[{id,login,displayName,grantedAt}], vips:[…], ttl}`.
  - `GET /twitch/subage/{user}/{channel}` → `{meta:{type:"paid"|"prime"|"gift", tier:"1"|"2"|"3"}|null, cumulative:{months}|null, streak, …}`. `meta: null` means not currently subscribed.
  - `GET /twitch/badges/global` and `/twitch/badges/channel?login=` → `[{set_id, versions:[{id, image_url_1x/2x/4x, title}]}]`. Channel subscriber versions are months (`"0","3","6",…`), offset by 2000 or 3000 for tiers 2 and 3.
  - `GET /twitch/emotes/channel/{login}` → `{subProducts:[{tier, emotes:[{id, code}]}]}`. There is no global-emote list (`/twitch/emotes/global` is a 404), so the common Twitch globals are hardcoded, with ids checked via `GET /twitch/emotes/{name}`.
- **7TV** (`https://7tv.io/v3`): `GET /emote-sets/global` and `GET /users/twitch/{twitchId}` (which includes `emote_set`). Emote entries are `{id, name, data:{host:{url:"//cdn.7tv.app/emote/…"}}}`; the image is `https:${url}/2x.webp`.
- **BTTV** (`https://api.betterttv.net/3`): `GET /cached/emotes/global` → `[{id, code}]`. `GET /cached/users/twitch/{id}` → `{channelEmotes, sharedEmotes}`. The image is `https://cdn.betterttv.net/emote/{id}/2x`.
- **FFZ via BTTV's cache**: `GET /cached/frankerfacez/emotes/global` and `/cached/frankerfacez/users/twitch/{id}` → `[{id, code, images:{1x,2x,4x}}]`.
- **Cheermote images**: `https://d3aqoihi2n8ty8.cloudfront.net/actions/{prefix}/dark/animated/{tier}/4.gif`. **Assumed** to hold for every prefix (verified pattern for `cheer`; the Nutty overlay uses the same one).
- These are community services. ivr.fi in particular is unofficial, and its rate limits are undocumented. Everything is cached (`TtlCache`), and failures are cached for 60 s.

## Mix It Up

Docs moved from wiki.mixitupapp.com to **mixitup.bot/docs/…**. The old URLs 302 to the getting-started page.

- **Verified (docs)** — Developer API at `http://localhost:8911/api/v2`, enabled under Services → Developer API (mixitup.bot/docs/reference/developer-api). Endpoints used:
  - `GET /status/version` → `"1.0.0.0"`
  - `GET /commands?skip&pageSize` → `{TotalCount, Commands:[{ID,Name,Type,IsEnabled,Unlocked?,GroupName?}]}`
  - `POST /commands/{id}` with `{Platform?, Arguments?, SpecialIdentifiers?: map<string,string>, IgnoreRequirements?}`
  - `POST /chat/message` with `{Message, Platform?, SendAsStreamer?}`
  - `GET /counters` → `{TotalCount, Counters:[{Name,Amount}]}`

  Errors are ProblemDetails `{status,title,detail}`.
- **Verified (docs)** — Web Request action supports GET/POST/PUT/DELETE, custom headers and a body, and times out after 10 s (docs/actions/web-request-action).
- **Verified (docs)** — Event identifiers come from docs/events, docs/platforms/twitch, docs/platforms/youtube and docs/chat; user identifiers from docs/reference/special-identifiers.
  - `$targetuser…` mirrors every `$user…`.
  - Chat Message Received is cross-platform; `$streamingplatform` says which platform.
  - There is no message id identifier. There is no `$useryoutubeid`; `$userid` is Mix It Up's internal id.
  - `$usercolor` falls back to `#000000`.
- **Assumed** — Identifiers are substituted as raw text, unescaped. Unknown identifiers may stay literal.

## SAMMI

- **Verified (docs)** — Local API at `http://localhost:9450` (sammi.solutions/docs/api/reference), enabled with Settings → Open Local API Server. A password, if set, is sent as the raw `Authorization` header.
  - `GET /api?request=getVariable&name=…` → `{data}`. `Architecture` is a built-in global, used as the health check.
  - `POST /api` with `{request:"triggerButton", buttonID}`.
  - `POST /webhook` with `{trigger, ...data}` fires Webhook Triggers whose message matches `trigger` (docs/api/webhooks).
  - There is no endpoint to list buttons or variables, and no chat endpoint.
- **Verified (docs)** — Commands used by the forwarder button:
  - Trigger Pull Data: an empty Pull Value pulls the whole object; "Trigger Type" pulls the numeric type (list in docs/commands/trigger; the doc names it `trigger_type`).
  - Stringify Object.
  - HTTP Request: URL, Method, Header Object Name, Body Object JSON.

  Text boxes substitute `/$var$/`.
- **Verified (docs)** — Per-trigger pull values (docs/triggers/twitch, docs/triggers/youtube) are documented as display labels: chat has User Name, Display Name, User ID, Message ID, Emote List (IRC format), Badge List (names only), Name Color, Is Mod/VIP/Subscriber/Broadcaster/Founder, reply fields, Is Own Chat. Subscription has a Context of sub/resub/subgift/anonsubgift/resubgift/anonresubgift. Hype train has Event begin/progress/end, with no level-up event.
- **Assumed** — The JSON keys in a whole-object pull are snake_case versions of the labels; `normalizeKeys` accepts either. Stringify Object accepts a pulled variable. The HTTP Request body box substitutes `/$sbJson$/`. None of these have been run against a live SAMMI.
