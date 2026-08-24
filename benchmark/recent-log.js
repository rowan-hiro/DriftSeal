'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { openOutcomeIndex } = require('../lib/outcome-index-sqlite.js');

const DRIFTSEAL = path.join(__dirname, '..', 'bin', 'driftseal.js');
const quick = process.argv.includes('--quick');
const large = process.argv.includes('--large');
const unrelatedOutcomes = large ? 100_000 : quick ? 2_000 : 10_000;
const laneOutcomes = large ? 1_000 : quick ? 20 : 100;
const samples = quick ? 5 : 20;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-recent-log-benchmark-'));
const home = path.join(root, 'seal');
const outcomeDirectory = path.join(home, 'outcomes');
const wal = path.join(outcomeDirectory, 'events.jsonl');
const indexFile = path.join(outcomeDirectory, '.outcome-index.sqlite');
const env = {
  ...process.env,
  DRIFTSEAL_HOME: home,
  DRIFTSEAL_DECISION_HOME: path.join(home, 'madr'),
};

function runCli(args, envOverrides = {}) {
  return execFileSync(process.execPath, [DRIFTSEAL, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function event(type, fields) {
  return {
    logVersion: 2,
    schemaVersion: type === 'lane_add' || fields.lane ? 2 : 1,
    type,
    ...fields,
  };
}

function outcomeEvents(id, outcome, lane, minute) {
  const beganAt = new Date(Date.UTC(2026, 0, 1, 0, minute, 0)).toISOString();
  const endedAt = new Date(Date.UTC(2026, 0, 1, 0, minute, 1)).toISOString();
  return [
    event('begin', {
      id,
      ts: beganAt,
      outcome,
      acceptance: [],
      verify: null,
      decisions: [],
      ...(lane === 'main' ? {} : { lane }),
    }),
    event('end', {
      id,
      ts: endedAt,
      status: 'abandoned',
      note: `closed ${outcome}`,
      verifyResult: null,
      head: null,
    }),
  ];
}

function writeSyntheticWal() {
  fs.mkdirSync(outcomeDirectory, { recursive: true });
  const lines = [];
  let sequence = 1;
  for (let i = 0; i < unrelatedOutcomes; i++) {
    const id = `2026-01-01-${String(sequence++).padStart(6, '0')}`;
    lines.push(...outcomeEvents(id, `unrelated work ${i}`, 'main', i % 1440));
  }
  lines.push(
    event('lane_add', {
      id: 'lane:focus',
      lane: 'focus',
      description: 'Benchmark focus lane',
      ts: '2026-01-02T00:00:00.000Z',
    })
  );
  for (let i = 0; i < laneOutcomes; i++) {
    const id = `2026-01-02-${String(sequence++).padStart(6, '0')}`;
    lines.push(...outcomeEvents(id, `focus work ${i}`, 'focus', i));
  }
  fs.writeFileSync(wal, `${lines.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(outcomeDirectory, '.current-lane'), 'focus\n');
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
    p95: Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2)),
  };
}

function measure(action, count = samples) {
  const durations = [];
  let value;
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    value = action();
    durations.push(performance.now() - started);
  }
  return { ...distribution(durations), value };
}

try {
  writeSyntheticWal();
  const cold = measure(() => runCli(['log', '--last', '3']), 1);
  const hot = measure(() => runCli(['log', '--last', '3']));
  const fullFold = measure(
    () =>
      runCli(['log', '--last', '3'], {
        _DRIFTSEAL_TEST_DISABLE_OUTCOME_INDEX: '1',
      }),
    quick ? 1 : 3
  );
  assert.equal(hot.value, fullFold.value);
  assert.match(hot.value, new RegExp(`focus work ${laneOutcomes - 1}`));
  assert.doesNotMatch(hot.value, /unrelated work/);

  const index = openOutcomeIndex(indexFile, { readOnly: true });
  const direct = measure(() => index.queryRecent('focus', 3));
  const queryPlan = index.explainRecent().map((row) => row.detail);
  index.close();
  assert.equal(direct.value.length, 3);
  assert.ok(
    queryPlan.some((detail) => /outcomes_lane_visible_ordinal/.test(detail)),
    `expected recent query index in plan: ${queryPlan.join('; ')}`
  );

  const nextId = `2026-01-03-${String(unrelatedOutcomes + laneOutcomes + 1).padStart(6, '0')}`;
  fs.appendFileSync(
    wal,
    `${outcomeEvents(nextId, 'incremental focus work', 'focus', 0)
      .map(JSON.stringify)
      .join('\n')}\n`
  );
  const incremental = measure(() => runCli(['log', '--last', '3']), 1);
  assert.match(incremental.value, /incremental focus work/);

  const startup = measure(() =>
    execFileSync(process.execPath, ['-e', ''], {
      cwd: root,
      stdio: 'ignore',
    })
  );
  const stats = {
    mode: large ? 'large' : quick ? 'quick' : 'default',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    outcomes: {
      unrelated: unrelatedOutcomes,
      currentLane: laneOutcomes,
    },
    samples,
    bytes: {
      wal: fs.statSync(wal).size,
      sqlite: fs.statSync(indexFile).size,
    },
    milliseconds: {
      processStartup: { p50: startup.p50, p95: startup.p95 },
      coldBuildAndRecent: { p50: cold.p50, p95: cold.p95 },
      hotRecentCli: { p50: hot.p50, p95: hot.p95 },
      hotRecentQuery: { p50: direct.p50, p95: direct.p95 },
      fullFoldRecent: { p50: fullFold.p50, p95: fullFold.p95 },
      incrementalAndRecent: { p50: incremental.p50, p95: incremental.p95 },
    },
    queryPlan,
  };
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
