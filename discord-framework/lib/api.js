// Elyxion Discord Framework — full REST API surface
// ---------------------------------------------------------------
// A complete map of the Discord REST API v10 on top of RestClient.
// Every method returns the raw result object
//   { statusCode, data, body, headers }
// and never throws for HTTP error codes — check `statusCode`.
//
//   const api = new RestApi(rest);
//   await api.createReaction(channelId, messageId, '👍');
//   await api.banMember(guildId, userId, { delete_message_seconds: 3600 });
//   await api.editMember(guildId, userId, { communication_disabled_until: untilIso });
'use strict';

const { buildQuery, encodeEmoji, permissionsToBitfield } = require('./util');
const { Collection } = require('./collection');

// ---- Payload helpers (pure — used by tests) ----------------------

// Validate a bulk-delete id list: 2-100 unique ids. Returns
// { messages } payload or throws a descriptive error.
function bulkDeleteBody(ids) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 100) {
    throw new Error('bulkDeleteMessages needs between 2 and 100 message ids (got ' +
      (Array.isArray(ids) ? ids.length : typeof ids) + ')');
  }
  const unique = Array.from(new Set(ids.map(String)));
  return { messages: unique };
}

// Normalize permission overwrites into API payloads; allow/deny may
// be permission names, comma lists, numbers, or bitfield strings —
// anything permissionsToBitfield understands.
function buildOverwrites(overwrites) {
  return (overwrites || []).map((o) => ({
    id: String(o.id),
    type: o.type === 1 || o.type === 'member' ? 1 : 0,
    allow: toBitfieldString(o.allow),
    deny: toBitfieldString(o.deny)
  }));
}

// Anything goes in; a clean base-10 string comes out. Undefined
// inputs pass through so callers can omit the key.
function toBitfieldString(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return permissionsToBitfield(value);
}

// ---- The API surface ---------------------------------------------

class RestApi {
  constructor(rest) {
    this.rest = rest;
  }

  _get(path) { return this.rest.get(path); }
  _post(path, body) { return this.rest.post(path, body); }
  _put(path, body) { return this.rest.put(path, body); }
  _patch(path, body) { return this.rest.patch(path, body); }
  _del(path) { return this.rest.del(path); }

  // ---- Users & applications -------------------------------------

  getCurrentUser() { return this._get('/users/@me'); }

  getUser(userId) { return this._get('/users/' + userId); }

  editCurrentUser(patch) { return this._patch('/users/@me', patch); }

  createDM(userId) { return this._post('/users/@me/channels', { recipient_id: String(userId) }); }

  leaveGuild(guildId) { return this._del('/users/@me/guilds/' + guildId); }

  getApplicationInfo() { return this._get('/oauth2/applications/@me'); }

  listGlobalCommands(applicationId) { return this._get('/applications/' + applicationId + '/commands'); }

  registerGlobalCommands(applicationId, commands) {
    return this._put('/applications/' + applicationId + '/commands', commands);
  }

  deleteAllGlobalCommands(applicationId) {
    return this._put('/applications/' + applicationId + '/commands', []);
  }

  deleteGlobalCommand(applicationId, commandId) {
    return this._del('/applications/' + applicationId + '/commands/' + commandId);
  }

  listGuildCommands(applicationId, guildId) {
    return this._get('/applications/' + applicationId + '/guilds/' + guildId + '/commands');
  }

  registerGuildCommands(applicationId, guildId, commands) {
    return this._put('/applications/' + applicationId + '/guilds/' + guildId + '/commands', commands);
  }

  // ---- Messages ---------------------------------------------------

  sendMessage(channelId, payload) {
    return this._post('/channels/' + channelId + '/messages', payload);
  }

  getMessage(channelId, messageId) {
    return this._get('/channels/' + channelId + '/messages/' + messageId);
  }

  getMessages(channelId, options) {
    options = options || {};
    return this._get('/channels/' + channelId + '/messages' + buildQuery({
      limit: options.limit,
      around: options.around,
      before: options.before,
      after: options.after
    }));
  }

  // Ids are matched newest-first by Discord; returns data as a
  // Collection keyed by message id when successful.
  async fetchMessagePage(bot, channelId, options) {
    const res = await this.getMessages(channelId, options);
    if (res.statusCode !== 200 || !Array.isArray(res.data)) return new Collection();
    for (const message of res.data) {
      bot.cache.handle('MESSAGE_CREATE', Object.assign({ channel_id: channelId }, message));
    }
    return new Collection(res.data.map((m) => [m.id, m]));
  }

  crosspostMessage(channelId, messageId) {
    return this._post('/channels/' + channelId + '/messages/' + messageId + '/crosspost');
  }

  pinMessage(channelId, messageId) {
    return this._put('/channels/' + channelId + '/messages/pins/' + messageId);
  }

  unpinMessage(channelId, messageId) {
    return this._del('/channels/' + channelId + '/messages/pins/' + messageId);
  }

  listPinnedMessages(channelId) {
    return this._get('/channels/' + channelId + '/messages/pins');
  }

  bulkDeleteMessages(channelId, ids) {
    return this._post('/channels/' + channelId + '/messages/bulk-delete', bulkDeleteBody(ids));
  }

  triggerTypingIndicator(channelId) {
    return this._post('/channels/' + channelId + '/typing');
  }

  sendPoll(channelId, questionText, choices, options) {
    options = options || {};
    const poll = {
      question: { text: String(questionText) },
      answers: (choices || []).map((c) => ({ poll_media: { text: String(typeof c === 'string' ? c : c.text) } })),
      allow_multiselect: !!options.multiSelect
    };
    const duration = parseInt(options.durationHours, 10);
    if (!isNaN(duration) && duration >= 1 && duration <= 768) poll.duration = duration;
    return this.sendMessage(channelId, { poll });
  }

  // ---- Reactions ---------------------------------------------------

  addReaction(channelId, messageId, emoji) {
    return this._put('/channels/' + channelId + '/messages/' + messageId +
      '/reactions/' + encodeEmoji(emoji) + '/@me');
  }

  removeOwnReaction(channelId, messageId, emoji) {
    return this._del('/channels/' + channelId + '/messages/' + messageId +
      '/reactions/' + encodeEmoji(emoji) + '/@me');
  }

  removeUserReaction(channelId, messageId, emoji, userId) {
    return this._del('/channels/' + channelId + '/messages/' + messageId +
      '/reactions/' + encodeEmoji(emoji) + '/' + userId);
  }

  removeAllReactions(channelId, messageId) {
    return this._del('/channels/' + channelId + '/messages/' + messageId + '/reactions');
  }

  removeAllReactionsForEmoji(channelId, messageId, emoji) {
    return this._del('/channels/' + channelId + '/messages/' + messageId +
      '/reactions/' + encodeEmoji(emoji));
  }

  getReactions(channelId, messageId, emoji, options) {
    options = options || {};
    return this._get('/channels/' + channelId + '/messages/' + messageId +
      '/reactions/' + encodeEmoji(emoji) + buildQuery({
        limit: options.limit,
        after: options.after,
        type: options.type
      }));
  }

  // Follow pagination automatically; resolves with a user Collection.
  async fetchReactions(channelId, messageId, emoji, options) {
    options = options || {};
    const limit = Math.min(options.fetchAll ? 200 : 100, options.limit || 100);
    const users = new Collection();
    let after = options.after;
    for (;;) {
      const res = await this.getReactions(channelId, messageId, emoji, { limit, after });
      if (res.statusCode !== 200 || !Array.isArray(res.data)) break;
      for (const u of res.data) users.set(u.id, u);
      if (!options.fetchAll || res.data.length < limit) break;
      after = res.data[res.data.length - 1].id;
    }
    return users;
  }

  // ---- Channels ----------------------------------------------------

  getChannel(channelId) { return this._get('/channels/' + channelId); }

  editChannel(channelId, patch) {
    patch = patch || {};
    const body = {};
    for (const key of ['name', 'type', 'position', 'topic', 'nsfw', 'bitrate',
      'user_limit', 'rate_limit_per_user', 'parent_id', 'rtc_region',
      'video_quality_mode', 'default_auto_archive_duration', 'archived',
      'auto_archive_duration', 'locked', 'invitable', 'applied_tags',
      'available_tags', 'default_reaction_emoji']) {
      if (patch[key] !== undefined) body[key] = patch[key];
    }
    if (patch.permission_overwrites !== undefined) {
      body.permission_overwrites = buildOverwrites(patch.permission_overwrites);
    }
    return this._patch('/channels/' + channelId, body);
  }

  createGuildChannel(guildId, options) {
    options = options || {};
    const body = {};
    for (const key of ['name', 'type', 'topic', 'nsfw', 'bitrate', 'user_limit',
      'rate_limit_per_user', 'position', 'rtc_region', 'video_quality_mode',
      'default_auto_archive_duration']) {
      if (options[key] !== undefined) body[key] = options[key];
    }
    if (options.parentId !== undefined) body.parent_id = String(options.parentId);
    if (options.overwrites !== undefined) {
      body.permission_overwrites = buildOverwrites(options.overwrites);
    }
    return this._post('/guilds/' + guildId + '/channels', body);
  }

  setChannelParent(channelId, parentId) {
    return this.editChannel(channelId, { parent_id: parentId });
  }

  deleteChannel(channelId) { return this._del('/channels/' + channelId); }

  putPermissionOverwrite(channelId, overwriteId, overwrite) {
    const body = {
      type: overwrite.type === 1 || overwrite.type === 'member' ? 1 : 0
    };
    // The PUT endpoint wants numeric bitfields; all current permission
    // bits (< 2^51) survive the double conversion exactly.
    const allow = toBitfieldString(overwrite.allow);
    const deny = toBitfieldString(overwrite.deny);
    if (allow !== undefined) body.allow = Number(allow);
    if (deny !== undefined) body.deny = Number(deny);
    return this._put('/channels/' + channelId + '/permissions/' + overwriteId, body);
  }

  deletePermissionOverwrite(channelId, overwriteId) {
    return this._del('/channels/' + channelId + '/permissions/' + overwriteId);
  }

  // ---- Threads -------------------------------------------------------

  startThreadFromMessage(channelId, messageId, options) {
    options = options || {};
    return this._post('/channels/' + channelId + '/messages/' + messageId + '/threads', {
      name: String(options.name || 'Thread'),
      auto_archive_duration: options.autoArchiveDuration || 1440,
      rate_limit_per_user: options.rateLimitPerUser
    });
  }

  startThreadWithoutMessage(channelId, options) {
    options = options || {};
    const body = {
      name: String(options.name || 'Thread'),
      auto_archive_duration: options.autoArchiveDuration || 1440,
      type: options.type || 11
    };
    if (options.invitable !== undefined) body.invitable = !!options.invitable;
    return this._post('/channels/' + channelId + '/threads', body);
  }

  joinThread(threadId) { return this._put('/channels/' + threadId + '/thread-members/@me'); }

  leaveThread(threadId) { return this._del('/channels/' + threadId + '/thread-members/@me'); }

  addThreadMember(threadId, userId) {
    return this._put('/channels/' + threadId + '/thread-members/' + userId);
  }

  removeThreadMember(threadId, userId) {
    return this._del('/channels/' + threadId + '/thread-members/' + userId);
  }

  getThreadMembers(threadId) {
    return this._get('/channels/' + threadId + '/thread-members');
  }

  listActiveThreads(guildId) { return this._get('/guilds/' + guildId + '/threads/active'); }

  listArchivedThreads(channelId, options) {
    options = options || {};
    return this._get('/channels/' + channelId + '/threads/archived/public' + buildQuery({
      before: options.before,
      limit: options.limit
    }));
  }

  // ---- Guilds ----------------------------------------------------------

  getGuild(guildId) { return this._get('/guilds/' + guildId + buildQuery({ with_counts: true })); }

  editGuild(guildId, patch) {
    const body = {};
    for (const key of ['name', 'verification_level', 'default_message_notifications',
      'explicit_content_filter', 'afk_timeout', 'description', 'banner', 'icon',
      'splash', 'discovery_splash', 'owner_id', 'rules_channel_id',
      'public_updates_channel_id', 'preferred_locale', 'afk_channel_id',
      'system_channel_id', 'premium_progress_bar_enabled']) {
      if (patch && patch[key] !== undefined) body[key] = patch[key];
    }
    return this._patch('/guilds/' + guildId, body);
  }

  listGuildChannels(guildId) { return this._get('/guilds/' + guildId + '/channels'); }

  moveChannel(guildId, positions) {
    return this._patch('/guilds/' + guildId + '/channels', positions);
  }

  listActiveThreadsForGuild(guildId) { return this.listActiveThreads(guildId); }

  getAuditLog(guildId, options) {
    options = options || {};
    return this._get('/guilds/' + guildId + '/audit-logs' + buildQuery({
      user_id: options.userId,
      action_type: options.actionType,
      before: options.before,
      after: options.after,
      limit: options.limit
    }));
  }

  getVanityURL(guildId) { return this._get('/guilds/' + guildId + '/vanity-url'); }

  getVoiceRegions() { return this._get('/voice/regions'); }

  // ---- Members & moderation -----------------------------------------

  getMember(guildId, userId) { return this._get('/guilds/' + guildId + '/members/' + userId); }

  searchMembers(guildId, query, limit) {
    return this._get('/guilds/' + guildId + '/members/search' + buildQuery({
      query, limit: limit || 10
    }));
  }

  listMembers(guildId, options) {
    options = options || {};
    return this._get('/guilds/' + guildId + '/members' + buildQuery({
      limit: options.limit || 1000,
      after: options.after
    }));
  }

  // Page through /members until exhausted. Resolves with a member
  // Collection keyed "guildId:userId".
  async fetchAllMembers(guildId, onBatch) {
    const members = new Collection();
    let after;
    for (;;) {
      const res = await this.listMembers(guildId, { limit: 1000, after });
      if (res.statusCode !== 200 || !Array.isArray(res.data) || !res.data.length) break;
      for (const m of res.data) {
        m.guild_id = guildId;
        members.set(guildId + ':' + m.user.id, m);
      }
      if (onBatch) onBatch(res.data);
      if (res.data.length < 1000) break;
      after = res.data[res.data.length - 1].user.id;
    }
    return members;
  }

  editMember(guildId, userId, patch) {
    const body = {};
    for (const key of ['nick', 'roles', 'mute', 'deaf', 'channel_id',
      'communication_disabled_until', 'flags']) {
      if (patch && patch[key] !== undefined) body[key] = patch[key];
    }
    return this._patch('/guilds/' + guildId + '/members/' + userId, body);
  }

  kickMember(guildId, userId) {
    return this._del('/guilds/' + guildId + '/members/' + userId);
  }

  banMember(guildId, userId, options) {
    options = options || {};
    return this._del('/guilds/' + guildId + '/members/' + userId + buildQuery({
      delete_message_days: options.deleteMessageDays,
      delete_message_seconds: options.deleteMessageSeconds
    }));
  }

  unbanMember(guildId, userId) {
    return this._del('/guilds/' + guildId + '/bans/' + userId);
  }

  getBan(guildId, userId) { return this._get('/guilds/' + guildId + '/bans/' + userId); }

  listBans(guildId, options) {
    options = options || {};
    return this._get('/guilds/' + guildId + '/bans' + buildQuery({
      limit: options.limit, before: options.before, after: options.after
    }));
  }

  // Mute/timeout sugar around editMember.
  timeoutMember(guildId, userId, millisecondsOrIso) {
    let iso = millisecondsOrIso;
    if (/^\d+$/.test(String(millisecondsOrIso))) {
      iso = new Date(Date.now() + Number(millisecondsOrIso)).toISOString();
    }
    return this.editMember(guildId, userId, { communication_disabled_until: iso || null });
  }

  moveMember(guildId, userId, voiceChannelId) {
    return this.editMember(guildId, userId, { channel_id: voiceChannelId || null });
  }

  countPrune(guildId, options) {
    options = options || {};
    return this._get('/guilds/' + guildId + '/prune' + buildQuery({
      days: options.days, include_roles: arrayParam(options.includeRoles)
    }));
  }

  beginPrune(guildId, options) {
    options = options || {};
    return this._post('/guilds/' + guildId + '/prune' + buildQuery({
      days: options.days, include_roles: arrayParam(options.includeRoles),
      compute_prune_count: true
    }), {});
  }

  // ---- Roles --------------------------------------------------------

  listRoles(guildId) { return this._get('/guilds/' + guildId + '/roles'); }

  createRole(guildId, role) {
    role = role || {};
    const body = {};
    if (role.name !== undefined) body.name = String(role.name);
    if (role.color !== undefined) body.color = role.color;
    if (role.hoist !== undefined) body.hoist = !!role.hoist;
    if (role.mentionable !== undefined) body.mentionable = !!role.mentionable;
    if (role.icon !== undefined) body.icon = role.icon;
    if (role.unicodeEmoji !== undefined) body.unicode_emoji = role.unicodeEmoji;
    if (role.permissions !== undefined) body.permissions = toBitfieldString(role.permissions) || '0';
    return this._post('/guilds/' + guildId + '/roles', body);
  }

  editRole(guildId, roleId, patch) {
    const body = {};
    for (const key of ['name', 'color', 'hoist', 'mentionable', 'icon', 'unicode_emoji']) {
      if (patch && patch[key] !== undefined) body[key] = patch[key];
    }
    if (patch && patch.permissions !== undefined) {
      body.permissions = toBitfieldString(patch.permissions) || '0';
    }
    return this._patch('/guilds/' + guildId + '/roles/' + roleId, body);
  }

  deleteRole(guildId, roleId) { return this._del('/guilds/' + guildId + '/roles/' + roleId); }

  reorderRoles(guildId, orderedIds) {
    return this._patch('/guilds/' + guildId + '/roles',
      orderedIds.map((id, index) => ({ id: String(id), position: index + 1 })));
  }

  addMemberRole(guildId, userId, roleId) {
    return this._put('/guilds/' + guildId + '/members/' + userId + '/roles/' + roleId);
  }

  removeMemberRole(guildId, userId, roleId) {
    return this._del('/guilds/' + guildId + '/members/' + userId + '/roles/' + roleId);
  }

  // ---- Invites --------------------------------------------------------

  createInvite(channelId, options) {
    options = options || {};
    const body = {};
    if (options.maxAgeSeconds !== undefined) body.max_age = options.maxAgeSeconds;
    if (options.maxUses !== undefined) body.max_uses = options.maxUses;
    if (options.temporary !== undefined) body.temporary = !!options.temporary;
    if (options.unique !== undefined) body.unique = !!options.unique;
    if (options.targetType !== undefined) body.target_type = options.targetType;
    if (options.targetUserId !== undefined) body.target_user_id = String(options.targetUserId);
    if (options.targetApplicationId !== undefined) body.target_application_id = String(options.targetApplicationId);
    return this._post('/channels/' + channelId + '/invites', body);
  }

  getInvite(code, options) {
    options = options || {};
    return this._get('/invites/' + code + buildQuery({
      with_counts: options.withCounts, with_expiration: options.withExpiration,
      guild_scheduled_event_id: options.scheduledEventId
    }));
  }

  deleteInvite(code) { return this._del('/invites/' + code); }

  listGuildInvites(guildId) { return this._get('/guilds/' + guildId + '/invites'); }

  listChannelInvites(channelId) { return this._get('/channels/' + channelId + '/invites'); }

  // ---- Webhooks -------------------------------------------------------

  createWebhook(channelId, options) {
    options = options || {};
    const body = { name: String(options.name || 'Elyxion') };
    if (options.avatar !== undefined) body.avatar = options.avatar;
    return this._post('/channels/' + channelId + '/webhooks', body);
  }

  listChannelWebhooks(channelId) { return this._get('/channels/' + channelId + '/webhooks'); }

  listGuildWebhooks(guildId) { return this._get('/guilds/' + guildId + '/webhooks'); }

  getWebhook(webhookId, token) {
    return this._get('/webhooks/' + webhookId + (token ? '/' + token : ''));
  }

  editWebhook(webhookId, patch) {
    const body = {};
    for (const key of ['name', 'avatar', 'channel_id']) {
      if (patch && patch[key] !== undefined) body[key] = patch[key];
    }
    return this._patch('/webhooks/' + webhookId, body);
  }

  deleteWebhook(webhookId, token) {
    return this._del('/webhooks/' + webhookId + (token ? '/' + token : ''));
  }

  executeWebhook(webhookId, token, payload, options) {
    options = options || {};
    return this.rest.post('/webhooks/' + webhookId + '/' + token + buildQuery({
      wait: options.wait, thread_id: options.threadId
    }), payload);
  }

  // ---- Emojis & stickers ----------------------------------------------

  listEmojis(guildId) { return this._get('/guilds/' + guildId + '/emojis'); }

  getEmoji(guildId, emojiId) { return this._get('/guilds/' + guildId + '/emojis/' + emojiId); }

  createEmoji(guildId, emoji) {
    return this._post('/guilds/' + guildId + '/emojis', {
      name: emoji.name,
      image: emoji.image
    });
  }

  editEmoji(guildId, emojiId, patch) {
    const body = {};
    if (patch.name !== undefined) body.name = patch.name;
    return this._patch('/guilds/' + guildId + '/emojis/' + emojiId, body);
  }

  deleteEmoji(guildId, emojiId) { return this._del('/guilds/' + guildId + '/emojis/' + emojiId); }

  listStickers(guildId) { return this._get('/guilds/' + guildId + '/stickers'); }

  getSticker(stickerId) { return this._get('/stickers/' + stickerId); }

  // ---- Scheduled events --------------------------------------------------

  listScheduledEvents(guildId, withUserCount) {
    return this._get('/guilds/' + guildId + '/scheduled-events' + buildQuery({
      with_user_count: withUserCount
    }));
  }

  createScheduledEvent(guildId, event) {
    event = event || {};
    const body = {
      name: String(event.name || ''),
      privacy_level: event.privacyLevel || 2,
      entity_type: event.entityType
    };
    if (event.description !== undefined) body.description = String(event.description);
    if (event.scheduledStartTime) body.scheduled_start_time = event.scheduledStartTime;
    if (event.scheduledEndTime) body.scheduled_end_time = event.scheduledEndTime;
    if (event.channelId) body.channel_id = String(event.channelId);
    if (event.entityMetadataLocation) {
      body.entity_metadata = { location: String(event.entityMetadataLocation) };
    }
    return this._post('/guilds/' + guildId + '/scheduled-events', body);
  }

  editScheduledEvent(guildId, eventId, patch) {
    const body = patch || {};
    if (body.privacyLevel !== undefined) body.privacy_level = body.privacyLevel, delete body.privacyLevel;
    if (body.entityType !== undefined) body.entity_type = body.entityType, delete body.entityType;
    return this._patch('/guilds/' + guildId + '/scheduled-events/' + eventId, body);
  }

  deleteScheduledEvent(guildId, eventId) {
    return this._del('/guilds/' + guildId + '/scheduled-events/' + eventId);
  }

  listEventSubscribers(guildId, eventId, options) {
    options = options || {};
    return this._get('/guilds/' + guildId + '/scheduled-events/' + eventId +
      '/users' + buildQuery({ limit: options.limit, with_member: options.withMembers }));
  }

  // ---- AutoMod ------------------------------------------------------------

  listAutomodRules(guildId) { return this._get('/guilds/' + guildId + '/auto-moderation/rules'); }

  getAutomodRule(guildId, ruleId) {
    return this._get('/guilds/' + guildId + '/auto-moderation/rules/' + ruleId);
  }

  createAutomodRule(guildId, rule) {
    rule = rule || {};
    return this._post('/guilds/' + guildId + '/auto-moderation/rules', {
      name: String(rule.name || ''),
      event_type: rule.eventType || 1,
      trigger_type: rule.triggerType,
      trigger_metadata: rule.triggerMetadata,
      actions: rule.actions,
      enabled: rule.enabled !== false,
      exempt_roles: rule.exemptRoles || [],
      exempt_channels: rule.exemptChannels || []
    });
  }

  editAutomodRule(guildId, ruleId, patch) {
    return this._patch('/guilds/' + guildId + '/auto-moderation/rules/' + ruleId, patch || {});
  }

  deleteAutomodRule(guildId, ruleId) {
    return this._del('/guilds/' + guildId + '/auto-moderation/rules/' + ruleId);
  }
}

function arrayParam(list) {
  if (!list) return undefined;
  return (Array.isArray(list) ? list : [list]).join(',');
}

module.exports = {
  RestApi,
  bulkDeleteBody,
  buildOverwrites,
  buildQuery,
  encodeEmoji,
  toBitfieldString,
  RestApiHelpers: { toBitfieldString, arrayParam }
};
