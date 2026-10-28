# Using sb-bridge with SAMMI

This guide shows how to get your SAMMI events (Twitch chat, subs, cheers, hype trains, moderation, YouTube…) into overlays and tools built for Streamer.bot, using sb-bridge.

It works in two directions:

| Direction | How | What you get |
|---|---|---|
| **SAMMI → overlays** | One SAMMI button forwards every trigger it receives to sb-bridge | Overlays receive Streamer.bot events such as `Twitch.ChatMessage` |
| **Overlays/tools → SAMMI** | sb-bridge calls SAMMI's local API | Tools can fire SAMMI webhook triggers or buttons as Streamer.bot "actions", and read SAMMI variables |

---

## 1. Set up

1. In SAMMI Core open **Settings** and tick **Open Local API Server**. If you set a password there, put it in sb-bridge's config too (step 2).
2. Turn on the SAMMI connection in `sb-bridge.config.json` (next to `package.json`, or next to the executable):

   ```json
   {
     "sammi": { "enabled": true, "password": "" }
   }
   ```

3. Restart sb-bridge. The console should show `connected to SAMMI at http://127.0.0.1:9450`. If SAMMI isn't open, events still work; only section 4 needs the connection.

---

## 2. Forward SAMMI events with one button

Unlike Mix It Up or Aitum, SAMMI needs only **one** forwarding button. It sends each trigger's full data and its trigger type, and sb-bridge works out which Streamer.bot event it is.

### Build the forwarder button

1. Create a new button, e.g. **SB Bridge**.
2. **Triggers:** add each trigger you want overlays to see:

   | SAMMI trigger | Becomes |
   |---|---|
   | Twitch Chat (keep the message `*`) | `Twitch.ChatMessage` |
   | Twitch Subscription | `Twitch.Sub`, `Twitch.ReSub` or `Twitch.GiftSub` |
   | Twitch Community Gift Subs | `Twitch.GiftBomb` |
   | Twitch Bits | `Twitch.Cheer` |
   | Twitch Channel Points (redemption name `*`) | `Twitch.RewardRedemption` |
   | Twitch Raid | `Twitch.Raid` |
   | Twitch New Follower | `Twitch.Follow` |
   | Twitch Moderation (ban, timeout, untimeout/unban, chat cleared, message deleted) | `Twitch.UserBanned`, `UserTimedOut`, `UserUnbanned`, `ChatCleared`, `ChatMessageDeleted` |
   | Twitch Hype Train | `Twitch.HypeTrainStart`, `HypeTrainUpdate`, `HypeTrainLevelUp`, `HypeTrainEnd` |
   | YouTube Chat | `YouTube.Message` |
   | YouTube Subscriber | `YouTube.NewSubscriber` |
   | YouTube Super Chat / Super Sticker | `YouTube.SuperChat` / `YouTube.SuperSticker` |
   | YouTube Member | `YouTube.NewSponsor`, or `YouTube.MemberMileStone` for renewals |
   | Anything else (OBS, hotkeys, webhooks, Stream Deck…) | `General.Custom` with the trigger's data |

3. **Button settings:** make the button **overlappable**, so a busy chat doesn't queue or drop triggers while one is still being sent.
4. **Commands**, in this order:

   | # | Command | Settings |
   |---|---|---|
   | 1 | **Trigger Pull Data** | Save Variable As: `sbData` · Pull Value: *(leave empty, pulls the whole object)* |
   | 2 | **Trigger Pull Data** | Save Variable As: `sbType` · Pull Value: `Trigger Type` |
   | 3 | **Stringify Object** | Object Name: `sbData` · save the result as `sbJson` |
   | 4 | **HTTP Request** | URL: `http://127.0.0.1:8080/ingest/sammi/event//$sbType$/` · Method: `POST` · Body Object JSON: `/$sbJson$/` |

   The URL ends with the trigger type number, inserted with SAMMI's `/$variable$/` syntax. A chat message, for example, posts to `…/ingest/sammi/event/0`.

5. Save, then type in chat. The sb-bridge console logs a `Twitch.ChatMessage` and overlays show it.

> **Not yet tested in SAMMI itself.** These steps follow SAMMI's documentation. Two of them depend on details the docs don't fully confirm: that **Stringify Object** accepts the pulled `sbData` variable, and that the HTTP Request body box fills in `/$sbJson$/`. If the console shows `Body must be the stringified trigger object`, the body arrived empty or wasn't JSON. Check those two commands first. sb-bridge accepts field names as SAMMI shows them (`User Name`) or in any snake_case/camelCase form.

If you set an `ingestToken` in sb-bridge, add `?token=YOUR_TOKEN` to the end of the URL.

### What arrives

- **Twitch chat** carries the user's ID, name colour, mod/VIP/sub status, message ID, reply details and shared-chat source. **Twitch emotes render as images**, built from SAMMI's emote list.
- **Deletions and bans** remove the right messages in overlays, because SAMMI provides real message and user IDs.
- **Hype trains:** SAMMI only reports begin, progress and end. sb-bridge emits `HypeTrainLevelUp` when a progress update shows a higher level.

---

## 3. Single-trigger buttons (optional)

You don't need a single forwarder. Any SAMMI button can run commands 1–4 to forward just its own trigger, e.g. a button that already handles your raid alert. It gets the same results.

---

## 4. Let tools control SAMMI

SAMMI's API can't list buttons or variables, so tell sb-bridge which ones tools may use:

```json
{
  "sammi": {
    "enabled": true,
    "actions": [
      "Confetti",
      { "name": "Scene Swap", "buttonId": "ID19" }
    ],
    "globals": ["deathCount", "currentGoal"]
  }
}
```

- **Actions** appear to tools under the group "SAMMI":
  - **A plain name** (`"Confetti"`) fires the SAMMI **webhook trigger** of that name. Any arguments the tool sends come along as webhook data. In SAMMI, give a button a **Webhook Trigger** whose message is `Confetti`, and use **Trigger Pull Data** to read the arguments.
  - **An object with `buttonId`** presses that button directly. Arguments are ignored.
  - **A different webhook name:** use `{ "name": "Confetti", "webhook": "my-confetti-trigger" }` to show one name to tools while firing another trigger.
- **Globals:** names listed under `globals` appear in `GetGlobals`. `GetGlobal` can read any SAMMI global variable by name, listed or not.
- **`SendMessage` isn't supported;** SAMMI's API has no chat endpoint. A tool needing chat can fire a webhook action whose button sends the message.

---

## 5. Limitations

- **Badge images come from a public lookup.** SAMMI lists badge names but not their images; sb-bridge looks them up (see the README's *Filling in missing detail*). Set `broadcaster.twitch.login` so your channel's own sub badges are used. With lookups turned off, badges aren't shown, but mod/VIP/sub status still affects styling.
- **Gift bombs don't name recipients.** SAMMI's Subscription trigger also fires once per recipient, so those arrive as individual `GiftSub`s if the forwarder has both triggers.
- **First-time chatter highlighting isn't available,** because SAMMI doesn't report it.

---

## 6. Troubleshooting

**Test without SAMMI.** In PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/ingest/sammi/event/0 `
  -Body '{"user_name": "testuser", "display_name": "TestUser", "message": "hello"}'
```

The reply lists what was sent (`emitted: {Twitch.ChatMessage}`).

| Symptom | Check |
|---|---|
| Nothing in the sb-bridge console | The HTTP Request URL and Method, and that sb-bridge is running. |
| `Missing trigger type` | The URL must end in the trigger type number, so check the `sbType` pull. |
| Everything arrives as `General.Custom` | The trigger type isn't one sb-bridge maps (see the table in section 2), or `sbType` pulled the wrong value. |
| Overlay shows a blank name | The pulled data didn't include the user fields. Run sb-bridge with `SB_BRIDGE_LOG_LEVEL=debug` and inspect what arrives. |
| Tools don't see SAMMI actions | List them under `sammi.actions` (section 4). |
| `SAMMI unreachable` in the console | Local API Server not enabled, or a wrong `password`. |
