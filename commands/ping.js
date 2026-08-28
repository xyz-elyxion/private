'use strict';

// !ping — latency check: round-trip REST time + gateway uptime.

async function run(ctx) {
  const started = Date.now();
  const sent = await ctx.reply('Pinging…');
  const roundTrip = Date.now() - started;

  let gateway = 'n/a';
  if (ctx.bot.gateway && ctx.bot.gateway._heartbeatTimer) {
    gateway = 'connected';
  }

  await ctx.bot.editMessage(ctx.message.channel_id, sent.id,
    '🏓 **Pong!** — REST round trip ' + roundTrip + 'ms' +
    (gateway === 'connected' ? ', gateway live, session ' + Math.floor(process.uptime()) + 's old' : ''));
}

module.exports = {
  options: { description: 'Check that the bot is alive', usage: 'ping', aliases: ['pong'] },
  run
};
