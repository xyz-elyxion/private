'use strict';

// Private application entry point: the HTTP server and Discord bot run as
// one process instead of being managed as independent applications.
const server = require('./server');
const { start: startBot } = require('./bot');

startBot().catch((err) => {
  console.error('[private] bot failed to start:', err.message);
  try { if (server && server.close) server.close(); } catch (_) {}
  process.exit(1);
});
