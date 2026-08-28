'use strict';

// Private application entry point: the HTTP server and Discord bot run as
// one process instead of being managed as independent applications.
require('./server');

let botModule;
try {
  botModule = require('./bot');
} catch (err) {
  console.error('[private] Discord bot could not load:', err.message);
  console.error('[private] HTTP server remains available; Discord bot is disabled.');
}

if (botModule && botModule.start) {
  botModule.start().catch((err) => {
    console.error('[private] bot failed to start:', err.message);
    console.error('[private] HTTP server remains available; Discord bot is disabled.');
  });
}
