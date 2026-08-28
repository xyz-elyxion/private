'use strict';

// !timeout <user> <minutes> [reason] — timeout a member (MODERATE_MEMBERS).

async function run(ctx) {
  const who = ctx.args[0];
  const minutes = parseInt(ctx.args[1], 10);

  const mentionId = typeof who === 'string' && /^\d{17,20}$/.test(who)
    ? who
    : require('elyxion-discord').parseMention(who || '');
  if (!mentionId || isNaN(minutes) || minutes <= 0) {
    return ctx.reply('Usage: `!timeout @user <minutes> [reason]`');
  }
  if (ctx.author.id === mentionId) return ctx.reply("You can't timeout yourself.");

  try {
    await ctx.bot.timeout(ctx.guildId, mentionId, minutes * 60 * 1000);
    const reason = ctx.args.slice(2).join(' ');
    return ctx.reply('⏱ Timed out <@' + mentionId + '> for **' + minutes +
      ' min**' + (reason ? ' — ' + reason : ''));
  } catch (err) {
    return ctx.reply('Failed: ' + err.message);
  }
}

module.exports = {
  options: {
    description: 'Timeout a member',
    usage: 'timeout <user> <minutes>',
    permissions: ['MODERATE_MEMBERS'],
    guildOnly: true,
    cooldown: 3000
  },
  run
};
