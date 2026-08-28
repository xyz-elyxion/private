// Elyxion Discord Framework — CLI (`elyxion cli.js <command> [args]`)
// Commands: create <dir>, run [dir]
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '0.2.0';

const HELP = [
  '',
  '  Elyxion Discord Framework CLI  v' + VERSION,
  '',
  '  Usage:  elyxion cli.js <command> [options]',
  '',
  '  Commands:',
  '    create <name>    Scaffold a new bot project',
  '    run [dir]        Load bot.js and start the bot (default: .)',
  '',
  '  Options:',
  '    -h, --help       Show this help',
  '    -v, --version    Print version',
  ''
].join('\n');

function run(argv) {
  const args = argv || process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === '-v' || cmd === '--version') { console.log('elyxion-discord v' + VERSION); return; }

  if (cmd === 'create') {
    const name = args[1];
    if (!name) { console.log('Usage: elyxion cli.js create <name>'); process.exit(1); }
    scaffold(name);
    return;
  }

  if (cmd === 'run') {
    const dir = args[1] && !args[1].startsWith('-') ? args[1] : '.';
    runBot(dir);
    return;
  }

  console.log('Unknown command: ' + cmd);
  console.log(HELP);
  process.exit(1);
}

function scaffold(name) {
  const target = path.resolve(name);
  if (fs.existsSync(target)) {
    console.log('Error: directory already exists: ' + name);
    process.exit(1);
  }

  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, 'commands'));

  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: name,
    version: '0.1.0',
    description: '',
    main: 'bot.js',
    dependencies: { 'elyxion-discord': '^0.1.0' }
  }, null, 2));

  fs.writeFileSync(path.join(target, 'bot.js'), EXAMPLE_BOT);
  fs.writeFileSync(path.join(target, 'commands', 'ping.js'), EXAMPLE_PING);
  fs.writeFileSync(path.join(target, '.env.example'), [
    '# Discord bot token — create one at https://discord.com/developers/applications',
    'DISCORD_TOKEN=your-bot-token-here',
    '',
    '# Optional command prefix (defaults to !)',
    'PREFIX=!'
  ].join('\n'));

  fs.writeFileSync(path.join(target, 'README.md'), [
    '# ' + name,
    '',
    'A Discord bot built with the Elyxion Discord Framework — zero dependencies,',
    'running on the Elyxion runtime.',
    '',
    '## Install',
    'First make the framework available to require():',
    '```bash',
    'elyx install elyxion-discord   # or clone the framework repo next to this project',
    '```',
    '',
    '## Setup',
    'Copy `.env.example` to `.env` and set your bot token (bot.js loads it for you).',
    '',
    '## Run',
    '```bash',
    'elyxion bot.js',
    '```',
    '',
    '## Structure',
    '- `bot.js` — the bot entry point (commands, events, login)',
    '- `commands/` — one file per command',
    ''
  ].join('\n'));

  console.log('✓ Created project at ' + target);
  console.log('  Copy .env.example to .env, add your token, then:');
  console.log('  cd ' + name + ' && elyxion bot.js');
}

function runBot(dir) {
  const abs = path.resolve(dir);
  const botFile = path.join(abs, 'bot.js');

  if (!fs.existsSync(botFile)) {
    console.log('Error: no bot.js found in ' + abs + '. Run `elyxion cli.js create <name>` first.');
    process.exit(1);
  }

  const mod = require(botFile);

  if (typeof mod.start === 'function') {
    mod.start({});
  } else if (mod.bot && typeof mod.bot.login === 'function') {
    mod.bot.login().then(() => mod.bot.connect()).catch((err) => {
      console.error('Error: ' + err.message);
      process.exit(1);
    });
  } else {
    console.log('Error: bot.js must export { start } or { bot }.');
    process.exit(1);
  }
}

const EXAMPLE_BOT = [
  "'use strict';",
  '',
  "const { loadEnv } = require('elyxion-discord');",
  'loadEnv(); // read .env if present (no dependencies)',
  '',  "  const { createBot, Embed } = require('elyxion-discord');",
  '',
  'const bot = createBot({',
  "  prefix: process.env.PREFIX || '!',",
  "  token: process.env.DISCORD_TOKEN || ''",
  '});',
  '',
  "const ping = require('./commands/ping');",
  "bot.command('ping', ping.run, ping.options);",
  '',
  "bot.command('embed', (ctx) => {",
  '  const embed = new Embed()',
  "    .setTitle('Hello from Elyxion')",
  "    .setDescription('A Discord bot running on the Elyxion runtime.')",
  "    .setColor('#8b5cf6')",
  "    .addField('Runtime', 'Elyxion — no Node.js required', true)",
  "    .addField('Framework', 'elyxion-discord', true)",
  "    .setFooter('Built with elyxion-discord');",
  '  ctx.reply({ embeds: [embed.toJSON()] });',
  "}, { description: 'Sends an embed' });",
  '',
  '// Slash commands are auto-registered with Discord after login.',
  "bot.slash('ping', (ctx) => ctx.reply('pong!'), { description: 'Replies with pong' });",
  '',
  "bot.on('ready', (user) => {",
  "  console.log('  ⚡ Logged in as ' + user.username + ' (' + user.id + ')');",
  "  console.log('     Commands: !ping, !embed, /ping');",
  "  console.log('');",
  '});',
  '',
  "bot.on('error', (err) => console.error('Bot error: ' + err.message));",
  '',
  "module.exports = { start: (opts) => bot.login().then(() => bot.connect()) };",
  ''
].join('\n');

const EXAMPLE_PING = [
  "'use strict';",
  '',
  '// Example command. Add more files here and register them in bot.js:',
  "//   const myCmd = require('./commands/mycmd');",
  "//   bot.command('mycmd', myCmd.run, myCmd.options);",
  '',
  'module.exports = {',
  "  options: { description: 'Replies with pong', usage: 'ping' },",
  '  run: (ctx) => {',
  "    ctx.reply('pong!');",
  '  }',
  '};',
  ''
].join('\n');

if (require.main === module) run();

module.exports = { run };
