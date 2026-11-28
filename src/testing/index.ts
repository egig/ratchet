// Test helpers for Ratchet itself and for plugin packages (`@egig/ratchet/testing`). Not loaded by
// any runtime path — import only from test files. `postgres` is a dependency of @egig/ratchet.
export { connectTestDb, testDatabaseUrl } from './db.js';
export type { TestDb } from './db.js';

// The same toolkit every plugin receives as `PluginContext.kit` — for unit-testing plugin code
// without assembling a whole app (`createRatchetApp`).
export { pluginToolkit as testToolkit } from '../plugin/toolkit.js';
