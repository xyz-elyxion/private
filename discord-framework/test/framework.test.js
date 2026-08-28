// Elyxion Discord Framework — tests
// ---------------------------------------------------------------
// Runs under the Elyxion runtime (`elyxion test/framework.test.js`)
// and under Node.js (`node test/framework.test.js`). Network calls
// are stubbed — everything tested here runs in-process.
'use strict';

const assert = require('assert');
const { TestRunner } = require('../../elyxion-cli/test/runner');

const fw = require('../index');
const { Embed, createBot, CommandRegistry } = fw;
const { encodeFrame, FrameParser, intentBits } = require('../lib/gateway');

const runner = new TestRunner();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- util -------------------------------------------------------

runner.describe('util', () => {
  runner.it('resolveColor accepts names, hex, ints, and rgb arrays', () => {
    assert.strictEqual(fw.resolveColor('red'), 0xed4245);
    assert.strictEqual(fw.resolveColor('#8b5cf6'), 0x8b5cf6);
    assert.strictEqual(fw.resolveColor('8b5cf6'), 0x8b5cf6);
    assert.strictEqual(fw.resolveColor(0xffffff), 0xffffff);
    assert.strictEqual(fw.resolveColor([1, 2, 3]), (1 << 16) | (2 << 8) | 3);
    assert.strictEqual(fw.resolveColor('nope'), 0x000000);
  });

  runner.it('parseMention extracts a user id', () => {
    assert.strictEqual(fw.parseMention('<@123456789012345678>'), '123456789012345678');
    assert.strictEqual(fw.parseMention('<@!123456789012345678>'), '123456789012345678');
    assert.strictEqual(fw.parseMention('hello'), null);
  });

  runner.it('snowflakeToDate decodes a snowflake timestamp', () => {
    const date = fw.snowflakeToDate('1754064000000000000');
    assert(date instanceof Date);
    assert.strictEqual(date.getTime(), Math.floor(1754064000000000000 / 4194304) + 1420070400000);
    assert.strictEqual(fw.snowflakeToDate('not-an-id'), null);
  });

  runner.it('truncate shortens long strings', () => {
    assert.strictEqual(fw.truncate('hello world', 5), 'hell…');
    assert.strictEqual(fw.truncate('hi', 5), 'hi');
  });

  runner.it('loadEnv reads a .env file without clobbering existing vars', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const file = path.join(os.tmpdir(), 'elyxion-discord-env-' + Date.now() + '.env');
    fs.writeFileSync(file, 'A=1\nB="two words"\n# comment\nC=3\n');
    process.env.B = 'already-set';
    fw.loadEnv(file);
    assert.strictEqual(process.env.A, '1');
    assert.strictEqual(process.env.B, 'already-set');
    assert.strictEqual(process.env.C, '3');
    delete process.env.A; delete process.env.B; delete process.env.C;
    fs.unlinkSync(file);
  });
});

// ---- permissions -------------------------------------------------

runner.describe('permissions', () => {
  runner.it('hasPermission reads low 32-bit permission bits', () => {
    assert.strictEqual(fw.hasPermission('8', 'ADMINISTRATOR'), true);
    assert.strictEqual(fw.hasPermission('8192', 'MANAGE_MESSAGES'), true); // 2^13
    assert.strictEqual(fw.hasPermission('8192', 'KICK_MEMBERS'), false);
    assert.strictEqual(fw.hasPermission('2', 'KICK_MEMBERS'), true);
    assert.strictEqual(fw.hasPermission('1024', 'VIEW_CHANNEL'), true);
  });

  runner.it('hasPermission reads high 32-bit permission bits (no BigInt)', () => {
    assert.strictEqual(fw.hasPermission('1099511627776', 'MODERATE_MEMBERS'), true); // 2^40
    assert.strictEqual(fw.hasPermission('1099511627776', 'MANAGE_MESSAGES'), false);
  });

  runner.it('ADMINISTRATOR implies every permission', () => {
    assert.strictEqual(fw.hasPermission('8', 'KICK_MEMBERS'), true);
    assert.strictEqual(fw.hasPermission('8', 'MODERATE_MEMBERS'), true);
  });

  runner.it('accepts arrays and comma lists of permission names', () => {
    assert.strictEqual(fw.hasPermission(['KICK_MEMBERS', 'BAN_MEMBERS'], 'KICK_MEMBERS'), true);
    assert.strictEqual(fw.hasPermission('KICK_MEMBERS, BAN_MEMBERS', 'BAN_MEMBERS'), true);
  });
});

// ---- embeds -----------------------------------------------------

runner.describe('embed', () => {
  runner.it('builds a complete embed JSON payload', () => {
    const embed = new Embed()
      .setTitle('Title')
      .setDescription('Desc')
      .setColor('#8b5cf6')
      .setURL('https://example.com')
      .setAuthor('Elyxion', { url: 'https://example.com' })
      .setFooter('Footer', 'https://example.com/icon.png')
      .setThumbnail('https://example.com/t.png')
      .setImage('https://example.com/i.png')
      .setTimestamp('2026-01-01T00:00:00.000Z')
      .addField('A', '1', true)
      .addField('B', '2');

    const json = embed.toJSON();
    assert.strictEqual(json.title, 'Title');
    assert.strictEqual(json.description, 'Desc');
    assert.strictEqual(json.color, 0x8b5cf6);
    assert.strictEqual(json.url, 'https://example.com');
    assert.strictEqual(json.author.name, 'Elyxion');
    assert.strictEqual(json.footer.text, 'Footer');
    assert.strictEqual(json.thumbnail.url, 'https://example.com/t.png');
    assert.strictEqual(json.image.url, 'https://example.com/i.png');
    assert.strictEqual(json.timestamp, '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(json.fields, [
      { name: 'A', value: '1', inline: true },
      { name: 'B', value: '2', inline: false }
    ]);
  });

  runner.it('enforces the 25-field limit', () => {
    const embed = new Embed();
    assert.throws(() => {
      for (let i = 0; i < 26; i++) embed.addField('f' + i, 'v');
    }, /25/);
  });

  runner.it('setTimestamp() without an argument uses now', () => {
    const before = Date.now();
    const ts = new Embed().setTimestamp().toJSON().timestamp;
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    assert(parsed >= before - 1000 && parsed <= after + 1000);
  });
});

// ---- command parsing --------------------------------------------

runner.describe('commands', () => {
  runner.it('parses prefix, name, args, and text', () => {
    const parsed = require('../lib/commands').parseCommand;
    const hit = parsed('!greet ada lovelace', '!');
    assert.strictEqual(hit.name, 'greet');
    assert.deepStrictEqual(hit.args, ['ada', 'lovelace']);
    assert.strictEqual(hit.text, 'ada lovelace');
  });

  runner.it('returns null for non-command messages', () => {
    const parsed = require('../lib/commands').parseCommand;
    assert.strictEqual(parsed('hello there', '!'), null);
    assert.strictEqual(parsed('!', '!'), null);
  });

  runner.it('find() matches commands and aliases', () => {
    const reg = new CommandRegistry();
    reg.register('ping', () => {}, { aliases: ['p'], description: 'Pong' });
    assert(reg.find('!ping', '!'));
    assert(reg.find('!p', '!'));
    assert.strictEqual(reg.find('!pong', '!'), null);
    assert.strictEqual(reg.find('!ping', '!').command.description, 'Pong');
  });
});

// ---- typed args, subcommands, groups ----------------------------

runner.describe('advanced commands', () => {
  runner.it('parses typed arguments into ctx.options', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let seen = null;
    bot.sendMessage = async () => ({});
    bot.command('give', (ctx) => { seen = ctx; }, {
      args: [
        { name: 'user', type: 'user', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'reason', type: 'rest' }
      ]
    });
    bot._handleMessage({
      id: '1', channel_id: 'c',
      content: '!give <@123456789012345678> 42 thanks a lot',
      author: { id: 'u', bot: false }
    });
    await tick();
    assert(seen);
    assert.strictEqual(seen.options.user, '123456789012345678');
    assert.strictEqual(seen.options.amount, 42);
    assert.strictEqual(seen.options.reason, 'thanks a lot');
  });

  runner.it('coerces booleans and integers', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let seen = null;
    bot.sendMessage = async () => ({});
    bot.command('cfg', (ctx) => { seen = ctx; }, {
      args: [
        { name: 'flag', type: 'boolean', required: true },
        { name: 'count', type: 'integer', required: true }
      ]
    });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!cfg yes 7', author: { id: 'u', bot: false } });
    await tick();
    assert(seen);
    assert.strictEqual(seen.options.flag, true);
    assert.strictEqual(seen.options.count, 7);
  });

  runner.it('emits argumentError for bad typed input', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let err = null;
    bot.on('argumentError', (e) => { err = e; });
    let ran = false;
    bot.command('give', () => { ran = true; }, {
      args: [{ name: 'amount', type: 'number', required: true }]
    });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!give abc', author: { id: 'u', bot: false } });
    await tick();
    assert(err && /number/.test(err.message));
    assert.strictEqual(ran, false);
  });

  runner.it('reports missing required arguments', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let err = null;
    bot.on('argumentError', (e) => { err = e; });
    bot.command('kick', () => {}, { args: [{ name: 'user', type: 'user', required: true }] });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!kick', author: { id: 'u', bot: false } });
    await tick();
    assert(err && /missing required argument "user"/.test(err.message));
  });

  runner.it('matches subcommands with space-separated names', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let which = null;
    bot.sendMessage = async () => ({});
    bot.command('admin', () => { which = 'root'; });
    bot.command('admin ban', (ctx) => { which = 'ban:' + ctx.args.join(','); });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!admin ban alice', author: { id: 'u', bot: false } });
    await tick();
    assert.strictEqual(which, 'ban:alice');
  });

  runner.it('prefers the longest matching subcommand path', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let which = null;
    bot.sendMessage = async () => ({});
    bot.command('admin', (ctx) => { which = 'root:' + ctx.text; });
    bot.command('admin ban', (ctx) => { which = 'ban:' + ctx.text; });
    bot.command('admin ban hard', (ctx) => { which = 'hard:' + ctx.text; });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!admin ban hard bob', author: { id: 'u', bot: false } });
    await tick();
    assert.strictEqual(which, 'hard:bob');
  });

  runner.it('groups prefix command names', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let which = null;
    bot.sendMessage = async () => ({});
    const mod = bot.group('mod');
    mod.command('kick', (ctx) => { which = ctx.name + ':' + ctx.args[0]; });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!mod kick u1', author: { id: 'u', bot: false } });
    await tick();
    assert.strictEqual(which, 'mod kick:u1');
  });
});

// ---- middleware, cooldowns, permissions -------------------------

runner.describe('gates & middleware', () => {
  runner.it('runs middleware in order with next()', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    const log = [];
    bot.use(async (ctx, next) => { log.push('a'); await next(); log.push('c'); });
    bot.command('x', () => { log.push('b'); }, {
      middleware: [(ctx, next) => { log.push('m'); return next(); }]
    });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!x', author: { id: 'u', bot: false } });
    await tick();
    assert.deepStrictEqual(log, ['a', 'm', 'b', 'c']);
  });

  runner.it('middleware can short-circuit without running the handler', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let ran = false;
    bot.use((ctx, next) => { /* never calls next */ });
    bot.command('x', () => { ran = true; });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!x', author: { id: 'u', bot: false } });
    await tick();
    assert.strictEqual(ran, false);
  });

  runner.it('cooldown blocks repeat calls and emits an event', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let runs = 0;
    let blocked = null;
    bot.on('cooldown', (info) => { blocked = info; });
    bot.command('slow', () => { runs++; }, { cooldown: 60000 });
    const msg = { id: '1', channel_id: 'c', content: '!slow', author: { id: 'u', bot: false } };
    bot._handleMessage(msg);
    await tick();
    bot._handleMessage(msg);
    await tick();
    assert.strictEqual(runs, 1);
    assert(blocked && blocked.remaining > 0);
  });

  runner.it('permissions block and emit noPermission', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let ran = false;
    let blocked = null;
    bot.on('noPermission', (info) => { blocked = info; });
    bot.sendMessage = async () => ({});
    bot.command('mod', () => { ran = true; }, { permissions: ['KICK_MEMBERS'] });
    bot._handleMessage({
      id: '1', channel_id: 'c', guild_id: 'g', content: '!mod',
      author: { id: 'u', bot: false },
      member: { permissions: '1024' } // VIEW_CHANNEL only
    });
    await tick();
    assert.strictEqual(ran, false);
    assert(blocked && blocked.missing.indexOf('KICK_MEMBERS') !== -1);
  });

  runner.it('admins pass permission checks', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let ran = false;
    bot.sendMessage = async () => ({});
    bot.command('mod', () => { ran = true; }, { permissions: ['KICK_MEMBERS'] });
    bot._handleMessage({
      id: '1', channel_id: 'c', guild_id: 'g', content: '!mod',
      author: { id: 'u', bot: false },
      member: { permissions: '8' } // ADMINISTRATOR
    });
    await tick();
    assert.strictEqual(ran, true);
  });

  runner.it('guildOnly denies commands in DMs', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let ran = false;
    let denied = null;
    bot.on('commandDenied', (info) => { denied = info; });
    bot.command('guild', () => { ran = true; }, { guildOnly: true });
    bot._handleMessage({ id: '1', channel_id: 'c', content: '!guild', author: { id: 'u', bot: false } });
    await tick();
    assert.strictEqual(ran, false);
    assert(denied && denied.reason === 'guildOnly');
  });
});

// ---- bot dispatch -----------------------------------------------

runner.describe('bot', () => {
  runner.it('dispatches a command and replies with a mention', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let sent = null;
    bot.sendMessage = async (channelId, payload) => { sent = { channelId, payload }; return { id: 'm2' }; };

    bot.command('ping', (ctx) => ctx.reply('pong'));

    bot._handleMessage({
      id: 'm1',
      channel_id: 'c1',
      content: '!ping',
      author: { id: 'u1', bot: false }
    });
    await tick();

    assert(sent, 'expected a reply');
    assert.strictEqual(sent.channelId, 'c1');
    assert(sent.payload.content.includes('<@u1>'));
    assert(sent.payload.content.includes('pong'));
  });

  runner.it('passes args through to the handler', async () => {
    const bot = createBot({ token: 'test', prefix: '.' });
    let seen = null;
    bot.sendMessage = async () => ({});
    bot.command('echo', (ctx) => { seen = ctx; ctx.reply(ctx.text); });

    bot._handleMessage({ id: 'x', channel_id: 'c', content: '.echo hello world', author: { id: 'u', bot: false } });
    await tick();

    assert.strictEqual(seen.name, 'echo');
    assert.deepStrictEqual(seen.args, ['hello', 'world']);
    assert.strictEqual(seen.text, 'hello world');
  });

  runner.it('ignores bot messages and unknown commands', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let ran = false;
    bot.command('ping', () => { ran = true; });

    bot._handleMessage({ id: '1', channel_id: 'c', content: '!ping', author: { id: 'bot1', bot: true } });
    bot._handleMessage({ id: '2', channel_id: 'c', content: '!nope', author: { id: 'u', bot: false } });
    await tick();

    assert.strictEqual(ran, false);
  });

  runner.it('emits commandError when a handler throws', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let error = null;
    bot.on('commandError', (err) => { error = err; });
    bot.command('boom', () => { throw new Error('kaboom'); });

    bot._handleMessage({ id: '1', channel_id: 'c', content: '!boom', author: { id: 'u', bot: false } });
    await tick();

    assert(error && error.message === 'kaboom');
  });

  runner.it('dispatches gateway dispatch events and feeds the cache', () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let got = null;
    bot.on('MESSAGE_CREATE', (m) => { got = m; });
    bot._handleGatewayEvent({ op: 0, t: 'MESSAGE_CREATE', d: { id: '1', channel_id: 'c1', content: 'hi' } });
    assert.strictEqual(got.id, '1');
    assert(bot.cache.getMessage('c1', '1'));
  });
});

// ---- interactions ------------------------------------------------

runner.describe('interactions', () => {
  runner.it('extracts slash command options including subcommand paths', () => {
    const data = {
      name: 'admin',
      options: [
        { name: 'ban', type: 1, options: [
          { name: 'user', type: 6, value: '123456789012345678' },
          { name: 'reason', type: 3, value: 'spam' }
        ] }
      ]
    };
    const opts = fw.extractOptions(data);
    assert.strictEqual(opts.map.user, '123456789012345678');
    assert.strictEqual(opts.map.reason, 'spam');
    assert.strictEqual(opts.raw.length, 2);
    assert.strictEqual(fw.interactionPath(data), 'admin ban');
  });

  runner.it('dispatches an APPLICATION_COMMAND interaction with a reply', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let called = null;
    const posts = [];
    bot.rest.post = async (path, body) => { posts.push({ path, body }); return { statusCode: 200, data: {} }; };
    bot.slash('ping', (ctx) => { called = ctx; ctx.reply('pong'); }, { description: 'Ping' });

    bot.interactions.handle({
      type: 2, id: 'i1', token: 'tok', application_id: 'app', channel_id: 'c',
      data: { name: 'ping', options: [] }
    }, bot);
    await tick();

    assert(called);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].path, '/interactions/i1/tok/callback');
    assert.strictEqual(posts[0].body.type, 4);
    assert.strictEqual(posts[0].body.data.content, 'pong');
  });

  runner.it('routes component interactions by custom id', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let which = null;
    bot.rest.post = async () => ({ statusCode: 200, data: {} });
    bot.button('like', (ctx) => { which = ctx.customId; ctx.update({ content: 'Liked!' }); });

    bot.interactions.handle({
      type: 3, id: 'i2', token: 'tok2', application_id: 'app',
      data: { custom_id: 'like', component_type: 2 }
    }, bot);
    await tick();

    assert.strictEqual(which, 'like');
  });

  runner.it('routes modal submissions by custom id', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let which = null;
    bot.rest.post = async () => ({ statusCode: 200, data: {} });
    bot.modal('feedback', (ctx) => { which = ctx.customId; ctx.reply('Thanks!'); });

    bot.interactions.handle({
      type: 5, id: 'i3', token: 'tok3', application_id: 'app',
      data: { custom_id: 'feedback', components: [] }
    }, bot);
    await tick();

    assert.strictEqual(which, 'feedback');
  });

  runner.it('deferred interactions route replies through the webhook', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    const posts = [];
    bot.rest.post = async (path, body) => { posts.push({ path, body }); return { statusCode: 200, data: {} }; };
    bot.slash('slow', async (ctx) => {
      await ctx.defer(true);
      ctx.reply('done');
    });

    bot.interactions.handle({
      type: 2, id: 'i4', token: 'tok4', application_id: 'app', channel_id: 'c',
      data: { name: 'slow', options: [] }
    }, bot);
    await tick();

    assert.strictEqual(posts.length, 2);
    assert.strictEqual(posts[0].body.type, 5); // deferred
    assert.strictEqual(posts[0].body.data.flags, 64); // ephemeral
    assert.strictEqual(posts[1].path, '/webhooks/app/tok4'); // followup
    assert.strictEqual(posts[1].body.content, 'done');
  });

  runner.it('builds slash command API bodies including subcommands', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.slash('admin', () => {}, {
      description: 'Admin commands',
      subcommands: {
        ban: {
          description: 'Ban a user',
          options: [{ name: 'user', type: 'user', required: true, description: 'Who' }]
        },
        kick: { description: 'Kick a user' }
      }
    });
    const puts = [];
    await bot.interactions.registerAll(
      { put: async (p, b) => { puts.push({ p, b }); return { statusCode: 200 }; } },
      'app1'
    );
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(puts[0].p, '/applications/app1/commands');
    assert.strictEqual(puts[0].b.length, 1); // subcommands aren't separate commands
    assert.strictEqual(puts[0].b[0].name, 'admin');
    assert.strictEqual(puts[0].b[0].options.length, 2);
    assert.strictEqual(puts[0].b[0].options[0].type, 1); // SUB_COMMAND
    assert.strictEqual(puts[0].b[0].options[0].name, 'ban');
    assert.strictEqual(puts[0].b[0].options[0].options[0].type, 6); // USER
  });

  runner.it('sends a modal payload with builder components', () => {
    const modal = new fw.Modal()
      .setCustomId('feedback')
      .setTitle('Feedback')
      .addComponent(new fw.ActionRow().addComponent(
        new fw.TextInput().setCustomId('body').setLabel('Message').setStyle(2).setRequired(true)
      ));
    const json = modal.toJSON();
    assert.strictEqual(json.custom_id, 'feedback');
    assert.strictEqual(json.title, 'Feedback');
    assert.strictEqual(json.components[0].type, 1);
    assert.strictEqual(json.components[0].components[0].type, 4);
    assert.strictEqual(json.components[0].components[0].custom_id, 'body');
    assert.strictEqual(json.components[0].components[0].required, true);
  });

  runner.it('button and select builders validate their payloads', () => {
    const button = new fw.Button().setStyle(5).setURL('https://example.com').setLabel('Visit');
    assert.strictEqual(button.toJSON().style, 5);
    assert.throws(() => new fw.Button().toJSON(), /custom_id/);

    const select = new fw.SelectMenu()
      .setCustomId('pick')
      .addOption({ label: 'A', value: 'a' })
      .addOption({ label: 'B', value: 'b' });
    assert.strictEqual(select.toJSON().options.length, 2);
  });
});

// ---- cache ------------------------------------------------------

runner.describe('cache', () => {
  runner.it('stores and evicts messages per channel', () => {
    const cache = new fw.Cache({ messageLimitPerChannel: 2 });
    cache.handle('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1', content: 'a' });
    cache.handle('MESSAGE_CREATE', { id: 'm2', channel_id: 'c1', content: 'b' });
    cache.handle('MESSAGE_CREATE', { id: 'm3', channel_id: 'c1', content: 'c' });
    assert.strictEqual(cache.getMessage('c1', 'm1'), null);
    assert(cache.getMessage('c1', 'm2'));
    assert(cache.getMessage('c1', 'm3'));
  });

  runner.it('removes messages on MESSAGE_DELETE', () => {
    const cache = new fw.Cache();
    cache.handle('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1' });
    cache.handle('MESSAGE_DELETE', { id: 'm1', channel_id: 'c1' });
    assert.strictEqual(cache.getMessage('c1', 'm1'), null);
  });

  runner.it('seeds channels and roles from GUILD_CREATE and cleans up on delete', () => {
    const cache = new fw.Cache();
    cache.handle('GUILD_CREATE', {
      id: 'g1',
      name: 'Test',
      channels: [{ id: 'c1', guild_id: 'g1' }],
      roles: [{ id: 'r1', guild_id: 'g1' }],
      members: [{ guild_id: 'g1', user: { id: 'u1' } }]
    });
    assert.strictEqual(cache.getGuild('g1').name, 'Test');
    assert(cache.getChannel('c1'));
    assert(cache.getRole('g1', 'r1'));
    assert(cache.getMember('g1', 'u1'));
    cache.handle('GUILD_DELETE', { id: 'g1' });
    assert.strictEqual(cache.getGuild('g1'), null);
    assert.strictEqual(cache.getChannel('c1'), null);
    assert.strictEqual(cache.getRole('g1', 'r1'), null);
    assert.strictEqual(cache.getMember('g1', 'u1'), null);
  });

  runner.it('respects disabled collections', () => {
    const cache = new fw.Cache({ users: false });
    cache.handle('USER_UPDATE', { id: 'u1', username: 'x' });
    assert.strictEqual(cache.getUser('u1'), null);
    cache.handle('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1' });
    assert(cache.getMessage('c1', 'm1'));
  });
});

// ---- REST helpers ------------------------------------------------

runner.describe('rest helpers', () => {
  runner.it('routeKey normalizes snowflakes', () => {
    const { routeKey } = require('../lib/rest');
    const a = routeKey('GET', '/channels/123456789012345678/messages');
    const b = routeKey('GET', '/channels/999999999999999999/messages');
    assert.strictEqual(a, b);
    assert(a.indexOf('{id}') !== -1);
  });

  runner.it('parseHeaders reads a rate-limit header block', () => {
    const { parseHeaders } = require('../lib/rest');
    const headers = parseHeaders(
      'HTTP/1.1 200 OK\r\n' +
      'X-RateLimit-Limit: 5\r\n' +
      'X-RateLimit-Remaining: 0\r\n' +
      'X-RateLimit-Reset-After: 2.5\r\n' +
      'X-RateLimit-Bucket: abc\r\n' +
      'Content-Type: application/json\r\n'
    );
    assert.strictEqual(headers['x-ratelimit-limit'], '5');
    assert.strictEqual(headers['x-ratelimit-remaining'], '0');
    assert.strictEqual(headers['x-ratelimit-reset-after'], '2.5');
    assert.strictEqual(headers['x-ratelimit-bucket'], 'abc');
  });

  runner.it('sleepSync blocks for the requested time', () => {
    const { sleepSync } = require('../lib/rest');
    const start = Date.now();
    sleepSync(20);
    assert(Date.now() - start >= 10);
  });

  runner.it('sendFile throws without a file payload', () => {
    const { RestClient } = fw;
    const rest = new RestClient({ token: 'test' });
    assert.throws(() => rest.sendFile('c1', { content: 'hi' }), /file/);
  });
});

// ---- gateway session & presence ---------------------------------

runner.describe('gateway session', () => {
  // Feed a parsed JSON payload straight into the frame handler and
  // capture outbound frames via a stubbed _write.
  function makeGateway(capture, options) {
    const gw = new fw.Gateway(Object.assign({ token: 'tok', intents: ['GUILDS'] }, options || {}));
    gw._write = (buf) => {
      const frames = new FrameParser().push(buf);
      for (const f of frames) capture.push(JSON.parse(String(f.payload)));
    };
    return gw;
  }

  function payload(obj) {
    return { opcode: 1, payload: Buffer.from(JSON.stringify(obj)) };
  }

  runner.it('identifies on Hello and stores the session on READY', () => {
    const sent = [];
    const gw = makeGateway(sent);
    let readyData = null;
    gw.on('ready', (d) => { readyData = d; });

    gw._onFrame(payload({ op: 10, d: { heartbeat_interval: 41250 } }));
    assert.strictEqual(sent[0].op, 2); // identify
    assert.strictEqual(sent[0].d.intents, 1);

    gw._onFrame(payload({ op: 0, t: 'READY', s: 3, d: { session_id: 'sess1', user: { id: 'u1' } } }));
    assert.strictEqual(gw.session_id, 'sess1');
    assert(readyData && readyData.session_id === 'sess1');
    assert.strictEqual(gw._sequence, 3);
    gw.close();
  });

  runner.it('resumes with op 6 on a reconnect', () => {
    const sent = [];
    const gw = makeGateway(sent);
    gw._onFrame(payload({ op: 10, d: { heartbeat_interval: 41250 } }));
    gw._onFrame(payload({ op: 0, t: 'READY', s: 5, d: { session_id: 'sess2', user: { id: 'u1' } } }));
    gw._resumeRequested = true;
    gw._onFrame(payload({ op: 10, d: { heartbeat_interval: 41250 } }));
    const resume = sent[sent.length - 1];
    assert.strictEqual(resume.op, 6);
    assert.strictEqual(resume.d.session_id, 'sess2');
    assert.strictEqual(resume.d.seq, 5);
    gw.close();
  });

  runner.it('drops the session and re-identifies on op 9 with false', () => {
    const sent = [];
    const gw = makeGateway(sent);
    gw._onFrame(payload({ op: 10, d: { heartbeat_interval: 41250 } }));
    gw._onFrame(payload({ op: 0, t: 'READY', s: 9, d: { session_id: 'sess3', user: { id: 'u1' } } }));
    gw._resumeRequested = true;
    gw._onFrame(payload({ op: 9, d: false }));
    assert.strictEqual(gw.session_id, null);
    assert.strictEqual(gw._sequence, null);
    gw.close();
  });

  runner.it('sends presence updates as op 3', () => {
    const sent = [];
    const gw = makeGateway(sent);
    gw._connected = true;
    gw.setPresence({ status: 'dnd', activities: [{ name: 'Coding', type: 0 }] });
    assert.strictEqual(sent[0].op, 3);
    assert.strictEqual(sent[0].d.status, 'dnd');
    assert.strictEqual(sent[0].d.activities[0].name, 'Coding');
    gw.close();
  });

  runner.it('answers heartbeat requests with the current sequence', () => {
    const sent = [];
    const gw = makeGateway(sent);
    gw._connected = true;
    gw._sequence = 42;
    gw._onFrame(payload({ op: 1 }));
    assert.strictEqual(sent[0].op, 1);
    assert.strictEqual(sent[0].d, 42);
    gw.close();
  });
});

// ---- websocket framing ------------------------------------------

runner.describe('gateway framing', () => {
  runner.it('encodes and decodes a masked text frame round-trip', () => {
    const frame = encodeFrame('hello');
    const parsed = new FrameParser();
    const frames = parsed.push(frame);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].opcode, 0x1);
    assert.strictEqual(String(frames[0].payload), 'hello');
  });

  runner.it('handles 126-byte and 64-bit length frames', () => {
    const big = new Array(200).join('x'); // 199 chars
    const frame = encodeFrame(big);
    const parsed = new FrameParser();
    const frames = parsed.push(frame);
    assert.strictEqual(String(frames[0].payload), big);
  });

  runner.it('parses frames split across multiple chunks', () => {
    const frame = encodeFrame('split me');
    const half = Math.floor(frame.length / 2);
    const parsed = new FrameParser();
    assert.deepStrictEqual(parsed.push(frame.slice(0, half)), []);
    const frames = parsed.push(frame.slice(half));
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(String(frames[0].payload), 'split me');
  });

  runner.it('parses two frames from one buffer', () => {
    const buf = Buffer.concat([encodeFrame('one'), encodeFrame('two')]);
    const parsed = new FrameParser();
    const frames = parsed.push(buf);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(String(frames[0].payload), 'one');
    assert.strictEqual(String(frames[1].payload), 'two');
  });

  runner.it('intentBits maps names to gateway intent bits', () => {
    const bits = intentBits(['GUILDS', 'GUILD_MESSAGES']);
    assert.strictEqual(bits, (1 << 0) | (1 << 9));
    assert.strictEqual(intentBits(['NOPE']), 0);
  });
});

// ---- v0.3: full API surface -------------------------------------

runner.describe('v0.3 util & collection', () => {
  runner.it('permissionsToBitfield combines names into a decimal bitfield', () => {
    const bits = fw.permissionsToBitfield(['SEND_MESSAGES', 'KICK_MEMBERS']);
    assert.strictEqual(bits, String((1 << 11) | (1 << 1)));
    assert.strictEqual(fw.hasPermission(bits, 'KICK_MEMBERS'), true);
    assert.strictEqual(fw.hasPermission(bits, 'MANAGE_MESSAGES'), false);
  });

  runner.it('permissionsToBitfield handles high bits without BigInt', () => {
    const bits = fw.permissionsToBitfield(['MODERATE_MEMBERS']); // bit 40
    assert.strictEqual(bits, '1099511627776');
    assert.strictEqual(fw.hasPermission(bits, 'MODERATE_MEMBERS'), true);
  });

  runner.it('permissionsToBitfield accepts numbers, strings, and comma lists', () => {
    assert.strictEqual(fw.permissionsToBitfield(8), '8');
    assert.strictEqual(fw.permissionsToBitfield('8192'), '8192');
    assert.strictEqual(fw.hasPermission(
      fw.permissionsToBitfield('KICK_MEMBERS, BAN_MEMBERS'), 'BAN_MEMBERS'), true);
    assert.throws(() => fw.permissionsToBitfield(['NOT_A_PERM']), /Unknown permission/);
  });

  runner.it('buildQuery encodes params and skips empties', () => {
    assert.strictEqual(fw.buildQuery({ limit: 50, before: '123', after: undefined }),
      '?limit=50&before=123');
    assert.strictEqual(fw.buildQuery({}), '');
    assert.strictEqual(fw.buildQuery(null), '');
  });

  runner.it('encodeEmoji handles unicode and custom forms', () => {
    assert.strictEqual(fw.encodeEmoji('<:smile:123456789012345678>'),
      'smile:123456789012345678');
    assert.strictEqual(fw.encodeEmoji('<a:dance:999999999999999999>'),
      'dance:999999999999999999');
    assert.ok(fw.encodeEmoji('\uD83D\uDC4D').indexOf('%') !== -1);
  });

  runner.it('Collection provides find/filter/map/sort/random/sweep', () => {
    const c = new fw.Collection([['a', 3], ['b', 1], ['c', 2]]);
    assert.strictEqual(c.find((v) => v === 2), 2);
    assert.strictEqual(c.filter((v) => v > 1).size, 2);
    assert.deepStrictEqual(c.map((v) => v * 10), [30, 10, 20]);
    c.sortInPlace((x, y) => x - y);
    assert.deepStrictEqual(c.toArray(), [1, 2, 3]);
    assert.strictEqual(c.first, 1);
    assert.strictEqual(c.last, 3);
    assert.ok(typeof c.random() === 'number'); // single random pick
    assert.strictEqual(c.sweep((v) => v >= 2), 2);
    assert.strictEqual(c.size, 1);
  });
});

runner.describe('v0.3 API payloads', () => {
  runner.it('bulkDeleteBody validates and dedupes ids', () => {
    const { bulkDeleteBody } = require('../lib/api');
    assert.deepStrictEqual(bulkDeleteBody(['m2', 'm1', 'm2']).messages, ['m2', 'm1']);
    assert.throws(() => bulkDeleteBody(['only-one']), /between 2 and 100/);
    assert.throws(() => bulkDeleteBody(new Array(101).fill('x')), /between 2 and 100/);
  });

  runner.it('buildOverwrites converts permission names to bitfields', () => {
    const { buildOverwrites } = require('../lib/api');
    const out = buildOverwrites([{
      id: '555', type: 'member',
      allow: ['VIEW_CHANNEL'],
      deny: ['SEND_MESSAGES', 'ADD_REACTIONS']
    }]);
    assert.strictEqual(out[0].type, 1);
    assert.strictEqual(out[0].allow, String(1 << 10));
    assert.strictEqual(out[0].deny, String((1 << 11) | (1 << 6)));
  });

  runner.it('REST endpoints land on the right URLs', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    const calls = [];
    const METHOD_NAMES = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
    for (const m of ['get', 'post', 'put', 'patch', 'del']) {
      bot.rest[m] = async (path, body) => {
        calls.push(METHOD_NAMES[m] + ' ' + path);
        return { statusCode: 200, data: {} };
      };
    }

    await bot.kick('g1', 'u1');
    await bot.unban('g1', 'u2');
    await bot.setNickname('g1', 'u3', 'Nick');
    await bot.timeout('g1', 'u4', 60000);
    await bot.addRole('g1', 'u5', 'r1');
    await bot.triggerTyping('c1');
    await bot.bulkDelete('c1', ['m1', 'm2']);
    await bot.createInvite('c1', { maxAgeSeconds: 3600, maxUses: 10 });
    await bot.clearReactions('c1', 'm9');

    assert(calls.indexOf('DELETE /guilds/g1/members/u1') !== -1);
    assert(calls.indexOf('DELETE /guilds/g1/bans/u2') !== -1);
    assert(calls.indexOf('PATCH /guilds/g1/members/u3') !== -1);
    let timeoutCall = null;
    for (const c of calls) if (c.indexOf('/members/u4') !== -1 && c.indexOf('PATCH') === 0) timeoutCall = c;
    assert(timeoutCall, 'expected a PATCH timeout call');
    assert(calls.indexOf('PUT /guilds/g1/members/u5/roles/r1') !== -1);
    assert(calls.indexOf('POST /channels/c1/typing') !== -1);
    assert(calls.indexOf('POST /channels/c1/messages/bulk-delete') !== -1);
    assert(calls.indexOf('POST /channels/c1/invites') !== -1);
    assert(calls.indexOf('DELETE /channels/c1/messages/m9/reactions') !== -1);
  });

  runner.it('_expect turns HTTP errors into thrown Errors with codes', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.rest.del = async () => ({ statusCode: 403, data: { message: 'Missing Permissions' } });
    let err = null;
    try { await bot.kick('g1', 'u1'); } catch (e) { err = e; }
    assert(err && err.message.indexOf('kick failed (HTTP 403)') === 0);
    assert.strictEqual(err.statusCode, 403);
  });
});

runner.describe('v0.3 messaging conveniences', () => {
  runner.it('react encodes emoji into the PUT endpoint', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let path = null;
    bot.rest.put = async (p) => { path = p; return { statusCode: 204, data: null }; };
    await bot.react('c1', 'm1', '\uD83D\uDC4D');
    assert(path.indexOf('/reactions/') !== -1 && path.endsWith('/@me'));
    await bot.react('c1', 'm1', '<:smile:123456789012345678>');
    assert(path.indexOf('/reactions/smile:123456789012345678/@me') !== -1);
  });

  runner.it('sendDM opens a DM channel then posts to it', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    const calls = [];
    bot.rest.post = async (path, body) => {
      calls.push({ path, body });
      return path === '/users/@me/channels'
        ? { statusCode: 200, data: { id: 'dm1' } }
        : { statusCode: 200, data: {} };
    };
    await bot.sendDM('u1', 'hello there');
    assert.strictEqual(calls[0].path, '/users/@me/channels');
    assert.strictEqual(calls[1].path, '/channels/dm1/messages');
    assert.strictEqual(calls[1].body.content, 'hello there');
  });

  runner.it('defaultAllowedMentions merge into outgoing messages', async () => {
    const bot = createBot({
      token: 'test', prefix: '!',
      defaultAllowedMentions: { parse: ['users'] }
    });
    let sent = null;
    bot.rest.post = async (path, body) => { sent = body; return { statusCode: 200, data: {} }; };

    await bot.sendMessage('c1', 'hi');
    assert.deepStrictEqual(sent.allowed_mentions, { parse: ['users'] });

    await bot.sendMessage('c1', { content: 'hi', allowed_mentions: { parse: [] } });
    assert.deepStrictEqual(sent.allowed_mentions, { parse: [] }); // caller wins
  });

  runner.it('fetchMessages pages and warms the cache', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.rest.get = async () => ({
      statusCode: 200,
      data: [{ id: 'm1', content: 'one' }, { id: 'm2', content: 'two' }]
    });
    const page = await bot.fetchMessages('c1');
    assert.strictEqual(page.size, 2);
    assert.strictEqual(bot.cache.getMessage('c1', 'm1').content, 'one');
  });
});

runner.describe('v0.3 derived events', () => {
  runner.it('messageUpdate carries old and new states', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.cache.handle('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1', content: 'before' });
    let update = null;
    bot.on('messageUpdate', (u) => { update = u; });
    bot._handleGatewayEvent({ op: 0, t: 'MESSAGE_UPDATE', d: { id: 'm1', channel_id: 'c1', content: 'after' } });
    await tick();
    assert(update && update.old && update.old.content === 'before');
    assert(update.new.content === 'after');
  });

  runner.it('messageDelete exposes the deleted content, bulk included', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.cache.handle('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1', content: 'gone soon' });
    let del = null;
    bot.on('messageDelete', (d) => { del = d; });
    bot._handleGatewayEvent({ op: 0, t: 'MESSAGE_DELETE', d: { id: 'm1', channel_id: 'c1' } });
    await tick();
    assert(del && del.old && del.old.content === 'gone soon');

    let bulkDel = null;
    bot.on('messageDelete', (d) => { bulkDel = d; });
    bot._handleGatewayEvent({ op: 0, t: 'MESSAGE_DELETE_BULK', d: { ids: ['a', 'b'], channel_id: 'c1' } });
    await tick();
    assert(bulkDel && bulkDel.bulk === true);
  });

  runner.it('reactionAdd resolves the reacting user', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    let reaction = null;
    bot.on('reactionAdd', (r) => { reaction = r; });
    bot._handleGatewayEvent({
      op: 0, t: 'MESSAGE_REACTION_ADD',
      d: {
        user_id: 'u1', message_id: 'm1', channel_id: 'c1', burst: false,
        member: { user: { id: 'u1', username: 'ada' } },
        emoji: { id: null, name: '\uD83D\uDC4D' }
      }
    });
    await tick();
    assert(reaction && reaction.userId === 'u1');
    assert(reaction.user.username === 'ada');
    assert(reaction.emoji.name === '\uD83D\uDC4D');
  });

  runner.it('guildMemberAdd delivers cached members with guild attached', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.cache.handle('GUILD_CREATE', { id: 'g1', name: 'Test Guild' });
    bot.cache.handle('GUILD_MEMBER_ADD', { guild_id: 'g1', user: { id: 'u5' } });
    let added = null;
    bot.on('guildMemberAdd', (m) => { added = m; });
    bot._handleGatewayEvent({ op: 0, t: 'GUILD_MEMBER_ADD', d: { guild_id: 'g1', user: { id: 'u5' } } });
    await tick();
    assert(added && added.user.id === 'u5');
    assert(added.guild && added.guild.name === 'Test Guild');
  });

  runner.it('voiceStateUpdate reports joins, moves, and leaves', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    const updates = [];
    bot.on('voiceStateUpdate', (u) => updates.push(u));
    bot._handleGatewayEvent({
      op: 0, t: 'VOICE_STATE_UPDATE',
      d: { user_id: 'u1', session_id: 's1', channel_id: 'vc1', guild_id: 'g1' }
    });
    await tick();
    assert(updates[0] && updates[0].joined === true);

    bot._handleGatewayEvent({
      op: 0, t: 'VOICE_STATE_UPDATE',
      d: { user_id: 'u1', session_id: 's1', channel_id: 'vc2', guild_id: 'g1' }
    });
    await tick();
    assert(updates[1] && updates[1].movedChannel === true && updates[1].old.channel_id === 'vc1');

    bot._handleGatewayEvent({
      op: 0, t: 'VOICE_STATE_UPDATE',
      d: { user_id: 'u1', session_id: 's1', channel_id: null, guild_id: 'g1' }
    });
    await tick();
    assert(updates[2] && updates[2].left === true);
  });
});

runner.describe('v0.3 voice & chunks', () => {
  runner.it('discovery packets round-trip through the parser', () => {
    const { encodeDiscoveryPacket, parseDiscoveryPacket } = require('../lib/voice');
    const packet = encodeDiscoveryPacket(1234567890);
    assert.strictEqual(packet.length, 74);
    assert.strictEqual(packet.readUInt32LE(4), 1234567890);

    const reply = Buffer.alloc(74);
    reply.writeUInt16LE(0x2, 0); // response type
    reply.writeUInt16LE(70, 2);
    reply.writeUInt32LE(1234567890, 4);
    reply.write('192.168.1.25', 8, 'ascii');
    reply.writeUInt16LE(50000, 72);
    const parsed = parseDiscoveryPacket(reply);
    assert.strictEqual(parsed.ip, '192.168.1.25');
    assert.strictEqual(parsed.port, 50000);
  });

  runner.it('VoiceManager issues an op-4 join over the client gateway', async () => {
    const bot = createBot({ token: 'test', prefix: '!' });
    bot.user = { id: 'bot1' };
    let sentState = null;
    bot.gateway = { sendVoiceState(s) { sentState = s; } };
    bot.voice.join('g1', 'vc1', { selfDeaf: true });
    assert(sentState && sentState.guild_id === 'g1' && sentState.channel_id === 'vc1');
    assert.strictEqual(sentState.self_deaf, true);
  });

  runner.it('requestGuildMembers sends op 8 with sane defaults', () => {
    const sent = [];
    const gw = new fw.Gateway({ token: 'tok', intents: ['GUILD_MEMBERS'] });
    gw._connected = true;
    gw._write = (buf) => {
      for (const f of new FrameParser().push(buf)) sent.push(JSON.parse(String(f.payload)));
    };
    gw.requestGuildMembers({ guild_id: 'g1' });
    assert.strictEqual(sent[0].op, 8);
    assert.strictEqual(sent[0].d.guild_id, 'g1');
    assert.strictEqual(sent[0].d.query, '');
    gw.requestGuildMembers({ guild_id: 'g1', user_ids: [42, '99'] });
    assert.deepStrictEqual(sent[1].d.user_ids, ['42', '99']);
    assert.strictEqual(sent[1].d.query, undefined);
    assert.throws(() => gw.requestGuildMembers({}), /guild_id/);
    gw.close();
  });

  runner.it('cache ingests GUILD_MEMBERS_CHUNK and thread events', () => {
    const cache = new fw.Cache();
    cache.handle('GUILD_MEMBERS_CHUNK', {
      guild_id: 'g1',
      members: [{ user: { id: 'u9' } }, { user: { id: 'u10' } }]
    });
    assert(cache.getMember('g1', 'u9'));
    assert(cache.getMember('g1', 'u10'));

    cache.handle('THREAD_CREATE', { id: 't1', guild_id: 'g1', name: 'Thread' });
    assert(cache.getChannel('t1'));
    cache.handle('THREAD_DELETE', { id: 't1' });
    assert.strictEqual(cache.getChannel('t1'), null);
  });
});

// Run
runner.run().then((results) => {
  process.exit(results.failed > 0 ? 1 : 0);
});
