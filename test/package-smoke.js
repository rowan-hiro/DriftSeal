'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-package-smoke-'));
const packDirectory = path.join(temporary, 'pack');
const consumer = path.join(temporary, 'consumer');

function npmCli() {
  const npmJs = process.env.npm_execpath;
  assert.equal(typeof npmJs, 'string', 'package smoke expects to run under npm (npm_execpath)');
  assert.notEqual(npmJs, '', 'package smoke expects to run under npm (npm_execpath)');
  assert.match(path.basename(npmJs), /\.js$/i, 'npm_execpath must be the JavaScript CLI');
  assert.equal(fs.existsSync(npmJs), true, `npm_execpath exists: ${npmJs}`);
  return npmJs;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli(), ...args], options);
}

function leftoverRebuildFiles(outcomeDir) {
  return fs
    .readdirSync(outcomeDir)
    .filter(
      (name) =>
        name.startsWith('..outcome-index.sqlite.') && name.endsWith('.tmp')
    );
}

function assertValidRebuiltIndex(indexFile, outcomeDir, runtime) {
  assert.equal(fs.existsSync(indexFile), true, 'rebuilt SQLite index exists');
  const raw = fs.readFileSync(indexFile);
  assert.notEqual(raw.toString('utf8'), 'corrupt package smoke index');
  assert.equal(raw.subarray(0, 16).toString(), 'SQLite format 3\0');

  const leftovers = leftoverRebuildFiles(outcomeDir);
  assert.deepEqual(leftovers, [], `temporary rebuild files remain: ${leftovers.join(', ')}`);

  const DatabaseSync = runtime.getDatabaseSync();
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try {
    assert.equal(
      Number(db.prepare('PRAGMA user_version').get().user_version),
      runtime.INDEX_SCHEMA_VERSION
    );
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const outcomes = db
      .prepare('SELECT id, ordinal, lane, status FROM outcomes ORDER BY ordinal')
      .all();
    assert.equal(outcomes.length, 1);
    assert.equal(typeof outcomes[0].id, 'string');
    assert.notEqual(outcomes[0].id, '');
    assert.equal(Number(outcomes[0].ordinal), 0);
    assert.equal(outcomes[0].lane, 'main');
    assert.equal(outcomes[0].status, 'abandoned');
  } finally {
    db.close();
  }
}

try {
  fs.mkdirSync(packDirectory);
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'driftseal-package-smoke', private: true }, null, 2)}\n`
  );
  const packed = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', packDirectory])
  );
  assert.equal(packed.length, 1);
  const tarball = path.join(packDirectory, packed[0].filename);
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
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
  const outcomeDir = path.join(home, 'outcomes');
  const indexFile = path.join(outcomeDir, '.outcome-index.sqlite');
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
  assert.equal(fs.existsSync(indexFile), true);
  fs.writeFileSync(indexFile, 'corrupt package smoke index');
  const rebuilt = run(process.execPath, [cli, 'log', '--last', '1'], {
    cwd: sandbox,
    env,
  });
  assert.match(rebuilt, /packaged sqlite smoke/);
  assertValidRebuiltIndex(indexFile, outcomeDir, {
    INDEX_SCHEMA_VERSION: require(path.join(installed, 'lib', 'outcome-index-sqlite.js'))
      .INDEX_SCHEMA_VERSION,
    getDatabaseSync: require(path.join(installed, 'lib', 'sqlite-runtime.js'))
      .getDatabaseSync,
  });
  process.stdout.write(`package smoke passed: ${packed[0].filename}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
