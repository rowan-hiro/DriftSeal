'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-package-smoke-'));
const packDirectory = path.join(temporary, 'pack');
const consumer = path.join(temporary, 'consumer');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

try {
  fs.mkdirSync(packDirectory);
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'driftseal-package-smoke', private: true }, null, 2)}\n`
  );
  const packed = JSON.parse(
    run(npmCommand, ['pack', '--json', '--pack-destination', packDirectory])
  );
  assert.equal(packed.length, 1);
  const tarball = path.join(packDirectory, packed[0].filename);
  run(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
  });

  const installed = path.join(consumer, 'node_modules', 'driftseal');
  for (const file of [
    'bin/driftseal.js',
    'bin/driftseal-mcp.js',
    'lib/outcome-fold.js',
    'lib/outcome-index-sqlite.js',
    'lib/sqlite-runtime.js',
    'benchmark/recent-log.js',
    'test/package-smoke.js',
  ]) {
    assert.equal(fs.existsSync(path.join(installed, file)), true, `${file} is packaged`);
  }

  const sandbox = path.join(temporary, 'sandbox');
  const home = path.join(sandbox, '.seal');
  fs.mkdirSync(sandbox);
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: home,
    DRIFTSEAL_DECISION_HOME: path.join(home, 'madr'),
  };
  const cli = path.join(installed, 'bin', 'driftseal.js');
  run(process.execPath, [cli, 'begin', 'packaged sqlite smoke'], {
    cwd: sandbox,
    env,
  });
  run(
    process.execPath,
    [cli, 'end', '--status', 'abandoned', '--note', 'packaged smoke'],
    { cwd: sandbox, env }
  );
  const logged = spawnSync(process.execPath, [cli, 'log', '--last', '1'], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(logged.status, 0, logged.stderr);
  assert.match(logged.stdout, /packaged sqlite smoke/);
  assert.doesNotMatch(logged.stderr, /SQLite is an experimental feature/);
  assert.equal(
    fs.existsSync(path.join(home, 'outcomes', '.outcome-index.sqlite')),
    true
  );
  fs.writeFileSync(
    path.join(home, 'outcomes', '.outcome-index.sqlite'),
    'corrupt package smoke index'
  );
  const rebuilt = run(process.execPath, [cli, 'log', '--last', '1'], {
    cwd: sandbox,
    env,
  });
  assert.match(rebuilt, /packaged sqlite smoke/);
  process.stdout.write(`package smoke passed: ${packed[0].filename}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
