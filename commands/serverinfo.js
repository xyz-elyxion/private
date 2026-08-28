'use strict';

// !serverinfo — guild details from the cache, rendered as an embed.

const { Embed } = require('elyxion-discord');

async function run(ctx) {
  if (!ctx.guildId) return ctx.reply('Use this in a server.');

  // Make sure we actually have the guild cached; GUILD_CREATE seeded it.
  let guild = ctx.bot.cache.getGuild(ctx.guildId);
  if (!guild) {
    const res = await ctx.bot.api.getGuild(ctx.guildId);
    if (res.statusCode === 200) guild = res.data;
  }
  if (!guild) return ctx.reply("I couldn't find this server's info.");

  const embed = new Embed()
    .setTitle(guild.name)
    .setColor('blurple')
    .setThumbnail(guild.icon ? 'https://cdn.discordapp.com/icons/' + guild.id + '/' + guild.icon + '.png' : undefined)
    .addField('Members', String(guild.member_count || (guild.members ? guild.members.length : '?')), true)
    .addField('Channels', String(guild.channels ? guild.channels.length : '?'), true)
    .addField('Roles', String(guild.roles ? guild.roles.length : '?'), true)
    .setFooter('Server ID: ' + guild.id);

  if (guild.owner_id) {
    const owner = ctx.bot.cache.getUser(guild.owner_id);
    embed.addField('Owner', owner ? '<@' + owner.id + '>' : '`' + guild.owner_id + '`', true);
  }

  return ctx.reply({ embeds: [embed.toJSON()] });
}

module.exports = {
  options: { description: 'Show info about this server', usage: 'serverinfo', guildOnly: true },
  run
};
