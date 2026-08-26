'use strict';

const { loadEnv } = require('elyxion-discord');
loadEnv(); // read .env if present (no dependencies)

const { createBot, Embed } = require('elyxion-discord');

const bot = createBot({
  prefix: process.env.PREFIX || '!',
  token: process.env.DISCORD_TOKEN || ''
});

const ping = require('./commands/ping');
bot.command('ping', ping.run, ping.options);

bot.command('embed', (ctx) => {
  const embed = new Embed()
    .setTitle('Hello from Elyxion')
    .setDescription('A Discord bot running on the Elyxion runtime.')
    .setColor('#8b5cf6')
    .addField('Runtime', 'Elyxion — no Node.js required', true)
    .addField('Framework', 'elyxion-discord', true)
    .setFooter('Built with elyxion-discord');
  ctx.reply({ embeds: [embed.toJSON()] });
}, { description: 'Sends an embed' });

bot.on('ready', (user) => {
  console.log('  ⚡ Logged in as ' + user.username + ' (' + user.id + ')');
  console.log('     Commands: !ping, !embed');
  console.log('');
});

bot.on('error', (err) => console.error('Bot error: ' + err.message));

module.exports = { start: (opts) => bot.login().then(() => bot.connect()) };
