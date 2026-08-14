#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createApi, DECISION_STATUSES, END_STATUSES } = require('./driftseal.js');

const SERVER_NAME = 'driftseal';
const SERVER_VERSION = require('../package.json').version;

function parseArguments(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true, root };
    if (argument === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--root requires a directory');
      root = value;
      continue;
    }
    if (argument.startsWith('--root=')) {
      const value = argument.slice('--root='.length);
      if (!value) throw new Error('--root requires a directory');
      root = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { help: false, root };
}

function helpText() {
  return `DriftSeal MCP server

usage:
  driftseal-mcp [--root <repository>]

The server uses stdio transport and fixes all DriftSeal state to the selected
repository. Tool calls cannot select another root.`;
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function success(structuredContent, summary) {
  return {
    structuredContent,
    content: [{ type: 'text', text: summary || jsonText(structuredContent) }],
  };
}

function failure(error) {
  const message = error && error.message ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `DriftSeal rejected the operation: ${message}` }],
  };
}

function guarded(action) {
  try {
    return action();
  } catch (error) {
    return failure(error);
  }
}

function registerTools(server, api, z) {
  const intentRecord = z.object({
    id: z.string(),
    intent: z.string(),
    verify: z.string().nullable(),
    decisions: z.array(z.string()),
    status: z.enum(END_STATUSES).or(z.literal('in_progress')),
    note: z.string().nullable(),
    verifyResult: z.string().nullable(),
    beganAt: z.string(),
    endedAt: z.string().nullable(),
    reclaimed: z.boolean(),
    reclaimReason: z.string().nullable(),
    reclaimedAt: z.string().nullable(),
  });
  const decisionRecord = z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(DECISION_STATUSES),
    file: z.string(),
  });
  const decisionWithContent = decisionRecord.extend({ content: z.string() });
  const absorbResult = z.object({
    mappings: z.array(
      z.object({
        kind: z.enum(['intent', 'decision']),
        from: z.string(),
        to: z.string(),
      })
    ),
    abandoned: z.string().nullable(),
    copies: z.array(z.string()),
    outputFile: z.string(),
    exitCode: z.number().int(),
  });
  const closedStatus = z.enum(END_STATUSES);
  const decisionStatus = z.enum(DECISION_STATUSES);
  const decisionId = z.string().regex(/^\d+$/, 'decision id must contain only digits');
  const nonEmpty = z.string().trim().min(1);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'driftseal_status',
    {
      title: 'Get current DriftSeal intent',
      description:
        'Inspect the one intent currently in progress before repository work or after context loss. Returns null when no intent is open.',
      inputSchema: {},
      outputSchema: { root: z.string(), intent: intentRecord.nullable() },
      annotations: readOnly,
    },
    async () =>
      guarded(() => {
        const intent = api.status();
        return success(
          { root: api.root, intent },
          intent ? `Intent ${intent.id} is ${intent.status}.` : 'No DriftSeal intent is in progress.'
        );
      })
  );

  server.registerTool(
    'driftseal_begin',
    {
      title: 'Begin a DriftSeal intent',
      description:
        'Open one focused work-round intent before making repository changes. Fails if another intent is already open; close it explicitly first.',
      inputSchema: {
        intent: nonEmpty.describe('Outcome this work round will accomplish.'),
        verify: nonEmpty.optional().describe('Exact command or outcome check that will prove completion.'),
        decisions: z
          .array(decisionId)
          .default([])
          .describe('Existing decision IDs this round may change or explicitly confirm.'),
      },
      outputSchema: { root: z.string(), intent: intentRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const intent = api.begin(input);
        return success({ root: api.root, intent }, `Opened DriftSeal intent ${intent.id}.`);
      })
  );

  server.registerTool(
    'driftseal_end',
    {
      title: 'Close a DriftSeal intent',
      description:
        'Close the current work-round intent with an honest terminal status, note, and verification result. Linked decisions must be reconciled before completed or partial closure.',
      inputSchema: {
        id: z.string().optional().describe('Intent ID; omit to close the current open intent.'),
        status: closedStatus.default('completed'),
        note: nonEmpty.optional().describe('What actually happened in the round.'),
        verifyResult: nonEmpty.optional().describe('Concise, honest result of the declared verification.'),
      },
      outputSchema: { root: z.string(), intent: intentRecord },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const intent = api.end(input);
        return success({ root: api.root, intent }, `Closed DriftSeal intent ${intent.id} as ${intent.status}.`);
      })
  );

  server.registerTool(
    'driftseal_log',
    {
      title: 'List DriftSeal intent history',
      description:
        'Review recent or complete DriftSeal intent history to re-anchor work and understand prior outcomes. Reclaimed records are hidden unless includeReclaimed is set.',
      inputSchema: {
        last: z.number().int().positive().max(100).optional(),
        includeReclaimed: z.boolean().default(false),
      },
      outputSchema: { root: z.string(), intents: z.array(intentRecord) },
      annotations: readOnly,
    },
    async (input) =>
      guarded(() => {
        const intents = api.log({ last: input.last, all: input.includeReclaimed });
        return success({ root: api.root, intents }, `Found ${intents.length} DriftSeal intent records.`);
      })
  );

  server.registerTool(
    'driftseal_absorb',
    {
      title: 'Absorb another DriftSeal lineage',
      description:
        'Repair the fixed repository after a merge collision or absorb another worktree\'s intent and decision logs, remapping colliding IDs. Omit otherLog to repair the current repository. This rewrites only the fixed repository; incoming paths are read-only sources.',
      inputSchema: {
        otherLog: z
          .string()
          .optional()
          .describe('Incoming events.jsonl path. Relative paths resolve from the fixed repository.'),
        otherDecisions: z
          .string()
          .optional()
          .describe('Incoming decision directory. Relative paths resolve from the fixed repository.'),
        abandon: z
          .enum(['ours', 'theirs'])
          .optional()
          .describe('Side whose open intent to abandon when both lineages have one in progress.'),
        dryRun: z.boolean().default(false),
      },
      outputSchema: { root: z.string(), result: absorbResult },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const result = api.absorb(input);
        const action = input.dryRun ? 'Absorb dry run' : 'Absorb';
        return success(
          { root: api.root, result },
          `${action} completed with ${result.mappings.length} ID remapping(s).`
        );
      })
  );

  server.registerTool(
    'driftseal_reclaim',
    {
      title: 'Reclaim DriftSeal intent records',
      description:
        'Hide meaningless closed intent records (for example harness- or sandbox-caused failures) by appending reclaim markers. Never deletes log lines. Without ids, reclaims failed/abandoned, decision-unlinked records older than olderThan days.',
      inputSchema: {
        ids: z
          .array(z.string())
          .default([])
          .describe('Intent IDs to reclaim; omit for batch mode by age.'),
        reason: nonEmpty.describe('Why these records are meaningless (required, kept in the log).'),
        olderThan: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Batch mode retention window in days (default 7).'),
        force: z
          .boolean()
          .default(false)
          .describe('Allow reclaiming partial/completed or decision-linked records by explicit id.'),
        dryRun: z.boolean().default(false),
      },
      outputSchema: { root: z.string(), intents: z.array(intentRecord) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const intents = api.reclaim({
          ids: input.ids,
          reason: input.reason,
          olderThan: input.olderThan,
          force: input.force,
          dryRun: input.dryRun,
        });
        return success(
          { root: api.root, intents },
          input.dryRun
            ? `${intents.length} DriftSeal intent records match.`
            : `Reclaimed ${intents.length} DriftSeal intent records.`
        );
      })
  );

  server.registerTool(
    'driftseal_unreclaim',
    {
      title: 'Restore a reclaimed DriftSeal intent record',
      description: 'Restore one reclaimed intent record to the visible log by appending an unreclaim marker.',
      inputSchema: {
        id: z.string(),
        reason: nonEmpty.describe('Why this record is being restored (required, kept in the log).'),
      },
      outputSchema: { root: z.string(), intent: intentRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const intent = api.unreclaim(input);
        return success({ root: api.root, intent }, `Restored DriftSeal intent ${intent.id}.`);
      })
  );

  server.registerTool(
    'driftseal_decision_list',
    {
      title: 'List DriftSeal decisions',
      description:
        'Find MADR decision records, optionally filtered by current status. Use this before showing or linking a decision.',
      inputSchema: {
        status: decisionStatus.optional(),
        last: z.number().int().positive().max(100).optional(),
      },
      outputSchema: { root: z.string(), decisions: z.array(decisionRecord) },
      annotations: readOnly,
    },
    async (input) =>
      guarded(() => {
        const decisions = api.decisionList(input);
        return success({ root: api.root, decisions }, `Found ${decisions.length} DriftSeal decisions.`);
      })
  );

  server.registerTool(
    'driftseal_decision_show',
    {
      title: 'Show a DriftSeal decision',
      description: 'Read one complete MADR decision record by stable numeric ID.',
      inputSchema: { id: decisionId },
      outputSchema: { root: z.string(), decision: decisionWithContent },
      annotations: readOnly,
    },
    async ({ id }) =>
      guarded(() => {
        const decision = api.decisionShow({ id });
        return success({ root: api.root, decision }, `Loaded DriftSeal decision ${decision.id}.`);
      })
  );

  server.registerTool(
    'driftseal_decision_add',
    {
      title: 'Add a DriftSeal decision',
      description:
        'Create a MADR record only for durable rationale, rejected paths, deferred choices, or costly-to-reverse decisions that Git and the intent log cannot recover.',
      inputSchema: {
        title: nonEmpty,
        context: nonEmpty,
        outcome: nonEmpty,
        status: decisionStatus.default('accepted'),
        drivers: z.array(nonEmpty).default([]),
        options: z.array(nonEmpty).default([]),
        consequences: z.array(nonEmpty).default([]),
      },
      outputSchema: { root: z.string(), decision: decisionWithContent },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const decision = api.decisionAdd(input);
        return success({ root: api.root, decision }, `Created DriftSeal decision ${decision.id}.`);
      })
  );

  server.registerTool(
    'driftseal_decision_update',
    {
      title: 'Reconcile a DriftSeal decision',
      description:
        'Reconcile one decision linked to the current open intent, updating or explicitly confirming its status with a history note.',
      inputSchema: {
        id: decisionId,
        status: decisionStatus.optional(),
        note: nonEmpty,
      },
      outputSchema: { root: z.string(), decision: decisionWithContent },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const decision = api.decisionUpdate(input);
        return success({ root: api.root, decision }, `Reconciled DriftSeal decision ${decision.id}.`);
      })
  );
}

function registerResources(server, api) {
  const registerJson = (name, uri, title, description, read) => {
    server.registerResource(
      name,
      uri,
      { title, description, mimeType: 'application/json' },
      async () => {
        const value = read();
        return { contents: [{ uri, mimeType: 'application/json', text: jsonText(value) }] };
      }
    );
  };

  registerJson(
    'current-intent',
    'driftseal://intent/current',
    'Current DriftSeal intent',
    'The work-round intent currently in progress for the fixed repository.',
    () => ({ root: api.root, intent: api.status() })
  );
  registerJson(
    'recent-intents',
    'driftseal://intents/recent',
    'Recent DriftSeal intents',
    'The ten most recent work-round intent records for the fixed repository.',
    () => ({ root: api.root, intents: api.log({ last: 10 }) })
  );
  registerJson(
    'decision-catalog',
    'driftseal://decisions',
    'DriftSeal decision catalog',
    'All MADR decision summaries for the fixed repository.',
    () => ({ root: api.root, decisions: api.decisionList() })
  );
}

async function createServer({ root }) {
  const [{ McpServer }, { StdioServerTransport }, zod] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod'),
  ]);
  const z = zod.z || zod.default || zod;
  const api = createApi({ root: path.resolve(root), isolateStorage: true });
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Use driftseal_status before repository changes or after context loss. Open one focused intent with driftseal_begin before changes, then run the declared verification and close it honestly with driftseal_end. Reconcile every linked decision before completed or partial closure.',
    }
  );
  registerTools(server, api, z);
  registerResources(server, api);
  return { server, transport: new StdioServerTransport(), root: api.root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText() + '\n');
    return;
  }
  const { server, transport } = await createServer(options);
  await server.connect(transport);
}

module.exports = { createServer, helpText, parseArguments, registerResources, registerTools };

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`driftseal-mcp: error: ${message}`);
    process.exitCode = 1;
  });
}
