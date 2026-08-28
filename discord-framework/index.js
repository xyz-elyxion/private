// Elyxion Discord Framework
// ---------------------------------------------------------------
// A zero-dependency Discord bot framework for the Elyxion runtime.
//
//   const { createBot, Embed } = require('elyxion-discord');
//
//   const bot = createBot({ prefix: '!', token: process.env.DISCORD_TOKEN });
//   bot.command('ping', (ctx) => ctx.reply('pong'));
//   bot.slash('ping', (ctx) => ctx.reply('pong'), { description: 'Ping' });
//   bot.on('ready', (user) => console.log('Logged in as ' + user.username));
//   bot.login().then(() => bot.connect());
//
// The runtime has no outbound TLS client, so REST traffic goes
// through `curl` (the same approach the Elyxion package manager
// uses), and the gateway speaks the Discord WebSocket protocol
// directly over the runtime's tls/net modules.
'use strict';

const { Bot, createBot } = require('./lib/client');
const { CommandRegistry, CommandGroup, parseCommand, parseArgs, ARG_TYPES } = require('./lib/commands');
const { RestClient, DEFAULT_BASE_URL, routeKey, parseHeaders, sleepSync } = require('./lib/rest');
const { Gateway, FrameParser, encodeFrame } = require('./lib/gateway');
const { Embed } = require('./lib/embed');
const { Cache } = require('./lib/cache');
const { Collection } = require('./lib/collection');
const { RestApi, bulkDeleteBody, buildOverwrites, toBitfieldString } = require('./lib/api');
const { EventEnricher } = require('./lib/events');
const { VoiceManager, VoiceConnection, encodeDiscoveryPacket, parseDiscoveryPacket } = require('./lib/voice');
const {
  InteractionRegistry,
  InteractionContext,
  ActionRow,
  Button,
  SelectMenu,
  TextInput,
  Modal,
  InteractionTypes,
  OptionTypes,
  extractOptions,
  interactionPath,
  normalizeMessage
} = require('./lib/interactions');
const {
  resolveColor, parseMention, snowflakeToDate, isSnowflake,
  truncate, loadEnv, buildQuery, encodeEmoji,
  PERMISSIONS, hasPermission, hasBit, decimalToWords, permissionsToBitfield
} = require('./lib/util');

const VERSION = '0.3.0';

module.exports = {
  version: VERSION,

  // Client
  Bot,
  createBot,

  // Commands
  CommandRegistry,
  CommandGroup,
  parseCommand,
  parseArgs,
  ARG_TYPES,

  // REST
  RestClient,
  DEFAULT_BASE_URL,
  routeKey,
  parseHeaders,
  sleepSync,

  // Gateway (WebSocket)
  Gateway,
  FrameParser,
  encodeFrame,

  // Embeds
  Embed,

  // Cache & collections
  Cache,
  Collection,

  // Full REST API surface
  RestApi,
  bulkDeleteBody,
  buildOverwrites,
  toBitfieldString,

  // Derived events
  EventEnricher,

  // Voice
  VoiceManager,
  VoiceConnection,
  encodeDiscoveryPacket,
  parseDiscoveryPacket,

  // Interactions
  InteractionRegistry,
  InteractionContext,
  ActionRow,
  Button,
  SelectMenu,
  TextInput,
  Modal,
  InteractionTypes,
  OptionTypes,
  extractOptions,
  interactionPath,
  normalizeMessage,

  // Permissions & utilities
  PERMISSIONS,
  hasPermission,
  hasBit,
  decimalToWords,
  permissionsToBitfield,
  resolveColor,
  parseMention,
  snowflakeToDate,
  isSnowflake,
  truncate,
  loadEnv,
  buildQuery,
  encodeEmoji
};
