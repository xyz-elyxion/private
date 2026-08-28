'use strict';

// !echo — repeat the user's text back, mentioning nobody unexpectedly
// (bot.defaultAllowedMentions already restricts pings to users/roles).

function run(ctx) {
  if (!ctx.text) return ctx.reply('Usage: `!echo <text>`');
  return ctx.reply(ctx.text);
}

module.exports = {
  options: { description: 'Repeat your text', usage: 'echo <text>' },
  run
};
