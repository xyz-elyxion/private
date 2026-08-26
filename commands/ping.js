'use strict';

// Example command. Add more files here and register them in bot.js:
//   const myCmd = require('./commands/mycmd');
//   bot.command('mycmd', myCmd.run, myCmd.options);

module.exports = {
  options: { description: 'Replies with pong', usage: 'ping' },
  run: (ctx) => {
    ctx.reply('pong!');
  }
};
