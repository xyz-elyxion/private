# private

The Elyxion registry + marketing site, built with both the **Elyxion Website
Framework** (server-side HTML, styled with shadcn/ui) and the **Elyxion
Discord Framework** (a Discord bot).

## Website

Built with the Elyxion Website Framework.

### Install

First make the framework available to require():

```bash
elyx install elyxion-website   # or clone the framework repo next to this project
```

### Run

```bash
elyxion app.js        # the scaffolded framework app
elyxion server.js     # the existing registry + static site server
```

## Discord bot

Built with the Elyxion Discord Framework.

### Install

```bash
elyx install elyxion-discord   # or clone the framework repo next to this project
```

### Setup

1. Create an application + bot at https://discord.com/developers/applications and copy the **token**
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN=...`
3. Invite the bot to a server with the `bot` scope (needs Send Messages; Moderation commands additionally need Manage Messages / Moderate Members)

Never commit `.env` — it's git-ignored already.

### Run

```bash
node bot.js --check    # offline self-test: loads framework + commands, no login
node bot.js            # go live: REST verify, slash-command sync, gateway connect
npm test               # offline smoke tests of the command pipeline
```
(under the Elyxion runtime the same files run as `elyxion bot.js`)

### Commands

Prefix commands autoload from `commands/` — one file per command exporting
`{ options, run }` (or an array/object of those). Drop a file in, restart, done.

| Command | What it does |
| --- | --- |
| `!help [command]` | List commands or show one in detail |
| `!ping` | Latency check |
| `!echo <text>` | Repeat text back |
| `!userinfo [user]` | Look up a user (embed) |
| `!serverinfo` | Server stats from cache (embed, guild-only) |
| `!purge <count>` | Bulk delete 2–100 recent messages (`MANAGE_MESSAGES`) |
| `!timeout <user> <min>` | Timeout a member (`MODERATE_MEMBERS`) |

The bot also registers a `/serverinfo` slash command automatically on login,
sets its presence to reflect the version, restricts outgoing pings to users
and roles only (`defaultAllowedMentions`), and shuts down cleanly on Ctrl+C.

## Structure

- `app.js` — website framework entry point
- `public/` — website static assets (CSS, images, etc.)
- `theme/` — the website framework's shadcn/ui theme (globals.css)
- `bot.js` — Discord bot entry point (framework loading, autoloading, lifecycle)
- `commands/` — one file per Discord command (autoloaded)
- `test/smoke.js` — offline smoke tests (no network, no token needed)
- `server.js` — the existing registry + static site server
- `build.js` — the existing static site builder
