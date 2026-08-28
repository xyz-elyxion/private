// Elyxion Discord Framework — example bot
// ------------------------------------------------------------------
// Run with:  elyxion examples/basic/bot.js
// (set DISCORD_TOKEN first, or create a .env next to this file)
'use strict';

const { loadEnv, createBot, Embed } = require('../../index');
loadEnv();

// defaultAllowedMentions stops the bot from ever pinging
// @everyone/@here or roles unless a payload opts back in.
const bot = createBot({
  prefix: process.env.PREFIX || '!',
  token: process.env.DISCORD_TOKEN || '',
  defaultAllowedMentions: { parse: ['users'] }
});

bot.command('ping', (ctx) => {
  ctx.reply('pong!');
}, { description: 'Replies with pong' });

bot.command('react', async (ctx) => {
  await bot.react(ctx.message.channel_id, ctx.message.id, '\uD83D\uDC4D');
}, { description: 'Adds a thumbs-up reaction to your message' });

bot.command('purge', async (ctx) => {
  const recent = await bot.fetchMessages(ctx.message.channel_id, { limit: 50 });
  const ids = recent.map((m) => m.id).filter((id) => id !== ctx.message.id).slice(0, 90);
  for (let i = 0; i + 2 <= ids.length; i += 2) {
    await bot.bulkDelete(ctx.message.channel_id, ids.slice(i, i + 2)).catch(() => {});
  }
  ctx.reply('Cleaned up ' + ids.length + ' messages.');
}, { description: 'Bulk-deletes recent messages', permissions: ['MANAGE_MESSAGES'], guildOnly: true });

bot.slash('serverinfo', async (ctx) => {
  const guild = ctx.guildId && bot.cache.getGuild(ctx.guildId);
  if (!guild) return ctx.reply('Use this in a server.');
  await ctx.reply({
    embeds: [new Embed()
      .setTitle(guild.name)
      .addField('Members', String(guild.member_count || 'unknown'), true)
      .setColor('blue')
      .toJSON()]
  });
}, { description: 'Show info about this server' });

// Derived events ship richer payloads than raw dispatches:
bot.on('guildMemberAdd', (member) => {
  console.log('New member: ' + (member.user ? member.user.username : member.id));
});

bot.on('reactionAdd', (reaction) => {
  // reaction.emoji, reaction.user, reaction.messageId are pre-resolved.
});

// Voice: join/leave/move channels (full signaling; no audio codec).
//   bot.voice.join(guildId, channelId, { selfDeaf: true });
//   bot.on('voiceStateUpdate', ({ joined, left, movedChannel }) => ...);

bot.command('embed', (ctx) => {
  const embed = new Embed()
    .setTitle('Hello from Elyxion')
    .setDescription('A Discord bot running on the Elyxion runtime — no Node.js required.')
    .setColor('#8b5cf6')
    .addField('Runtime', 'Elyxion — one binary, zero dependencies', true)
    .addField('Framework', 'elyxion-discord', true)
    .setFooter('Built with elyxion-discord');
  ctx.reply({ embeds: [embed.toJSON()] });
}, { description: 'Sends an embed' });

bot.command('help', (ctx) => {
  const list = bot.commands.list()
    .map((c) => '`' + bot.prefix + c.usage + '` — ' + c.description)
    .join('\n');
  ctx.reply('**Commands**\n' + list);
}, { description: 'Lists commands' });

bot.on('ready', (user) => {
  console.log('');
  console.log('  ⚡ Elyxion Discord Framework example');
  console.log('     Logged in as ' + user.username + ' (' + user.id + ')');
  console.log('     Prefix commands: !ping, !embed, !help, !react, !purge');
  console.log('     Slash commands are synced automatically on login.');
  console.log('');
});

bot.on('error', (err) => console.error('Bot error: ' + err.message));

if (require.main === module) {
  bot.login().then(() => bot.connect());
}

module.exports = { bot };
