# Using sb-bridge with Aitum Nexus

This guide shows how to get your Aitum Nexus events (chat messages, subs, cheers, hype trains, YouTube Super Chats…) into overlays and tools built for Streamer.bot, using sb-bridge.

It works in two directions:

| Direction | How | What you get |
|---|---|---|
| **Aitum → overlays** | An Aitum **Send Webhook** action posts each event to sb-bridge | Overlays receive Streamer.bot events such as `Twitch.ChatMessage` and `YouTube.SuperChat` |
| **Overlays/tools → Aitum** | sb-bridge calls the Nexus public API | Tools can list and run your Nexus commands as Streamer.bot "actions", and read your Nexus global variables |

---

## 1. Set up

1. Start sb-bridge (see the main [README](../README.md)). Close Streamer.bot first if you have it, because both use port 8080.
2. Turn on the Aitum connection, which everything in this guide needs. Create `sb-bridge.config.json` next to `package.json`, or next to the executable (or add the `aitum` line to your existing one):

   ```json
   {
     "aitum": { "enabled": true }
   }
   ```

3. Restart sb-bridge with Nexus open. The console should show `connected to Aitum Nexus at http://127.0.0.1:7777/aitum`. If Nexus isn't open, events from Aitum still work; only section 5 (tools controlling Aitum) needs the connection.

---

## 2. Send Aitum events to your overlays

Each Aitum event you want an overlay to see needs one Aitum **command**: a trigger plus a **Send Webhook** action.

### Build a command (example: chat messages)

1. In Nexus, create a new command, for example *"Bridge: Twitch chat"*.
2. **Trigger:** add **Twitch → Chat Message**. Leave the Username and Message filters empty so it fires for every message.
3. **Action:** add **Nexus → Send Webhook**, then fill in:
   - **Endpoint:** `http://127.0.0.1:8080/ingest/aitum/twitch/chat-message`
   - **Body:**

     ```json
     {
       "username": "{TWITCH:username}",
       "message": "{TWITCH:message}"
     }
     ```

4. Insert the variables with the field's **Local** dropdown, not by typing them. Aitum shows local variables as names like *Twitch: Username*; choosing one inserts its template, such as `{TWITCH:username}`. In this guide, `{TWITCH:…}` / `{YOUTUBE:…}` marks which variable to pick. The exact text Aitum inserts may look slightly different, and that's fine.
5. Save the command, then type something in your chat. The sb-bridge console prints the event, and your overlay shows the message.

### Rules for every body

- **Put quotes around every value, numbers included:** `"bits": "{TWITCH:bits}"`, not `"bits": {TWITCH:bits}`. Aitum requires the body to be valid JSON, and sb-bridge turns `"100"` back into a number.
- **Quotes inside chat messages are fine.** A message like `she said "hi"` breaks the JSON once Aitum fills it in, and sb-bridge repairs it. The repair relies on the field names shown here, so keep them exactly as written (they're case-sensitive).
- **Fields you leave out get sensible defaults.** The examples include every field sb-bridge understands for each trigger.
- **Aitum's "Test Actions" button uses fallback values** (e.g. *Unknown User*, *Unknown Message*). That's a quick way to check the connection.
- **Address format:** `http://127.0.0.1:8080/ingest/aitum/<platform>/<trigger>`. If Aitum runs on a different PC, replace `127.0.0.1` with the sb-bridge PC's address, and set `"websocket": { "host": "0.0.0.0" }` in the config.
- **If you set an `ingestToken`,** add it to the address as `?token=YOUR_TOKEN`. Send Webhook can't send custom headers.

---

## 3. Payload reference

Each entry shows the Aitum trigger, the Endpoint path (after `http://127.0.0.1:8080`), the Body, and the Streamer.bot event your overlays receive.

### Twitch

#### Chat message
Trigger **Twitch → Chat Message** · Endpoint `/ingest/aitum/twitch/chat-message` · Emits `Twitch.ChatMessage`

```json
{
  "username": "{TWITCH:username}",
  "message": "{TWITCH:message}"
}
```

#### Follow
Trigger **Twitch → Follow** · Endpoint `/ingest/aitum/twitch/follow` · Emits `Twitch.Follow`

```json
{
  "username": "{TWITCH:username}"
}
```
*(Pick the trigger's **Follower Username** variable.)*

#### Subscription
Trigger **Twitch → Subscription** · Endpoint `/ingest/aitum/twitch/subscription` · Emits `Twitch.Sub`, or `Twitch.ReSub` when `months` is above 1

```json
{
  "username": "{TWITCH:username}",
  "tier": "{TWITCH:tier}",
  "message": "{TWITCH:message}"
}
```

- `tier` is Aitum's **Subscription Tier** (1, 2 or 3). Overlays see it as `"1000"`, `"2000"` or `"3000"`, like Streamer.bot.
- Aitum doesn't say how many months a viewer has subscribed, so this always arrives as a new **Sub**. If you have a month count from elsewhere (a global variable, say), add `"months": "…"` and anything above 1 becomes a **ReSub**.

#### Gift subscription
Trigger **Twitch → Gift Subscription** · Endpoint `/ingest/aitum/twitch/gift-subscription` · Emits `Twitch.GiftSub` (1 gift) or `Twitch.GiftBomb` (2 or more)

```json
{
  "gifter": "{TWITCH:gifter}",
  "tier": "{TWITCH:tier}",
  "totalGifts": "{TWITCH:totalGifts}"
}
```

- Aitum doesn't report who received a gift, so single gifts show the recipient as *"a viewer"*.
- Some overlays (including the Nutty multichat overlay) only display `GiftSub`, not `GiftBomb`, so multi-gifts may not appear there.

#### Bit cheer
Trigger **Twitch → Bit Cheer** · Endpoint `/ingest/aitum/twitch/bit-cheer` · Emits `Twitch.Cheer`

```json
{
  "username": "{TWITCH:username}",
  "bits": "{TWITCH:bits}",
  "message": "{TWITCH:message}"
}
```

#### Channel point redemption
Trigger **Twitch → Channel Point Redemption** · Endpoint `/ingest/aitum/twitch/channel-point-redemption` · Emits `Twitch.RewardRedemption`

```json
{
  "redemption": "{TWITCH:redemption}",
  "username": "{TWITCH:username}",
  "cost": "{TWITCH:cost}",
  "userInput": "{TWITCH:userInput}"
}
```

The trigger is tied to one reward, so you need one command per reward you want shown. You can also type the reward name straight into `redemption` instead of using a variable.

#### Incoming raid
Trigger **Twitch → Incoming Raid** · Endpoint `/ingest/aitum/twitch/incoming-raid` · Emits `Twitch.Raid`

```json
{
  "raidingChannel": "{TWITCH:raidingChannel}",
  "viewers": "{TWITCH:viewers}"
}
```
*(Pick **Raiding Channel** and **Amount of Viewers**.)*

#### Hype trains
Hype trains need four commands, one per trigger.

| Aitum trigger | Endpoint | Emits | Body |
|---|---|---|---|
| Hype Train - Started | `/ingest/aitum/twitch/hype-train-started` | `Twitch.HypeTrainStart` | `{"level": "{TWITCH:level}", "progress": "{TWITCH:progress}"}` |
| Hype Train - Progress | `/ingest/aitum/twitch/hype-train-progress` | `Twitch.HypeTrainUpdate` | `{"level": "{TWITCH:level}", "progress": "{TWITCH:progress}"}` |
| Hype Train - Level Change | `/ingest/aitum/twitch/hype-train-level-change` | `Twitch.HypeTrainLevelUp` | `{"level": "{TWITCH:level}"}` |
| Hype Train - Ended | `/ingest/aitum/twitch/hype-train-ended` | `Twitch.HypeTrainEnd` | `{"level": "{TWITCH:level}"}` |

`progress` is Aitum's percentage towards the next level (0–100). Overlays receive `level`, `progress`, `percent` (the same number) and `percentDecimal` (0–1).

#### Shoutout received
Trigger **Twitch → Shoutout Received** · Endpoint `/ingest/aitum/twitch/shoutout-received` · Emits `Twitch.ShoutoutReceived`

```json
{
  "channel": "{TWITCH:channel}",
  "viewerCount": "{TWITCH:viewerCount}"
}
```

#### Ad starting
Trigger **Twitch → Ad Starting** · Endpoint `/ingest/aitum/twitch/ad-starting` · Emits `Twitch.AdRun`

```json
{
  "length": "{TWITCH:length}",
  "scheduled": "{TWITCH:scheduled}"
}
```

### YouTube

All YouTube triggers accept these optional user fields. Include whichever your trigger offers; overlays use them for badges and avatars:

```json
"username": "{YOUTUBE:username}",
"isBroadcaster": "{YOUTUBE:isBroadcaster}",
"isModerator": "{YOUTUBE:isModerator}",
"isMember": "{YOUTUBE:isMember}",
"isVerified": "{YOUTUBE:isVerified}",
"profileImageUrl": "{YOUTUBE:profileImageUrl}",
"channelUrl": "{YOUTUBE:channelUrl}",
"channelId": "{YOUTUBE:channelId}"
```

#### Chat message
Trigger **YouTube → Chat Message Added** · Endpoint `/ingest/aitum/youtube/chat-message-added` · Emits `YouTube.Message`

```json
{
  "username": "{YOUTUBE:username}",
  "message": "{YOUTUBE:message}",
  "isBroadcaster": "{YOUTUBE:isBroadcaster}",
  "isModerator": "{YOUTUBE:isModerator}",
  "isMember": "{YOUTUBE:isMember}",
  "isVerified": "{YOUTUBE:isVerified}",
  "profileImageUrl": "{YOUTUBE:profileImageUrl}",
  "channelId": "{YOUTUBE:channelId}"
}
```

#### Super Chat
Trigger **YouTube → Super Chat** · Endpoint `/ingest/aitum/youtube/super-chat` · Emits `YouTube.SuperChat`

```json
{
  "username": "{YOUTUBE:username}",
  "amount": "{YOUTUBE:purchaseAmountDisplayString}",
  "amountMicros": "{YOUTUBE:amountMicros}",
  "currency": "{YOUTUBE:purchaseCurrency}",
  "comment": "{YOUTUBE:comment}",
  "tier": "{YOUTUBE:tier}",
  "profileImageUrl": "{YOUTUBE:profileImageUrl}",
  "channelId": "{YOUTUBE:channelId}"
}
```
*(For `amount`, pick **Purchase Amount (Display String)**, e.g. "$5.00". This is what overlays display. `amountMicros` is **Amount (In Micros)**.)*

#### Super Sticker
Trigger **YouTube → Super Sticker** · Endpoint `/ingest/aitum/youtube/super-sticker` · Emits `YouTube.SuperSticker`

Same body as Super Chat, without `comment`. Aitum doesn't provide the sticker image, so overlays show the amount without the sticker.

#### New membership / upgraded membership
Triggers **YouTube → New Membership** and **Upgraded Membership** · Endpoints `/ingest/aitum/youtube/new-membership` and `/ingest/aitum/youtube/upgraded-membership` · Both emit `YouTube.NewSponsor`; upgrades also carry `isUpgrade: true`

```json
{
  "username": "{YOUTUBE:username}",
  "levelName": "{YOUTUBE:levelName}",
  "channelId": "{YOUTUBE:channelId}"
}
```

#### Member milestone
Trigger **YouTube → Member Milestone Chat** · Endpoint `/ingest/aitum/youtube/member-milestone-chat` · Emits `YouTube.MemberMileStone`

```json
{
  "username": "{YOUTUBE:username}",
  "months": "{YOUTUBE:months}",
  "levelName": "{YOUTUBE:levelName}",
  "comment": "{YOUTUBE:comment}"
}
```

---

## 4. Anything else: custom and full Streamer.bot events

For any other Aitum trigger (OBS, MIDI, Stream Deck, timers…), send to the general address **`/ingest/aitum`**:

- **A custom event.** Any body without `source`/`type` arrives as `General.Custom`, the event Streamer.bot tools use for custom data:

  ```json
  { "event": "scene-changed", "scene": "{OBS:sceneName}" }
  ```

- **A specific Streamer.bot event.** Name the event and provide its data in Streamer.bot's format:

  ```json
  {
    "event": { "source": "Obs", "type": "SceneChanged" },
    "data": { "scene": { "sceneName": "{OBS:sceneName}" } }
  }
  ```

  Use this only when you know what the receiving tool expects. Unlike the routes in section 3, this sends your `data` unchanged and doesn't repair broken JSON.

---

## 5. Let tools control Aitum

With `"aitum": { "enabled": true }`:

- **Your Nexus commands appear as Streamer.bot actions** (group "Aitum"). A tool that runs an action by name, e.g. a Stream Deck plugin or a web control panel calling `DoAction` with `"Hype Mode"`, runs the Nexus command with that name. Arguments a tool passes are ignored, because Nexus commands don't take inputs.
- **Your Nexus global variables appear as Streamer.bot globals**, readable with `GetGlobals` / `GetGlobal`.

sb-bridge refreshes the command list whenever a tool asks for it, so new commands appear without a restart.

---

## 6. Limitations

Aitum's Twitch triggers provide only display names, so sb-bridge **fills in the rest from public lookups**: real user IDs, name colours, avatars, mod/VIP/sub status, badge images, and emotes (Twitch, 7TV, BTTV, FFZ). See the README's *Filling in missing detail* section.

**For this to work fully, set your channel name** in `sb-bridge.config.json`. Without it, users still get IDs and colours, but not roles, sub status, channel badges or channel emotes:

```json
{ "broadcaster": { "twitch": { "login": "yourtwitchname" } } }
```

These gaps remain:

- **First-time chatter highlighting isn't available,** because Aitum doesn't report it.
- **Message deletions, bans and timeouts aren't sent,** because Aitum has no triggers for them. Overlays won't remove those messages.
- **Sub events don't include months, and gift subs don't include recipients** (see their sections above). The *chat* sub status and months above come from the lookup, not from Aitum's sub trigger.
- **The first message from a new chatter can take up to ~1.5 s** while their details are looked up; later messages from them are instant.

If you also run Firebot, it provides much richer Twitch data; use Aitum for YouTube and anything Firebot doesn't cover. Don't send the same platform's events from both, or overlays will show duplicates.

---

## 7. Troubleshooting

**Test without Aitum.** In PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/ingest/aitum/twitch/chat-message `
  -Body '{"username": "TestUser", "message": "hello from PowerShell"}'
```

The reply lists what was sent, e.g. `emitted: {Twitch.ChatMessage}`, and connected overlays show the message. If that works but Aitum doesn't, the problem is in the Aitum command.

| Symptom | Check |
|---|---|
| Nothing in the sb-bridge console when the trigger fires | Endpoint typo, sb-bridge not running, or a different port. Try Aitum's **Test Actions** button. |
| `Unknown Aitum trigger route` | The end of the Endpoint must match one of the paths in section 3 exactly. |
| `401` / `Invalid ingest token` | Add `?token=…` to the Endpoint, or remove `ingestToken` from the config. |
| Overlay shows "Unknown User" / "Unknown Message" | Aitum used its fallback values: the variable wasn't inserted from the Local dropdown, or the action ran from Test Actions. |
| Event reaches sb-bridge but the overlay ignores it | Run sb-bridge with `SB_BRIDGE_LOG_LEVEL=debug` to see each event and how many clients received it. "0 client(s)" means the overlay isn't connected or doesn't listen for that event. |
| Tools don't see Nexus commands | Check `"aitum": { "enabled": true }` and that Nexus is open; the console logs `Aitum Nexus unreachable` otherwise. |
