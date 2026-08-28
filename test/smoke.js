'use strict';

// Offline smoke test for private/bot.js — no network, stubbed messaging.
// Run: node test/smoke.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'smoke-test-token';
const { bot } = require('../bot.js');

const assert = require('assert');
let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  const replies = [];
  // Stub at the REST layer so the REAL sendMessage / reply /
  // _withDefaultMentions pipeline still runs.
  for (const m of ['get', 'put', 'patch', 'del']) {
    bot.rest[m] = async () => ({ statusCode: 200, data: {}, headers: {} });
  }
  bot.rest.post = async (pathName, payload) => {
    const m = String(pathName).match(/^\/channels\/([^/]+)\/messages$/);
    if (m) replies.push({ channelId: m[1], payload });
    return { statusCode: 200, data: { id: 'm2' }, headers: {} };
  };

  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

  function send(content, extra) {
    bot._handleMessage(Object.assign({
      id: 'm1', channel_id: 'c1', content,
      author: { id: 'u1', username: 'tester', bot: false }
    }, extra || {}));
  }

  // !ping
  send('!ping');
  await tick();
  ok('ping acknowledges', /Pinging/.test((replies[replies.length - 1] || {}).payload ? replies[replies.length - 1].payload.content : ''));

  // !help
  send('!help');
  await tick();
  ok('help lists commands', replies.some((r) => r.payload.content && r.payload.content.indexOf('**Commands**') !== -1));

  // !help <command>
  send('!help timeout');
  await tick();
  ok('help detail shows usage + permission', replies.some((r) =>
    r.payload.content && r.payload.content.indexOf('**!timeout <user> <minutes>**') !== -1 &&
    r.payload.content.indexOf('MODERATE_MEMBERS') !== -1));

  // !echo
  send('!echo hello world');
  await tick();
  const echoReply = replies.find((r) => r.payload.content && r.payload.content.indexOf('hello world') !== -1);
  ok('echo repeats text', !!echoReply);

  // defaultAllowedMentions flow through reply → sendMessage
  const withMentions = replies.find((r) => r.payload.allowed_mentions);
  ok('defaultAllowedMentions attached to outgoing messages',
    !!withMentions && Array.isArray(withMentions.payload.allowed_mentions.parse) &&
    withMentions.payload.allowed_mentions.parse.indexOf('everyone') === -1);

  // !purge without permission
  let denied = null;
  bot.on('noPermission', (info) => { denied = info; });
  send('!purge 10', { guild_id: 'g1', member: { permissions: '1024' } }); // VIEW_CHANNEL only
  await tick();
  ok('purge blocked without MANAGE_MESSAGES', !!denied);

  // !purge happy path with perms (rest.get returns {} so page is empty)
  send('!purge 5', { guild_id: 'g1', member: { permissions: String(1 << 13) } });
  await tick();
  ok('purge runs when permitted',
    replies.some((r) => r.payload.content && r.payload.content.indexOf('Swept') !== -1));

  // !userinfo defaults to self via cache
  bot.cache.handle('MESSAGE_CREATE', {
    id: 'm1', channel_id: 'c1',
    author: { id: 'u1', username: 'tester', bot: false }
  });
  send('!userinfo');
  await tick();
  ok('userinfo renders an embed', replies.some((r) => r.payload.embeds && r.payload.embeds.length === 1));

  // Unknown command is ignored
  const before = replies.length;
  send('!definitelynotacommand');
  await tick();
  ok('unknown commands are ignored', replies.length === before);

  console.log('');
  console.log('Smoke: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
