// Elyxion Discord Framework — Embed builder
// ---------------------------------------------------------------
// A small builder for Discord embed objects. Emits exactly the JSON
// Discord's REST API accepts, so `embed.toJSON()` can be passed
// straight to sendMessage / editMessage.
'use strict';

const { resolveColor } = require('./util');

const MAX_FIELDS = 25;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FOOTER = 2048;

class Embed {
  constructor(data = {}) {
    this.title = data.title !== undefined ? data.title : undefined;
    this.description = data.description !== undefined ? data.description : undefined;
    this.url = data.url !== undefined ? data.url : undefined;
    this.color = data.color !== undefined ? resolveColor(data.color) : undefined;
    this.timestamp = data.timestamp !== undefined ? data.timestamp : undefined;
    this.fields = (data.fields || []).map((f) => Object.assign({}, f));
    this.author = data.author ? Object.assign({}, data.author) : null;
    this.footer = data.footer ? Object.assign({}, data.footer) : null;
    this.thumbnail = data.thumbnail ? Object.assign({}, data.thumbnail) : null;
    this.image = data.image ? Object.assign({}, data.image) : null;
  }

  setTitle(title) {
    const t = String(title || '');
    if (t.length > MAX_TITLE) throw new Error('Embed title must be ' + MAX_TITLE + ' characters or fewer');
    this.title = t;
    return this;
  }

  setDescription(description) {
    const d = String(description || '');
    if (d.length > MAX_DESCRIPTION) throw new Error('Embed description must be ' + MAX_DESCRIPTION + ' characters or fewer');
    this.description = d;
    return this;
  }

  setURL(url) {
    this.url = String(url || '');
    return this;
  }

  setColor(color) {
    this.color = resolveColor(color);
    return this;
  }

  setTimestamp(date) {
    if (date === undefined || date === null) {
      this.timestamp = new Date().toISOString();
    } else {
      const d = new Date(date);
      this.timestamp = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    return this;
  }

  setAuthor(name, options) {
    options = options || {};
    this.author = {
      name: String(name || ''),
      url: options.url !== undefined ? String(options.url) : undefined,
      icon_url: options.icon_url !== undefined ? String(options.icon_url) : undefined
    };
    return this;
  }

  setFooter(text, iconURL) {
    const t = String(text || '');
    if (t.length > MAX_FOOTER) throw new Error('Embed footer must be ' + MAX_FOOTER + ' characters or fewer');
    this.footer = {
      text: t,
      icon_url: iconURL !== undefined ? String(iconURL) : undefined
    };
    return this;
  }

  setThumbnail(url) {
    this.thumbnail = { url: String(url || '') };
    return this;
  }

  setImage(url) {
    this.image = { url: String(url || '') };
    return this;
  }

  addField(name, value, inline) {
    if (this.fields.length >= MAX_FIELDS) throw new Error('Embeds can have at most ' + MAX_FIELDS + ' fields');
    const n = String(name || '');
    const v = String(value || '');
    if (n.length > MAX_FIELD_NAME) throw new Error('Embed field names must be ' + MAX_FIELD_NAME + ' characters or fewer');
    if (v.length > MAX_FIELD_VALUE) throw new Error('Embed field values must be ' + MAX_FIELD_VALUE + ' characters or fewer');
    this.fields.push({ name: n, value: v, inline: !!inline });
    return this;
  }

  addFields(...fields) {
    for (const f of fields) this.addField(f.name, f.value, f.inline);
    return this;
  }

  toJSON() {
    const out = {};
    if (this.title !== undefined) out.title = this.title;
    if (this.description !== undefined) out.description = this.description;
    if (this.url !== undefined) out.url = this.url;
    if (this.color !== undefined) out.color = this.color;
    if (this.timestamp !== undefined) out.timestamp = this.timestamp;
    if (this.fields.length) out.fields = this.fields;
    if (this.author) out.author = this.author;
    if (this.footer) out.footer = this.footer;
    if (this.thumbnail) out.thumbnail = this.thumbnail;
    if (this.image) out.image = this.image;
    return out;
  }
}

module.exports = { Embed, MAX_FIELDS };
