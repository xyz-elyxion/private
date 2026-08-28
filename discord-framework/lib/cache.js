// Elyxion Discord Framework — in-memory cache
// ---------------------------------------------------------------
// A dependency-free store for guilds, channels, users, members,
// messages, and roles, kept fresh by feeding it gateway dispatch
// events (bot.cache.handle(event, data)). Collections can be
// disabled via options; the message cache is capped per channel.
'use strict';

const DEFAULT_OPTIONS = {
  guilds: true,
  channels: true,
  users: true,
  members: true,
  messages: true,
  roles: true,
  presences: false,
  messageLimitPerChannel: 200
};

class Cache {
  constructor(options) {
    options = options === true ? {} : options || {};
    this.options = Object.assign({}, DEFAULT_OPTIONS, typeof options === 'object' ? options : {});
    this.options = this.options || DEFAULT_OPTIONS;

    this.guilds = new Map();
    this.channels = new Map();
    this.users = new Map();
    this.members = new Map();
    this.messages = new Map();
    this.roles = new Map();
    this.presences = new Map();

    // channel id -> [message cache keys, oldest first]
    this._messageOrder = new Map();
  }

  _enabled(name) {
    return this.options[name] !== false;
  }

  // ---- Getters --------------------------------------------------

  getGuild(id) { return this.guilds.get(String(id)) || null; }
  getChannel(id) { return this.channels.get(String(id)) || null; }
  getUser(id) { return this.users.get(String(id)) || null; }
  getMember(guildId, userId) { return this.members.get(String(guildId) + ':' + String(userId)) || null; }
  getMessage(channelId, messageId) { return this.messages.get(String(channelId) + ':' + String(messageId)) || null; }
  getRole(guildId, roleId) { return this.roles.get(String(guildId) + ':' + String(roleId)) || null; }
  getPresence(userId) { return this.presences.get(String(userId)) || null; }

  // Generic get/set/delete by collection name ('guilds', ...).
  get(collection, key) {
    const map = this[collection];
    return map && map.get ? map.get(String(key)) || null : null;
  }

  set(collection, key, value) {
    const map = this[collection];
    if (map && map.set) map.set(String(key), value);
    return this;
  }

  delete(collection, key) {
    const map = this[collection];
    if (map && map.delete) map.delete(String(key));
    return this;
  }

  clear() {
    this.guilds.clear();
    this.channels.clear();
    this.users.clear();
    this.members.clear();
    this.messages.clear();
    this.roles.clear();
    this.presences.clear();
    this._messageOrder.clear();
    return this;
  }

  // ---- Event handling -------------------------------------------

  handle(event, data) {
    switch (event) {
      case 'READY':
        this._onReady(data);
        break;
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        this._setGuild(data, event === 'GUILD_CREATE');
        break;
      case 'GUILD_DELETE':
        this._deleteGuild(data);
        break;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        this._setChannel(data);
        break;
      case 'CHANNEL_DELETE':
        this._deleteChannel(data);
        break;
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
        this._setMember(data);
        break;
      case 'GUILD_MEMBER_REMOVE':
        this._deleteMember(data);
        break;
      case 'GUILD_MEMBERS_CHUNK':
        for (const member of data.members || []) {
          this._setMember(Object.assign({ guild_id: data.guild_id }, member));
        }
        break;
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        this._setChannel(data);
        break;
      case 'THREAD_DELETE':
        this._deleteChannel(data);
        break;
      case 'THREAD_LIST_SYNC':
        for (const t of data.threads || []) this._setChannel(t);
        break;
      case 'THREAD_MEMBERS_UPDATE':
        // Member counts live on the channel object; update in place.
        {
          const thread = this.channels.get(String(data.id));
          if (thread) {
            thread.member_count = data.member_count;
            this.channels.set(String(data.id), thread);
          }
        }
        break;
      case 'USER_UPDATE':
        this._setUser(data);
        break;
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE':
        this._setMessage(data);
        break;
      case 'MESSAGE_DELETE':
        this._deleteMessage(data);
        break;
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
        this._setRole(data);
        break;
      case 'GUILD_ROLE_DELETE':
        this._deleteRole(data);
        break;
      case 'GUILD_EMOJIS_UPDATE':
        this._setGuildEmojis(data);
        break;
      case 'PRESENCE_UPDATE':
        this._setPresence(data);
        break;
      default:
        break;
    }
    return this;
  }

  _onReady(data) {
    if (!data) return;
    if (data.user && this._enabled('users')) this.users.set(String(data.user.id), data.user);
    for (const guild of data.guilds || []) {
      this._setGuild(guild, true);
    }
  }

  _setGuild(guild, seedChildren) {
    if (!guild || !guild.id) return;
    if (this._enabled('guilds')) this.guilds.set(String(guild.id), guild);
    if (seedChildren) {
      for (const ch of guild.channels || []) this._setChannel(ch);
      for (const role of guild.roles || []) this._setRole(role);
      for (const member of guild.members || []) this._setMember(member);
    }
  }

  _deleteGuild(guild) {
    if (!guild) return;
    const id = String(guild.id);
    this.guilds.delete(id);
    const guildPrefix = id + ':';
    for (const key of Array.from(this.roles.keys())) {
      if (key.indexOf(guildPrefix) === 0) this.roles.delete(key);
    }
    for (const key of Array.from(this.members.keys())) {
      if (key.indexOf(guildPrefix) === 0) this.members.delete(key);
    }
    for (const [cid, ch] of Array.from(this.channels.entries())) {
      if (String(ch.guild_id) === id) this.channels.delete(cid);
    }
  }

  _setChannel(channel) {
    if (!channel || !channel.id) return;
    if (this._enabled('channels')) this.channels.set(String(channel.id), channel);
  }

  _deleteChannel(channel) {
    if (!channel) return;
    this.channels.delete(String(channel.id));
  }

  _setMember(member) {
    if (!member || !member.user || !member.user.id) return;
    const guildId = String(member.guild_id || '');
    if (!guildId) return;
    if (this._enabled('members')) {
      this.members.set(guildId + ':' + String(member.user.id), member);
    }
    if (this._enabled('users')) this.users.set(String(member.user.id), member.user);
  }

  _deleteMember(member) {
    if (!member || !member.user) return;
    this.members.delete(String(member.guild_id || '') + ':' + String(member.user.id));
  }

  _setUser(user) {
    if (!user || !user.id) return;
    if (this._enabled('users')) this.users.set(String(user.id), user);
  }

  _setMessage(message) {
    if (!message || !message.id) return;
    if (!this._enabled('messages')) return;
    const cid = String(message.channel_id || '');
    if (!cid) return;
    const key = cid + ':' + String(message.id);
    this.messages.set(key, message);

    let order = this._messageOrder.get(cid);
    if (!order) {
      order = [];
      this._messageOrder.set(cid, order);
    }
    order.push(key);
    const limit = Math.max(1, this.options.messageLimitPerChannel || 200);
    while (order.length > limit) {
      const oldest = order.shift();
      this.messages.delete(oldest);
    }
  }

  _deleteMessage(message) {
    if (!message) return;
    const cid = String(message.channel_id || '');
    const key = cid + ':' + String(message.id);
    this.messages.delete(key);
    const order = this._messageOrder.get(cid);
    if (order) {
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
    }
  }

  _setRole(role) {
    if (!role || !role.id) return;
    if (this._enabled('roles')) this.roles.set(String(role.guild_id || '') + ':' + String(role.id), role);
  }

  _deleteRole(role) {
    if (!role) return;
    this.roles.delete(String(role.guild_id || '') + ':' + String(role.id));
  }

  _setGuildEmojis(data) {
    if (!data || !this._enabled('guilds')) return;
    const guild = this.guilds.get(String(data.guild_id || ''));
    if (guild) {
      guild.emojis = data.emojis || [];
      this.guilds.set(String(data.guild_id), guild);
    }
  }

  _setPresence(presence) {
    if (!presence || !presence.user || !presence.user.id) return;
    if (!this._enabled('presences')) return;
    this.presences.set(String(presence.user.id), presence);
  }
}

module.exports = { Cache };
