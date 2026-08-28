// Elyxion Discord Framework — interactions
// ---------------------------------------------------------------
// Slash commands, message components (buttons/selects), modals, and
// autocomplete. Handles the interaction lifecycle: the 3-second ack
// window (with automatic deferral), initial responses, deferred
// followups, and editing the original reply — all over the REST API.
//
//   bot.slash('ping', (ctx) => ctx.reply('pong'), { description: 'Ping' });
//   bot.button('like', (ctx) => ctx.update({ content: 'Liked!' }));
//   bot.modal('feedback', (ctx) => ctx.reply('Thanks!'));
'use strict';

const { Embed } = require('./embed');

// ---- Constants --------------------------------------------------

const InteractionTypes = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5
};

const OptionTypes = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11
};

const TYPE_NAMES = {
  string: OptionTypes.STRING,
  integer: OptionTypes.INTEGER,
  boolean: OptionTypes.BOOLEAN,
  user: OptionTypes.USER,
  channel: OptionTypes.CHANNEL,
  role: OptionTypes.ROLE,
  mentionable: OptionTypes.MENTIONABLE,
  number: OptionTypes.NUMBER,
  attachment: OptionTypes.ATTACHMENT
};

const EPHEMERAL = 1 << 6;

// ---- Option extraction ------------------------------------------

// Walk an interaction's options and return a flat map of option name
// -> value (subcommand/subcommand-group names are traversed).
function extractOptions(data) {
  const map = {};
  const raw = [];
  const focused = { name: null, value: undefined };
  (function walk(opts) {
    for (const o of opts || []) {
      if (o.type === OptionTypes.SUB_COMMAND || o.type === OptionTypes.SUB_COMMAND_GROUP) {
        walk(o.options);
      } else {
        raw.push(o);
        if (map[o.name] === undefined) map[o.name] = o.value;
        if (o.focused) {
          focused.name = o.name;
          focused.value = o.value;
        }
      }
    }
  })(data && data.options);
  return { map, raw, focused };
}

// Full slash-command path from an interaction's options, e.g.
// options [{ name:'admin', type:2, ... }, { name:'ban', type:1 }]
// becomes 'admin ban'.
function interactionPath(data) {
  const root = String((data && data.name) || '').toLowerCase();
  const names = [];
  (function walk(opts) {
    for (const o of opts || []) {
      if (o.type === OptionTypes.SUB_COMMAND || o.type === OptionTypes.SUB_COMMAND_GROUP) {
        names.push(String(o.name).toLowerCase());
        walk(o.options);
      }
    }
  })(data && data.options);
  const sub = names.join(' ');
  if (!root) return sub;
  return sub ? root + ' ' + sub : root;
}

// Normalize a reply value into a message payload: strings become
// { content }, Embeds become { embeds }, objects pass through with
// any Embed/component builder instances converted.
function normalizeMessage(content) {
  if (typeof content === 'string') return { content };
  if (content instanceof Embed) return { embeds: [content.toJSON()] };
  if (content && typeof content.toJSON === 'function') return content.toJSON();
  const out = Object.assign({}, content || {});
  if (out.embeds) out.embeds = out.embeds.map((e) => (e && typeof e.toJSON === 'function' ? e.toJSON() : e));
  if (out.components) out.components = out.components.map((c) => (c && typeof c.toJSON === 'function' ? c.toJSON() : c));
  return out;
}

function optionType(type) {
  if (typeof type === 'number') return type;
  const n = TYPE_NAMES[String(type || 'string').toLowerCase()];
  return n || OptionTypes.STRING;
}

function toAPIOptions(list) {
  return (list || []).map((o) => {
    const out = {
      type: optionType(o.type),
      name: o.name,
      description: o.description || 'No description'
    };
    if (o.required) out.required = true;
    if (o.choices) out.choices = o.choices;
    if (o.min_value !== undefined) out.min_value = o.min_value;
    if (o.max_value !== undefined) out.max_value = o.max_value;
    if (o.min_length !== undefined) out.min_length = o.min_length;
    if (o.max_length !== undefined) out.max_length = o.max_length;
    if (o.autocomplete) out.autocomplete = true;
    return out;
  });
}

function toAPICommand(entry) {
  if (entry._subcommands) {
    return {
      name: entry.path,
      description: entry.options.description || 'No description',
      options: entry._subcommands.map((sub) => ({
        type: OptionTypes.SUB_COMMAND,
        name: sub.name,
        description: sub.options.description || 'No description',
        options: toAPIOptions(sub.options.options)
      }))
    };
  }
  return {
    name: entry.path,
    description: entry.options.description || 'No description',
    options: toAPIOptions(entry.options.options)
  };
}

// ---- Registry ---------------------------------------------------

class InteractionRegistry {
  constructor() {
    this.commands = [];
    this.components = new Map(); // custom_id -> handler
    this.modals = new Map();     // custom_id -> handler
    this._pathMap = null;
  }

  // slash(name, handler, { description, options, subcommands, guildId })
  // Subcommands may be an object of { name: handler | { handler, description, options } }.
  slash(name, handler, options) {
    options = options || {};
    if (typeof handler !== 'function') throw new TypeError('Slash command "' + name + '" needs a handler function');
    const base = String(name).toLowerCase().trim();
    if (!base || base.length > 32) {
      throw new Error('Slash command names must be 1-32 characters: ' + name);
    }

    const entry = {
      path: base,
      name: base,
      handler,
      options
    };
    this.commands.push(entry);

    const subs = options.subcommands || options.subcommandGroup;
    if (subs) {
      entry._subcommands = [];
      for (const key of Object.keys(subs)) {
        const sub = typeof subs[key] === 'function' ? { handler: subs[key] } : subs[key];
        const subEntry = {
          path: base + ' ' + String(key).toLowerCase(),
          name: String(key).toLowerCase(),
          handler: sub.handler || handler,
          options: sub,
          parent: base,
          _isSub: true
        };
        entry._subcommands.push(subEntry);
        this.commands.push(subEntry);
      }
    }
    this._pathMap = null;
    return entry;
  }

  button(customId, handler) {
    this.components.set(String(customId), handler);
    return this;
  }

  select(customId, handler) {
    this.components.set(String(customId), handler);
    return this;
  }

  modal(customId, handler) {
    this.modals.set(String(customId), handler);
    return this;
  }

  _byPath() {
    if (!this._pathMap) {
      this._pathMap = {};
      for (const c of this.commands) this._pathMap[c.path] = c;
    }
    return this._pathMap;
  }

  _findByPath(path) {
    return this._byPath()[path] || null;
  }

  // Push registered commands to Discord. Returns
  // { global, guilds: { [guildId]: result } }.
  async registerAll(rest, applicationId) {
    const globalCmds = [];
    const guildCmds = {};
    for (const entry of this.commands) {
      if (entry._isSub) continue; // parents carry their subcommands as options
      if (entry.options.guildId) {
        const g = String(entry.options.guildId);
        (guildCmds[g] = guildCmds[g] || []).push(toAPICommand(entry));
      } else {
        globalCmds.push(toAPICommand(entry));
      }
    }
    const result = { global: null, guilds: {} };
    if (globalCmds.length) {
      result.global = await rest.put('/applications/' + applicationId + '/commands', globalCmds);
    }
    for (const g of Object.keys(guildCmds)) {
      result.guilds[g] = await rest.put('/applications/' + applicationId + '/guilds/' + g + '/commands', guildCmds[g]);
    }
    return result;
  }

  // Route an INTERACTION_CREATE payload to the right handler.
  handle(payload, bot) {
    try {
      switch (payload.type) {
        case InteractionTypes.APPLICATION_COMMAND:
          this._handleCommand(payload, bot);
          break;
        case InteractionTypes.MESSAGE_COMPONENT:
          this._handleComponent(payload, bot);
          break;
        case InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE:
          this._handleAutocomplete(payload, bot);
          break;
        case InteractionTypes.MODAL_SUBMIT:
          this._handleModal(payload, bot);
          break;
        default:
          break;
      }
    } catch (err) {
      bot.emit('interactionError', err, payload);
    }
  }

  _handleCommand(payload, bot) {
    const path = interactionPath(payload.data);
    let entry = this._findByPath(path);
    if (!entry) entry = this._findByPath(String(path).split(' ')[0]);
    if (!entry) {
      bot.emit('unhandledInteraction', payload);
      new InteractionContext(payload, bot).defer(false).catch((err) => bot.emit('error', err));
      return;
    }
    const ctx = new InteractionContext(payload, bot);
    Promise.resolve()
      .then(() => entry.handler(ctx))
      .catch((err) => bot.emit('interactionError', err, payload));
  }

  _handleComponent(payload, bot) {
    const id = payload.data && payload.data.custom_id;
    const handler = this.components.get(String(id || ''));
    if (!handler) {
      bot.emit('unhandledInteraction', payload);
      return;
    }
    const ctx = new InteractionContext(payload, bot);
    Promise.resolve()
      .then(() => handler(ctx))
      .catch((err) => bot.emit('interactionError', err, payload));
  }

  _handleModal(payload, bot) {
    const id = payload.data && payload.data.custom_id;
    const handler = this.modals.get(String(id || ''));
    if (!handler) {
      bot.emit('unhandledInteraction', payload);
      return;
    }
    const ctx = new InteractionContext(payload, bot);
    Promise.resolve()
      .then(() => handler(ctx))
      .catch((err) => bot.emit('interactionError', err, payload));
  }

  _handleAutocomplete(payload, bot) {
    const path = interactionPath(payload.data);
    const entry = this._findByPath(path);
    const ctx = new InteractionContext(payload, bot);
    const handler = entry && (entry.options.autocompleteHandler || (entry.options.autocomplete ? entry.handler : null));
    if (!handler) {
      ctx.autocomplete([]).catch((err) => bot.emit('error', err));
      return;
    }
    Promise.resolve()
      .then(() => handler(ctx))
      .catch((err) => bot.emit('interactionError', err, payload));
  }
}

// ---- Interaction context ----------------------------------------

class InteractionContext {
  constructor(interaction, bot) {
    this.interaction = interaction;
    this.bot = bot;
    this._bot = bot; // used by the auto-defer timer

    this.id = interaction.id;
    this.token = interaction.token;
    this.applicationId = interaction.application_id;
    this.channelId = interaction.channel_id || null;
    this.guildId = interaction.guild_id || null;
    this.member = interaction.member || null;
    this.user = (interaction.member && interaction.member.user) || interaction.user || null;
    this.locale = interaction.locale || null;
    this.guildLocale = interaction.guild_locale || null;
    this.message = interaction.message || null;
    this.isComponent = interaction.type === InteractionTypes.MESSAGE_COMPONENT;

    const data = interaction.data || {};
    this.customId = data.custom_id || null;
    this.values = data.values || null;
    this.componentType = data.component_type || null;
    this.components = data.components || null;

    const opts = extractOptions(data);
    this.options = opts.map;
    this.optionRaw = opts.raw;
    this.focused = opts.focused;

    this._acked = false;
    this._deferred = false;

    // Discord requires an ack within 3 seconds; auto-defer if the
    // handler hasn't responded in time.
    this._autoDefer = setTimeout(() => {
      this._autoDefer = null;
      this.defer(false).catch((err) => this._bot.emit('error', err));
    }, 2500);
    if (this._autoDefer.unref) this._autoDefer.unref();
  }

  _callbackURL() {
    return '/interactions/' + this.id + '/' + this.token + '/callback';
  }

  _webhookURL() {
    return '/webhooks/' + this.applicationId + '/' + this.token;
  }

  _clearAutoDefer() {
    if (this._autoDefer) {
      clearTimeout(this._autoDefer);
      this._autoDefer = null;
    }
  }

  // Raw interaction callback. Throws if already acknowledged.
  async respond(payload) {
    if (this._acked) throw new Error('Interaction already acknowledged');
    const res = await this.bot.rest.post(this._callbackURL(), payload);
    if (res.statusCode >= 400) {
      const detail = res.data && res.data.message ? ': ' + res.data.message : '';
      throw new Error('Interaction response failed (HTTP ' + res.statusCode + ')' + detail);
    }
    this._acked = true;
    this._clearAutoDefer();
    return res.data;
  }

  // Acknowledge with a deferred response so followups can be sent later.
  async defer(ephemeral) {
    if (this._acked) return;
    const data = {};
    if (ephemeral) data.flags = EPHEMERAL;
    await this.respond({ type: this.isComponent ? 6 : 5, data });
    this._deferred = true;
  }

  async deferUpdate() {
    return this.defer(false);
  }

  // Initial reply (or followup if already acked/deferred).
  async reply(content) {
    const data = normalizeMessage(content);
    if (this._acked) return this.followup(data);
    return this.respond({ type: this.isComponent ? 7 : 4, data });
  }

  // Edit the original reply (components only, after an update).
  async update(content) {
    if (this._acked) return this.editReply(content);
    return this.respond({ type: 7, data: normalizeMessage(content) });
  }

  async editReply(content) {
    const res = await this.bot.rest.patch(this._webhookURL() + '/messages/@original', normalizeMessage(content));
    if (res.statusCode >= 400) {
      const detail = res.data && res.data.message ? ': ' + res.data.message : '';
      throw new Error('editReply failed (HTTP ' + res.statusCode + ')' + detail);
    }
    return res.data;
  }

  async followup(content) {
    const res = await this.bot.rest.post(this._webhookURL(), normalizeMessage(content));
    if (res.statusCode >= 400) {
      const detail = res.data && res.data.message ? ': ' + res.data.message : '';
      throw new Error('followup failed (HTTP ' + res.statusCode + ')' + detail);
    }
    return res.data;
  }

  // Open a modal: a Modal builder instance or a plain object.
  async modal(modal) {
    const data = modal && typeof modal.toJSON === 'function' ? modal.toJSON() : modal;
    return this.respond({ type: 9, data });
  }

  // Autocomplete choices: [{ name, value }] or objects with more fields.
  async autocomplete(choices) {
    return this.respond({ type: 8, data: { choices: choices || [] } });
  }
}

// ---- Message component builders ---------------------------------

class ActionRow {
  constructor() {
    this.components = [];
  }

  addComponent(component) {
    if (this.components.length >= 5) {
      throw new Error('Action rows can hold at most 5 components');
    }
    this.components.push(component);
    return this;
  }

  toJSON() {
    return { type: 1, components: this.components.map((c) => c.toJSON()) };
  }
}

class Button {
  constructor() {
    this.style = 1;
    this.label = '';
    this.custom_id = undefined;
    this.url = undefined;
    this.emoji = undefined;
    this.disabled = false;
  }

  setStyle(style) {
    this.style = style;
    return this;
  }

  setLabel(label) {
    this.label = String(label || '');
    return this;
  }

  setCustomId(customId) {
    this.custom_id = String(customId || '');
    return this;
  }

  setURL(url) {
    this.url = String(url || '');
    return this;
  }

  setEmoji(emoji) {
    this.emoji = emoji;
    return this;
  }

  setDisabled(disabled) {
    this.disabled = !!disabled;
    return this;
  }

  toJSON() {
    const out = { type: 2, style: this.style, label: this.label, disabled: this.disabled };
    if (this.style === 5) {
      if (!this.url) throw new Error('Link buttons need a URL');
      out.url = this.url;
    } else {
      if (!this.custom_id) throw new Error('Buttons need a custom_id');
      out.custom_id = this.custom_id;
    }
    if (this.emoji) out.emoji = this.emoji;
    return out;
  }
}

class SelectMenu {
  constructor() {
    this.custom_id = undefined;
    this.options = [];
    this.placeholder = undefined;
    this.min_values = 0;
    this.max_values = 1;
    this.disabled = false;
  }

  setCustomId(customId) {
    this.custom_id = String(customId || '');
    return this;
  }

  setPlaceholder(placeholder) {
    this.placeholder = String(placeholder || '');
    return this;
  }

  setMinValues(n) {
    this.min_values = n;
    return this;
  }

  setMaxValues(n) {
    this.max_values = n;
    return this;
  }

  setDisabled(disabled) {
    this.disabled = !!disabled;
    return this;
  }

  addOption(option) {
    if (this.options.length >= 25) {
      throw new Error('Select menus can hold at most 25 options');
    }
    if (!option.value) throw new Error('Select menu options need a value');
    this.options.push({
      label: String(option.label || option.value),
      value: String(option.value),
      description: option.description !== undefined ? String(option.description) : undefined,
      emoji: option.emoji,
      default: !!option.default
    });
    return this;
  }

  toJSON() {
    if (!this.custom_id) throw new Error('Select menus need a custom_id');
    const out = {
      type: 3,
      custom_id: this.custom_id,
      options: this.options.map((o) => {
        const clean = { label: o.label, value: o.value };
        if (o.description !== undefined) clean.description = o.description;
        if (o.emoji) clean.emoji = o.emoji;
        if (o.default) clean.default = true;
        return clean;
      }),
      min_values: this.min_values,
      max_values: this.max_values,
      disabled: this.disabled
    };
    if (this.placeholder) out.placeholder = this.placeholder;
    return out;
  }
}

class TextInput {
  constructor() {
    this.custom_id = undefined;
    this.label = '';
    this.style = 1;
    this.placeholder = undefined;
    this.value = undefined;
    this.min_length = undefined;
    this.max_length = undefined;
    this.required = false;
  }

  setCustomId(customId) {
    this.custom_id = String(customId || '');
    return this;
  }

  setLabel(label) {
    this.label = String(label || '');
    return this;
  }

  setStyle(style) {
    this.style = style; // 1 = short, 2 = paragraph
    return this;
  }

  setPlaceholder(placeholder) {
    this.placeholder = String(placeholder || '');
    return this;
  }

  setValue(value) {
    this.value = String(value || '');
    return this;
  }

  setMinLength(n) {
    this.min_length = n;
    return this;
  }

  setMaxLength(n) {
    this.max_length = n;
    return this;
  }

  setRequired(required) {
    this.required = !!required;
    return this;
  }

  toJSON() {
    if (!this.custom_id) throw new Error('Text inputs need a custom_id');
    const out = { type: 4, custom_id: this.custom_id, label: this.label, style: this.style, required: this.required };
    if (this.placeholder) out.placeholder = this.placeholder;
    if (this.value) out.value = this.value;
    if (this.min_length !== undefined) out.min_length = this.min_length;
    if (this.max_length !== undefined) out.max_length = this.max_length;
    return out;
  }
}

class Modal {
  constructor() {
    this.custom_id = undefined;
    this.title = '';
    this.components = [];
  }

  setCustomId(customId) {
    this.custom_id = String(customId || '');
    return this;
  }

  setTitle(title) {
    this.title = String(title || '');
    return this;
  }

  addComponent(component) {
    this.components.push(component);
    return this;
  }

  toJSON() {
    if (!this.custom_id) throw new Error('Modals need a custom_id');
    return {
      custom_id: this.custom_id,
      title: this.title,
      components: this.components.map((c) => (c && typeof c.toJSON === 'function' ? c.toJSON() : c))
    };
  }
}

module.exports = {
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
};
