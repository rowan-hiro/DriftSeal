'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'driftseal-mcp.js');
const { createApi, runCommand } = require('../bin/driftseal.js');
const { parseArguments } = require('../bin/driftseal-mcp.js');

async function connect(root, env = process.env) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const client = new Client({ name: 'driftseal-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER, '--root', root],
    env,
  });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test('programmatic API returns structured records without changing its fixed root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-api-test-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-api-other-'));
  const api = createApi({ root, isolateStorage: true });

  assert.equal(api.root, fs.realpathSync(root));
  assert.equal(api.status(), null);
  const opened = api.begin({
    intent: 'exercise structured API',
    acceptance: ['the declared command exits successfully'],
    verify: 'true',
  });
  assert.equal(opened.status, 'in_progress');
  assert.equal(opened.intent, 'exercise structured API');
  const verification = api.verify({ allowTrackedCommand: true });
  assert.equal(verification.verification.passed, true);
  const closed = api.end({ status: 'completed', note: 'done', verifyResult: 'passed' });
  assert.equal(closed.status, 'completed');
  assert.equal(api.log().length, 1);
  assert.equal(fs.existsSync(path.join(root, '.intent-log', 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(other, '.intent-log', 'events.jsonl')), false);
  assert.throws(() => createApi({ root: path.join(root, 'missing') }), /does not exist/);
});

test('captured verification output is bounded without changing complete evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-api-bounded-output-'));
  const api = createApi({ root, isolateStorage: true });
  const stdout =
    'stdout-head\n' +
    'x'.repeat(1024 * 1024) +
    'stdout-middle-sentinel' +
    'y'.repeat(1024 * 1024) +
    '\nstdout-tail\n';
  const stderr =
    'stderr-head\n' +
    'a'.repeat(1024 * 1024) +
    'stderr-middle-sentinel' +
    'b'.repeat(1024 * 1024) +
    '\nstderr-tail\n';
  const script =
    "process.stdout.write('stdout-head\\n'+'x'.repeat(1048576)+'stdout-'+'middle-sentinel'" +
    "+'y'.repeat(1048576)+'\\nstdout-tail\\n')" +
    ";process.stderr.write('stderr-head\\n'+'a'.repeat(1048576)+'stderr-'+'middle-sentinel'" +
    "+'b'.repeat(1048576)+'\\nstderr-tail\\n')";

  api.begin({
    intent: 'verify bounded API capture',
    acceptance: ['complete output evidence survives bounded replay capture'],
    verify: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
  });
  const output = runCommand(['verify', '--allow-tracked-command'], {
    root,
    isolateStorage: true,
    capture: true,
  });

  assert.ok(output.stdout.length < 100 * 1024);
  assert.ok(output.stderr.length < 100 * 1024);
  assert.match(output.stdout, /stdout-head/);
  assert.match(output.stdout, /stdout-tail/);
  assert.doesNotMatch(output.stdout, /stdout-middle-sentinel/);
  assert.match(output.stderr, /stderr-head/);
  assert.match(output.stderr, /stderr-tail/);
  assert.doesNotMatch(output.stderr, /stderr-middle-sentinel/);
  assert.match(output.stdout, /captured output truncated/);
  assert.match(output.stderr, /captured output truncated/);
  assert.equal(output.data.verification.stdoutBytes, Buffer.byteLength(stdout));
  assert.equal(output.data.verification.stderrBytes, Buffer.byteLength(stderr));
  assert.equal(
    output.data.verification.outputHash,
    crypto.createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex')
  );
});

test('MCP startup arguments fix one repository root', () => {
  assert.deepEqual(parseArguments([]), { help: false, root: process.cwd() });
  assert.deepEqual(parseArguments(['--root', '/tmp/example']), {
    help: false,
    root: '/tmp/example',
  });
  assert.throws(() => parseArguments(['--root']), /requires a directory/);
  assert.throws(() => parseArguments(['--repository', '/tmp/example']), /unknown argument/);
});

test('stdio MCP exposes the complete v1 workflow, resources, and repository boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-outside-'));
  const incomingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-incoming-'));
  const incomingApi = createApi({ root: incomingRoot, isolateStorage: true });
  const incomingDecision = incomingApi.decisionAdd({
    title: 'Keep incoming lineage context',
    context: 'The incoming worktree made an independent decision.',
    outcome: 'Preserve it while remapping its colliding numeric ID.',
    status: 'proposed',
  });
  incomingApi.begin({
    intent: 'incoming MCP absorb round',
    verify: 'true',
    decisions: [incomingDecision.id],
  });
  incomingApi.decisionUpdate({
    id: incomingDecision.id,
    status: 'accepted',
    note: 'The incoming lineage completed its verification.',
  });
  incomingApi.end({
    status: 'completed',
    note: 'Prepared an independent lineage for MCP absorb coverage.',
    verifyResult: 'passed',
  });
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: outside,
    DRIFTSEAL_DECISION_HOME: path.join(outside, 'decisions'),
  };
  const client = await connect(root, env);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        'driftseal_status',
        'driftseal_begin',
        'driftseal_verify',
        'driftseal_end',
        'driftseal_log',
        'driftseal_absorb',
        'driftseal_reclaim',
        'driftseal_unreclaim',
        'driftseal_decision_list',
        'driftseal_decision_show',
        'driftseal_decision_add',
        'driftseal_decision_update',
      ]
    );
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_status').annotations.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_verify').annotations.destructiveHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_verify').annotations.openWorldHint, true);
    assert.ok(
      tools.tools.find((tool) => tool.name === 'driftseal_verify').inputSchema.properties
        .allowTrackedCommand
    );
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_end').annotations.destructiveHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_absorb').annotations.destructiveHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'driftseal_reclaim').annotations.destructiveHint, true);

    const resources = await client.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      ['driftseal://intent/current', 'driftseal://intents/recent', 'driftseal://decisions']
    );

    const initial = await call(client, 'driftseal_status', { root: outside });
    assert.equal(initial.structuredContent.root, fs.realpathSync(root));
    assert.equal(initial.structuredContent.intent, null);

    const first = await call(client, 'driftseal_begin', {
      intent: 'first MCP round',
      verify: 'true',
    });
    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent.intent.status, 'in_progress');

    const conflict = await call(client, 'driftseal_begin', { intent: 'must not replace first' });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /still in_progress/);

    const abandoned = await call(client, 'driftseal_end', {
      status: 'abandoned',
      note: 'Clearing the test round.',
    });
    assert.equal(abandoned.structuredContent.intent.status, 'abandoned');

    const added = await call(client, 'driftseal_decision_add', {
      title: 'Keep MCP state repository-local',
      context: 'The MCP server is launched for one repository.',
      outcome: 'Ignore storage override environment variables in MCP mode.',
      status: 'proposed',
      options: ['Honor inherited storage overrides', 'Use the fixed repository root'],
      consequences: ['Tool inputs cannot redirect DriftSeal writes.'],
    });
    assert.equal(added.structuredContent.decision.id, '0001');
    assert.equal(added.structuredContent.decision.status, 'proposed');

    const listed = await call(client, 'driftseal_decision_list', { status: 'proposed' });
    assert.equal(listed.structuredContent.decisions.length, 1);
    const shown = await call(client, 'driftseal_decision_show', { id: '1' });
    assert.match(shown.structuredContent.decision.content, /Keep MCP state repository-local/);

    const linked = await call(client, 'driftseal_begin', {
      intent: 'reconcile MCP boundary decision',
      acceptance: ['the fixed-root workflow passes its declared check'],
      verify: 'true',
      decisions: ['1'],
    });
    assert.deepEqual(linked.structuredContent.intent.decisions, ['0001']);

    const updated = await call(client, 'driftseal_decision_update', {
      id: '1',
      status: 'accepted',
      note: 'The fixed-root boundary passed the MCP integration test.',
    });
    assert.equal(updated.structuredContent.decision.status, 'accepted');

    const verified = await call(client, 'driftseal_verify', { allowTrackedCommand: true });
    assert.equal(verified.isError, undefined);
    assert.equal(verified.structuredContent.verification.passed, true);

    const completed = await call(client, 'driftseal_end', {
      status: 'completed',
      note: 'Exercised the linked decision workflow.',
      verifyResult: 'MCP integration assertions passed.',
    });
    assert.equal(completed.structuredContent.intent.status, 'completed');

    const history = await call(client, 'driftseal_log', { last: 10 });
    assert.equal(history.structuredContent.intents.length, 2);

    const noReason = await call(client, 'driftseal_reclaim', { ids: ['x'] });
    assert.equal(noReason.isError, true);

    const reclaimed = await call(client, 'driftseal_reclaim', {
      ids: [abandoned.structuredContent.intent.id],
      reason: 'Clearing round was test scaffolding, not project signal.',
    });
    assert.equal(reclaimed.isError, undefined);
    assert.equal(reclaimed.structuredContent.intents[0].reclaimed, true);
    assert.equal(
      reclaimed.structuredContent.intents[0].reclaimReason,
      'Clearing round was test scaffolding, not project signal.'
    );

    const filtered = await call(client, 'driftseal_log', { last: 10 });
    assert.equal(filtered.structuredContent.intents.length, 1);
    const unfiltered = await call(client, 'driftseal_log', { last: 10, includeReclaimed: true });
    assert.equal(unfiltered.structuredContent.intents.length, 2);

    const restored = await call(client, 'driftseal_unreclaim', {
      id: abandoned.structuredContent.intent.id,
      reason: 'Kept for the integration test record.',
    });
    assert.equal(restored.structuredContent.intent.reclaimed, false);
    const restoredHistory = await call(client, 'driftseal_log', { last: 10 });
    assert.equal(restoredHistory.structuredContent.intents.length, 2);

    const absorbInput = {
      otherLog: path.join(incomingRoot, '.intent-log', 'events.jsonl'),
      otherDecisions: path.join(incomingRoot, '.decision-log'),
    };
    const absorbDryRun = await call(client, 'driftseal_absorb', {
      ...absorbInput,
      dryRun: true,
    });
    assert.equal(absorbDryRun.isError, undefined);
    assert.equal(absorbDryRun.structuredContent.result.mappings.length, 2);
    assert.equal((await call(client, 'driftseal_log', { last: 10 })).structuredContent.intents.length, 2);

    const absorbed = await call(client, 'driftseal_absorb', absorbInput);
    assert.equal(absorbed.isError, undefined);
    assert.equal(absorbed.structuredContent.root, fs.realpathSync(root));
    assert.deepEqual(
      absorbed.structuredContent.result.mappings.map((mapping) => mapping.kind).sort(),
      ['decision', 'intent']
    );
    assert.equal(absorbed.structuredContent.result.exitCode, 0);
    assert.equal((await call(client, 'driftseal_log', { last: 10 })).structuredContent.intents.length, 3);
    assert.equal(
      fs.readdirSync(path.join(root, '.decision-log')).some((file) => /^0002-/.test(file)),
      true
    );

    const currentResource = await client.readResource({ uri: 'driftseal://intent/current' });
    assert.equal(JSON.parse(currentResource.contents[0].text).intent, null);

    assert.equal(fs.existsSync(path.join(root, '.intent-log', 'events.jsonl')), true);
    assert.equal(fs.existsSync(path.join(root, '.decision-log', '0001-keep-mcp-state-repository-local.md')), true);
    assert.equal(fs.existsSync(path.join(outside, 'events.jsonl')), false);
    assert.equal(fs.existsSync(path.join(outside, 'decisions')), false);
  } finally {
    await client.close();
  }
});

function holdLogLock(root) {
  const lock = path.join(root, '.intent-log', '.driftseal.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  return lock;
}

const READ_ONLY_ENV = {
  ...process.env,
  _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50',
};

test('MCP status and log surface a degraded read-only snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-readonly-'));
  const setup = createApi({ root, isolateStorage: true });
  setup.begin({ intent: 'MCP round behind a held lock', verify: 'true' });
  holdLogLock(root);
  const client = await connect(root, READ_ONLY_ENV);

  try {
    const status = await call(client, 'driftseal_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.readOnly, true);
    assert.equal(status.structuredContent.intent.status, 'in_progress');
    assert.equal(status.structuredContent.intent.readOnly, true);
    assert.match(status.content[0].text, /read-only/);

    const log = await call(client, 'driftseal_log', { last: 10 });
    assert.equal(log.isError, undefined);
    assert.equal(log.structuredContent.readOnly, true);
    assert.equal(log.structuredContent.intents.length, 1);
    assert.match(log.content[0].text, /read-only/);
  } finally {
    await client.close();
  }
});

test('MCP status with no open intent still reports a degraded snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-readonly-empty-'));
  holdLogLock(root);
  const client = await connect(root, READ_ONLY_ENV);

  try {
    const status = await call(client, 'driftseal_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.intent, null);
    assert.equal(status.structuredContent.readOnly, true);
    assert.match(status.content[0].text, /No DriftSeal intent is in progress/);
    assert.match(status.content[0].text, /read-only/);
  } finally {
    await client.close();
  }
});

test('MCP driftseal_log coerces a non-string head to null without a schema error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-corrupt-head-'));
  const api = createApi({ root, isolateStorage: true });
  api.begin({ intent: 'round whose head is corrupted on disk', verify: 'true' });
  api.end({ status: 'completed', note: 'done', verifyResult: 'ok' });

  const file = path.join(root, '.intent-log', 'events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  events.find((event) => event.type === 'begin').head = {};
  events.find((event) => event.type === 'end').head = 42;
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const client = await connect(root);
  try {
    const log = await call(client, 'driftseal_log', { last: 10 });
    assert.equal(log.isError, undefined);
    assert.equal(log.structuredContent.intents.length, 1);
    assert.equal(log.structuredContent.intents[0].beginHead, null);
    assert.equal(log.structuredContent.intents[0].endHead, null);

    const status = await call(client, 'driftseal_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.intent, null);
  } finally {
    await client.close();
  }
});

test('MCP status accepts a verification record with a null exit code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-null-exit-'));
  const api = createApi({ root, isolateStorage: true });
  api.begin({
    intent: 'round interrupted by a signal',
    acceptance: ['the verifier result remains inspectable'],
    verify: 'true',
  });
  api.verify({ allowTrackedCommand: true });

  const file = path.join(root, '.intent-log', 'events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const verification = events.find((event) => event.type === 'verify');
  verification.exitCode = null;
  verification.signal = 'SIGTERM';
  verification.passed = false;
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const client = await connect(root);
  try {
    const status = await call(client, 'driftseal_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.intent.verification.exitCode, null);
    assert.equal(status.structuredContent.intent.verification.signal, 'SIGTERM');
  } finally {
    await client.close();
  }
});
