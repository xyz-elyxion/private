// Elyxion Discord Framework — enriched events
// ---------------------------------------------------------------
// Adds derived, easier-to-consume events on top of the raw gateway
// dispatches. Raw dispatches still fire (MESSAGE_CREATE, ...) —
// these are extras:
//
//   message            every MESSAGE_CREATE as a hydrated Message
//   messageUpdate      with { old } when the cache saw the original
//   messageDelete      fires for bulk deletes too (per id)
//   reactionAdd        from MESSAGE_REACTION_ADD, resolved user
//   guildMemberAdd     member with .guild attached
//   memberBoost / memberUnboost    PREMIUM_GUILD_SUBSCRIPTION_*
//   voiceStateUpdate   with old state
//   presenceUpdate     with old state
// 'use strict';

class EventEnricher {
  constructor(bot) {
    this.bot = bot;
  }

  // Called by Bot._handleGatewayEvent for opcode-0 dispatches.
  // Reads the cache as-is (pre-update state); the caller feeds
  // cache.handle() afterwards exactly once.
  handle(type, data) {
    const cache = this.bot.cache;
    switch (type) {
      case 'MESSAGE_CREATE':
        this._emit('message', this.hydrateMessage(data));
        break;

      case 'MESSAGE_UPDATE': {
        const old = cache.getMessage(data.channel_id, data.id);
        this._emit('messageUpdate', {
          old: old,
          new: data,
          channel: cache.getChannel(data.channel_id),
          guild: cache.getGuild(data.guild_id)
        });
        break;
      }

      case 'MESSAGE_DELETE': {
        const old = cache.getMessage(data.channel_id, data.id);
        this._emit('messageDelete', { old, id: data.id, channelId: data.channel_id });
        break;
      }

      case 'MESSAGE_DELETE_BULK':
        for (const id of data.ids || []) {
          const old = cache.getMessage(data.channel_id, id);
          this._emit('messageDelete', { old, id, channelId: data.channel_id, bulk: true });
        }
        break;

      case 'MESSAGE_REACTION_ADD': {
        const user = data.member && data.member.user ? data.member.user : data.user;
        this._emit('reactionAdd', {
          userId: (user && user.id) || data.user_id,
          user,
          emoji: data.emoji,
          messageId: data.message_id,
          channelId: data.channel_id,
          guildId: data.guild_id || null,
          burst: !!data.burst
        });
        break;
      }
      case 'MESSAGE_REACTION_REMOVE': {
        this._emit('reactionRemove', {
          userId: data.user_id,
          user: data.user || null,
          emoji: data.emoji,
          messageId: data.message_id,
          channelId: data.channel_id
        });
        break;
      }
      case 'MESSAGE_REACTION_REMOVE_ALL':
        this._emit('reactionsClear', { messageId: data.message_id, channelId: data.channel_id });
        break;
      case 'MESSAGE_REACTION_REMOVE_EMOJI':
        this._emit('reactionsClearEmoji', {
          messageId: data.message_id, channelId: data.channel_id, emoji: data.emoji
        });
        break;

      case 'GUILD_MEMBER_ADD': {
        const member = cache.getMember(data.guild_id, data.user && data.user.id);
        if (member && member.user) member.guild = cache.getGuild(data.guild_id);
        this._emit('guildMemberAdd', member || data);
        break;
      }
      case 'GUILD_MEMBER_REMOVE': {
        this._emit('guildMemberRemove', data.user || data);
        break;
      }
      case 'GUILD_MEMBER_UPDATE': {
        const old = cache.getMember(data.guild_id, data.user && data.user.id);
        this._emit('memberUpdate', { old, new: data });
        this._detectBoost(data, old);
        break;
      }
      case 'PREMIUM_GUILD_SUBSCRIPTION_CREATE':
        this._emit('memberBoost', { guildId: data.guild_id, user: data.user });
        break;
      case 'PREMIUM_GUILD_SUBSCRIPTION_UPDATE':
        this._emit('memberBoostUpdate', { guildId: data.guild_id, user: data.user });
        break;
      case 'PREMIUM_GUILD_SUBSCRIPTION_DELETE':
        this._emit('memberUnboost', { guildId: data.guild_id, user: data.user });
        break;

      case 'VOICE_STATE_UPDATE': {
        const old = this._previousVoice(data.user_id);
        this._trackVoice(data);
        this._emitVoiceUpdate(old, data);
        break;
      }

      case 'PRESENCE_UPDATE': {
        const old = cache.getPresence(data.user && data.user.id);
        this._emit('presenceUpdate', { old, new: data });
        break;
      }

      case 'TYPING_START': {
        const channel = cache.getChannel(data.channel_id);
        this._emit('typingStart', {
          channelId: data.channel_id,
          channel,
          guildId: data.guild_id || null,
          userId: data.user_id,
          timestamp: data.timestamp,
          member: data.member || null
        });
        break;
      }

      default:
        break;
    }
  }

  _emit(name, payload) {
    try {
      this.bot.emit(name, payload);
    } catch (err) {
      // Listener errors must not break dispatch handling.
      if (this.bot.listenerCount('error')) this.bot.emit('error', err);
    }
  }

  hydrateMessage(data) {
    const cache = this.bot.cache;
    return {
      raw: data,
      id: data.id,
      content: data.content,
      author: data.author,
      member: data.member || null,
      channelId: data.channel_id,
      guildId: data.guild_id || null,
      channel: cache.getChannel(data.channel_id),
      guild: cache.getGuild(data.guild_id),
      attachments: data.attachments || [],
      embeds: data.embeds || [],
      mentions: data.mentions || [],
      mentionEveryone: !!data.mention_everyone,
      pinned: !!data.pinned,
      tts: !!data.tts,
      reference: data.referenced_message || null,
      createdAt: fwSnowflakeDate(data.id)
    };
  }

  // Track previous voice states so voiceStateUpdate can expose `old`.
  _trackVoice(state) {
    if (!this._voiceHistory) this._voiceHistory = new Map();
    this._voiceHistory.set(String(state.user_id), state);
  }

  _previousVoice(userId) {
    if (!this._voiceHistory) return null;
    return this._voiceHistory.get(String(userId)) || null;
  }

  _emitVoiceUpdate(old, next) {
    const unchanged = old &&
      old.channel_id === next.channel_id &&
      old.self_mute === next.self_mute && old.self_deaf === next.self_deaf &&
      old.mute === next.mute && old.deaf === next.deaf &&
      old.session_id === next.session_id;
    if (unchanged) return;
    this._emit('voiceStateUpdate', {
      old: old,
      new: next,
      joined: !!(next.channel_id && (!old || !old.channel_id)),
      left: !!(!next.channel_id && old && old.channel_id),
      movedChannel: !!(old && next.channel_id && old.channel_id !== next.channel_id)
    });
  }

  // Nitro boost detection from role changes.
  _detectBoost(member, oldMember) {
    if (!oldMember || !member) return;
    const boostRoles = ['133722280468295680', '133722280468295681', '133722280468295682'];
    const has = (m) => (m.roles || []).some((r) => boostRoles.indexOf(r) !== -1);
    const was = has(oldMember);
    const is = has(member);
    if (!was && is) this._emit('memberBoost', { guildId: member.guild_id, user: member.user, viaRole: true });
    if (was && !is) this._emit('memberUnboost', { guildId: member.guild_id, user: member.user, viaRole: true });
  }
}

function fwSnowflakeDate(id) {
  if (!/^\d{17,20}$/.test(String(id || ''))) return null;
  return new Date(Math.floor(Number(id) / 4194304) + 1420070400000);
}

module.exports = { EventEnricher };
