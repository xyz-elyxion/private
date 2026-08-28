'use strict';

// !help — list commands, or detail one:  !help <command>

function run(ctx) {
  const bot = ctx.bot;
  const registry = bot.commands.list();

  if (ctx.args && ctx.args.length) {
    const wanted = String(ctx.args[0]).toLowerCase();
    const cmd = registry.find((c) => c.name === wanted || c.aliases.indexOf(wanted) !== -1);
    if (!cmd) return ctx.reply('No command called `' + bot.prefix + wanted + '`.');
    const lines = ['**' + bot.prefix + cmd.usage + '**'];
    if (cmd.description) lines.push(cmd.description);
    if (cmd.aliases.length) lines.push('Aliases: ' + cmd.aliases.map((a) => '`' + a + '`').join(', '));
    if (cmd.permissions.length) lines.push('Requires: ' + cmd.permissions.join(', '));
    if (cmd.cooldown > 0) lines.push('Cooldown: ' + Math.round(cmd.cooldown / 1000) + 's');
    return ctx.reply(lines.join('\n'));
  }

  const seen = {};
  const rows = [];
  for (const cmd of registry) {
    if (seen[cmd.name]) continue; // subcommand paths share prefixes
    seen[cmd.name] = true;
    rows.push('`' + bot.prefix + cmd.usage + '` — ' + (cmd.description || '(no description)'));
  }
  return ctx.reply(['**Commands**', ...rows, '', 'Detail: `' + bot.prefix + 'help <command>`'].join('\n'));
}

module.exports = {
  options: { description: 'List commands or show one in detail', usage: 'help [command]' },
  run
};
