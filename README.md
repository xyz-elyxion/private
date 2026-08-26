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

Copy `.env.example` to `.env` and set your bot token (bot.js loads it for you).

### Run

```bash
elyxion bot.js
```

## Structure

- `app.js` — website framework entry point
- `public/` — website static assets (CSS, images, etc.)
- `theme/` — the website framework's shadcn/ui theme (globals.css)
- `bot.js` — Discord bot entry point (commands, events, login)
- `commands/` — one file per Discord command
- `server.js` — the existing registry + static site server
- `build.js` — the existing static site builder
