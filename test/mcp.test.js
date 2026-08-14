'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'driftseal-mcp.js');
const { createApi } = require('../bin/driftseal.js');
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
  const opened = api.begin({ intent: 'exercise structured API', verify: 'true' });
  assert.equal(opened.status, 'in_progress');
  assert.equal(opened.intent, 'exercise structured API');
  const closed = api.end({ status: 'completed', note: 'done', verifyResult: 'passed' });
  assert.equal(closed.status, 'completed');
  assert.equal(api.log().length, 1);
  assert.equal(fs.existsSync(path.join(root, '.intent-log', 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(other, '.intent-log', 'events.jsonl')), false);
  assert.throws(() => createApi({ root: path.join(root, 'missing') }), /does not exist/);
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
