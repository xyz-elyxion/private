'use strict';

// !purge <count> — bulk-delete recent messages (MANAGE_MESSAGES).

async function run(ctx) {
  const count = parseInt(ctx.args[0], 10);
  if (isNaN(count) || count < 2 || count > 100) {
    return ctx.reply('Give me a number between **2 and 100** — `!purge 25`.');
  }

  const page = await ctx.bot.fetchMessages(ctx.message.channel_id, { limit: count });
  // Newest first from the API; drop the invoking message itself.
  const ids = page.map((m) => m.id).filter((id) => id !== ctx.message.id);

  let deleted = 0;
  for (let i = 0; i + 1 < ids.length; i += 2) {
    try {
      await ctx.bot.bulkDelete(ctx.message.channel_id, ids.slice(i, i + 2));
      deleted += Math.min(2, ids.length - i);
    } catch (_) { /* older than 14 days or no permission — skip */ }
  }

  return ctx.reply('Swept **' + deleted + '** messages. 🧹');
}

module.exports = {
  options: {
    description: 'Bulk delete recent messages (2-100)',
    usage: 'purge <count>',
    permissions: ['MANAGE_MESSAGES'],
    guildOnly: true,
    cooldown: 5000
  },
  run
};
