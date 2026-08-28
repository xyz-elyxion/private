// Elyxion Discord Framework — command registry & parser
// ---------------------------------------------------------------
// Prefix-based commands with typed argument parsing, subcommands,
// permission checks, cooldowns, middleware, and command groups.
'use strict';

const { parseMention, isSnowflake } = require('./util');

// Parses a message body into { name, args, text } when it starts
// with the prefix, otherwise returns null.
function parseCommand(content, prefix) {
  const str = String(content || '');
  const pre = String(prefix === undefined ? '!' : prefix);
  if (!str.startsWith(pre)) return null;

  const rest = str.slice(pre.length).trim();
  if (!rest) return null;

  const m = rest.match(/^(\S+)\s*([\s\S]*)$/);
  const name = (m ? m[1] : rest).toLowerCase();
  const tail = m && m[2] ? m[2].trim() : '';

  return {
    name,
    args: tail ? tail.split(/\s+/).filter(Boolean) : [],
    text: tail,
    raw: str
  };
}

// ---- Typed argument parsing -------------------------------------

const ARG_TYPES = {
  string: {
    coerce: (v) => ({ ok: true, value: v })
  },
  number: {
    coerce: (v) => {
      const n = Number(v);
      return isNaN(n)
        ? { ok: false, reason: 'expected a number, got "' + v + '"' }
        : { ok: true, value: n };
    }
  },
  integer: {
    coerce: (v) => {
      const n = Number(v);
      return isNaN(n) || Math.floor(n) !== n
        ? { ok: false, reason: 'expected a whole number, got "' + v + '"' }
        : { ok: true, value: n };
    }
  },
  boolean: {
    coerce: (v) => {
      const s = String(v).toLowerCase();
      if (/^(true|1|yes|y|on)$/.test(s)) return { ok: true, value: true };
      if (/^(false|0|no|n|off)$/.test(s)) return { ok: true, value: false };
      return { ok: false, reason: 'expected true/false, got "' + v + '"' };
    }
  },
  user: {
    coerce: (v) => {
      const id = parseMention(v) || (isSnowflake(v) ? v : null);
      return id
        ? { ok: true, value: id }
        : { ok: false, reason: 'expected a user mention or id, got "' + v + '"' };
    }
  },
  channel: {
    coerce: (v) => {
      const m = String(v).match(/^<#(\d+)>$/);
      const id = m ? m[1] : (isSnowflake(v) ? v : null);
      return id
        ? { ok: true, value: id }
        : { ok: false, reason: 'expected a channel mention or id, got "' + v + '"' };
    }
  },
  role: {
    coerce: (v) => {
      const m = String(v).match(/^<@&(\d+)>$/);
      const id = m ? m[1] : (isSnowflake(v) ? v : null);
      return id
        ? { ok: true, value: id }
        : { ok: false, reason: 'expected a role mention or id, got "' + v + '"' };
    }
  },
  snowflake: {
    coerce: (v) => (isSnowflake(v)
      ? { ok: true, value: v }
      : { ok: false, reason: 'expected a snowflake id, got "' + v + '"' })
  },
  rest: {
    // handled specially — consumes all remaining arguments
    coerce: (v) => ({ ok: true, value: v })
  }
};

// Parse raw args against a command's `args` spec. Returns
// { options, errors, leftover }. `options` maps arg names to typed
// values; `errors` is a list of human-readable problems.
function parseArgs(command, rawArgs) {
  const errors = [];
  const options = {};
  const rest = (rawArgs || []).slice();
  const specs = (command && command.args) || [];

  for (const raw of specs) {
    const spec = typeof raw === 'string' ? { name: raw, type: 'string' } : raw;
    const name = spec.name || 'arg';

    if (String(spec.type || 'string').toLowerCase() === 'rest') {
      options[name] = rest.join(' ');
      rest.length = 0;
      continue;
    }
    if (rest.length === 0) {
      if (spec.required !== false) errors.push('missing required argument "' + name + '"');
      continue;
    }
    const value = rest.shift();
    const typeName = String(spec.type || 'string').toLowerCase();
    const t = ARG_TYPES[typeName];
    if (!t) {
      errors.push('unknown argument type "' + spec.type + '" for "' + name + '"');
      continue;
    }
    const res = t.coerce(value);
    if (!res.ok) errors.push(res.reason + ' (for "' + name + '")');
    else options[name] = res.value;
  }

  if (command && command.strictArgs && rest.length) {
    errors.push('unexpected extra argument' + (rest.length > 1 ? 's' : '') + ': ' + rest.join(' '));
  }
  return { options, errors, leftover: rest };
}

// ---- Registry ---------------------------------------------------

class CommandRegistry {
  constructor() {
    this._commands = [];
  }

  // register(name, handler, options) or register({ name, handler, ... })
  register(name, handler, options) {
    if (name && typeof name === 'object') {
      options = name;
      name = options.name;
      handler = options.handler || options.run;
    }
    options = options || {};

    if (!name) throw new TypeError('Command needs a name');
    if (typeof handler !== 'function') throw new TypeError('Command "' + name + '" needs a handler function');

    let permissions = options.permissions || [];
    if (!Array.isArray(permissions)) permissions = [permissions];

    const command = {
      name: String(name).toLowerCase(),
      aliases: (options.aliases || []).map((a) => String(a).toLowerCase()),
      description: options.description || '',
      usage: options.usage || String(name),
      cooldown: options.cooldown || 0,
      permissions,
      permissionMessage: options.permissionMessage,
      middleware: options.middleware || [],
      args: options.args || [],
      strictArgs: !!options.strictArgs,
      guildOnly: !!options.guildOnly,
      dmOnly: !!options.dmOnly,
      handler
    };
    this._commands.push(command);
    return command;
  }

  find(content, prefix) {
    const parsed = parseCommand(content, prefix);
    if (!parsed) return null;

    // Candidate paths from longest to shortest so subcommands win:
    // 'admin', 'admin ban', 'admin ban user', ...
    const tokens = parsed.text ? parsed.text.split(/\s+/) : [];
    const candidates = [];
    let path = parsed.name;
    candidates.push(path);
    for (let i = 0; i < tokens.length; i++) {
      path = path + ' ' + tokens[i];
      candidates.push(path);
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
      const cmd = this._findExact(candidates[i]);
      if (!cmd) continue;
      const consumed = i; // tail words consumed by the subcommand path
      const hit = Object.assign({}, parsed, { command: cmd, name: candidates[i] });
      if (consumed > 0) {
        hit.subcommand = candidates[i];
        hit.args = tokens.slice(consumed);
        hit.text = hit.args.join(' ');
      }
      return hit;
    }
    return null;
  }

  _findExact(name) {
    for (const c of this._commands) {
      if (c.name === name || c.aliases.indexOf(name) !== -1) return c;
    }
    return null;
  }

  list() {
    return this._commands.slice();
  }
}

// A named group whose commands are prefixed with the group name and
// inherit shared options (middleware, cooldown, permissions, ...).
class CommandGroup {
  constructor(registry, name, options) {
    if (!registry || typeof registry.register !== 'function') {
      throw new TypeError('CommandGroup needs a CommandRegistry');
    }
    this.registry = registry;
    this.name = String(name).toLowerCase();
    this.options = options || {};
  }

  command(name, handler, options) {
    const merged = Object.assign({}, this.options, options || {});
    return this.registry.register(this.name + ' ' + name, handler, merged);
  }
}

module.exports = { CommandRegistry, CommandGroup, parseCommand, parseArgs, ARG_TYPES };
