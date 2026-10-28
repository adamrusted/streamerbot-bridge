# Using sb-bridge with Mix It Up

This guide shows how to get your Mix It Up events (chat, subs, cheers, hype trains, YouTube Super Chats…) into overlays and tools built for Streamer.bot, using sb-bridge.

It works in two directions:

| Direction | How | What you get |
|---|---|---|
| **Mix It Up → overlays** | A **Web Request** action on each Mix It Up event posts it to sb-bridge | Overlays receive Streamer.bot events such as `Twitch.ChatMessage` |
| **Overlays/tools → Mix It Up** | sb-bridge calls Mix It Up's Developer API | Tools can list and run your Mix It Up commands, read your counters, and send chat messages |

---

## 1. Set up

1. In Mix It Up, open **Services**, scroll to **Developer API** and click **Connect**. sb-bridge needs this to run commands, read counters and send chat.
2. Turn on the Mix It Up connection in `sb-bridge.config.json` (next to `package.json`, or next to the executable):

   ```json
   {
     "mixitup": { "enabled": true }
   }
   ```

3. Restart sb-bridge. The console should show `connected to Mix It Up … at http://127.0.0.1:8911/api/v2`. If Mix It Up isn't open, events still work; only section 4 needs the connection.

---

## 2. Send Mix It Up events to your overlays

Each Mix It Up event you want overlays to see needs one **Web Request** action.

### Example: chat messages

1. In Mix It Up, open **Events**, find **Chat Message Received**, and click **Add Command**.
2. Add a **Web Request** action:
   - **URL:** `http://127.0.0.1:8080/ingest/mixitup/chat-message`
   - **Method:** `POST`
   - **Headers** (optional): `Content-Type` = `application/json`
   - **Body:**

     ```json
     {
       "username": "$username",
       "userdisplayname": "$userdisplayname",
       "usertwitchid": "$usertwitchid",
       "usercolor": "$usercolor",
       "userismod": "$userismod",
       "userisvip": "$userisvip",
       "userissubscriber": "$userissubscriber",
       "usersubmonths": "$usersubmonths",
       "usersubbadge": "$usersubbadge",
       "userprimaryrole": "$userprimaryrole",
       "message": "$message",
       "streamingplatform": "$streamingplatform"
     }
     ```

   - **Response handling:** leave it as *Plain Text*. sb-bridge's reply doesn't matter.
3. Save, and send a chat message. The sb-bridge console logs it and overlays show it.

### Rules for every body

- **Each key is the special identifier's name without the `$`,** e.g. `"bitsamount": "$bitsamount"`. Keep the keys exactly as shown, all lowercase.
- **Put quotes around every value,** numbers and true/false included. sb-bridge converts them back.
- **Quotes inside chat messages are fine.** Mix It Up inserts the text as-is, which can break the JSON, and sb-bridge repairs it using the keys.
- **The user block.** The chat example above includes every user identifier sb-bridge reads. Twitch events take any part of that block; the more you include, the better overlays look: name colours, mod/VIP/sub styling, and a sub badge. In the bodies below, `…user block…` means "paste those user lines here".
- **If you set an `ingestToken`,** add the header `x-bridge-token` with your token.
- **Testing:** Mix It Up's **Test** button on an event fills identifiers with sample values, which is a quick way to check the connection.

---

## 3. Event reference

All URLs start with `http://127.0.0.1:8080/ingest/mixitup/`.

### Chat

| Mix It Up event | Route | Emits | Body (besides the user block) |
|---|---|---|---|
| Chat Message Received | `chat-message` | `Twitch.ChatMessage` or `YouTube.Message` | `"message": "$message", "streamingplatform": "$streamingplatform"` |
| Chat Message Deleted | `message-deleted` | `Twitch.ChatMessageDeleted` | `"targetusername": "$targetusername", "message": "$message"` |
| Chat User Timeout | `user-timeout` | `Twitch.UserTimedOut` | `"targetusername": "$targetusername", "targetusertwitchid": "$targetusertwitchid", "timeoutlength": "$timeoutlength"` |
| Chat User Banned | `user-banned` | `Twitch.UserBanned` | `"targetusername": "$targetusername", "targetusertwitchid": "$targetusertwitchid"` |

- **Chat Message Received covers all platforms.** `$streamingplatform` decides whether the message becomes a Twitch or a YouTube event. Kick messages are skipped, because overlays such as the Nutty multichat connect to Kick themselves (see the README's Kick setting).
- **Deletes need the chat route.** Mix It Up has no message IDs, so sb-bridge assigns its own to each chat message, then matches deletions by user and text. Overlays only remove deleted messages if they arrived through `chat-message`.
- **Ban and timeout bodies need no user block.** Leave out the `user…` lines; they describe the moderator, if anyone.

### Twitch

| Mix It Up event | Route | Emits | Body (besides the user block) |
|---|---|---|---|
| Twitch Channel Followed | `follow` | `Twitch.Follow` | (user block only) |
| Twitch Channel Subscribed | `subscribed` | `Twitch.Sub` | `"usersubplan": "$usersubplan", "message": "$message"` |
| Twitch Channel Resubscribed | `resubscribed` | `Twitch.ReSub` | `"usersubplan": "$usersubplan", "usersubmonths": "$usersubmonths", "usersubstreak": "$usersubstreak", "message": "$message"` |
| Twitch Channel Subscription Gifted | `subscription-gifted` | `Twitch.GiftSub` | `"targetusername": "$targetusername", "targetuserdisplayname": "$targetuserdisplayname", "targetusertwitchid": "$targetusertwitchid", "usersubplan": "$usersubplan", "usersubmonthsgifted": "$usersubmonthsgifted", "usertotalsubsgifted": "$usertotalsubsgifted", "isanonymous": "$isanonymous"` |
| Twitch Channel Mass Subscriptions Gifted | `mass-subscriptions-gifted` | `Twitch.GiftBomb` | `"usersubplan": "$usersubplan", "subsgiftedamount": "$subsgiftedamount", "subsgiftedlifetimeamount": "$subsgiftedlifetimeamount", "isanonymous": "$isanonymous"` |
| Twitch Channel Bits Cheered | `bits-cheered` | `Twitch.Cheer` | `"bitsamount": "$bitsamount", "message": "$message"` |
| Twitch Channel Points Redeemed | `channel-points-redeemed` | `Twitch.RewardRedemption` | `"rewardname": "$rewardname", "rewardcost": "$rewardcost", "message": "$message"` |
| Twitch Channel Raided | `raided` | `Twitch.Raid` | `"raidviewercount": "$raidviewercount"` |
| Twitch Channel Hype Train Start | `hype-train-start` | `Twitch.HypeTrainStart` | hype train block (below) |
| Twitch Channel Hype Train Progress | `hype-train-progress` | `Twitch.HypeTrainUpdate` | hype train block |
| Twitch Channel Hype Train Level Up | `hype-train-level-up` | `Twitch.HypeTrainLevelUp` | hype train block |
| Twitch Channel Hype Train End | `hype-train-end` | `Twitch.HypeTrainEnd` | `"hypetraintotallevel": "$hypetraintotallevel", "hypetraintotalpoints": "$hypetraintotalpoints"` |
| Twitch Channel Shoutout Received | `shoutout-received` | `Twitch.ShoutoutReceived` | `"shoutoutviewercount": "$shoutoutviewercount"` |
| Twitch Channel Ad Started | `ad-started` | `Twitch.AdRun` | `"adduration": "$adduration", "adisautomatic": "$adisautomatic"` (no user block) |
| Twitch Channel Watch Streak | `watch-streak` | `Twitch.WatchStreak` | `"userwatchstreak": "$userwatchstreak", "message": "$message"` |
| Twitch Channel Stream Start / Stop | `stream-start` / `stream-stop` | `Twitch.StreamOnline` / `StreamOffline` | `{}` (empty body) |

**Hype train block:**

```json
"hypetrainlevel": "$hypetrainlevel",
"hypetrainlevelpoints": "$hypetrainlevelpoints",
"hypetrainlevelgoal": "$hypetrainlevelgoal",
"hypetraintotalpoints": "$hypetraintotalpoints"
```

sb-bridge works out `percent` (progress through the current level) from the level points and goal.

**Gift subs and mass gifts:** Mix It Up runs either *Subscription Gifted* (once per recipient) or *Mass Subscriptions Gifted* (once per batch), depending on **Settings → Commands → Mass Gifted Subscriptions Filter Amount**. Set up both. Some overlays (including the Nutty multichat) show only individual gift subs, so set the filter amount high if you want every recipient shown.

**A full example (resubscribed):**

```json
{
  "username": "$username",
  "userdisplayname": "$userdisplayname",
  "usertwitchid": "$usertwitchid",
  "usercolor": "$usercolor",
  "usersubbadge": "$usersubbadge",
  "usersubplan": "$usersubplan",
  "usersubmonths": "$usersubmonths",
  "usersubstreak": "$usersubstreak",
  "message": "$message"
}
```

### YouTube

| Mix It Up event | Route | Emits | Body (besides the user block) |
|---|---|---|---|
| YouTube Channel Super Chat | `youtube-super-chat` | `YouTube.SuperChat` | `"amount": "$amount", "amountnumber": "$amountnumber", "currencytype": "$currencytype", "message": "$message", "tier": "$tier"` |
| YouTube Channel New Member | `youtube-new-member` | `YouTube.NewSponsor` | `"usersubplan": "$usersubplan"` |
| YouTube Channel Member Milestone | `youtube-member-milestone` | `YouTube.MemberMileStone` | `"usersubplan": "$usersubplan", "usersubmonths": "$usersubmonths", "message": "$message"` |
| YouTube Channel Membership Gifted | `youtube-membership-gifted` | `YouTube.GiftMembershipReceived` | `"targetusername": "$targetusername", "usersubplan": "$usersubplan"` |

YouTube chat goes through the shared **Chat Message Received** route (see Chat above). For YouTube events, the useful user identifiers are `username`, `userdisplayname`, `userid`, `useravatar`, `userismod` and `userissubscriber`.

### Anything else

To send any other event, post a full Streamer.bot event to `http://127.0.0.1:8080/ingest/event`:

```json
{ "event": { "source": "General", "type": "Custom" }, "data": { "what": "giveaway-started", "prize": "$giveawayitem" } }
```

---

## 4. Let tools control Mix It Up

With the Developer API connected:

- **Your Mix It Up commands appear as Streamer.bot actions,** grouped by their Mix It Up group (or by type, e.g. "Mix It Up Chat"). A tool calling `DoAction` runs the command.
  - **Arguments become special identifiers.** An argument `user` is available as `$user`; non-text values arrive as JSON text. To fill `$arg1text` and friends, pass an argument named `arguments`, e.g. `"arguments": "bob 50"`.
  - **Requirements are skipped by default.** Commands run even if cooldowns, costs or role checks would block them, because the tool asked for them directly. Set `"mixitup": { "ignoreRequirements": false }` to keep requirements in force.
- **Your counters appear as Streamer.bot globals** (`GetGlobals` / `GetGlobal`).
- **`SendMessage`** posts to Twitch, YouTube or Kick chat through Mix It Up. It uses the bot account when the tool asks for the bot; otherwise the streamer.

---

## 5. Limitations

Mix It Up's identifiers carry no emote images and only the sub badge, so sb-bridge **fills these in from public lookups**: emotes become images (Twitch, 7TV, BTTV, FFZ), and broadcaster/moderator/VIP badges are added. Set `broadcaster.twitch.login` in the config to include your channel's own emotes and sub badges. See the README's *Filling in missing detail* section.

- **Other badges (bits, founder, etc.) aren't shown,** since Mix It Up doesn't report which ones a user has.
- **Message IDs are generated by sb-bridge,** so deletions are matched by user and text (see Chat above).
- **Some events fire once per user per session.** Mix It Up only fires follows, raids and subs once per user each time it runs.
- **Kick chat isn't forwarded** (see Chat above).

---

## 6. Troubleshooting

**Test without Mix It Up.** In PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/ingest/mixitup/chat-message `
  -Body '{"username": "testuser", "userdisplayname": "TestUser", "message": "hello", "streamingplatform": "Twitch"}'
```

The reply lists what was sent (`emitted: {Twitch.ChatMessage}`).

| Symptom | Check |
|---|---|
| Nothing in the sb-bridge console | The URL, the Method (must be POST), and that sb-bridge is running. |
| `Unknown Mix It Up event route` | The end of the URL must match a route in section 3 exactly. |
| Overlay shows `$username` literally | That identifier doesn't exist for this event; remove the line. |
| Names show in the wrong colour or without styling | Add more of the user block to that event's body. |
| Tools don't see your commands | Developer API not connected in Mix It Up, or `mixitup.enabled` missing. The console logs `Mix It Up unreachable`. |
