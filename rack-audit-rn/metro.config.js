const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Vercel's build container hangs indefinitely at "Starting Metro Bundler"
// when Metro tries to spin up its worker_threads/child_process transform
// pool (reproduced 4x in a row, always at the exact same point, regardless
// of expo web output mode) — forcing a single in-process worker avoids the
// pool entirely and lets the build actually run to completion there.
config.maxWorkers = 1;

module.exports = config;
