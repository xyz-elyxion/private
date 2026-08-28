// Elyxion Discord Framework — Collection
// ---------------------------------------------------------------
// A Map subclass with the collection helpers you'd expect from a
// Discord library (find, filter, map, sort, random, ...). Used for
// cached and fetched entities: bot.cache.guilds, fetchBans(), etc.
'use strict';

class Collection extends Map {
  constructor(entries) {
    super(entries || []);
  }

  // First item matching a predicate.
  find(fn) {
    for (const [key, value] of this) {
      if (fn(value, key)) return value;
    }
    return null;
  }

  filter(fn) {
    const out = new Collection();
    for (const [key, value] of this) {
      if (fn(value, key)) out.set(key, value);
    }
    return out;
  }

  map(fn) {
    const out = [];
    for (const [key, value] of this) out.push(fn(value, key));
    return out;
  }

  some(fn) {
    for (const [key, value] of this) {
      if (fn(value, key)) return true;
    }
    return false;
  }

  every(fn) {
    for (const [key, value] of this) {
      if (!fn(value, key)) return false;
    }
    return true;
  }

  reduce(fn, initial) {
    let acc = initial;
    let hasAcc = arguments.length >= 2;
    for (const [key, value] of this) {
      if (!hasAcc) { acc = value; hasAcc = true; continue; }
      acc = fn(acc, value, key);
    }
    return acc;
  }

  toArray() {
    return Array.from(this.values());
  }

  // Array of keys, newest insertion first like discord.js' sweep order.
  keysArray() {
    return Array.from(this.keys());
  }

  at(index) {
    const values = this.toArray();
    if (index < 0) index += values.length;
    return values[index];
  }

  get first() {
    return this.at(0);
  }

  get last() {
    return this.at(-1);
  }

  sortInPlace(comparator) {
    const entries = Array.from(this.entries()).sort((a, b) => comparator(a[1], b[1], a[0], b[0]));
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }

  sorted(comparator) {
    return new Collection(Array.from(this.entries()).sort((a, b) => comparator(a[1], b[1], a[0], b[0])));
  }

  random(count) {
    const values = this.toArray();
    if (count === undefined) {
      return values.length ? values[Math.floor(Math.random() * values.length)] : undefined;
    }
    const pool = values.slice();
    const picked = [];
    while (picked.length < count && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picked;
  }

  concat(other) {
    const out = new Collection(this);
    for (const [k, v] of other) out.set(k, v);
    return out;
  }

  // Remove every entry matching fn; returns count removed.
  sweep(fn) {
    const doomed = [];
    for (const [key, value] of this) {
      if (fn(value, key)) doomed.push(key);
    }
    for (const key of doomed) this.delete(key);
    return doomed.length;
  }
}

module.exports = { Collection };
