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
let FRAMEWORK_PATH = path.join(__dirname, 'discord-framework', 'index.js');
try {
  fs.statSync(FRAMEWORK_PATH);
} catch (_) {
  try {
    FRAMEWORK_PATH = require('elyxion-discord');
  } catch (err) {
    console.error('[bot] Cannot find the discord-framework.');
    console.error('       Expected: ' + path.join(__dirname, 'discord-framework'));
    throw err;
  }
}

const fw = require(FRAMEWORK_PATH);
// Command files use require('elyxion-discord'), so map that package name to
// the vendored framework in runtimes that do not support package resolution.
try {
  const Module = require('module');
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request) {
    if (request === 'elyxion-discord') return FRAMEWORK_PATH;
    return originalResolve.apply(this, arguments);
  };
} catch (_) {}
const { loadEnv, createBot } = fw;
loadEnv(path.join(__dirname, '.env'));

// ---- Config ---------------------------------------------------------
const CHECK_ONLY = process.argv.includes('--check');
const TOKEN = process.env.DISCORD_TOKEN || '';
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN && !CHECK_ONLY) {
  console.error('[bot] No Discord token found; bot disabled.');
  console.error('       Set DISCORD_TOKEN in Render environment variables to enable it.');
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
  const value = mod && mod.default ? mod.default : mod;
  const cmd = typeof value === 'function' ? { run: value } : Object.assign({}, value);
  if (value && typeof value.run === 'function') cmd.run = value.run;
  if (!cmd.name) cmd.name = fallbackName;
  if (!cmd.run && typeof cmd.handler === 'function') cmd.run = cmd.handler;
  // Some Elyxion builds expose function properties as non-enumerable.
  if (!cmd.run && value && typeof value.run === 'function') cmd.run = value.run;
  if (!cmd.run) throw new Error('command "' + cmd.name + '" has no run()');
  return cmd;
}

for (const file of fs.readdirSync(COMMANDS_DIR).sort()) {
  if (!file.endsWith('.js')) continue;
  const base = path.basename(file, '.js');
  const mod = require(path.join(COMMANDS_DIR, file));
  // Each command file is one module. The runtime can expose its object
  // export without enumerable properties, so do not split it with
  // Object.values(); normalizeCommand reads run directly.
  const exported = mod && mod.default ? mod.default : mod;
  const cmd = normalizeCommand(exported, base);
  bot.command(cmd.name, cmd.run, Object.assign({ description: '(no description)' }, cmd.options));
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

  if (!TOKEN) return;

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
