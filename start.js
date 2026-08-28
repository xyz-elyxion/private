'use strict';

// Private application entry point: the HTTP server and Discord bot run as
// one process instead of being managed as independent applications.
require('./server');

const { start: startBot } = require('./bot');

startBot().catch((err) => {
  console.error('[private] bot failed to start:', err.message);
  console.error('[private] HTTP server remains available; Discord bot is disabled.');
});
