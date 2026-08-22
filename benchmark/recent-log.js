'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const DRIFTSEAL = path.join(__dirname, '..', 'bin', 'driftseal.js');
const quick = process.argv.includes('--quick');
const unrelatedOutcomes = quick ? 24 : 300;
const laneOutcomes = quick ? 6 : 30;
const samples = quick ? 3 : 10;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-recent-log-benchmark-'));
const env = {
  ...process.env,
  DRIFTSEAL_HOME: home,
  DRIFTSEAL_DECISION_HOME: path.join(home, 'madr'),
};

function run(args, envOverrides = {}) {
  return execFileSync(process.execPath, [DRIFTSEAL, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function closeOutcome(outcome, note) {
  run(['begin', outcome]);
  run(['end', '--status', 'abandoned', '--note', note]);
}

function measure(command, count = 1, envOverrides = {}) {
  const durations = [];
  let output = '';
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    output = run(command, envOverrides);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return {
    medianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(2)),
    output,
  };
}

try {
  for (let i = 0; i < unrelatedOutcomes; i++) {
    closeOutcome(`unrelated work ${i}`, `unrelated ${i}`);
  }
  run(['lane', 'add', 'focus']);
  run(['lane', 'switch', 'focus']);
  for (let i = 0; i < laneOutcomes; i++) {
    closeOutcome(`focus work ${i}`, `focus ${i}`);
  }

  const indexFile = path.join(home, 'outcomes', '.lane-index.json');
  fs.rmSync(indexFile, { force: true });
  const cold = measure(['log', '--last', '3']);
  const hot = measure(['log', '--last', '3'], samples);
  const legacy = measure(['log', '--last', '3'], samples, {
    _DRIFTSEAL_TEST_DISABLE_RECENT_INDEX: '1',
    _DRIFTSEAL_TEST_FORCE_INDEX_RELINK: '1',
  });
  const full = measure(['log', '--all-lanes'], samples);

  assert.match(hot.output, new RegExp(`focus work ${laneOutcomes - 1}`));
  assert.doesNotMatch(hot.output, /unrelated work/);
  assert.equal(hot.output, legacy.output);
  assert.equal(fs.existsSync(indexFile), true);

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: quick ? 'quick' : 'default',
        outcomes: {
          unrelated: unrelatedOutcomes,
          currentLane: laneOutcomes,
        },
        samples,
        coldRecentLogMs: cold.medianMs,
        hotRecentLogMedianMs: hot.medianMs,
        legacyRecentLogMedianMs: legacy.medianMs,
        recentLogSpeedup: Number((legacy.medianMs / hot.medianMs).toFixed(2)),
        fullAllLanesLogMedianMs: full.medianMs,
      },
      null,
      2
    )}\n`
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
