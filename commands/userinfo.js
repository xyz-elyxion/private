'use strict';

// !userinfo [mention|id] — who is that? Defaults to the caller.

const { Embed, parseMention } = require('elyxion-discord');

async function run(ctx) {
  const target = ctx.args[0];
  let user = null;
  let member = null;

  if (target) {
    const id = parseMention(target) || (/^\d{17,20}$/.test(target) ? target : null);
    if (!id) return ctx.reply('Mention a user or give their ID.');
    member = ctx.bot.cache.getMember(ctx.guildId || '', id);
    if (member && member.user) user = member.user;
    if (!user) {
      const res = await ctx.bot.api.getUser(id);
      if (res.statusCode !== 200) return ctx.reply("Couldn't find that user.");
      user = res.data;
    }
  } else {
    user = ctx.author;
    member = ctx.message.member || null;
  }

  const embed = new Embed()
    .setTitle(user.username + (user.discriminator && user.discriminator !== '0' ? '#' + user.discriminator : ''))
    .setColor(member && member.roles && member.roles.length ? 'green' : 'gray')
    .setThumbnail(user.avatar
      ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png'
      : undefined)
    .addField('ID', '`' + user.id + '`', true)
    .addField('Bot', user.bot ? 'yes' : 'no', true);

  if (member) {
    if (member.nick) embed.addField('Nickname', member.nick, true);
    if (member.joined_at) embed.addField('Joined', new Date(Date.parse(member.joined_at)).toDateString(), true);
    const roles = (member.roles || []).filter((r) => r !== ctx.guildId);
    if (roles.length) embed.addField('Roles', String(roles.length), true);
  }

  return ctx.reply({ embeds: [embed.toJSON()] });
}

module.exports = {
  options: { description: 'Look up a user', usage: 'userinfo [user]' },
  run
};
