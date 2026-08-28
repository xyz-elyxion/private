'use strict';

// Elyxion private Discord bot
// ------------------------------------------------------------------
// Run:
//   node bot.js            # start the bot (needs DISCORD_TOKEN in .env)
//   node bot.js --check    # offline self-test: loads commands, no login
//
// Token setup:
//   copy .env.example to .env and paste a token from
//   https://discord.com/developers/applications

const path = require('path');
const fs = require('fs');

// ---- Load the framework -------------------------------------------
// Prefer the installed elyxion-discord package (elyx_modules / node_modules);
// fall back to a sibling checkout of discord-framework for monorepo dev.
let FRAMEWORK_PATH = null;
try {
  FRAMEWORK_PATH = require.resolve('elyxion-discord');
} catch (_) {
  try {
    FRAMEWORK_PATH = require.resolve(path.join(__dirname, '..', 'discord-framework', 'index.js'));
    // Teach every later require('elyxion-discord') — including command
    // files — where the fallback lives.
    const Module = require('module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request) {
      if (request === 'elyxion-discord') return FRAMEWORK_PATH;
      return originalResolve.apply(this, arguments);
    };
  } catch (err) {
    console.error('[bot] Cannot find the discord-framework.');
    console.error('       Install it:  elyx install elyxion-discord');
    console.error('       Or keep the discord-framework repo next to this project.');
    process.exit(1);
  }
}

const fw = require(FRAMEWORK_PATH);
const { loadEnv, createBot } = fw;
loadEnv(path.join(__dirname, '.env'));

// ---- Config ---------------------------------------------------------
const CHECK_ONLY = process.argv.includes('--check');
const TOKEN = process.env.DISCORD_TOKEN || '';
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN && !CHECK_ONLY) {
  console.error('[bot] No Discord token found.');
  console.error('');
  console.error('  1. Create an application + bot at https://discord.com/developers/applications');
  console.error('  2. Copy .env.example to .env');
  console.error('  3. Put the token in it:  DISCORD_TOKEN=your-token');
  console.error('');
  process.exit(1);
}
if (!CHECK_ONLY) {
  console.log('[bot] framework v' + fw.version + ', prefix "' + PREFIX + '"');
}

// Never @everyone/@here by accident: outgoing messages may mention
// users and roles only.
const bot = createBot({
  token: TOKEN,
  prefix: PREFIX,
  defaultAllowedMentions: { parse: ['users', 'roles'] }
});

// ---- Command autoloading --------------------------------------------
// Every .js file in commands/ exports either one command module or an
// array/object of them: { name?, description?, usage?, run, options? }.
const COMMANDS_DIR = path.join(__dirname, 'commands');

function normalizeCommand(mod, fallbackName) {
  const cmd = typeof mod === 'function' ? { run: mod } : Object.assign({}, mod);
  if (!cmd.name) cmd.name = fallbackName;
  if (!cmd.run) throw new Error('command "' + cmd.name + '" has no run()');
  return cmd;
}

for (const file of fs.readdirSync(COMMANDS_DIR).sort()) {
  if (!file.endsWith('.js')) continue;
  const base = path.basename(file, '.js');
  const mod = require(path.join(COMMANDS_DIR, file));
  const list = Array.isArray(mod) ? mod
    : typeof mod === 'object' && !mod.run && !mod.options ? Object.values(mod)
    : [mod];
  for (const entry of list) {
    const cmd = normalizeCommand(entry, base);
    bot.command(cmd.name, cmd.run, Object.assign({ description: '(no description)' }, cmd.options));
  }
}

// ---- Lifecycle -------------------------------------------------------
bot.on('error', (err) => console.error('[bot:error]', err.message));
bot.on('commandError', (err, ctx) => {
  console.error('[cmd:error]', ctx.name + ':', err.message);
  ctx.reply('Something broke running that command.').catch(() => {});
});
bot.on('interactionError', (err) => console.error('[interaction:error]', err.message));
bot.on('unhandledInteraction', (p) => console.warn('[interaction] unhandled type=' + p.type));

// Derived events: keep a light footprint — log joins/leaves only.
bot.on('guildMemberAdd', (member) => {
  const who = member.user ? member.user.username : member.id;
  const where = member.guild ? member.guild.name : (member.guild_id || 'unknown guild');
  console.log('[members] ' + who + ' joined ' + where);
});
bot.on('guildMemberRemove', (user) => {
  console.log('[members] ' + (user.username || user.id) + ' left');
});

// ---- Startup ----------------------------------------------------------
let started = false;

async function start() {
  if (started) return;
  started = true;

  await bot.login();          // verifies the token via REST, syncs slash commands
  console.log('  ⚡ Logged in as ' + bot.user.username +
    (bot.user.discriminator && bot.user.discriminator !== '0' ? '#' + bot.user.discriminator : '') +
    ' (' + bot.user.id + ')');

  bot.connect();              // opens the gateway

  // Presence once the gateway session is actually live.
  bot.gateway.once('ready', () => {
    try {
      bot.gateway.setPresence({
        status: 'online',
        activities: [{ name: PREFIX + 'help · v' + fw.version, type: 0 }]
      });
    } catch (_) { /* presence is cosmetic */ }
    console.log('     Gateway ready — try ' + PREFIX + 'help in Discord');
    console.log('');
  });
}

process.on('SIGINT', () => {
  console.log('\n[bot] shutting down…');
  try { if (bot.gateway) bot.gateway.close(); } catch (_) {}
  process.exit(0);
});

module.exports = { bot, start };

// ---- Entry point --------------------------------------------------------
if (require.main === module) {
  if (CHECK_ONLY) {
    const cmds = bot.commands.list();
    console.log('[check] framework v' + fw.version);
    console.log('[check] prefix "' + PREFIX + '", commands (' + cmds.length + '):');
    for (const c of cmds) {
      console.log('         ' + PREFIX + c.usage + ' — ' + c.description);
    }
    console.log(TOKEN
      ? '[check] OK — token present; starting will connect to Discord.'
      : '[check] OK — loaded offline (no token yet); set DISCORD_TOKEN in .env to go live.');
    process.exit(0);
  }

  start().catch((err) => {
    console.error('[bot] failed to start:', err.message);
    process.exit(1);
  });
}
