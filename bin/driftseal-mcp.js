#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createApi, DECISION_STATUSES, END_STATUSES } = require('./driftseal.js');

const SERVER_NAME = 'driftseal';
const SERVER_VERSION = require('../package.json').version;
const READ_ONLY_SUFFIX =
  '(read-only: another mutation holds the lock; this snapshot may be incomplete)';

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
  const verificationRecord = z.object({
    id: z.string(),
    passed: z.boolean(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    outputHash: z.string().regex(/^[a-f0-9]{64}$/),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    workspace: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    head: z.string().nullable(),
    ranAt: z.string(),
  });
  const extensionRecord = z.object({
    extension: z.string(),
    acceptance: z.array(z.string()),
    verify: z.string().nullable(),
    decisions: z.array(z.string()),
    extendedAt: z.string(),
    head: z.string().nullable(),
  });
  const outcomeRecord = z.object({
    id: z.string(),
    outcome: z.string(),
    lane: z.string().optional(),
    extensions: z.array(extensionRecord),
    acceptance: z.array(z.string()),
    verify: z.string().nullable(),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    verification: verificationRecord.nullable(),
    decisions: z.array(z.string()),
    status: z.enum(END_STATUSES).or(z.literal('in_progress')),
    note: z.string().nullable(),
    verifyResult: z.string().nullable(),
    beginHead: z.string().nullable(),
    endHead: z.string().nullable(),
    beganAt: z.string(),
    endedAt: z.string().nullable(),
    reclaimed: z.boolean(),
    reclaimReason: z.string().nullable(),
    reclaimedAt: z.string().nullable(),
    imported: z.object({
      sourceIds: z.array(z.string()),
      sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }).nullable(),
    readOnly: z.boolean().optional(),
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
        kind: z.enum(['outcome', 'decision']),
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
      title: 'Get current DriftSeal outcome',
      description:
        'Inspect the one outcome currently in progress before repository work or after context loss. Returns null when no outcome is open.',
      inputSchema: {},
      outputSchema: {
        root: z.string(),
        outcome: outcomeRecord.nullable(),
        readOnly: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async () =>
      guarded(() => {
        const outcome = api.status();
        const readOnly = api.readOnly;
        const snapshot = outcome && readOnly ? { ...outcome, readOnly: true } : outcome;
        const summary = snapshot
          ? `Outcome ${snapshot.id} is ${snapshot.status}.`
          : 'No DriftSeal outcome is in progress.';
        return success(
          { root: api.root, outcome: snapshot, ...(readOnly ? { readOnly: true } : {}) },
          readOnly ? `${summary} ${READ_ONLY_SUFFIX}` : summary
        );
      })
  );

  server.registerTool(
    'driftseal_begin',
    {
      title: 'Begin a DriftSeal outcome',
      description:
        'Open one coherent delivery outcome before making durable project changes. Fails if another outcome is already open.',
      inputSchema: {
        outcome: nonEmpty.describe('Coherent delivery outcome this work will accomplish.'),
        acceptance: z
          .array(nonEmpty)
          .default([])
          .describe('Observable outcomes that make machine-verified completion meaningful.'),
        verify: nonEmpty.optional().describe('Exact command or outcome check that will prove completion.'),
        decisions: z
          .array(decisionId)
          .default([])
          .describe('Existing decision IDs this round may change or explicitly confirm.'),
      },
      outputSchema: { root: z.string(), outcome: outcomeRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const outcome = api.begin(input);
        return success({ root: api.root, outcome }, `Opened DriftSeal outcome ${outcome.id}.`);
      })
  );

  server.registerTool(
    'driftseal_extend',
    {
      title: 'Extend the current DriftSeal outcome',
      description:
        'Append another scoped step to the same coherent outcome. Added acceptance requires a replacement verifier for the cumulative contract, and every extension invalidates earlier verification.',
      inputSchema: {
        extension: nonEmpty,
        acceptance: z.array(nonEmpty).default([]),
        verify: nonEmpty.optional(),
        decisions: z.array(decisionId).default([]),
      },
      outputSchema: { root: z.string(), outcome: outcomeRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const outcome = api.extend(input);
        return success({ root: api.root, outcome }, `Extended DriftSeal outcome ${outcome.id}.`);
      })
  );

  server.registerTool(
    'driftseal_verify',
    {
      title: 'Run the declared DriftSeal verification',
      description:
        'Execute the current acceptance-bound outcome\'s cumulative verifier and bind evidence to its contract hash and Git-visible workspace. Inspect it with driftseal_status first; provenance-less commands require allowTrackedCommand.',
      inputSchema: {
        allowTrackedCommand: z
          .boolean()
          .default(false)
          .describe(
            'Explicitly allow a command without matching local outcome provenance after inspection.'
          ),
      },
      outputSchema: {
        root: z.string(),
        outcome: outcomeRecord,
        verification: verificationRecord,
        exitCode: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      guarded(() => {
        const result = api.verify({ allowTrackedCommand: input.allowTrackedCommand });
        return success(
          { root: api.root, ...result },
          `Machine verification ${result.verification.passed ? 'passed' : 'failed'} for outcome ${result.outcome.id}.`
        );
      })
  );

  server.registerTool(
    'driftseal_end',
    {
      title: 'Close a DriftSeal outcome',
      description:
        'Close the current outcome honestly. Reconcile linked decisions before final verification; completed acceptance-bound outcomes require fresh contract- and workspace-bound evidence.',
      inputSchema: {
        id: z.string().optional().describe('Outcome ID; omit to close the current open outcome.'),
        status: closedStatus.default('completed'),
        note: nonEmpty.optional().describe('What actually happened in the round.'),
        verifyResult: nonEmpty.optional().describe('Concise, honest result of the declared verification.'),
      },
      outputSchema: { root: z.string(), outcome: outcomeRecord },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const outcome = api.end(input);
        return success({ root: api.root, outcome }, `Closed DriftSeal outcome ${outcome.id} as ${outcome.status}.`);
      })
  );

  server.registerTool(
    'driftseal_log',
    {
      title: 'List DriftSeal outcome history',
      description:
        'Review recent or complete DriftSeal outcome history. Defaults to the current lane. Reclaimed records are hidden unless includeReclaimed is set.',
      inputSchema: {
        last: z.number().int().positive().max(100).optional(),
        includeReclaimed: z.boolean().default(false),
        allLanes: z
          .boolean()
          .default(false)
          .describe('Show outcomes from every lane instead of the current lane.'),
      },
      outputSchema: {
        root: z.string(),
        outcomes: z.array(outcomeRecord),
        readOnly: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async (input) =>
      guarded(() => {
        const outcomes = api.log({
          last: input.last,
          all: input.includeReclaimed,
          allLanes: input.allLanes,
        });
        const readOnly = api.readOnly;
        const summary = `Found ${outcomes.length} DriftSeal outcome records.`;
        return success(
          { root: api.root, outcomes, ...(readOnly ? { readOnly: true } : {}) },
          readOnly ? `${summary} ${READ_ONLY_SUFFIX}` : summary
        );
      })
  );

  const laneRecord = z.object({
    name: z.string(),
    description: z.string().nullable(),
    addedAt: z.string().nullable(),
    inferred: z.boolean().optional(),
    visible: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    current: z.boolean().optional(),
  });

  server.registerTool(
    'driftseal_lane',
    {
      title: 'Show DriftSeal lanes',
      description:
        'List named outcome lanes and the current lane. Re-anchoring and log history follow the current lane.',
      inputSchema: {},
      outputSchema: {
        root: z.string(),
        current: z.string(),
        missingCurrentLane: z.string().nullable().optional(),
        lanes: z.array(laneRecord),
        total: z.number().int().nonnegative(),
        readOnly: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async () =>
      guarded(() => {
        const snapshot = api.lane();
        const readOnly = api.readOnly;
        return success(
          { root: api.root, ...snapshot, ...(readOnly ? { readOnly: true } : {}) },
          `Current DriftSeal lane is ${snapshot.current}.`
        );
      })
  );

  server.registerTool(
    'driftseal_lane_add',
    {
      title: 'Add a DriftSeal lane',
      description:
        'Create a named lane for a long-lived capability. The default lane main always exists.',
      inputSchema: {
        name: nonEmpty.describe('Lane name: a lowercase letter, then letters, digits, or hyphens.'),
        description: nonEmpty.optional(),
      },
      outputSchema: { root: z.string(), name: z.string(), description: z.string().nullable() },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const lane = api.laneAdd({ name: input.name, description: input.description });
        return success({ root: api.root, ...lane }, `Added DriftSeal lane ${lane.name}.`);
      })
  );

  server.registerTool(
    'driftseal_lane_switch',
    {
      title: 'Switch the current DriftSeal lane',
      description:
        'Move this worktree onto an existing lane. Refused while an outcome is open.',
      inputSchema: { name: nonEmpty },
      outputSchema: { root: z.string(), current: z.string() },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const result = api.laneSwitch({ name: input.name });
        return success({ root: api.root, ...result }, `Switched to DriftSeal lane ${result.current}.`);
      })
  );

  server.registerTool(
    'driftseal_lane_assign',
    {
      title: 'Assign a closed outcome to a lane',
      description: 'Move a closed outcome onto an existing lane with an append-only assign event.',
      inputSchema: {
        id: nonEmpty.describe('Closed outcome id.'),
        lane: nonEmpty,
      },
      outputSchema: { root: z.string(), outcome: outcomeRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const outcome = api.laneAssign({ id: input.id, lane: input.lane });
        return success(
          { root: api.root, outcome },
          `Assigned outcome ${outcome.id} to lane ${outcome.lane}.`
        );
      })
  );

  server.registerTool(
    'driftseal_absorb',
    {
      title: 'Absorb another DriftSeal lineage',
      description:
        'Repair the fixed repository after a merge collision or absorb another worktree\'s outcome and MADR logs, remapping colliding IDs.',
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
          .describe('Side whose open outcome to abandon when both lineages have one in progress.'),
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
      title: 'Reclaim DriftSeal outcome records',
      description:
        'Hide meaningless closed outcome records behind append-only markers. Never deletes log lines.',
      inputSchema: {
        ids: z
          .array(z.string())
          .default([])
          .describe('Outcome IDs to reclaim; omit for batch mode by age.'),
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
      outputSchema: { root: z.string(), outcomes: z.array(outcomeRecord) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const outcomes = api.reclaim({
          ids: input.ids,
          reason: input.reason,
          olderThan: input.olderThan,
          force: input.force,
          dryRun: input.dryRun,
        });
        return success(
          { root: api.root, outcomes },
          input.dryRun
            ? `${outcomes.length} DriftSeal outcome records match.`
            : `Reclaimed ${outcomes.length} DriftSeal outcome records.`
        );
      })
  );

  server.registerTool(
    'driftseal_unreclaim',
    {
      title: 'Restore a reclaimed DriftSeal outcome record',
      description: 'Restore one reclaimed outcome record to the visible log by appending an unreclaim marker.',
      inputSchema: {
        id: z.string(),
        reason: nonEmpty.describe('Why this record is being restored (required, kept in the log).'),
      },
      outputSchema: { root: z.string(), outcome: outcomeRecord },
      annotations: localWrite,
    },
    async (input) =>
      guarded(() => {
        const outcome = api.unreclaim(input);
        return success({ root: api.root, outcome }, `Restored DriftSeal outcome ${outcome.id}.`);
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
        'Create a MADR record only for durable rationale, rejected paths, deferred choices, or costly-to-reverse decisions that Git and the outcome log cannot recover.',
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
        'Reconcile one decision linked to the current open outcome, updating or explicitly confirming its status with a history note.',
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

  const migrationPlan = z.object({
    format: z.literal('driftseal-v1-to-v2-plan'),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z.array(z.object({
      outcome: nonEmpty,
      summary: nonEmpty,
      sourceIds: z.array(z.string()).min(1),
    })),
    excluded: z.array(z.object({ sourceId: z.string(), reason: nonEmpty })).default([]),
  });
  const migrationSources = {
    sourceLog: nonEmpty.optional().describe('Path to the v1 events.jsonl source.'),
    sourceDecisions: nonEmpty.optional().describe('Path to the v1 MADR directory.'),
  };
  server.registerTool(
    'driftseal_migration_inspect',
    {
      title: 'Inspect a DriftSeal v1 repository for v2 migration',
      description: 'Read and normalize custom or repository-default v1 logs for model-assisted grouping. The v2 destination is the fixed repository .seal root. Makes no changes.',
      inputSchema: migrationSources,
      outputSchema: { root: z.string(), inspection: z.unknown() },
      annotations: readOnly,
    },
    async (locations) => guarded(() => {
      const inspection = api.migrationInspect(locations);
      return success({ root: api.root, inspection }, `Found ${inspection.records.length} closed v1 intent records.`);
    })
  );
  server.registerTool(
    'driftseal_migration_apply',
    {
      title: 'Stage a validated DriftSeal v1-to-v2 migration',
      description: 'Validate a model-generated ordered grouping plan, create .seal side-by-side, copy MADRs byte-for-byte, and never delete v1 data.',
      inputSchema: { plan: migrationPlan, ...migrationSources },
      outputSchema: { root: z.string(), result: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ plan, ...locations }) => guarded(() => {
      const result = api.migrationApply({ plan, ...locations });
      return success({ root: api.root, result }, 'Staged DriftSeal v2 without deleting v1 data.');
    })
  );
  server.registerTool(
    'driftseal_migration_check',
    {
      title: 'Check a staged DriftSeal v1-to-v2 migration',
      description: 'Validate the staged outcome log and manifest-backed MADRs, then report whether v1 still awaits manual removal.',
      inputSchema: migrationSources,
      outputSchema: { root: z.string(), result: z.unknown() },
      annotations: readOnly,
    },
    async (locations) => guarded(() => {
      const result = api.migrationCheck(locations);
      return success({ root: api.root, result }, result.complete ? 'Migration complete.' : 'Migration valid; v1 remains for user review.');
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
    'current-outcome',
    'driftseal://outcome/current',
    'Current DriftSeal outcome',
    'The delivery outcome currently in progress for the fixed repository.',
    () => ({ root: api.root, outcome: api.status() })
  );
  registerJson(
    'recent-outcomes',
    'driftseal://outcomes/recent',
    'Recent DriftSeal outcomes',
    'The ten most recent outcome records on the current lane.',
    () => ({ root: api.root, outcomes: api.log({ last: 10 }) })
  );
  registerJson(
    'outcome-lanes',
    'driftseal://lanes',
    'DriftSeal outcome lanes',
    'Named lanes that partition outcome history, including the current lane.',
    () => ({ root: api.root, ...api.lane() })
  );
  registerJson(
    'decision-catalog',
    'driftseal://madr',
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
        'Use driftseal_status before durable project changes or after context loss. Open one coherent outcome with driftseal_begin and append same-outcome steps with driftseal_extend. Reconcile linked decisions after the final extension, inspect the cumulative verifier, use driftseal_verify for fresh contract-bound evidence, and close honestly with driftseal_end. Named lanes isolate orthogonal capability history; driftseal_log follows the current lane.',
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
