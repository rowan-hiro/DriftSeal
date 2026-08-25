#!/usr/bin/env node
'use strict';

/**
 * DriftSeal — Seal the outcome. Stop the drift.
 *
 * Outcome-level write-ahead log and MADR decision log for agentic coding sessions.
 *
 * Protocol per work round:
 *   1. driftseal begin "<outcome>" [--accept "<observable result>"] [--verify "<command>"]
 *   2. execute the outcome, using driftseal extend for same-outcome additions
 *   3. driftseal verify   (for acceptance-bound machine evidence)
 *   4. driftseal end [--status ...] [--note ...] [--verify-result ...]
 *
 * Events are appended to an append-only JSONL log (WAL semantics):
 *   { "type": "begin",  "id", "ts", "outcome", "acceptance", "verify" }
 *   { "type": "extend", "id", "ts", "extension", "acceptance", "verify" }
 *   { "type": "verify", "id", "ts", "command", "passed", "workspace" }
 *   { "type": "end",   "id", "ts", "status", "note", "verifyResult" }
 *
 * Seal root: $DRIFTSEAL_HOME, or .seal in cwd.
 * Outcome log: <seal-root>/outcomes/events.jsonl.
 * In a Git worktree, an open outcome is parked in Git metadata until end.
 * MADR records: <seal-root>/madr/.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { isDeepStrictEqual } = require('util');
const { StringDecoder } = require('string_decoder');
const { execFileSync, spawnSync } = require('child_process');
const { version: PACKAGE_VERSION } = require('../package.json');
const { createOutcomeFold } = require('../lib/outcome-fold.js');
const {
  OutcomeIndexError,
  SqliteUnavailableError,
  openOutcomeIndex,
  removeIndexFiles,
  temporaryIndexPath,
} = require('../lib/outcome-index-sqlite.js');
const { assertSupportedNode } = require('../lib/sqlite-runtime.js');

const END_STATUSES = ['completed', 'partial', 'failed', 'abandoned'];
const DECISION_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'deferred',
  'deprecated',
  'superseded',
];
const LOG_VERSION = 2;
const EVENT_SCHEMA_VERSION = 2;
const DEFAULT_WRITE_SCHEMA_VERSION = 1;
const LEGACY_EVENT_SCHEMA_VERSION = 4;
const PROTOCOL_VERSION = '2.1';
const DEFAULT_LOG_LANGUAGE = 'en';
const DEFAULT_LANE = 'main';
const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const IN_PROGRESS_GIT_PATH = 'driftseal-v2-in-progress.jsonl';
const CURRENT_LANE_GIT_PATH = 'driftseal-v2-current-lane';
const LANE_INDEX_GIT_PATH = 'driftseal-v3-outcome-index.sqlite';
const LEGACY_LANE_INDEX_GIT_PATH = 'driftseal-v2-lane-index.json';
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_INIT_STALE_MS = 5 * 1000;
const READ_ONLY_NOTICE = '(read-only: another mutation holds the lock; tail repair skipped)';
const READ_ONLY_LOCK_WAIT_MS = Number(process.env._DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS) || 1500;
const MAX_DECISION_SLUG_LENGTH = 180;
const VERIFICATION_OUTPUT_CHUNK_BYTES = 64 * 1024;
const CAPTURE_OUTPUT_EDGE_CHARACTERS = 32 * 1024;
const CAPTURE_OUTPUT_OMISSION = '\n... [driftseal captured output truncated] ...\n';
const LOCAL_OUTCOME_PROVENANCE_FILE = '.driftseal-local-outcome.json';
const outcomeFoldEngine = createOutcomeFold({
  fail,
  contentHash,
  logVersion: LOG_VERSION,
  defaultLane: DEFAULT_LANE,
});

class DriftSealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriftSealError';
  }
}

/** Thrown by parseArgs on --help/-h; dispatch prints the usage and exits 0. */
class HelpRequested extends DriftSealError {
  constructor(usageKey) {
    super('help requested');
    this.name = 'HelpRequested';
    this.usageKey = usageKey || null;
  }
}

/** Single source of truth for per-command usage lines. */
function usageFor(key) {
  const lines = {
    begin:
      'usage: driftseal begin "<outcome>" [--accept "<observable result>"] [--verify "<command>"] [--decision <id>] [--force]',
    extend:
      'usage: driftseal extend "<same-outcome addition>" [--accept "<observable result>"] [--verify "<command>"] [--decision <id>]',
    verify: 'usage: driftseal verify [--allow-tracked-command]',
    end: 'usage: driftseal end [id] [options]',
    status: 'usage: driftseal status',
    log: 'usage: driftseal log [--last N] [--all] [--all-lanes]',
    lane: 'usage: driftseal lane [add|switch|assign|show] ... (run: driftseal help)',
    'lane add': 'usage: driftseal lane add <name> [--desc "<why this capability exists>"]',
    'lane switch': 'usage: driftseal lane switch <name>',
    'lane assign': 'usage: driftseal lane assign <id> <name>',
    'lane show': 'usage: driftseal lane show [name]',
    reclaim:
      'usage: driftseal reclaim [id ...] --reason "<why>" [--older-than <days>] [--force] [--dry-run]',
    unreclaim: 'usage: driftseal unreclaim <id> --reason "<why>"',
    absorb: absorbUsage(),
    init: 'usage: driftseal init [--lang <tag>] [--local-log]',
    migrate:
      'usage: driftseal migrate v1-to-v2 inspect|apply|check [--source-log <file>] [--source-decisions <dir>] [--destination <dir>] [--plan <file>] [--json]',
    decision: 'usage: driftseal decision add|update|list|show (run: driftseal help)',
    'decision add':
      'usage: driftseal decision add "<title>" --context "..." --outcome "..." [options]',
    'decision update':
      'usage: driftseal decision update <id> [--status <status>] --note "<what changed or was confirmed>"',
    'decision list': 'usage: driftseal decision list [--status STATUS] [--last N | --count]',
    'decision show': 'usage: driftseal decision show <id>',
    hook: hookUsage(),
    'hook install': hookUsage(),
    'hook prompt': hookUsage(),
    'hook stop': hookUsage(),
    mcp: mcpInstallUsage(),
    skill: skillInstallUsage(),
  };
  return lines[key] || null;
}

let activeOutput = null;

function createBoundedOutputCapture() {
  return { head: '', tail: '', length: 0, headComplete: false };
}

function splitsSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function appendBoundedOutput(capture, value) {
  let text = String(value);
  capture.length += text.length;

  if (!capture.headComplete) {
    let take = Math.min(CAPTURE_OUTPUT_EDGE_CHARACTERS - capture.head.length, text.length);
    if (splitsSurrogatePair(text, take)) take -= 1;
    capture.head += text.slice(0, take);
    text = text.slice(take);
    if (text.length > 0) capture.headComplete = true;
  }

  if (text.length === 0) return;
  const combined = capture.tail + text;
  let start = Math.max(0, combined.length - CAPTURE_OUTPUT_EDGE_CHARACTERS);
  if (splitsSurrogatePair(combined, start)) start += 1;
  capture.tail = combined.slice(start);
}

function renderBoundedOutput(capture) {
  if (capture.length === capture.head.length + capture.tail.length) {
    return capture.head + capture.tail;
  }
  return capture.head + CAPTURE_OUTPUT_OMISSION + capture.tail;
}

function captureOutput(stream, value) {
  if (!activeOutput) return false;
  appendBoundedOutput(activeOutput[stream], value);
  return true;
}

function printLine(value = '') {
  const text = String(value);
  if (captureOutput('stdout', text + '\n')) return;
  console.log(text);
}

function printError(value = '') {
  const text = String(value);
  if (captureOutput('stderr', text + '\n')) return;
  console.error(text);
}

function writeOutput(value) {
  const text = String(value);
  if (captureOutput('stdout', text)) return;
  process.stdout.write(text);
}

function writeErrorOutput(value) {
  const text = String(value);
  if (captureOutput('stderr', text)) return;
  process.stderr.write(text);
}

if (process.env._DRIFTSEAL_TEST_UMASK) {
  process.umask(Number.parseInt(process.env._DRIFTSEAL_TEST_UMASK, 8));
}

function sealRoot() {
  return process.env.DRIFTSEAL_HOME || path.join(process.cwd(), '.seal');
}

function logDir() {
  return path.join(sealRoot(), 'outcomes');
}

function logFile() {
  return path.join(logDir(), 'events.jsonl');
}

function decisionDir() {
  return path.join(sealRoot(), 'madr');
}

// isolateStorage clears write-target env vars; detection still sees the inherited v1 homes.
let isolatedV1Detection = null;

function v1HomeEnv() {
  return process.env.DRIFTSEAL_HOME || isolatedV1Detection?.home || null;
}

function v1DecisionHomeEnv() {
  return process.env.DRIFTSEAL_DECISION_HOME || isolatedV1Detection?.decisions || null;
}

// A corrupt log line must not wedge reads; a non-string head degrades to null.
function normalizeHead(value) {
  return typeof value === 'string' ? value : null;
}

function normalizeMadrManifest(value, line) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`invalid migration MADR manifest on log line ${line}`);
  const names = new Set();
  return value.map((entry) => {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name ||
      !entry.name.endsWith('.md') || names.has(entry.name) ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    ) {
      fail(`invalid migration MADR manifest on log line ${line}`);
    }
    names.add(entry.name);
    return { name: entry.name, sha256: entry.sha256, bytes: entry.bytes };
  });
}

function normalizeMigrationSource(value, line) {
  if (value === undefined) return undefined;
  const normalizeLocation = (location) => {
    if (typeof location === 'string' && location.length > 0 && !location.includes('\0')) {
      return location;
    }
    if (
      !location || typeof location !== 'object' || Array.isArray(location) ||
      !['repository', 'absolute'].includes(location.base) ||
      typeof location.path !== 'string' || location.path.length === 0 || location.path.includes('\0') ||
      (location.base === 'repository' && path.isAbsolute(location.path))
    ) {
      fail(`invalid migration source identity on log line ${line}`);
    }
    if (location.base === 'repository' && !pathContains(process.cwd(), path.resolve(process.cwd(), location.path))) {
      fail(`invalid migration source identity on log line ${line}`);
    }
    return { base: location.base, path: location.path };
  };
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.logPresent !== 'boolean'
  ) {
    fail(`invalid migration source identity on log line ${line}`);
  }
  return {
    log: normalizeLocation(value.log),
    decisions: normalizeLocation(value.decisions),
    logPresent: value.logPresent,
  };
}

function laneEventId(name) {
  return `lane:${name}`;
}

function normalizeLaneName(value, { optional = false, line } = {}) {
  const prefix = line === undefined ? '' : ` on log line ${line}`;
  if (value === undefined || value === null || value === '') {
    if (optional) return DEFAULT_LANE;
    fail(`lane name required${prefix}`);
  }
  if (typeof value !== 'string') fail(`invalid lane name${prefix}`);
  const name = value.trim();
  if (!LANE_NAME_RE.test(name)) {
    fail(
      `invalid lane name "${name}"${prefix} (expected a lowercase letter, then up to 62 letters, digits, or hyphens)`
    );
  }
  return name;
}

function normalizeEvent(event, line) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail(`invalid event object on log line ${line}`);
  }
  const logVersion = event.logVersion === undefined ? 1 : event.logVersion;
  if (!Number.isSafeInteger(logVersion) || logVersion < 1 || logVersion > LOG_VERSION) {
    fail(`invalid or unsupported log version on log line ${line}`);
  }
  const supportedSchema = logVersion === LOG_VERSION ? EVENT_SCHEMA_VERSION : LEGACY_EVENT_SCHEMA_VERSION;
  if (
    event.schemaVersion !== undefined &&
    (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1)
  ) {
    fail(`invalid event schema version on log line ${line}`);
  }
  if (event.schemaVersion > supportedSchema) {
    fail(
      `event schema ${event.schemaVersion} requires a newer DriftSeal client (supported: ${supportedSchema})`
    );
  }
  if (typeof event.type !== 'string' || typeof event.id !== 'string' || event.id.length === 0) {
    fail(`invalid event type or outcome id on log line ${line}`);
  }

  if (event.type === 'begin') {
    const outcome = logVersion === LOG_VERSION ? event.outcome : event.intent;
    if (typeof outcome !== 'string' || outcome.trim().length === 0) {
      fail(`invalid begin event on log line ${line}`);
    }
    if (!Array.isArray(event.decisions) && event.decisions !== undefined) {
      fail(`invalid decisions list on log line ${line}`);
    }
    if (!Array.isArray(event.acceptance) && event.acceptance !== undefined) {
      fail(`invalid acceptance list on log line ${line}`);
    }
    const acceptance = event.acceptance || [];
    if (acceptance.some((criterion) => typeof criterion !== 'string' || criterion.trim().length === 0)) {
      fail(`invalid acceptance criterion on log line ${line}`);
    }
    if (acceptance.length > 0 && (typeof event.verify !== 'string' || event.verify.trim().length === 0)) {
      fail(`acceptance-bound intent has no verification command on log line ${line}`);
    }
    const decisions = (event.decisions || []).map(normalizeDecisionId);
    if (new Set(decisions).size !== decisions.length) {
      fail(`duplicate linked decision on log line ${line}`);
    }
    const lane = normalizeLaneName(event.lane, { optional: true, line });
    return { ...event, logVersion, outcome, acceptance, decisions, lane, head: normalizeHead(event.head) };
  }

  if (event.type === 'extend') {
    if (logVersion !== LOG_VERSION || typeof event.extension !== 'string' || event.extension.trim().length === 0) {
      fail(`invalid extend event on log line ${line}`);
    }
    if (!Array.isArray(event.decisions) && event.decisions !== undefined) {
      fail(`invalid extend decisions list on log line ${line}`);
    }
    if (!Array.isArray(event.acceptance) && event.acceptance !== undefined) {
      fail(`invalid extend acceptance list on log line ${line}`);
    }
    const acceptance = event.acceptance || [];
    if (acceptance.some((criterion) => typeof criterion !== 'string' || criterion.trim().length === 0)) {
      fail(`invalid extend acceptance criterion on log line ${line}`);
    }
    if (acceptance.length > 0 && (typeof event.verify !== 'string' || event.verify.trim().length === 0)) {
      fail(`acceptance-extending event has no replacement verification command on log line ${line}`);
    }
    if (event.verify !== null && event.verify !== undefined &&
      (typeof event.verify !== 'string' || event.verify.trim().length === 0)) {
      fail(`invalid extend verification command on log line ${line}`);
    }
    const decisions = (event.decisions || []).map(normalizeDecisionId);
    if (new Set(decisions).size !== decisions.length) {
      fail(`duplicate linked decision on log line ${line}`);
    }
    return { ...event, logVersion, acceptance, decisions, verify: event.verify || null, head: normalizeHead(event.head) };
  }

  if (event.type === 'verify') {
    if (
      typeof event.verificationId !== 'string' ||
      event.verificationId.length === 0 ||
      typeof event.command !== 'string' ||
      event.command.trim().length === 0 ||
      typeof event.passed !== 'boolean' ||
      (event.exitCode !== null && (!Number.isInteger(event.exitCode) || event.exitCode < 0)) ||
      (event.signal !== null && typeof event.signal !== 'string') ||
      !Number.isSafeInteger(event.durationMs) ||
      event.durationMs < 0 ||
      !Number.isSafeInteger(event.stdoutBytes) ||
      event.stdoutBytes < 0 ||
      !Number.isSafeInteger(event.stderrBytes) ||
      event.stderrBytes < 0 ||
      typeof event.outputHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(event.outputHash) ||
      (event.workspace !== null &&
        (typeof event.workspace !== 'string' || !/^[a-f0-9]{64}$/.test(event.workspace))) ||
      (logVersion === LOG_VERSION &&
        (typeof event.contractHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.contractHash))) ||
      event.passed !== (event.exitCode === 0 && event.signal === null)
    ) {
      fail(`invalid verification event on log line ${line}`);
    }
    return { ...event, logVersion, head: normalizeHead(event.head) };
  }

  if (event.type === 'end') {
    if (!END_STATUSES.includes(event.status)) fail(`invalid end event on log line ${line}`);
    if (
      event.verificationId !== undefined &&
      event.verificationId !== null &&
      (typeof event.verificationId !== 'string' || event.verificationId.length === 0)
    ) {
      fail(`invalid end verification id on log line ${line}`);
    }
    if (
      event.workspace !== undefined &&
      event.workspace !== null &&
      (typeof event.workspace !== 'string' || !/^[a-f0-9]{64}$/.test(event.workspace))
    ) {
      fail(`invalid end workspace on log line ${line}`);
    }
    if (logVersion === LOG_VERSION && event.status === 'completed' &&
      (typeof event.contractHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.contractHash))) {
      fail(`completed outcome has no contract hash on log line ${line}`);
    }
    return { ...event, logVersion, head: normalizeHead(event.head) };
  }

  if (event.type === 'import') {
    if (
      logVersion !== LOG_VERSION ||
      typeof event.outcome !== 'string' || event.outcome.trim().length === 0 ||
      !END_STATUSES.includes(event.status) ||
      !Array.isArray(event.sources) || event.sources.length === 0 ||
      !Array.isArray(event.decisions) ||
      typeof event.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(event.sourceFingerprint)
    ) {
      fail(`invalid imported outcome on log line ${line}`);
    }
    const decisions = event.decisions.map(normalizeDecisionId);
    if (new Set(decisions).size !== decisions.length) {
      fail(`duplicate linked decision on log line ${line}`);
    }
    if (event.sources.some((source) => !source || typeof source !== 'object' ||
      typeof source.id !== 'string' || source.id.length === 0)) {
      fail(`invalid imported outcome source on log line ${line}`);
    }
    const lane = normalizeLaneName(event.lane, { optional: true, line });
    return { ...event, logVersion, decisions, lane, head: normalizeHead(event.head) };
  }

  if (event.type === 'migration') {
    if (
      logVersion !== LOG_VERSION ||
      typeof event.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(event.sourceFingerprint) ||
      typeof event.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(event.planDigest) ||
      !Array.isArray(event.excluded)
    ) {
      fail(`invalid migration event on log line ${line}`);
    }
    return {
      ...event,
      logVersion,
      madrManifest: normalizeMadrManifest(event.madrManifest, line),
      source: normalizeMigrationSource(event.source, line),
    };
  }

  if (event.type === 'lane_add') {
    if (logVersion !== LOG_VERSION) fail(`invalid lane add event on log line ${line}`);
    const lane = normalizeLaneName(event.lane, { line });
    if (lane === DEFAULT_LANE) fail(`cannot add the default lane on log line ${line}`);
    if (event.id !== laneEventId(lane)) {
      fail(`lane add id must be ${laneEventId(lane)} on log line ${line}`);
    }
    if (
      event.description !== undefined &&
      event.description !== null &&
      typeof event.description !== 'string'
    ) {
      fail(`invalid lane description on log line ${line}`);
    }
    const description = event.description && event.description.trim().length > 0
      ? event.description.trim()
      : null;
    return { ...event, logVersion, lane, description };
  }

  if (event.type === 'lane_assign') {
    if (logVersion !== LOG_VERSION) fail(`invalid lane assign event on log line ${line}`);
    const lane = normalizeLaneName(event.lane, { line });
    return { ...event, logVersion, lane };
  }

  if (event.type === 'reclaim' || event.type === 'unreclaim') {
    if (typeof event.reason !== 'string' || event.reason.trim().length === 0) {
      fail(`invalid ${event.type} event on log line ${line}`);
    }
    return { ...event, logVersion };
  }

  if (
    event.type === 'decision_reconcile' ||
    event.type === 'decision_reconcile_prepare' ||
    event.type === 'decision_reconcile_commit' ||
    event.type === 'decision_reconcile_abort' ||
    event.type === 'decision_reconcile_cancel'
  ) {
    const schemaVersion = event.schemaVersion || 1;
    const outcomeStatus = logVersion === LOG_VERSION ? event.outcomeStatus : event.intentStatus;
    if (event.type === 'decision_reconcile' &&
      (logVersion === LOG_VERSION || schemaVersion >= 2)) {
      fail(`legacy decision reconciliation is not valid in schema ${schemaVersion} on log line ${line}`);
    }
    if (
      event.type !== 'decision_reconcile' &&
      (typeof event.reconciliationId !== 'string' || event.reconciliationId.length === 0)
    ) {
      fail(`invalid reconciliation id on log line ${line}`);
    }
    const decisionId = normalizeDecisionId(event.decisionId);
    if (
      event.type !== 'decision_reconcile_abort' &&
      event.type !== 'decision_reconcile_cancel' &&
      !DECISION_STATUSES.includes(event.toStatus)
    ) {
      fail(`invalid reconciliation status on log line ${line}`);
    }
    for (const field of ['oldHash', 'newHash', 'fileHash']) {
      if (event[field] !== undefined && !/^[a-f0-9]{64}$/.test(event[field])) {
        fail(`invalid reconciliation ${field} on log line ${line}`);
      }
    }
    if (
      event.type === 'decision_reconcile_prepare' &&
      (!event.oldHash || !event.newHash || !DECISION_STATUSES.includes(event.fromStatus))
    ) {
      fail(`incomplete reconciliation prepare on log line ${line}`);
    }
    if (
      event.type === 'decision_reconcile_commit' &&
      (!event.fileHash || !DECISION_STATUSES.includes(event.fromStatus))
    ) {
      fail(`incomplete reconciliation commit on log line ${line}`);
    }
    if (
      event.type === 'decision_reconcile_cancel' &&
      !['failed', 'abandoned'].includes(outcomeStatus)
    ) {
      fail(`invalid reconciliation cancellation on log line ${line}`);
    }
    return { ...event, logVersion, decisionId, ...(event.type === 'decision_reconcile_cancel' ? { outcomeStatus } : {}) };
  }

  fail(`unknown event type "${event.type}" on log line ${line}`);
}

function gitWorktreeRoot(cwd = process.cwd()) {
  if (!isGitWorkTree(cwd)) return null;
  return gitCapture(['rev-parse', '--show-toplevel'], cwd);
}

function worktreeInProgressFile(cwd = process.cwd()) {
  if (!isGitWorkTree(cwd)) return null;
  const gitPath = gitCapture(['rev-parse', '--git-path', IN_PROGRESS_GIT_PATH], cwd);
  if (!gitPath) return null;
  return path.resolve(cwd, gitPath);
}

function isParkableOutcomeLog() {
  if (process.env.DRIFTSEAL_HOME) return false;
  const root = gitWorktreeRoot();
  if (!root) return false;
  return path.resolve(logFile()) === path.resolve(root, '.seal', 'outcomes', 'events.jsonl');
}

function inProgressFile() {
  if (!isParkableOutcomeLog()) return null;
  return worktreeInProgressFile();
}

function worktreeMetadataFile(gitPath, cwd = process.cwd()) {
  if (!isGitWorkTree(cwd)) return null;
  const resolved = gitCapture(['rev-parse', '--git-path', gitPath], cwd);
  if (!resolved) return null;
  return path.resolve(cwd, resolved);
}

function currentLaneFile() {
  if (isParkableOutcomeLog()) return worktreeMetadataFile(CURRENT_LANE_GIT_PATH);
  return path.join(logDir(), '.current-lane');
}

function laneIndexFile() {
  // Keep the disposable index beside the WAL so agent sandboxes that deny
  // .git writes can still rebuild it inside the workspace.
  return path.join(logDir(), '.outcome-index.sqlite');
}

function retiredGitMetadataIndexFile() {
  if (!isParkableOutcomeLog()) return null;
  return worktreeMetadataFile(LANE_INDEX_GIT_PATH);
}

function legacyLaneIndexFile() {
  if (isParkableOutcomeLog()) return worktreeMetadataFile(LEGACY_LANE_INDEX_GIT_PATH);
  return path.join(logDir(), '.lane-index.json');
}

function emptyLaneCatalog() {
  return outcomeFoldEngine.emptyLaneCatalog();
}

function readCurrentLaneName() {
  const file = currentLaneFile();
  if (!file || !fs.existsSync(file)) return DEFAULT_LANE;
  const name = fs.readFileSync(file, 'utf8').trim();
  if (!name) return DEFAULT_LANE;
  return normalizeLaneName(name);
}

function writeCurrentLaneName(name, { readOnly = false } = {}) {
  if (readOnly) return;
  const file = currentLaneFile();
  if (!file) fail('cannot persist the current lane outside a writable seal');
  ensureDirectoryDurable(path.dirname(file));
  ensureDerivedLaneSidecarIgnore();
  atomicWriteFile(file, `${name}\n`, 0o600);
}

function ensureDerivedLaneSidecarIgnore() {
  if (!isGitWorkTree(logDir())) return;
  const ignoreFile = path.join(logDir(), '.gitignore');
  let current = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  let next = current;
  for (const name of [
    '.current-lane',
    '.lane-index.json',
    '.outcome-index.sqlite',
    '.outcome-index.sqlite-journal',
    '.outcome-index.sqlite-wal',
    '.outcome-index.sqlite-shm',
    '..outcome-index.sqlite.*.tmp',
  ]) {
    const present = next.split(/\r?\n/).some((line) => line.trim() === name);
    if (present) continue;
    if (next && !next.endsWith('\n')) next += '\n';
    next += `${name}\n`;
  }
  if (next === current) return;
  ensureDirectoryDurable(logDir());
  atomicWriteFile(ignoreFile, next, 0o644);
}

function hashFilePrefix(file, length) {
  const hash = crypto.createHash('sha256');
  if (length <= 0) return hash.digest('hex');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, length));
    let position = 0;
    while (position < length) {
      const requested = Math.min(buffer.length, length - position);
      const read = fs.readSync(fd, buffer, 0, requested, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (position !== length) return null;
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function laneIndexSourceIdentity(file, indexedThrough, indexedLines = 0) {
  if (!fs.existsSync(file)) {
    return {
      indexedThrough: 0,
      indexedLines: 0,
      walHash: contentHash(''),
      device: null,
      inode: null,
      mtimeMs: null,
      ctimeMs: null,
    };
  }
  const stat = fs.statSync(file);
  return {
    indexedThrough,
    indexedLines,
    walHash: hashFilePrefix(file, indexedThrough),
    device: Number(stat.dev),
    inode: Number(stat.ino),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function laneIndexMatchesFile(source, file, { exact = false } = {}) {
  if (
    !source ||
    typeof source.walHash !== 'string' ||
    !Number.isSafeInteger(source.indexedLines) ||
    source.indexedLines < 0
  ) {
    return false;
  }
  if (!fs.existsSync(file)) return source.indexedThrough === 0;
  const stat = fs.statSync(file);
  const size = stat.size;
  if (size < source.indexedThrough || (exact && size !== source.indexedThrough)) return false;
  if (
    source.device !== null &&
    source.inode !== null &&
    (Number(stat.dev) !== source.device || Number(stat.ino) !== source.inode)
  ) {
    return false;
  }
  if (
    size === source.indexedThrough &&
    stat.mtimeMs === source.mtimeMs &&
    stat.ctimeMs === source.ctimeMs
  ) {
    return true;
  }
  return hashFilePrefix(file, source.indexedThrough) === source.walHash;
}

function applyFoldEvent(state, ev) {
  return outcomeFoldEngine.applyFoldEvent(state, ev);
}

function consumeLogSlice(file, startByte, onEvent, { repairTail = false, readOnly = false, startLine = 0 } = {}) {
  if (!fs.existsSync(file)) return { endByte: 0, endLine: 0 };
  const fd = fs.openSync(file, 'r');
  let size;
  let buf;
  try {
    size = fs.fstatSync(fd).size;
    if (startByte > size) fail('lane index is ahead of the outcome log');
    if (startByte === size) return { endByte: size, endLine: startLine };
    buf = Buffer.alloc(size - startByte);
    fs.readSync(fd, buf, 0, buf.length, startByte);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (text.length > 0 && !text.endsWith('\n')) {
    const rawLines = text.split('\n');
    const tail = rawLines.at(-1);
    try {
      JSON.parse(tail);
    } catch {
      const validLength = text.lastIndexOf('\n') + 1;
      if (!readOnly) {
        if (!repairTail) fail(`corrupt final log line in ${file}`);
        const truncateTo = startByte + Buffer.byteLength(text.slice(0, validLength), 'utf8');
        const repairFd = fs.openSync(file, 'r+');
        try {
          fs.ftruncateSync(repairFd, truncateTo);
          fs.fsyncSync(repairFd);
        } finally {
          fs.closeSync(repairFd);
        }
      }
      text = text.slice(0, validLength);
    }
  }
  const parts = text.split('\n');
  let pos = startByte;
  let lineNumber = startLine;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (i === parts.length - 1 && line === '') break;
    lineNumber += 1;
    const start = pos;
    pos += Buffer.byteLength(line, 'utf8');
    if (i < parts.length - 1) pos += 1;
    if (line.trim().length === 0) continue;
    try {
      const event = normalizeEvent(JSON.parse(line), lineNumber);
      if (event.logVersion !== LOG_VERSION) {
        fail(`v1 intent log cannot be used as a v2 outcome log; run driftseal migrate v1-to-v2 inspect`);
      }
      onEvent(event, start, pos);
    } catch (err) {
      if (err instanceof DriftSealError || err instanceof OutcomeIndexError) throw err;
      fail(`corrupt log line ${lineNumber} in ${file}`);
    }
  }
  return { endByte: pos, endLine: lineNumber };
}

function replaceOutcomeIndexFile(temporary, target) {
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error && error.code)) throw error;
    removeIndexFiles(target);
    fs.renameSync(temporary, target);
  }
  fs.chmodSync(target, 0o600);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    fs.rmSync(`${target}${suffix}`, { force: true });
  }
  fsyncDirectory(path.dirname(target));
}

function removeLegacyLaneIndex() {
  const legacy = legacyLaneIndexFile();
  if (legacy) fs.rmSync(legacy, { force: true });
  const retired = retiredGitMetadataIndexFile();
  if (retired) removeIndexFiles(retired);
}

function rebuildCommittedOutcomeIndex({ repairTail = false } = {}) {
  const wal = logFile();
  const target = laneIndexFile();
  if (!target) return null;
  ensureDirectoryDurable(path.dirname(target));
  ensureDerivedLaneSidecarIgnore();
  const temporary = temporaryIndexPath(target);
  removeIndexFiles(temporary);
  let index;
  try {
    index = openOutcomeIndex(temporary);
    let slice;
    index.transaction(() => {
      const indexedEvents = [];
      slice = consumeLogSlice(
        wal,
        0,
        (event, startByte, endByte) =>
          indexedEvents.push({ event, startByte, endByte }),
        { repairTail }
      );
      index.replaceFromFoldState(
        outcomeFoldEngine.foldState(indexedEvents.map((item) => item.event)),
        indexedEvents
      );
      index.setSource(
        laneIndexSourceIdentity(wal, slice.endByte, slice.endLine),
        'full'
      );
      index.acceptProjection();
    });
    if (!index.integrityCheck()) fail('rebuilt SQLite outcome index failed integrity check');
    index.close();
    index = null;
    replaceOutcomeIndexFile(temporary, target);
    removeLegacyLaneIndex();
    const reopened = openOutcomeIndex(target);
    reopened.build = 'full';
    return reopened;
  } catch (error) {
    if (index) index.close();
    removeIndexFiles(temporary);
    throw error;
  }
}

function syncCommittedLaneIndex({ repairTail = false, readOnly = false, forceFull = false } = {}) {
  if (process.env._DRIFTSEAL_TEST_DISABLE_OUTCOME_INDEX === '1') return null;
  const wal = logFile();
  const target = laneIndexFile();
  if (!target) return null;
  if (readOnly) {
    if (!fs.existsSync(target)) return null;
    try {
      const index = openOutcomeIndex(target, { readOnly: true });
      if (
        !index.projectionTrusted() ||
        !laneIndexMatchesFile(index.source(), wal, { exact: true })
      ) {
        index.close();
        return null;
      }
      index.build = 'hot';
      return index;
    } catch {
      return null;
    }
  }
  if (forceFull || !fs.existsSync(target)) {
    try {
      return rebuildCommittedOutcomeIndex({ repairTail });
    } catch (error) {
      if (error instanceof SqliteUnavailableError) return null;
      throw error;
    }
  }
  let index;
  try {
    index = openOutcomeIndex(target);
    const source = index.source();
    if (!index.projectionTrusted() || !laneIndexMatchesFile(source, wal)) {
      index.close();
      return rebuildCommittedOutcomeIndex({ repairTail });
    }
    const size = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    if (size === source.indexedThrough) {
      index.build = 'hot';
      removeLegacyLaneIndex();
      return index;
    }
    let slice;
    index.transaction(() => {
      slice = consumeLogSlice(
        wal,
        source.indexedThrough,
        (event, start, end) =>
          index.applyEvent(event, start, end, { applyFoldEvent, defaultLane: DEFAULT_LANE }),
        {
          repairTail,
          startLine: source.indexedLines || 0,
        }
      );
      index.setSource(
        laneIndexSourceIdentity(wal, slice.endByte, slice.endLine),
        'incremental'
      );
      index.acceptProjection();
    });
    index.build = 'incremental';
    removeLegacyLaneIndex();
    return index;
  } catch (error) {
    if (index) index.close();
    if (error instanceof DriftSealError) throw error;
    if (error instanceof SqliteUnavailableError) return null;
    return rebuildCommittedOutcomeIndex({ repairTail });
  }
}

function attachIndexedOverlay(index, committed, plan, { readOnly = false } = {}) {
  const lanes = index.laneCatalog();
  if (!plan || plan.alreadyCommitted || plan.records.length === 0) {
    committed.lanes = lanes;
    return committed;
  }
  if (!readOnly && plan.mappings.length > 0) writeJsonl(plan.park, plan.records);
  const overlay = fold(plan.records.map((record) => record.event));
  for (const record of overlay) {
    let lane = lanes.get(record.lane);
    if (!lane) {
      const foldedLane = overlay.lanes.get(record.lane);
      lane = {
        name: record.lane,
        description: foldedLane ? foldedLane.description : null,
        addedAt: foldedLane ? foldedLane.addedAt : null,
        inferred: foldedLane ? foldedLane.inferred === true : true,
        head: null,
        count: 0,
        visible: 0,
      };
      lanes.set(record.lane, lane);
    }
    lane.count = (lane.count || 0) + 1;
    if (!record.reclaimed) lane.visible = (lane.visible || 0) + 1;
  }
  const records = [...committed, ...overlay];
  records.lanes = lanes;
  return records;
}

function queryOutcomeView(index, park, { repairTail = false, readOnly = false } = {}) {
  const committed = index.queryAll();
  if (!park || !fs.existsSync(park)) {
    committed.lanes = index.laneCatalog();
    return { index: null, records: committed };
  }
  const plan = planIndexedInProgressOverlay(index, park, { repairTail, readOnly });
  if (plan && plan.alreadyCommitted && !readOnly) discardInProgressLog(park);
  return {
    index: null,
    records: attachIndexedOverlay(index, committed, plan, { readOnly }),
  };
}

function recoverableOutcomeIndexError(error) {
  return (
    error instanceof OutcomeIndexError ||
    /^SQLITE_|^ERR_SQLITE_/.test(String(error && error.code))
  );
}

function loadOutcomeView({ repairTail = false, readOnly = false } = {}) {
  const park = inProgressFile();
  let index = syncCommittedLaneIndex({ repairTail, readOnly });
  if (!index) {
    const records = fold(readEvents({ repairTail, readOnly }));
    return { index: null, records };
  }
  try {
    return queryOutcomeView(index, park, { repairTail, readOnly });
  } catch (error) {
    index.close();
    index = null;
    if (readOnly && (error.code === 'ENOENT' || recoverableOutcomeIndexError(error))) {
      return { index: null, records: fold(readEvents({ repairTail, readOnly })) };
    }
    if (!recoverableOutcomeIndexError(error)) throw error;
    index = syncCommittedLaneIndex({ repairTail, forceFull: true });
    if (!index) return { index: null, records: fold(readEvents({ repairTail })) };
    return queryOutcomeView(index, park, { repairTail });
  } finally {
    if (index) index.close();
  }
}

function laneSummary(records, name) {
  const lanes = records.lanes || emptyLaneCatalog();
  const lane = lanes.get(name);
  const members = records.filter((record) => (record.lane || DEFAULT_LANE) === name);
  const visible = members.filter((record) => !record.reclaimed);
  return {
    name,
    description: lane ? lane.description : null,
    addedAt: lane ? lane.addedAt : null,
    inferred: Boolean(lane && lane.inferred),
    visible: visible.length,
    count: members.length,
  };
}

function publicLane(summary) {
  return {
    name: summary.name,
    description: summary.description,
    addedAt: summary.addedAt || null,
    inferred: summary.inferred === true,
    visible: summary.visible,
    count: summary.count,
  };
}

function resolveCurrentLane(records, { required = false } = {}) {
  const requested = readCurrentLaneName();
  const lanes = records.lanes || emptyLaneCatalog();
  if (lanes.has(requested)) return { current: requested, missing: null };
  if (required) {
    fail(`current lane ${requested} does not exist; switch to ${DEFAULT_LANE} or add it`);
  }
  return { current: DEFAULT_LANE, missing: requested };
}

function currentLaneOrFail(records) {
  return resolveCurrentLane(records, { required: true }).current;
}

function warnMissingCurrentLane(missing) {
  if (!missing) return;
  printLine(`warning: current lane ${missing} does not exist; showing ${DEFAULT_LANE}`);
}

function renderLaneLine(records, name) {
  const summary = laneSummary(records, name);
  return `lane: ${name} (${summary.visible} visible / ${summary.count} in lane)`;
}

function selectLaneLogRecords(records, current) {
  return records.filter(
    (record) => (record.lane || DEFAULT_LANE) === current || record.status === 'in_progress'
  );
}

function selectLastLogRecords(records, current, n) {
  const inLane = records.filter((record) => (record.lane || DEFAULT_LANE) === current);
  const clipped = inLane.slice(-n);
  const kept = new Set(clipped.map((record) => record.id));
  const extras = records.filter((record) => record.status === 'in_progress' && !kept.has(record.id));
  if (extras.length === 0) return clipped;
  const order = new Map(records.map((record, index) => [record.id, index]));
  return [...clipped, ...extras].sort((left, right) => order.get(left.id) - order.get(right.id));
}

function indexedLaneSummary(state, name) {
  const lane = state.lanes.get(name);
  return {
    name,
    description: lane ? lane.description : null,
    addedAt: lane ? lane.addedAt : null,
    inferred: Boolean(lane && lane.inferred),
    visible: lane ? lane.visible : 0,
    count: lane ? lane.count : 0,
  };
}

function tryLoadRecentOutcomeView(n, { includeReclaimed = false, repairTail = false, readOnly = false } = {}) {
  const park = inProgressFile();
  let index = syncCommittedLaneIndex({ repairTail, readOnly });
  if (!index) return null;
  const query = () => {
    const plan =
      park && fs.existsSync(park)
        ? planIndexedInProgressOverlay(index, park, { repairTail, readOnly })
        : null;
    if (plan && plan.alreadyCommitted && !readOnly) discardInProgressLog(park);
    const overlayView = attachIndexedOverlay(index, [], plan, { readOnly });
    const state = { lanes: overlayView.lanes };
    const { current, missing } = resolveCurrentLane(state);
    const committed = index.queryRecent(current, n, { includeReclaimed });
    const records = selectLastLogRecords(
      [...committed, ...overlayView],
      current,
      n
    );
    return { state, records, current, missing };
  };
  try {
    return query();
  } catch (error) {
    if (readOnly && error && error.code === 'ENOENT') return null;
    index.close();
    index = null;
    if (readOnly) return null;
    index = syncCommittedLaneIndex({ repairTail, forceFull: true });
    return query();
  } finally {
    if (index) index.close();
  }
}

function liveWorktreeOutcomeLog() {
  const root = gitWorktreeRoot();
  if (!root) return null;
  return path.resolve(root, '.seal', 'outcomes', 'events.jsonl');
}

function sameResolvedPath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function shouldAttachInProgress(file) {
  if (process.env.DRIFTSEAL_HOME) return false;
  const live = liveWorktreeOutcomeLog();
  return live !== null && sameResolvedPath(file, live);
}

function readJsonlRecordsFromFile(file, { repairTail = false, readOnly = false } = {}) {
  if (!fs.existsSync(file)) return [];
  if (
    readOnly &&
    process.env._DRIFTSEAL_TEST_UNLINK_PARK_BEFORE_READ === '1' &&
    path.basename(file) === IN_PROGRESS_GIT_PATH
  ) {
    // Simulate a writer flushing and unlinking the park between the existence
    // check and the read; the next attempt sees the park as absent.
    fs.unlinkSync(file);
  }
  let content = fs.readFileSync(file, 'utf8');
  const rawLines = content.split('\n');
  if (content.length > 0 && !content.endsWith('\n')) {
    const tail = rawLines.at(-1);
    try {
      JSON.parse(tail);
    } catch {
      const validLength = content.lastIndexOf('\n') + 1;
      if (!readOnly) {
        if (!repairTail) fail(`corrupt final log line in ${file}`);
        const fd = fs.openSync(file, 'r+');
        try {
          fs.ftruncateSync(fd, Buffer.byteLength(content.slice(0, validLength), 'utf8'));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      content = content.slice(0, validLength);
    }
  }
  return parseJsonlRecords(content, file);
}

/**
 * True when the parked records already sit in the committed log. A flush appends them, so
 * they land as a suffix; a merge that appends afterwards leaves them as an interior run.
 */
function overlayIsCommitted(committedEvents, overlayEvents) {
  if (overlayEvents.length === 0 || committedEvents.length < overlayEvents.length) return false;
  const head = overlayEvents[0];
  for (let start = committedEvents.length - overlayEvents.length; start >= 0; start--) {
    const candidate = committedEvents[start];
    if (candidate.type !== head.type || candidate.id !== head.id || candidate.ts !== head.ts) continue;
    const matches = overlayEvents.every((event, index) =>
      isDeepStrictEqual(committedEvents[start + index], event)
    );
    if (matches) return true;
  }
  return false;
}

/** How a parked overlay lines up with the committed log; touches neither file. */
function planInProgressOverlay(committedEvents, park, { repairTail = false, readOnly = false } = {}) {
  if (!park || !fs.existsSync(park)) return null;
  const overlayRecords = readJsonlRecordsFromFile(park, { repairTail, readOnly });
  const overlayEvents = overlayRecords.map((record) => record.event);
  if (overlayEvents.length === 0 || overlayIsCommitted(committedEvents, overlayEvents)) {
    return { park, records: [], mappings: [], alreadyCommitted: true };
  }
  const remapped = remapTheirsRecords(overlayRecords, committedEvents, new Map(), new Map());
  return { park, records: remapped.records, mappings: remapped.mappings, alreadyCommitted: false };
}

function planIndexedInProgressOverlay(index, park, { repairTail = false, readOnly = false } = {}) {
  if (!park || !fs.existsSync(park)) return null;
  const overlayRecords = readJsonlRecordsFromFile(park, { repairTail, readOnly });
  const overlayEvents = overlayRecords.map((record) => record.event);
  if (overlayEvents.length === 0 || index.containsEventSequence(overlayEvents)) {
    return { park, records: [], mappings: [], alreadyCommitted: true };
  }
  const remapped = remapTheirsRecords(
    overlayRecords,
    index.outcomeStartEvents(),
    new Map(),
    new Map()
  );
  return {
    park,
    records: remapped.records,
    mappings: remapped.mappings,
    alreadyCommitted: false,
  };
}

function discardInProgressLog(park) {
  fs.unlinkSync(park);
  fsyncDirectory(path.dirname(park));
}

function reconcileInProgressRecords(
  committedEvents,
  { repairTail = false, readOnly = false, park = inProgressFile() } = {}
) {
  const plan = planInProgressOverlay(committedEvents, park, { repairTail, readOnly });
  if (!plan) return [];
  if (plan.alreadyCommitted) {
    if (!readOnly) discardInProgressLog(park);
    return [];
  }
  if (!readOnly && plan.mappings.length > 0) writeJsonl(park, plan.records);
  return plan.records;
}

const READ_ONLY_SNAPSHOT_ATTEMPTS = 3;

function readEventsSnapshot(file, { repairTail = false, readOnly = false } = {}) {
  const records = readJsonlRecordsFromFile(file, { repairTail, readOnly });
  const events = records.map((record) => record.event);
  if (!shouldAttachInProgress(file)) return events;
  return events.concat(
    reconcileInProgressRecords(events, {
      repairTail,
      readOnly,
      park: worktreeInProgressFile(),
    }).map((record) => record.event)
  );
}

function readEvents({ repairTail = false, readOnly = false, file = logFile() } = {}) {
  if (!readOnly) return readEventsSnapshot(file, { repairTail, readOnly });
  // Lock-free reads race with a writer flushing the park: the park can pass the
  // existence check and be unlinked before the read. Retry the whole main+park
  // snapshot, because the flush may have appended the park to the main log.
  for (let attempt = 1; ; attempt++) {
    try {
      return readEventsSnapshot(file, { repairTail, readOnly });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (attempt >= READ_ONLY_SNAPSHOT_ATTEMPTS) {
        // The park keeps vanishing; treat it as absent and read the main log only.
        return readJsonlRecordsFromFile(file, { repairTail, readOnly }).map(
          (record) => record.event
        );
      }
    }
  }
}

function parseJsonlRecords(content, source = 'log', { allowLegacy = false } = {}) {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        const event = normalizeEvent(JSON.parse(line), i + 1);
        if (!allowLegacy && event.logVersion !== LOG_VERSION) {
          fail(`v1 intent log cannot be used as a v2 outcome log; run driftseal migrate v1-to-v2 inspect`);
        }
        return { raw: line, event };
      } catch (err) {
        if (err instanceof DriftSealError) throw err;
        fail(`corrupt log line ${i + 1} in ${source}`);
      }
    });
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM'].includes(err.code)) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensureDirectoryDurable(directory) {
  const target = path.resolve(directory);
  const missing = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const created of missing.reverse()) fsyncDirectory(path.dirname(created));
}

function ensureV2OutcomeLogExists() {
  ensureDirectoryDurable(logDir());
  if (fs.existsSync(logFile())) return;
  if (isParkableOutcomeLog()) return;
  fs.writeFileSync(logFile(), '');
  fsyncDirectory(logDir());
}

function eventWriteSchemaVersion(event) {
  if (Number.isSafeInteger(event.schemaVersion)) return event.schemaVersion;
  if (event.type === 'lane_add' || event.type === 'lane_assign') return EVENT_SCHEMA_VERSION;
  if (
    (event.type === 'begin' || event.type === 'import') &&
    event.lane &&
    event.lane !== DEFAULT_LANE
  ) {
    return EVENT_SCHEMA_VERSION;
  }
  return DEFAULT_WRITE_SCHEMA_VERSION;
}

function appendEventTo(file, event) {
  ensureDirectoryDurable(path.dirname(file));
  const existed = fs.existsSync(file);
  const storedEvent = {
    logVersion: LOG_VERSION,
    ...event,
    schemaVersion: eventWriteSchemaVersion(event),
  };
  const line = Buffer.from(`${JSON.stringify(storedEvent)}\n`, 'utf8');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > 0) {
      const lastByte = Buffer.alloc(1);
      const readFd = fs.openSync(file, 'r');
      try {
        fs.readSync(readFd, lastByte, 0, 1, stat.size - 1);
      } finally {
        fs.closeSync(readFd);
      }
      if (lastByte[0] !== 0x0a) fs.writeSync(fd, Buffer.from('\n'));
    }
    let offset = 0;
    while (offset < line.length) offset += fs.writeSync(fd, line, offset, line.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fsyncDirectory(path.dirname(file));
  return storedEvent;
}

/**
 * Move the parked records into the tracked log. Safe to retry: a remap is persisted to the
 * park first, the log is written before the park file is dropped, so an interruption either
 * leaves nothing committed or leaves the overlay recognizable as already committed.
 * Returns the outcome ids it had to remap.
 */
function flushInProgressLog() {
  const park = inProgressFile();
  if (!park || !fs.existsSync(park)) return new Map();
  const committedRecords = readJsonlRecordsFromFile(logFile());
  const plan = planInProgressOverlay(
    committedRecords.map((record) => record.event),
    park,
    { repairTail: true }
  );
  if (!plan) return new Map();
  if (plan.alreadyCommitted) {
    discardInProgressLog(park);
    return new Map();
  }
  // Persist a remap before touching the log: after any crash the park then matches what the
  // log received (or will receive), so recovery never re-remaps it into a duplicate.
  if (plan.mappings.length > 0) writeJsonl(park, plan.records);
  writeJsonl(logFile(), [...committedRecords, ...plan.records]);
  discardInProgressLog(park);
  return new Map(
    plan.mappings.filter((mapping) => mapping.kind === 'outcome').map((mapping) => [mapping.from, mapping.to])
  );
}

function parkedOpenOutcome(park) {
  if (!fs.existsSync(park)) return null;
  const records = readJsonlRecordsFromFile(park, { repairTail: true });
  return openOutcome(fold(records.map((record) => record.event)));
}

function appendEvent(event) {
  const park = inProgressFile();
  if (!park) {
    const stored = appendEventTo(logFile(), event);
    if (event.type === 'begin') writeLocalOutcomeProvenance(stored);
    if (event.type === 'end') clearLocalOutcomeProvenance(event.id);
    return stored;
  }

  const open = parkedOpenOutcome(park);
  // A park with nothing open left in it belongs in the log; an interrupted end retries here.
  if (!open) flushInProgressLog();

  if (event.type === 'begin') return appendEventTo(park, event);
  if (!open || open.id !== event.id) return appendEventTo(logFile(), event);
  if (event.type !== 'end') return appendEventTo(park, event);
  // Close in the tracked log, never in Git metadata: the parked records move first, so the
  // closing record cannot end up somewhere a clone or a removed worktree would drop it.
  const remapped = flushInProgressLog();
  if (process.env._DRIFTSEAL_TEST_CRASH_AFTER_IN_PROGRESS_FLUSH === '1') {
    fail('simulated interruption after the in-progress flush');
  }
  return appendEventTo(logFile(), remapEvent(event, remapped, new Map()));
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function localOutcomeProvenanceFile() {
  const root = gitWorktreeRoot();
  const key = contentHash(path.resolve(logFile())).slice(0, 16);
  if (!root) return path.join(logDir(), LOCAL_OUTCOME_PROVENANCE_FILE);
  const gitPath = gitCapture(['rev-parse', '--git-path', `driftseal-local-outcome-${key}.json`]);
  return gitPath ? path.resolve(process.cwd(), gitPath) : null;
}

function localOutcomeLogIdentity() {
  try {
    const stat = fs.statSync(logFile(), { bigint: true });
    return contentHash(JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
  } catch {
    return null;
  }
}

function localOutcomeProvenanceFingerprint({ id, ts, verify }) {
  return contentHash(JSON.stringify([id, ts, verify || null]));
}

function writeLocalOutcomeProvenance(event) {
  const file = localOutcomeProvenanceFile();
  if (!file) return;
  ensureDirectoryDurable(path.dirname(file));
  atomicWriteFile(
    file,
    JSON.stringify({
      version: 1,
      id: event.id,
      fingerprint: localOutcomeProvenanceFingerprint(event),
      logIdentity: localOutcomeLogIdentity(),
    }) + '\n',
    0o600
  );
}

function readLocalOutcomeProvenance() {
  const file = localOutcomeProvenanceFile();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      provenance.version !== 1 ||
      typeof provenance.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(provenance.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(provenance.logIdentity)
    ) {
      return null;
    }
    return provenance;
  } catch {
    return null;
  }
}

function hasMatchingLocalOutcomeProvenance(outcome) {
  const provenance = readLocalOutcomeProvenance();
  return (
    provenance !== null &&
    provenance.id === outcome.id &&
    provenance.logIdentity === localOutcomeLogIdentity() &&
    provenance.fingerprint ===
      localOutcomeProvenanceFingerprint({
        id: outcome.id,
        ts: outcome.tsBegin,
        verify: outcome.verify,
      })
  );
}

function clearLocalOutcomeProvenance(id) {
  const file = localOutcomeProvenanceFile();
  const provenance = readLocalOutcomeProvenance();
  if (!file || !provenance || provenance.id !== id) return;
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function atomicWriteFile(target, content, createMode = 0o644) {
  const existed = fs.existsSync(target);
  const mode = existed ? fs.statSync(target).mode & 0o777 : createMode;
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    if (existed) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    fsyncDirectory(path.dirname(target));
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw err;
  }
}

function atomicCreateFile(target, content, mode = 0o644) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temp, target);
    fs.unlinkSync(temp);
    fsyncDirectory(path.dirname(target));
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw err;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function processStartToken(pid) {
  if (process.env._DRIFTSEAL_TEST_NO_PROCESS_START_TOKEN === '1') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] || null;
  } catch {}

  if (process.platform === 'darwin') {
    try {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    try {
      const script =
        `$start = (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks; ` +
        '[Console]::Write($start.ToString([Globalization.CultureInfo]::InvariantCulture))';
      const started = execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
          windowsHide: true,
        }
      ).trim();
      return started ? `win32:${started}` : null;
    } catch {
      return null;
    }
  }

  return null;
}

function clearStaleLock(lock) {
  let stat;
  let owner;
  try {
    stat = fs.statSync(lock);
    owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  } catch {
    owner = null;
  }

  const staleAfter = owner ? LOCK_STALE_MS : LOCK_INIT_STALE_MS;
  const oldEnough = stat && Date.now() - stat.mtimeMs > staleAfter;
  if (
    owner &&
    owner.hostname === os.hostname() &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0
  ) {
    const currentStart = processStartToken(owner.pid);
    const alive = processIsAlive(owner.pid);
    const comparable = Boolean(owner.processStart && currentStart);
    if (alive && comparable && owner.processStart === currentStart) return false;
    if (alive && !comparable && !oldEnough) return false;
  } else if (owner && !oldEnough) {
    return false;
  } else if (!owner && !oldEnough) {
    return false;
  }

  const tombstone = `${lock}.stale.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lock, tombstone);
  } catch (err) {
    return err.code === 'ENOENT';
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
  fsyncDirectory(path.dirname(lock));
  return true;
}

const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function acquireMutationLock(resource, { waitMs = 0, intervalMs = 100 } = {}) {
  ensureDirectoryDurable(resource);
  const lock = path.join(resource, '.driftseal.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code === 'EEXIST' && clearStaleLock(lock)) continue;
      if (err.code !== 'EEXIST' || Date.now() >= deadline) {
        if (waitMs > 0) return null;
        fail(`another DriftSeal mutation is in progress (lock: ${lock})`);
      }
      Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, intervalMs);
    }
  }
  let token;
  let ownerFile;
  try {
    if (process.env._DRIFTSEAL_TEST_FAIL_LOCK_OWNER_INIT === '1') {
      throw new Error('simulated lock owner initialization failure');
    }
    token = crypto.randomUUID();
    ownerFile = path.join(lock, 'owner.json');
    const fd = fs.openSync(ownerFile, 'wx', 0o600);
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          processStart: processStartToken(process.pid),
          startedAt: new Date().toISOString(),
        }) + '\n'
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(lock);
    fsyncDirectory(resource);
  } catch (err) {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
      fsyncDirectory(resource);
    } catch {}
    throw err;
  }

  return () => {
    if (process.env._DRIFTSEAL_TEST_FAIL_LOCK_RELEASE === '1') {
      throw new Error('simulated lock release failure');
    }
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    } catch (err) {
      throw new Error(`cannot verify DriftSeal mutation lock ownership: ${lock}`, { cause: err });
    }
    if (owner.token !== token) {
      throw new Error(`DriftSeal mutation lock ownership changed before release: ${lock}`);
    }
    fs.rmSync(lock, { recursive: true, force: true });
    fsyncDirectory(resource);
  };
}

function withMutationLocks(resources, action, { tryWaitMs } = {}) {
  const roots = [
    ...new Set(
      resources.map((resource) => {
        ensureDirectoryDurable(resource);
        return fs.realpathSync(resource);
      })
    ),
  ].sort();
  const releases = [];

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    let firstError;
    for (const release of releases.reverse()) {
      try {
        release();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
  };
  const bestEffortCleanup = () => {
    try {
      cleanup();
    } catch {}
  };
  let actionFailed = false;
  process.once('exit', bestEffortCleanup);
  try {
    for (const root of roots) {
      const release =
        tryWaitMs === undefined
          ? acquireMutationLock(root)
          : acquireMutationLock(root, { waitMs: tryWaitMs });
      if (!release) return null;
      releases.push(release);
    }
    const data = action();
    return tryWaitMs === undefined ? data : { acquired: true, data };
  } catch (err) {
    actionFailed = true;
    throw err;
  } finally {
    process.removeListener('exit', bestEffortCleanup);
    if (actionFailed) bestEffortCleanup();
    else cleanup();
  }
}

function outcomeContractHash(record) {
  return outcomeFoldEngine.outcomeContractHash(record);
}

function newOutcomeRecord(ev) {
  return outcomeFoldEngine.newOutcomeRecord(ev);
}

/** Fold the event stream into one record per outcome. Legacy v1 events are accepted for migration. */
function fold(events) {
  return outcomeFoldEngine.fold(events);
}

function qualifyingDecisionUpdates(record, decisionId) {
  return outcomeFoldEngine.qualifyingDecisionUpdates(record, decisionId);
}

function openOutcome(records) {
  const open = records.filter((record) => record.status === 'in_progress');
  if (open.length > 1) fail(`multiple outcomes in progress: ${open.map((record) => record.id).join(', ')}`);
  return open[0] || null;
}

function parseOutcomeId(id) {
  const match = String(id).match(/^(\d{4}-\d{2}-\d{2})-(\d+)$/);
  if (!match) fail(`invalid outcome id: ${id}`);
  return { date: match[1], seq: Number.parseInt(match[2], 10) };
}

function nextIdForDate(date, events) {
  let maxSeq = 0;
  const prefix = `${date}-`;
  for (const ev of events) {
    if ((ev.type === 'begin' || ev.type === 'import') && typeof ev.id === 'string' && ev.id.startsWith(prefix)) {
      const seq = Number.parseInt(ev.id.slice(prefix.length), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  return `${date}-${String(maxSeq + 1).padStart(3, '0')}`;
}

function nextId(events) {
  return nextIdForDate(new Date().toISOString().slice(0, 10), events);
}

function normalizeDecisionId(value) {
  if (typeof value !== 'string' || !/^0*[1-9]\d*$/.test(value)) {
    fail(`invalid decision id: ${String(value)}`);
  }
  return value.replace(/^0+/, '').padStart(4, '0');
}

function parseDecision(file, content, fileId) {
  const titleMatch = content.match(/^# ([0-9]+)\. ([^\r\n]+)\r?(?:\n|$)/);
  if (!titleMatch) fail(`decision record must begin with a decision title: ${file}`);
  const titleId = normalizeDecisionId(titleMatch[1]);
  if (titleId !== fileId) {
    fail(`decision id mismatch in ${file}: filename is ${fileId}, title is ${titleId}`);
  }

  const firstSection = content.match(/^## ([^\r\n]+)\r?$/m);
  if (!firstSection || firstSection[1].trim() !== 'Status') {
    fail(`decision record must use Status as its first section: ${file}`);
  }
  const statusMatch = content.match(
    /^## Status[ \t]*\r?\n(?:[ \t]*\r?\n)+([^\r\n]+)(?=\r?\n|$)/m
  );
  if (!statusMatch || statusMatch[1].trim().startsWith('#')) {
    fail(`decision record has no valid status value: ${file}`);
  }
  const status = statusMatch[1].trim().toLowerCase();
  if (!DECISION_STATUSES.includes(status)) {
    fail(`invalid decision status "${status}" in ${file}`);
  }
  const statusStart = statusMatch.index + statusMatch[0].lastIndexOf(statusMatch[1]);
  return {
    id: fileId,
    title: titleMatch[2].trim(),
    status,
    statusStart,
    statusEnd: statusStart + statusMatch[1].length,
    file,
    content,
  };
}

function compareDecisionEntries(a, b) {
  return a.id.length - b.id.length || a.id.localeCompare(b.id) || a.file.localeCompare(b.file);
}

function listDecisionEntries(dir, { allowDuplicates = false } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = [];
  const ids = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const match = entry.name.match(/^(\d{4,})-.*\.md$/);
    if (!match) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) fail(`decision record must not be a symbolic link: ${entry.name}`);
    if (!stat.isFile()) fail(`decision record is not a regular file: ${entry.name}`);
    const id = normalizeDecisionId(match[1]);
    if (ids.has(id) && !allowDuplicates) {
      fail(`duplicate decision id ${id}: ${ids.get(id)}, ${entry.name}`);
    }
    if (!ids.has(id)) ids.set(id, entry.name);
    entries.push({ id, file: entry.name, path: fullPath });
  }
  return entries.sort(compareDecisionEntries);
}

function decisionIndex() {
  return listDecisionEntries(decisionDir());
}

function readDecision(entry) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  let content;
  try {
    fd = fs.openSync(entry.path, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(fd).isFile()) fail(`decision record is not a regular file: ${entry.file}`);
    content = fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return parseDecision(entry.file, content, entry.id);
}

function decisionCatalog(index = decisionIndex()) {
  return index.map(readDecision);
}

function nextDecisionId(index = decisionIndex()) {
  if (index.length === 0) return 1n;
  return BigInt(index.at(-1).id) + 1n;
}

function findDecision(value, index = decisionIndex()) {
  const id = normalizeDecisionId(value);
  const entry = index.find((record) => record.id === id);
  if (!entry) fail(`unknown decision id: ${value}`);
  return readDecision(entry);
}

function slugify(value) {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_DECISION_SLUG_LENGTH)
    .replace(/-$/, '');
  return slug || 'decision';
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function bulletSection(heading, values) {
  const items = values.length > 0 ? values : ['Not recorded.'];
  return `## ${heading}\n\n${items.map((value) => `* ${value.replace(/\s+/g, ' ').trim()}`).join('\n')}`;
}

function renderDecision({ id, title, date, status, context, outcome, drivers, options, consequences }) {
  return [
    `# ${id}. ${title}`,
    `Date: ${date}`,
    `## Status\n\n${titleCase(status)}`,
    `## Context and Problem Statement\n\n${context.trim()}`,
    bulletSection('Decision Drivers', drivers),
    bulletSection('Considered Options', options),
    `## Decision Outcome\n\n${outcome.trim()}`,
    bulletSection('Consequences', consequences),
  ].join('\n\n') + '\n';
}

function prepareDecisionReconciliation(decision, outcomeId, status, note) {
  const target = path.join(decisionDir(), decision.file);
  const fromStatus = decision.status;
  const reconciliationId = crypto.randomUUID();
  const updated =
    decision.content.slice(0, decision.statusStart) +
    titleCase(status) +
    decision.content.slice(decision.statusEnd);
  const ts = new Date().toISOString();
  const eol = decision.content.includes('\r\n') ? '\r\n' : '\n';
  const normalizedNote = note.trim().replace(/\r\n|\r|\n/g, eol);
  const hasDriftSealHistory = /^<!-- [a-z][a-z0-9-]*-reconciliation: [^>\r\n]+ -->\r?$/m.test(updated);
  const historyHeading = hasDriftSealHistory ? '' : `## Decision History${eol}${eol}`;
  const history = `${historyHeading}<!-- driftseal-reconciliation: ${reconciliationId} -->${eol}### ${ts} — Outcome \`${outcomeId}\`${eol}${eol}Status: ${titleCase(fromStatus)} → ${titleCase(status)}${eol}${eol}${normalizedNote}${eol}`;
  const separator = updated.endsWith(eol + eol) ? '' : updated.endsWith(eol) ? eol : eol + eol;
  const nextContent = updated + separator + history;
  return {
    type: 'decision_reconcile_prepare',
    id: outcomeId,
    decisionId: decision.id,
    reconciliationId,
    ts,
    fromStatus,
    toStatus: status,
    note,
    oldHash: contentHash(decision.content),
    newHash: contentHash(nextContent),
    target,
    content: nextContent,
  };
}

function reconciliationEvent(type, prepare) {
  return {
    type,
    id: prepare.id,
    decisionId: prepare.decisionId,
    reconciliationId: prepare.reconciliationId,
    ts: new Date().toISOString(),
    fromStatus: prepare.fromStatus,
    toStatus: prepare.toStatus,
    note: prepare.note,
    fileHash: prepare.newHash,
  };
}

function pendingReconciliations(events, outcomeId) {
  const prepares = new Map();
  const finished = new Set();
  for (const event of events) {
    if (event.id !== outcomeId) continue;
    if (event.type === 'decision_reconcile_prepare') {
      prepares.set(event.reconciliationId, event);
    } else if (
      event.type === 'decision_reconcile_commit' ||
      event.type === 'decision_reconcile_abort' ||
      event.type === 'decision_reconcile_cancel'
    ) {
      finished.add(event.reconciliationId);
    }
  }

  return [...prepares.values()].filter(
    (prepare) => !finished.has(prepare.reconciliationId)
  );
}

function recoverPendingReconciliations(events, outcomeId) {
  const pending = pendingReconciliations(events, outcomeId);
  if (pending.length === 0) return events;
  const index = decisionIndex();
  for (const prepare of pending) {
    const decision = findDecision(prepare.decisionId, index);
    const currentHash = contentHash(decision.content);
    if (currentHash === prepare.newHash) {
      const commit = reconciliationEvent('decision_reconcile_commit', prepare);
      events.push(appendEvent(commit));
    } else if (currentHash === prepare.oldHash) {
      const abort = {
        type: 'decision_reconcile_abort',
        id: prepare.id,
        decisionId: prepare.decisionId,
        reconciliationId: prepare.reconciliationId,
        ts: new Date().toISOString(),
        note: 'prepared reconciliation did not reach the decision file',
      };
      events.push(appendEvent(abort));
    } else {
      fail(
        `cannot recover reconciliation ${prepare.reconciliationId}: decision ${prepare.decisionId} matches neither the old nor prepared content`
      );
    }
  }
  return events;
}

function cancelPendingReconciliations(events, outcomeId, outcomeStatus) {
  for (const prepare of pendingReconciliations(events, outcomeId)) {
    const cancellation = {
      type: 'decision_reconcile_cancel',
      id: prepare.id,
      decisionId: prepare.decisionId,
      reconciliationId: prepare.reconciliationId,
      ts: new Date().toISOString(),
      outcomeStatus,
      note: `automatic recovery cancelled because outcome closed as ${outcomeStatus}`,
    };
    events.push(appendEvent(cancellation));
  }
  return events;
}

function escapeCancellationStatus(record) {
  const cancellation = record.decisionTerminals.find(
    (terminal) => terminal.type === 'decision_reconcile_cancel'
  );
  return cancellation ? cancellation.outcomeStatus : null;
}

function closeIntentAsEscape(events, record, requestedStatus, note, verifyResult) {
  const status = escapeCancellationStatus(record) || requestedStatus;
  cancelPendingReconciliations(events, record.id, status);
  if (process.env._DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_CANCEL === '1') {
    fail('simulated interruption after reconciliation cancellation');
  }
  events.push(
    appendEvent({
      type: 'end',
      id: record.id,
      ts: new Date().toISOString(),
      status,
      note: note || null,
      verifyResult: verifyResult || null,
      head: gitCapture(['rev-parse', 'HEAD']),
    })
  );
  return status;
}

function fail(msg) {
  throw new DriftSealError(msg);
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) {
    fail(`${flag} requires a positive integer`);
  }
  return number;
}

function looksLikeFlag(value, spec) {
  if (!value) return false;
  if (value.startsWith('--')) return true;
  return /^-.$/.test(value) && Object.values(spec).includes(value);
}

/** Minimal flag parser: positionals + --flag value / --flag=value / -x value */
function parseArgs(argv, spec, usageKey) {
  const positionals = [];
  const flags = {};
  const assignFlag = (name, value) => {
    if (spec[name] === 'multiple') {
      if (!flags[name]) flags[name] = [];
      flags[name].push(value);
      return;
    }
    if (Object.hasOwn(flags, name)) fail(`flag --${name} may only be specified once`);
    flags[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') throw new HelpRequested(usageKey);
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!(name in spec)) fail(`unknown flag: --${name}`);
      if (spec[name] === 'boolean') {
        if (eq !== -1) fail(`flag --${name} does not take a value`);
        assignFlag(name, true);
      } else {
        const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
        if (value === undefined || value === '' || (eq === -1 && looksLikeFlag(value, spec))) {
          fail(`flag --${name} requires a value`);
        }
        if (eq === -1) i++;
        assignFlag(name, value);
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const long = Object.keys(spec).find((k) => spec[k] === arg);
      if (!long) fail(`unknown flag: ${arg}`);
      if (spec[long] === 'boolean') {
        assignFlag(long, true);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || looksLikeFlag(value, spec)) fail(`flag ${arg} requires a value`);
      i++;
      assignFlag(long, value);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function render(rec, { currentLane } = {}) {
  const lines = [`[${rec.id}] ${rec.status}`];
  const lane = rec.lane || DEFAULT_LANE;
  if (lane !== DEFAULT_LANE || (currentLane && lane !== currentLane)) {
    lines.push(`  lane: ${lane}`);
  }
  lines.push(`  outcome: ${rec.outcome}`);
  for (const extension of rec.extensions) lines.push(`  extend: ${extension.extension}`);
  for (const criterion of rec.acceptance) lines.push(`  accept: ${criterion}`);
  if (rec.decisions.length > 0) lines.push(`  decisions: ${rec.decisions.join(', ')}`);
  if (rec.verify) lines.push(`  verify: ${rec.verify}`);
  if (rec.verification) {
    const state = rec.verification.passed ? 'passed' : 'failed';
    const workspace = rec.verification.workspace
      ? `, workspace ${rec.verification.workspace.slice(0, 12)}`
      : ', workspace unavailable';
    lines.push(
      `  machine-verification: ${state} (exit ${rec.verification.exitCode ?? '-'}, ` +
        `${rec.verification.durationMs} ms${workspace})`
    );
  }
  if (rec.verifyResult) lines.push(`  verify-result: ${rec.verifyResult}`);
  if (rec.note) lines.push(`  note: ${rec.note}`);
  if (rec.beginHead || rec.endHead) {
    lines.push(`  head: ${rec.beginHead || '-'}..${rec.endHead || '-'}`);
  }
  lines.push(`  began: ${rec.tsBegin}` + (rec.tsEnd ? `  ended: ${rec.tsEnd}` : ''));
  if (rec.reclaimed) lines.push(`  reclaimed: ${rec.reclaimReason}`);
  if (rec.imported) lines.push(`  imported-from: ${rec.imported.sourceIds.join(', ')}`);
  return lines.join('\n');
}

function publicVerification(verification) {
  if (!verification) return null;
  return {
    id: verification.verificationId,
    passed: verification.passed,
    exitCode: verification.exitCode,
    signal: verification.signal,
    durationMs: verification.durationMs,
    outputHash: verification.outputHash,
    stdoutBytes: verification.stdoutBytes,
    stderrBytes: verification.stderrBytes,
    workspace: verification.workspace,
    contractHash: verification.contractHash || null,
    head: verification.head,
    ranAt: verification.ts,
  };
}

function publicOutcome(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    outcome: rec.outcome,
    lane: rec.lane || DEFAULT_LANE,
    extensions: rec.extensions.map((extension) => ({ ...extension })),
    acceptance: [...rec.acceptance],
    verify: rec.verify,
    contractHash: rec.contractHash,
    verification: publicVerification(rec.verification),
    decisions: [...rec.decisions],
    status: rec.status,
    note: rec.note,
    verifyResult: rec.verifyResult,
    beginHead: rec.beginHead,
    endHead: rec.endHead,
    beganAt: rec.tsBegin,
    endedAt: rec.tsEnd,
    reclaimed: rec.reclaimed,
    reclaimReason: rec.reclaimReason,
    reclaimedAt: rec.reclaimedAt,
    imported: rec.imported
      ? {
          sourceIds: [...rec.imported.sourceIds],
          sourceFingerprint: rec.imported.sourceFingerprint,
        }
      : null,
  };
}

function publicDecision(decision, { includeContent = false } = {}) {
  const record = {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    file: decision.file,
  };
  if (includeContent) record.content = decision.content;
  return record;
}

const INTENT_PROTOCOL_MARKER = '<!-- driftseal -->';
const INTENT_PROTOCOL_END = '<!-- /driftseal -->';
const DECISION_PROTOCOL_MARKER = '<!-- driftseal-decisions -->';
const DECISION_PROTOCOL_END = '<!-- /driftseal-decisions -->';
const LOG_LANGUAGE_COMMENT_RE = /^<!-- driftseal-log-language: ([^>\r\n]+) -->\r?$/m;
const LOG_LANGUAGE_PROSE_RE = /\*\*Log language:\*\* `([^`]+)`/;
const LOCAL_LOG_COMMENT_RE = /^<!-- driftseal-local-log: true -->\r?$/m;
const IRREGULAR_GRANDFATHERED_TAGS = new Map([
  ['en-gb-oed', 'en-GB-oed'],
  ['i-ami', 'i-ami'],
  ['i-bnn', 'i-bnn'],
  ['i-default', 'i-default'],
  ['i-enochian', 'i-enochian'],
  ['i-hak', 'i-hak'],
  ['i-klingon', 'i-klingon'],
  ['i-lux', 'i-lux'],
  ['i-mingo', 'i-mingo'],
  ['i-navajo', 'i-navajo'],
  ['i-pwn', 'i-pwn'],
  ['i-tao', 'i-tao'],
  ['i-tay', 'i-tay'],
  ['i-tsu', 'i-tsu'],
  ['sgn-be-fr', 'sgn-BE-FR'],
  ['sgn-be-nl', 'sgn-BE-NL'],
  ['sgn-ch-de', 'sgn-CH-DE'],
]);

function titleCaseSubtag(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function isBcp47Variant(subtag) {
  return /^[A-Za-z0-9]{5,8}$/.test(subtag) || /^[0-9][A-Za-z0-9]{3}$/.test(subtag);
}

function isBcp47Singleton(subtag) {
  return /^[0-9A-WY-Za-wy-z]$/.test(subtag);
}

function parsePrivateUseSubtags(subtags, start, parts) {
  if (start >= subtags.length || !/^x$/i.test(subtags[start])) return null;
  parts.push('x');
  let index = start + 1;
  let count = 0;
  while (index < subtags.length && /^[A-Za-z0-9]{1,8}$/.test(subtags[index])) {
    parts.push(subtags[index].toLowerCase());
    index += 1;
    count += 1;
  }
  if (count === 0 || index !== subtags.length) return null;
  return parts.join('-');
}

function wellFormedBcp47(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.startsWith('-') || tag.endsWith('-')) {
    return null;
  }
  const irregular = IRREGULAR_GRANDFATHERED_TAGS.get(tag.toLowerCase());
  if (irregular) return irregular;

  const subtags = tag.split('-');
  if (subtags.some((subtag) => subtag.length === 0)) return null;

  const parts = [];
  if (/^x$/i.test(subtags[0])) return parsePrivateUseSubtags(subtags, 0, parts);

  let index = 0;
  const language = subtags[index];
  if (!/^[A-Za-z]{2,8}$/.test(language)) return null;
  parts.push(language.toLowerCase());
  index += 1;
  if (language.length <= 3) {
    let extlang = 0;
    while (index < subtags.length && /^[A-Za-z]{3}$/.test(subtags[index]) && extlang < 3) {
      parts.push(subtags[index].toLowerCase());
      index += 1;
      extlang += 1;
    }
  }

  if (index < subtags.length && /^[A-Za-z]{4}$/.test(subtags[index])) {
    parts.push(titleCaseSubtag(subtags[index]));
    index += 1;
  }

  if (index < subtags.length && /^[A-Za-z]{2}$/.test(subtags[index])) {
    parts.push(subtags[index].toUpperCase());
    index += 1;
  } else if (index < subtags.length && /^[0-9]{3}$/.test(subtags[index])) {
    parts.push(subtags[index]);
    index += 1;
  }

  const variants = new Set();
  while (index < subtags.length && isBcp47Variant(subtags[index])) {
    const variant = subtags[index].toLowerCase();
    if (variants.has(variant)) return null;
    variants.add(variant);
    parts.push(variant);
    index += 1;
  }

  const singletons = new Set();
  while (index < subtags.length && isBcp47Singleton(subtags[index])) {
    const singleton = subtags[index].toLowerCase();
    if (singletons.has(singleton)) return null;
    singletons.add(singleton);
    parts.push(singleton);
    index += 1;
    let following = 0;
    while (index < subtags.length && /^[A-Za-z0-9]{2,8}$/.test(subtags[index])) {
      parts.push(subtags[index].toLowerCase());
      index += 1;
      following += 1;
    }
    if (following === 0) return null;
  }

  if (index < subtags.length && /^x$/i.test(subtags[index])) {
    return parsePrivateUseSubtags(subtags, index, parts);
  }
  if (index !== subtags.length) return null;
  return parts.join('-');
}

function canonicalizeLogLanguage(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('invalid log language: use a BCP 47 tag such as en or zh-CN');
  }
  const canonical = wellFormedBcp47(value.trim());
  if (!canonical) {
    fail(`invalid log language "${value}": use a BCP 47 tag such as en or zh-CN`);
  }
  return canonical;
}

function intentLogLanguageParagraph(language) {
  return `**Log language:** \`${language}\`. Write intent-log prose (intent, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.`;
}

function decisionLogLanguageParagraph(language) {
  return `**Log language:** \`${language}\`. Write decision-log prose (title, context,
outcome, drivers, options, consequences, and update notes) in that language.
Keep MADR section headings, status tokens, and ids in English.`;
}

function parseLogLanguageFromBlock(block, label) {
  const commentMatch = block.match(LOG_LANGUAGE_COMMENT_RE);
  const proseMatch = block.match(LOG_LANGUAGE_PROSE_RE);
  const comment = commentMatch ? canonicalizeLogLanguage(commentMatch[1]) : null;
  const prose = proseMatch ? canonicalizeLogLanguage(proseMatch[1]) : null;
  if (comment && prose && comment !== prose) {
    fail(
      `${label} declares different log languages in the comment (${comment}) and prose (${prose}); pass --lang to set one`
    );
  }
  return comment || prose || null;
}

function extractManagedBlock(content, marker, endMarker) {
  const start = content.indexOf(marker);
  if (start === -1) return null;
  const end = content.indexOf(endMarker, start);
  if (end === -1) return null;
  return content.slice(start, end + endMarker.length);
}

function resolveInitLogLanguage(requested, content) {
  if (requested !== undefined) return canonicalizeLogLanguage(requested);
  const languages = new Set();
  const intent = extractManagedBlock(content, INTENT_PROTOCOL_MARKER, INTENT_PROTOCOL_END);
  const decision = extractManagedBlock(content, DECISION_PROTOCOL_MARKER, DECISION_PROTOCOL_END);
  if (intent) {
    const language = parseLogLanguageFromBlock(intent, 'intent protocol');
    if (language) languages.add(language);
  }
  if (decision) {
    const language = parseLogLanguageFromBlock(decision, 'decision protocol');
    if (language) languages.add(language);
  }
  if (languages.size > 1) {
    fail(
      `intent and decision protocols declare different log languages (${[...languages].join(', ')}); pass --lang to set one`
    );
  }
  return languages.size === 1 ? [...languages][0] : DEFAULT_LOG_LANGUAGE;
}

function resolveInitLocalLog(requested, content) {
  if (requested) return true;
  const intent = extractManagedBlock(content, INTENT_PROTOCOL_MARKER, INTENT_PROTOCOL_END);
  if (intent && LOCAL_LOG_COMMENT_RE.test(intent)) return true;
  const decision = extractManagedBlock(content, DECISION_PROTOCOL_MARKER, DECISION_PROTOCOL_END);
  return Boolean(decision && LOCAL_LOG_COMMENT_RE.test(decision));
}

/**
 * Log languages persisted in the current managed blocks, collected leniently
 * (no failure on malformed or conflicting declarations: init --lang may be
 * fixing exactly that). Lets init recognize default blocks written in the
 * existing language when --lang switches to a new one.
 */
function persistedLogLanguages(content) {
  const languages = new Set();
  const blocks = [
    extractManagedBlock(content, INTENT_PROTOCOL_MARKER, INTENT_PROTOCOL_END),
    extractManagedBlock(content, DECISION_PROTOCOL_MARKER, DECISION_PROTOCOL_END),
  ];
  for (const block of blocks) {
    if (!block) continue;
    const comment = block.match(LOG_LANGUAGE_COMMENT_RE);
    const prose = block.match(LOG_LANGUAGE_PROSE_RE);
    const value = comment ? comment[1] : prose ? prose[1] : null;
    const canonical = value ? wellFormedBcp47(value.trim()) : null;
    if (canonical) languages.add(canonical);
  }
  return languages;
}

function protocolBlockKey(block) {
  return block
    .replace(/^<!-- driftseal-log-language: [^>\r\n]+ -->\r?$/m, '<!-- driftseal-log-language: -->')
    .replace(/\*\*Log language:\*\* `[^`]+`/g, '**Log language:** ``');
}

function stripIntentLogLanguage(block, language = DEFAULT_LOG_LANGUAGE) {
  return block
    .replace(`\n<!-- driftseal-log-language: ${language} -->`, '')
    .replace(`\n${intentLogLanguageParagraph(language)}\n`, '');
}

function stripDecisionLogLanguage(block, language = DEFAULT_LOG_LANGUAGE) {
  return block
    .replace(`\n<!-- driftseal-log-language: ${language} -->`, '')
    .replace(`\n${decisionLogLanguageParagraph(language)}\n`, '');
}

function outcomeLogLanguageParagraph(language) {
  return `**Log language:** \`${language}\`. Write outcome-log prose (outcome, extension, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, ids, and lane names in English.`;
}

function intentProtocolBlockV20(language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${INTENT_PROTOCOL_MARKER}
<!-- driftseal-version: 2.0 -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: outcome write-ahead log

This repository uses DriftSeal (\`driftseal\`) to prevent agent drift. This
\`AGENTS.md\` protocol is the source of truth; use the CLI by default, with MCP
and lifecycle hooks as optional adapters.

**Log language:** \`${language}\`. Write outcome-log prose (outcome, extension, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.

1. **Write the outcome first**, before changing durable project content:
   \`driftseal begin "<coherent delivery outcome>" --accept "<observable result>" --verify "<exact command that proves the cumulative contract>"\`.
   Repeat \`--accept\` for independently observable criteria and add one
   \`--decision <id>\` for each existing MADR this outcome may change.
   Record outcomes for changes intended to persist in the project: code,
   configuration, documentation, dependencies, and equivalent files, inside or
   outside Git. Git operations, checks, temporary auxiliary work, and external
   state changes are exempt when they do not write durable project content here.
2. **Extend only the same outcome.** For another step toward the same coherent
   delivery goal, append \`driftseal extend "<addition>"\`. It may add
   \`--accept\`, \`--decision\`, and a replacement \`--verify\`; adding acceptance
   requires a replacement verifier that proves the complete accumulated contract.
   Every extension invalidates earlier verification and MADR reconciliation. If
   the delivery goal changes, close the current outcome honestly and begin a new one.
   One open outcome belongs to one worktree, or one configured non-Git project
   root. Every agent changing durable content in the same root re-anchors and
   continues it; separate worktrees hold separate outcomes.
3. **Reconcile, verify, then close.** After the final extension, reconcile every
   linked MADR with \`driftseal decision update\`. Inspect \`driftseal status\`,
   then run \`driftseal verify\` for an acceptance-bound outcome. A verifier
   without matching local provenance is untrusted and requires
   \`--allow-tracked-command\` after inspection. Finish with
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>"\`.
   Completed outcomes require fresh successful verification bound to both the
   current contract hash and Git-visible workspace. Never report success without
   closing the outcome.
4. **Re-anchor after context loss or handoff:** run \`driftseal status\` and
   \`driftseal log --last 3\` before changing durable content. Resume the open
   outcome when it still matches; otherwise close it and begin a new one.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
\`.seal/outcomes/events.jsonl\` (or its configured equivalent) directly. Use
\`reclaim\`/\`unreclaim\` for visibility markers and \`absorb\` after merge
collisions. These operations preserve append-only single-lineage history.

Seal root: \`.seal/\` (override with \`$DRIFTSEAL_HOME\`); outcome log:
\`.seal/outcomes/events.jsonl\`; ${localLog ? 'keep `.seal/` local and untracked.' : 'commit `.seal/` with the code.'}
${INTENT_PROTOCOL_END}`;
}

function intentProtocolBlockV21(version = PROTOCOL_VERSION, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${INTENT_PROTOCOL_MARKER}
<!-- driftseal-version: ${version} -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: outcome write-ahead log

This repository uses DriftSeal (\`driftseal\`) to prevent agent drift. This
\`AGENTS.md\` protocol is the source of truth; use the CLI by default, with MCP
and lifecycle hooks as optional adapters.

${outcomeLogLanguageParagraph(language)}

1. **Write the outcome first**, before changing durable project content:
   \`driftseal begin "<coherent delivery outcome>" --accept "<observable result>" --verify "<exact command that proves the cumulative contract>"\`.
   Repeat \`--accept\` for independently observable criteria and add one
   \`--decision <id>\` for each existing MADR this outcome may change.
   Record outcomes for changes intended to persist in the project: code,
   configuration, documentation, dependencies, and equivalent files, inside or
   outside Git. Git operations, checks, temporary auxiliary work, and external
   state changes are exempt when they do not write durable project content here.
2. **Extend only the same outcome.** For another step toward the same coherent
   delivery goal, append \`driftseal extend "<addition>"\`. It may add
   \`--accept\`, \`--decision\`, and a replacement \`--verify\`; adding acceptance
   requires a replacement verifier that proves the complete accumulated contract.
   Every extension invalidates earlier verification and MADR reconciliation. If
   the delivery goal changes, close the current outcome honestly and begin a new one.
   One open outcome belongs to one worktree, or one configured non-Git project
   root. Every agent changing durable content in the same root re-anchors and
   continues it; separate worktrees hold separate outcomes.
   Outcomes belong to one named lane (\`driftseal lane\`). The default lane is
   \`main\`; untagged history lives there. Re-anchoring and \`driftseal log\`
   follow the current lane. Close the open outcome before switching lanes.
   Create a lane only for a long-lived capability you expect to leave and resume.
3. **Reconcile, verify, then close.** After the final extension, reconcile every
   linked MADR with \`driftseal decision update\`. Inspect \`driftseal status\`,
   then run \`driftseal verify\` for an acceptance-bound outcome. A verifier
   without matching local provenance is untrusted and requires
   \`--allow-tracked-command\` after inspection. Finish with
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>"\`.
   Completed outcomes require fresh successful verification bound to both the
   current contract hash and Git-visible workspace. Never report success without
   closing the outcome.
4. **Re-anchor after context loss or handoff:** run \`driftseal status\` and
   \`driftseal log --last 3\` before changing durable content. Both follow the
   current lane. Resume the open outcome when it still matches; otherwise close
   it and begin a new one. If the requested work belongs to a different existing
   lane, switch first.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
\`.seal/outcomes/events.jsonl\` (or its configured equivalent) directly. Use
\`reclaim\`/\`unreclaim\` for visibility markers and \`absorb\` after merge
collisions. These operations preserve append-only single-lineage history.

Seal root: \`.seal/\` (override with \`$DRIFTSEAL_HOME\`); outcome log:
\`.seal/outcomes/events.jsonl\`; ${localLog ? 'keep `.seal/` local and untracked.' : 'commit `.seal/` with the code.'}
${INTENT_PROTOCOL_END}`;
}

function intentProtocolBlock(version = PROTOCOL_VERSION, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  if (String(version) === '2.0') return intentProtocolBlockV20(language, localLog);
  return intentProtocolBlockV21(version, language, localLog);
}

function v1IntentProtocolBlock(version = 14, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${INTENT_PROTOCOL_MARKER}
<!-- driftseal-version: ${version} -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (\`driftseal\`) to prevent agent drift. Every work round:

This \`AGENTS.md\` protocol is the source of truth. Use the \`driftseal\` CLI by
default; the companion skill only helps discover and resume the workflow, while
MCP and lifecycle hooks are optional adapters.

${intentLogLanguageParagraph(language)}

1. **Write intent first**, before changing durable project content:
   \`driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"\`.
   Repeat \`--accept\` when completion has multiple independently observable criteria.
   Add one \`--decision <id>\` for each existing decision this round may change.
   Record intents for changes intended to persist in the project: edits to code,
   configuration, documentation, dependencies, and equivalent project files,
   whether or not the project is inside a Git worktree. Everything else is
   exempt: Git operations (Git maintains their history — inspection, branch
   and worktree management, staging, commits, merges, rebases, cherry-picks,
   tags, and pushes); single-step commands that only build or check work
   already done, such as compiling or running tests; auxiliary file or shell
   operations whose results remain outside durable project content (for example
   an rsync scratch copy or temp scaffolding); and state changes to a remote
   machine or the local environment that do not write durable project content
   into this workspace. When an external operation does bring durable content
   into the project, record an intent for that project-content change, not for
   the external operation itself.
   In multi-agent work, one open intent belongs to one worktree, or to one
   configured project root outside Git. Every agent or subagent that changes
   durable project content in the same root first re-anchors and continues its
   matching open intent; agents working in separate worktrees hold separate
   intents. An agent that only receives another agent's changes through Git or
   into a shared worktree records no receiving intent and lets \`verify\` expose
   misalignment; handoff files are exempt while ignored or otherwise kept
   outside durable project content and require an intent when promoted into it.
   Size an intent to the smallest unit that leaves the tree self-consistent
   and can be verified on its own.
2. **Execute only the intent.** Scope change? Close the current intent
   (\`driftseal end -s partial|abandoned -n "<why>"\`) and \`driftseal begin\` a new one.
3. **Reconcile, verify, then close**: for a linked intent, first reconcile every
   declared decision as described below. For an acceptance-bound intent, inspect the
   exact command shown by \`driftseal status\`, then run \`driftseal verify\` to execute it
   and bind its exit status to the current Git-visible workspace contents. A command
   sourced from the repository intent log is untrusted and requires
   \`--allow-tracked-command\` after inspection; locally parked commands do not.
   An intent without \`--accept\` uses its declared check directly. Then run
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<optional context for the next agent>"\`.
   DriftSeal rejects \`completed\` when machine verification failed, never ran, or
   the workspace changed after it. Ignored files are outside the workspace fingerprint.
   Outside a Git worktree, only the recorded exit status is available.
   Never report success without closing the intent.
   Before closing a linked intent as \`completed\` or \`partial\`, reconcile every
   declared decision with \`driftseal decision update <id> --status <status> --note "<why>"\`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   To revise a decision's prose, edit the file, then run \`decision update\` to
   record the new content hash. Do not edit a decision after reconciling it;
   run \`decision update\` again so the final content hash is recorded.
   Interrupted reconciliation is recovered
   by the next linked \`decision update\` or successful \`end\`. Closing as
   \`failed\` or \`abandoned\` cancels pending recovery for that intent.
   Git operations remain subject to normal authorization and safety requirements
   even though they do not require an intent. Any content change made while
   preparing a Git operation still requires an intent when it meets the
   durable-project-content rule in step 1.
4. **Re-anchor after context loss**: run \`driftseal status\` and \`driftseal log --last 3\` before
   doing anything else. The open intent is the source of truth: resume it when its
   objective still matches the current task; otherwise close it (\`partial\` or
   \`abandoned\`, with a note) and \`begin\` a new one. Taking over work in the
   same root from another agent is the same re-anchor: resume the open intent
   when its objective still matches.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
\`.intent-log/events.jsonl\` (or anything under \`$DRIFTSEAL_HOME\`) directly; use
\`driftseal\` commands or the MCP tools. Retire meaningless closed records with
\`driftseal reclaim [id ...] --reason "<why>"\` — it appends a marker, never
deletes log lines; \`driftseal unreclaim <id> --reason "<why>"\` restores one.
After a merge collision, run \`driftseal absorb\` rather than editing the log;
if both sides still have an open intent, add \`--abandon-theirs\` or
\`--abandon-ours\`.

Log: \`.intent-log/events.jsonl\` (override with \`$DRIFTSEAL_HOME\`); ${localLog ? 'this repository keeps the log local and untracked; do not add it to commits.' : 'commit it with the code.'}
${INTENT_PROTOCOL_END}`;
}

function previousIntentProtocolBlock(version, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  const v13 = v1IntentProtocolBlock(version, language, localLog)
    .replace(
      '1. **Write intent first**, before changing durable project content:\n' +
        '   `driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"`.\n' +
        '   Repeat `--accept` when completion has multiple independently observable criteria.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Record intents for changes intended to persist in the project: edits to code,\n' +
        '   configuration, documentation, dependencies, and equivalent project files,\n' +
        '   whether or not the project is inside a Git worktree. Everything else is\n' +
        '   exempt: Git operations (Git maintains their history — inspection, branch\n' +
        '   and worktree management, staging, commits, merges, rebases, cherry-picks,\n' +
        '   tags, and pushes); single-step commands that only build or check work\n' +
        '   already done, such as compiling or running tests; auxiliary file or shell\n' +
        '   operations whose results remain outside durable project content (for example\n' +
        '   an rsync scratch copy or temp scaffolding); and state changes to a remote\n' +
        '   machine or the local environment that do not write durable project content\n' +
        '   into this workspace. When an external operation does bring durable content\n' +
        '   into the project, record an intent for that project-content change, not for\n' +
        '   the external operation itself.\n' +
        '   In multi-agent work, one open intent belongs to one worktree, or to one\n' +
        '   configured project root outside Git. Every agent or subagent that changes\n' +
        '   durable project content in the same root first re-anchors and continues its\n' +
        '   matching open intent; agents working in separate worktrees hold separate\n' +
        "   intents. An agent that only receives another agent's changes through Git or\n" +
        '   into a shared worktree records no receiving intent and lets `verify` expose\n' +
        '   misalignment; handoff files are exempt while ignored or otherwise kept\n' +
        '   outside durable project content and require an intent when promoted into it.\n' +
        '   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.',
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other non-Git change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"`.\n' +
        '   Repeat `--accept` when completion has multiple independently observable criteria.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Git operations never need an intent and are not included in the intent log;\n' +
        '   Git maintains their history. This includes inspection, branch and worktree\n' +
        '   management, staging, commits, merges, rebases, cherry-picks, tags, and pushes.\n' +
        '   A command whose result can be reconstructed from Git state (for example a\n' +
        '   patch file regenerated from a commit range, or a scratch harness that\n' +
        '   re-runs) needs no intent; content that will be committed and cannot be\n' +
        '   reconstructed (for example a .gitignore edit) does.\n' +
        '   Single-step commands that only build or check work already done, such as\n' +
        '   compiling or running tests, also need no intent.\n' +
        '   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.'
    )
    .replace(
      '   Git operations remain subject to normal authorization and safety requirements\n' +
        '   even though they do not require an intent. Any content change made while\n' +
        '   preparing a Git operation still requires an intent when it meets the\n' +
        '   durable-project-content rule in step 1.',
      '   Git operations remain subject to normal authorization and safety requirements\n' +
        '   even though they do not require an intent. Any non-Git content change made while\n' +
        '   preparing a Git operation does require a new intent, per the step 1 test.'
    )
    .replace(
      '4. **Re-anchor after context loss**: run `driftseal status` and `driftseal log --last 3` before\n' +
        '   doing anything else. The open intent is the source of truth: resume it when its\n' +
        '   objective still matches the current task; otherwise close it (`partial` or\n' +
        '   `abandoned`, with a note) and `begin` a new one. Taking over work in the\n' +
        '   same root from another agent is the same re-anchor: resume the open intent\n' +
        '   when its objective still matches.',
      '4. **Re-anchor after context loss**: run `driftseal status` and `driftseal log --last 3` before\n' +
        '   doing anything else. The open intent is the source of truth: resume it when its\n' +
        '   objective still matches the current task; otherwise close it (`partial` or\n' +
        '   `abandoned`, with a note) and `begin` a new one.'
    );
  if (version >= 13) return v13;
  const v12 = v13
    .replace(
      '   `driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"`.\n' +
        '   Repeat `--accept` when completion has multiple independently observable criteria.',
      '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.'
    )
    .replace(
      '3. **Reconcile, verify, then close**: for a linked intent, first reconcile every\n' +
        '   declared decision as described below. For an acceptance-bound intent, inspect the\n' +
        '   exact command shown by `driftseal status`, then run `driftseal verify` to execute it\n' +
        '   and bind its exit status to the current Git-visible workspace contents. A command\n' +
        '   sourced from the repository intent log is untrusted and requires\n' +
        '   `--allow-tracked-command` after inspection; locally parked commands do not.\n' +
        '   An intent without `--accept` uses its declared check directly. Then run\n' +
        '   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<optional context for the next agent>"`.\n' +
        '   DriftSeal rejects `completed` when machine verification failed, never ran, or\n' +
        '   the workspace changed after it. Ignored files are outside the workspace fingerprint.\n' +
        '   Outside a Git worktree, only the recorded exit status is available.',
      '3. **Verify, then close**: run the declared verification, then\n' +
        '   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<what the verification showed, written for the next agent>"`.'
    );
  if (version >= 12) return v12;
  const v11 = v12
    .replace(
      '-r "<what the verification showed, written for the next agent>"',
      '-r "<verify output>"'
    )
    .replace(
      '\n   A command whose result can be reconstructed from Git state (for example a\n' +
        '   patch file regenerated from a commit range, or a scratch harness that\n' +
        '   re-runs) needs no intent; content that will be committed and cannot be\n' +
        '   reconstructed (for example a .gitignore edit) does.',
      ''
    )
    .replace(
      '\n   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.',
      ''
    )
    .replace(
      '   To revise a decision\'s prose, edit the file, then run `decision update` to\n' +
        '   record the new content hash. Do not edit a decision after reconciling it;\n' +
        '   run `decision update` again so the final content hash is recorded.\n' +
        '   Interrupted reconciliation is recovered',
      '   Do not edit a decision after reconciling it; run `decision update` again so\n' +
        '   the final content hash is recorded. Interrupted reconciliation is recovered'
    )
    .replace(
      'preparing a Git operation does require a new intent, per the step 1 test.',
      'preparing a Git operation does require a new intent.'
    );
  if (version >= 11) return v11;
  const v10 = stripIntentLogLanguage(v11, language);
  if (version >= 10) return v10;
  const v9 = v10.replace(
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other non-Git change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Git operations never need an intent and are not included in the intent log;\n' +
        '   Git maintains their history. This includes inspection, branch and worktree\n' +
        '   management, staging, commits, merges, rebases, cherry-picks, tags, and pushes.\n' +
        '   Single-step commands that only build or check work already done, such as\n' +
        '   compiling or running tests, also need no intent.',
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Single-step commands that only build, check, or record work already done\n' +
        '   (compiling, running tests, `git add`/`git commit`) need no intent.'
    )
    .replace(
      '   Git operations remain subject to normal authorization and safety requirements\n' +
        '   even though they do not require an intent. Any non-Git content change made while\n' +
        '   preparing a Git operation does require a new intent.',
      '   An authorized Git commit that only stages and records the verified changes and\n' +
        '   just-closed log finalizes that round without requiring a new intent. Any content\n' +
        '   change made while preparing the commit does require a new intent.'
    );
  if (version >= 9) return v9;
  const v8 = v9.replace(
    '\nAfter a merge collision, run `driftseal absorb` rather than editing the log;\n' +
      'if both sides still have an open intent, add `--abandon-theirs` or\n' +
      '`--abandon-ours`.',
    ''
  );
  if (version >= 8) return v8;
  const v7 = v8.replace(
    '\nThis `AGENTS.md` protocol is the source of truth. Use the `driftseal` CLI by\n' +
      'default; the companion skill only helps discover and resume the workflow, while\n' +
      'MCP and lifecycle hooks are optional adapters.\n',
    ''
  );
  if (version >= 7) return v7;
  const v6 = v7.replace(
    'doing anything else. The open intent is the source of truth: resume it when its\n' +
      '   objective still matches the current task; otherwise close it (`partial` or\n' +
      '   `abandoned`, with a note) and `begin` a new one.',
    'doing anything else. The open intent is the source of truth.'
  );
  if (version >= 6) return v6;
  const v5 = v6.replace(
    '\n**Log access goes only through DriftSeal.** Never read, edit, move, or delete\n' +
      '`.intent-log/events.jsonl` (or anything under `$DRIFTSEAL_HOME`) directly; use\n' +
      '`driftseal` commands or the MCP tools. Retire meaningless closed records with\n' +
      '`driftseal reclaim [id ...] --reason "<why>"` — it appends a marker, never\n' +
      'deletes log lines; `driftseal unreclaim <id> --reason "<why>"` restores one.\n',
    ''
  );
  if (version >= 5) return v5;
  const v4 = v5.replace(
    '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
      '   making any other change that may need a rollback:\n' +
      '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
      '   Add one `--decision <id>` for each existing decision this round may change.\n' +
      '   Single-step commands that only build, check, or record work already done\n' +
      '   (compiling, running tests, `git add`/`git commit`) need no intent.',
    '1. **Write intent first**, before modifying a file or running a mutating command:\n' +
      '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
      '   Add one `--decision <id>` for each existing decision this round may change.'
  );
  if (version >= 4) return v4;
  return v4.replace(
    '   by the next linked `decision update` or successful `end`. Closing as\n' +
      '   `failed` or `abandoned` cancels pending recovery for that intent.',
    '   by the next `decision update` or `end`.'
  );
}

function protocolEol(content, eol) {
  return eol === '\n' ? content : content.replace(/\n/g, eol);
}

function decisionProtocolBlock(version = PROTOCOL_VERSION, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${DECISION_PROTOCOL_MARKER}
<!-- driftseal-decisions-version: ${version} -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: decision log

Record a MADR only when it preserves context that the outcome log and Git cannot
recover: rejected or deferred paths worth revisiting, non-obvious rationale for
long-lived or costly-to-reverse choices, and deprecated or superseded decisions.
Do not record routine, local, readily reversible choices.

${decisionLogLanguageParagraph(language)}

\`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"\`

Use \`proposed|accepted|rejected|deferred|deprecated|superseded\` statuses. Link
existing MADRs from \`begin\` or \`extend\`, then reconcile each linked record
with \`driftseal decision update\` before successful or partial closure. After a
merge, \`driftseal absorb\` remaps colliding ids; it never auto-merges concurrent
edits of a shared MADR.
${localLog ? 'Keep `.seal/madr/` local and untracked.' : 'Commit `.seal/madr/` with the code.'}
${DECISION_PROTOCOL_END}`;
}

function v1DecisionProtocolBlock(version = 14, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${DECISION_PROTOCOL_MARKER}
<!-- driftseal-decisions-version: ${version} -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history: a rejected or deferred path worth
revisiting, non-obvious rationale behind a long-lived or costly-to-reverse accepted
choice, or a deprecated or superseded decision. Do not record routine, local,
readily reversible choices.

${decisionLogLanguageParagraph(language)}

\`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"\`

Add one \`--driver\`, \`--option\`, or \`--consequence\` flag per item. Use
\`--status proposed|accepted|rejected|deferred|deprecated|superseded\` when needed.
Use \`proposed\` for a choice still under active consideration. Use \`deferred\`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with \`driftseal decision list --status deferred --count\`,
then review them with \`driftseal decision list --status deferred\`.
When an intent declares an existing decision with \`--decision <id>\`, use
\`driftseal decision update\` to record its status transition or explicit confirmation.
After a merge, colliding decision ids are remapped with \`driftseal absorb\`;
concurrent edits of a shared decision are not auto-merged.
${localLog ? 'Keep `.decision-log/` local and untracked; do not add it to commits.' : 'Commit `.decision-log/` with the code.'}
${DECISION_PROTOCOL_END}`;
}

function legacyIntentProtocolBlock() {
  return `${INTENT_PROTOCOL_MARKER}

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (\`driftseal\`) to prevent agent drift. Every work round:

1. **Write intent first**, before modifying a file or running a mutating command:
   \`driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"\`.
   Add one \`--decision <id>\` for each existing decision this round may change.
2. **Execute only the intent.** Scope change? Close the current intent
   (\`driftseal end -s partial|abandoned -n "<why>"\`) and \`driftseal begin\` a new one.
3. **Verify, then close**: run the declared verification, then
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<verify output>"\`.
   Never report success without closing the intent.
   Before closing a linked intent as \`completed\` or \`partial\`, reconcile every
   declared decision with \`driftseal decision update <id> --status <status> --note "<why>"\`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   An authorized Git commit that only stages and records the verified changes and
   just-closed log finalizes that round without requiring a new intent. Any content
   change made while preparing the commit does require a new intent.
4. **Re-anchor after context loss**: run \`driftseal status\` and \`driftseal log --last 3\` before
   doing anything else. The open intent is the source of truth.

Log: \`.intent-log/events.jsonl\` (override with \`$DRIFTSEAL_HOME\`); commit it with the code.`;
}

function legacyDecisionProtocolBlock() {
  return `${DECISION_PROTOCOL_MARKER}

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history: a rejected or deferred path worth
revisiting, non-obvious rationale behind a long-lived or costly-to-reverse accepted
choice, or a deprecated or superseded decision. Do not record routine, local,
readily reversible choices.

\`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --option "<considered option>" --consequence "<result>"\`

Add one \`--driver\`, \`--option\`, or \`--consequence\` flag per item. Use
\`--status proposed|accepted|rejected|deferred|deprecated|superseded\` when needed.
Use \`proposed\` for a choice still under active consideration. Use \`deferred\`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with \`driftseal decision list --status deferred --count\`,
then review them with \`driftseal decision list --status deferred\`.
When an intent declares an existing decision with \`--decision <id>\`, use
\`driftseal decision update\` to record its status transition or explicit confirmation.
Commit \`.decision-log/\` with the code.`;
}

function previousDecisionProtocolBlock(version, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  if (version >= 11) return v1DecisionProtocolBlock(version, language, localLog);
  const v10 = stripDecisionLogLanguage(v1DecisionProtocolBlock(version, language, localLog), language);
  if (version >= 9) return v10;
  const v8 = v10.replace(
    '\nAfter a merge, colliding decision ids are remapped with `driftseal absorb`;\n' +
      'concurrent edits of a shared decision are not auto-merged.',
    ''
  );
  if (version >= 7) return v8;
  return v8.replace(' --driver "<decision driver>"', '');
}

function upgradeManagedBlock({
  content,
  marker,
  endMarker,
  versionPattern,
  replacement,
  knownManagedBlocks,
  knownLegacyBlocks,
}) {
  const start = content.indexOf(marker);
  if (start === -1) return { content, found: false };
  if (content.indexOf(marker, start + marker.length) !== -1) {
    fail(`cannot safely upgrade multiple protocol blocks beginning with ${marker}`);
  }

  const managedEnd = content.indexOf(endMarker, start);
  if (managedEnd !== -1) {
    const after = managedEnd + endMarker.length;
    const block = content.slice(start, after);
    const versionMatch = block.match(versionPattern);
    if (!versionMatch) {
      fail(`cannot safely upgrade unversioned managed protocol block beginning with ${marker}`);
    }
    const version = versionMatch[1];
    if (!/^\d+(?:\.\d+)?$/.test(version)) {
      fail(`invalid protocol version in block beginning with ${marker}`);
    }
    const futureV2 = version.includes('.') && (() => {
      const [major, minor] = version.split('.').map(Number);
      const [supportedMajor, supportedMinor] = PROTOCOL_VERSION.split('.').map(Number);
      return major > supportedMajor || (major === supportedMajor && minor > supportedMinor);
    })();
    const futureV1 = !version.includes('.') && Number(version) > 14;
    if (futureV2 || futureV1) {
      fail(
        `protocol version ${version} requires a newer DriftSeal client (supported: ${PROTOCOL_VERSION})`
      );
    }
    // A block counts as unmodified when it matches the replacement or a known
    // released block, either exactly or once log-language declarations are
    // neutralized. The lenient key comparison covers every candidate, not just
    // the replacement, so `--lang` still repairs a block whose comment and
    // prose disagree even when the same run also toggles local log mode.
    const key = protocolBlockKey(block);
    const recognized =
      block === replacement ||
      knownManagedBlocks.includes(block) ||
      key === protocolBlockKey(replacement) ||
      knownManagedBlocks.some((known) => key === protocolBlockKey(known));
    if (!recognized) {
      fail(`cannot safely upgrade customized protocol block beginning with ${marker}`);
    }
    return {
      content: content.slice(0, start) + replacement + content.slice(after),
      found: true,
    };
  }

  const legacy = knownLegacyBlocks.find((block) => content.startsWith(block, start));
  if (legacy) {
    return {
      content: content.slice(0, start) + replacement + content.slice(start + legacy.length),
      found: true,
    };
  }
  fail(`cannot safely upgrade customized protocol block beginning with ${marker}`);
}

const MCP_TARGETS = ['codex', 'kimi-code', 'opencode', 'claude-code', 'cursor'];
const MCP_SCOPES = ['project', 'global'];
const MCP_TARGET_LABELS = {
  codex: 'Codex',
  'kimi-code': 'Kimi Code',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};

function mcpInstallUsage() {
  return 'usage: driftseal mcp install --target <codex|kimi-code|opencode|claude-code|cursor> [--scope project|global] [--root <repository>] [--force]';
}

function mcpConfigLocation(target, scope, root) {
  const home = os.homedir();
  if (target === 'codex') {
    const configDir = scope === 'project' ? path.join(root, '.codex') : path.join(home, '.codex');
    return { configDir, configFile: path.join(configDir, 'config.toml') };
  }
  if (target === 'kimi-code') {
    const userDir = process.env.KIMI_CODE_HOME
      ? path.resolve(process.env.KIMI_CODE_HOME)
      : path.join(home, '.kimi-code');
    const configDir = scope === 'project' ? path.join(root, '.kimi-code') : userDir;
    return { configDir, configFile: path.join(configDir, 'mcp.json') };
  }
  if (target === 'opencode') {
    const configDir =
      scope === 'project' ? root : path.join(home, '.config', 'opencode');
    return { configDir, configFile: path.join(configDir, 'opencode.json') };
  }
  if (target === 'claude-code') {
    const configDir = scope === 'project' ? root : home;
    return {
      configDir,
      configFile: path.join(configDir, scope === 'project' ? '.mcp.json' : '.claude.json'),
    };
  }
  if (target === 'cursor') {
    const configDir = scope === 'project' ? path.join(root, '.cursor') : path.join(home, '.cursor');
    return { configDir, configFile: path.join(configDir, 'mcp.json') };
  }
  fail(`unsupported MCP target "${target}"`);
}

function parseMcpInstallRequest(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--help' || subcommand === '-h') throw new HelpRequested('mcp');
  if (subcommand !== 'install') {
    fail(mcpInstallUsage());
  }
  const { positionals, flags } = parseArgs(rest, {
    target: 'single',
    scope: 'single',
    root: 'single',
    force: 'boolean',
  }, 'mcp');
  if (positionals.length > 0 || !flags.target) {
    fail(mcpInstallUsage());
  }

  const target = flags.target.toLowerCase();
  if (!MCP_TARGETS.includes(target)) {
    fail(`unsupported MCP target "${flags.target}" (expected: ${MCP_TARGETS.join(', ')})`);
  }
  const scope = (flags.scope || 'project').toLowerCase();
  if (!MCP_SCOPES.includes(scope)) {
    fail(`invalid MCP install scope "${scope}" (expected: ${MCP_SCOPES.join(', ')})`);
  }
  const root = repositoryRoot(flags.root || process.cwd());
  const { configDir, configFile } = mcpConfigLocation(target, scope, root);
  return {
    target,
    targetLabel: MCP_TARGET_LABELS[target],
    scope,
    root,
    force: Boolean(flags.force),
    configDir,
    configFile,
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexMcpSection(root, eol = '\n') {
  return [
    '[mcp_servers.driftseal]',
    'command = "driftseal-mcp"',
    `args = ["--root", ${tomlString(root)}]`,
  ].join(eol);
}

function codexMcpSectionRange(content) {
  const header = /^[ \t]*\[mcp_servers\.(?:driftseal|"driftseal"|'driftseal')\][ \t]*(?:#.*)?\r?$/gm;
  const matches = [...content.matchAll(header)];
  if (matches.length > 1) fail('Codex config contains duplicate mcp_servers.driftseal tables');
  if (matches.length === 0) return null;

  const start = matches[0].index;
  const nextTable = /^[ \t]*\[[^\r\n]+\][ \t]*(?:#.*)?\r?$/gm;
  nextTable.lastIndex = start + matches[0][0].length;
  const next = nextTable.exec(content);
  return { start, end: next ? next.index : content.length };
}

function installCodexMcp(request) {
  const { configDir, configFile, force, root, scope, target, targetLabel } = request;
  const existed = fs.existsSync(configFile);
  const current = existed ? fs.readFileSync(configFile, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const section = codexMcpSection(root, eol);
  const range = codexMcpSectionRange(current);
  let updated;

  if (!range) {
    const separator =
      current.length === 0
        ? ''
        : current.endsWith(eol + eol)
          ? ''
          : current.endsWith(eol)
            ? eol
            : eol + eol;
    updated = current + separator + section + eol;
  } else {
    const existingSection = current.slice(range.start, range.end).trim();
    if (existingSection.replace(/\r\n/g, '\n') === section.replace(/\r\n/g, '\n')) {
      printLine(`DriftSeal MCP is already installed for ${targetLabel} (${scope}): ${configFile}`);
      return { changed: false, target, scope, root, configFile };
    }
    if (!force) {
      fail(
        `Codex config already defines mcp_servers.driftseal in ${configFile}; ` +
          're-run with --force to replace that table'
      );
    }
    const trailing = range.end < current.length ? eol + eol : eol;
    updated = current.slice(0, range.start) + section + trailing + current.slice(range.end);
  }

  ensureDirectoryDurable(configDir);
  atomicWriteFile(configFile, updated);
  printLine(`Installed DriftSeal MCP for ${targetLabel} (${scope}): ${configFile}`);
  printLine(`Repository root: ${root}`);
  return { changed: true, target, scope, root, configFile };
}

function jsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonConfig(configFile, targetLabel, target) {
  if (!fs.existsSync(configFile)) {
    return target === 'opencode' ? { $schema: 'https://opencode.ai/config.json' } : {};
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    fail(`${targetLabel} config is not valid JSON: ${configFile}`);
  }
  if (!jsonObject(parsed)) fail(`${targetLabel} config must contain a JSON object: ${configFile}`);
  return parsed;
}

function jsonMcpDefinition(target, root) {
  if (target === 'opencode') {
    return {
      containerKey: 'mcp',
      server: { type: 'local', command: ['driftseal-mcp', '--root', root] },
    };
  }
  return {
    containerKey: 'mcpServers',
    server: { command: 'driftseal-mcp', args: ['--root', root] },
  };
}

function installJsonMcp(request) {
  const { configDir, configFile, force, root, scope, target, targetLabel } = request;
  const config = readJsonConfig(configFile, targetLabel, target);
  const { containerKey, server } = jsonMcpDefinition(target, root);
  if (config[containerKey] === undefined) config[containerKey] = {};
  if (!jsonObject(config[containerKey])) {
    fail(`${targetLabel} config field ${containerKey} must be a JSON object: ${configFile}`);
  }

  const existing = config[containerKey].driftseal;
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(server)) {
      printLine(`DriftSeal MCP is already installed for ${targetLabel} (${scope}): ${configFile}`);
      return { changed: false, target, scope, root, configFile };
    }
    if (!force) {
      fail(
        `${targetLabel} config already defines the driftseal MCP server in ${configFile}; ` +
          're-run with --force to replace that entry'
      );
    }
  }

  config[containerKey].driftseal = server;
  ensureDirectoryDurable(configDir);
  atomicWriteFile(configFile, JSON.stringify(config, null, 2) + '\n');
  printLine(`Installed DriftSeal MCP for ${targetLabel} (${scope}): ${configFile}`);
  printLine(`Repository root: ${root}`);
  return { changed: true, target, scope, root, configFile };
}

function installMcp(request) {
  return request.target === 'codex' ? installCodexMcp(request) : installJsonMcp(request);
}

const SKILL_NAME = 'use-driftseal';

/*
 * Every skill tree DriftSeal has ever bundled, oldest first, as skillTreeDigest
 * hashes. `skill install` treats a directory matching one of these as its own
 * earlier output and upgrades it in place; anything else is someone's local
 * skill that only --force may replace. Append the new digest whenever the
 * bundled skill changes, otherwise the next release cannot upgrade this one;
 * the "bundled use-driftseal skill is a known release" test fails until you do.
 */
const SKILL_RELEASE_DIGESTS = new Set([
  'e996627c96edc7c09599bc454c4225a416aa89e50aef14d4dd569dd21454e882', // 1b76215 initial commit
  '5f702545b18e117bafcea669b48cdb3b31c98079f97eaa084fd3b4ceff9500e8', // 5c2ec74 intents only for rollback-worthy changes
  '77f6365590ff181ee6be003930dd1696c363e213368de0f4e89962555af3fabe', // 56380a8 local MCP server
  'b7e2310eaf20b50b5ec28531471965607e7e070a4f58263e29408b2cd5cdfb11', // 1cc77f6 reclaim markers
  '08bc63b8dcf0f4f078252179a3fc2ca4ef2632ecb5b9dfe3782a452c3202c2c4', // de4a8a1 skill slimmed into a usage guide
  '8523459ff81cf0b97a36b30d216956a58d8a3b3b9760f455d7ea334604da335a', // 3a1d6e0 protocol v7 resume semantics
  'cc98b9348ec222320bfcd285ba3f1f499a42d15b31e9b1d83c35f0206b2d5ba9', // ca16785 CLI-first skill integration
  '0fd870f8c1b81f8386d986d64742679d56cd1d317c02890830c81876eb9227d6', // da8afd2 1.1.0 absorb
  '72ddea79940bdf2bce66d491888f11423ae1bd383e1b511028fda617e6f6fb27', // f395778 1.1.6 parked intents
  'df8bc7035de1a19faf307c92f9bb0f4052e683d1a94881c2c5d5cbef48b67568', // dc9899d 1.1.7 parked intents in absorb
  '42a0549dff21483c0508ea4a79658e7bf05cd98f8af4238c95dbd23cdcde7ee6', // 2.0.0 outcome workflow
  '38e89060ff37ecdd663eae73a3e0c646d6bb220fc8232a5762356375d84ba69b', // 2.1.0 outcome lanes
  'b4b2cc27ea71c5777b5eb9b67d861fbe1da43f31ab5d422d6a877e0cad592493', // 2.1.0 lane re-anchor recovery
]);

function skillInstallUsage() {
  return 'usage: driftseal skill install --target <codex|kimi-code|opencode|claude-code|cursor> [--scope project|global] [--root <repository>] [--force]';
}

function skillInstallLocation(target, scope, root) {
  const home = os.homedir();
  const roots = {
    codex: {
      project: path.join(root, '.agents', 'skills'),
      global: path.join(home, '.agents', 'skills'),
    },
    'kimi-code': {
      project: path.join(root, '.kimi-code', 'skills'),
      global: path.join(home, '.kimi-code', 'skills'),
    },
    opencode: {
      project: path.join(root, '.opencode', 'skills'),
      global: path.join(home, '.config', 'opencode', 'skills'),
    },
    'claude-code': {
      project: path.join(root, '.claude', 'skills'),
      global: path.join(home, '.claude', 'skills'),
    },
    cursor: {
      project: path.join(root, '.cursor', 'skills'),
      global: path.join(home, '.cursor', 'skills'),
    },
  };
  const skillsDir = roots[target][scope];
  return { skillsDir, skillDir: path.join(skillsDir, SKILL_NAME) };
}

function parseSkillInstallRequest(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--help' || subcommand === '-h') throw new HelpRequested('skill');
  if (subcommand !== 'install') fail(skillInstallUsage());
  const { positionals, flags } = parseArgs(rest, {
    target: 'single',
    scope: 'single',
    root: 'single',
    force: 'boolean',
  }, 'skill');
  if (positionals.length > 0 || !flags.target) fail(skillInstallUsage());

  const target = flags.target.toLowerCase();
  if (!MCP_TARGETS.includes(target)) {
    fail(`unsupported skill target "${flags.target}" (expected: ${MCP_TARGETS.join(', ')})`);
  }
  const scope = (flags.scope || 'project').toLowerCase();
  if (!MCP_SCOPES.includes(scope)) {
    fail(`invalid skill install scope "${scope}" (expected: ${MCP_SCOPES.join(', ')})`);
  }
  const root = repositoryRoot(flags.root || process.cwd());
  return {
    target,
    targetLabel: MCP_TARGET_LABELS[target],
    scope,
    root,
    force: Boolean(flags.force),
    ...skillInstallLocation(target, scope, root),
  };
}

/*
 * Identifies a skill tree by its contents alone: relative paths joined with "/"
 * and file bytes, never file modes or timestamps. The digest therefore stays
 * stable across platforms, checkouts, and npm tarballs, which is what lets
 * SKILL_RELEASE_DIGESTS recognize a skill DriftSeal installed earlier.
 */
function skillTreeDigest(directory) {
  if (!fs.existsSync(directory)) return null;
  const digest = crypto.createHash('sha256');

  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      digest.update(`directory\0${relative}\0`);
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (stat.isFile()) {
      digest.update(`file\0${relative}\0`);
      digest.update(fs.readFileSync(current));
      digest.update('\0');
      return;
    }
    if (stat.isSymbolicLink()) {
      digest.update(`symlink\0${relative}\0${fs.readlinkSync(current)}\0`);
      return;
    }
    digest.update(`other\0${relative}\0`);
  }

  visit(directory, '');
  return digest.digest('hex');
}

function preserveRegularFileModes(source, destination) {
  for (const name of fs.readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isDirectory()) {
      preserveRegularFileModes(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      fs.chmodSync(destinationPath, stat.mode & 0o777);
    }
  }
}

function installSkill(request) {
  const { force, root, scope, skillDir, skillsDir, target, targetLabel } = request;
  const sourceDir = path.join(__dirname, '..', 'skills', SKILL_NAME);
  if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    fail(`bundled ${SKILL_NAME} skill is missing from this DriftSeal installation: ${sourceDir}`);
  }

  const sourceDigest = skillTreeDigest(sourceDir);
  const existingDigest = skillTreeDigest(skillDir);
  if (existingDigest === sourceDigest) {
    printLine(`${SKILL_NAME} skill is already installed for ${targetLabel} (${scope}): ${skillDir}`);
    return { changed: false, target, scope, root, skillDir };
  }
  // An untouched skill from an earlier DriftSeal upgrades on its own; only a
  // skill this installer never wrote needs the operator to confirm with --force.
  const upgraded = existingDigest !== null && SKILL_RELEASE_DIGESTS.has(existingDigest);
  if (existingDigest !== null && !upgraded && !force) {
    fail(
      `${targetLabel} already has a ${SKILL_NAME} skill DriftSeal did not install at ${skillDir}; ` +
        're-run with --force to replace it'
    );
  }

  ensureDirectoryDurable(skillsDir);
  const suffix = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const temporary = path.join(skillsDir, `.${SKILL_NAME}.tmp-${suffix}`);
  const backup = path.join(skillsDir, `.${SKILL_NAME}.backup-${suffix}`);
  let movedExisting = false;
  try {
    fs.cpSync(sourceDir, temporary, { recursive: true, errorOnExist: true });
    preserveRegularFileModes(sourceDir, temporary);
    if (existingDigest !== null) {
      fs.renameSync(skillDir, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, skillDir);
    if (movedExisting) fs.rmSync(backup, { recursive: true, force: true });
    fsyncDirectory(skillsDir);
  } catch (err) {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
      if (movedExisting && !fs.existsSync(skillDir) && fs.existsSync(backup)) {
        fs.renameSync(backup, skillDir);
      }
    } catch {}
    throw err;
  }

  printLine(
    `${upgraded ? 'Upgraded' : 'Installed'} ${SKILL_NAME} skill for ` +
      `${targetLabel} (${scope}): ${skillDir}`
  );
  if (scope === 'project') printLine(`Repository root: ${root}`);
  return { changed: true, upgraded, target, scope, root, skillDir };
}

const HOOK_TARGETS = ['kimi-code', 'claude-code', 'codex'];
const HOOK_EVENTS = ['prompt', 'stop'];
const HOOK_EVENT_NAMES = { prompt: 'UserPromptSubmit', stop: 'Stop' };

function hookUsage() {
  return (
    'usage: driftseal hook install --target <kimi-code|claude-code|codex> [--scope project|global] [--root <repository>] [--force]\n' +
    '       driftseal hook prompt|stop [--format plain|claude-code]'
  );
}

function hookConfigLocation(target, scope, root) {
  const home = os.homedir();
  if (target === 'kimi-code') {
    const userDir = process.env.KIMI_CODE_HOME
      ? path.resolve(process.env.KIMI_CODE_HOME)
      : path.join(home, '.kimi-code');
    if (scope === 'project') {
      fail('Kimi Code hooks support only global scope; re-run with --scope global');
    }
    const configDir = userDir;
    return { configDir, configFile: path.join(configDir, 'config.toml') };
  }
  if (target === 'claude-code') {
    const configDir = scope === 'project' ? path.join(root, '.claude') : path.join(home, '.claude');
    return { configDir, configFile: path.join(configDir, 'settings.json') };
  }
  if (target === 'codex') {
    const configDir = scope === 'project' ? path.join(root, '.codex') : path.join(home, '.codex');
    return { configDir, configFile: path.join(configDir, 'hooks.json') };
  }
  fail(`unsupported hook target "${target}"`);
}

function parseHookInstallRequest(argv) {
  const { positionals, flags } = parseArgs(argv, {
    target: 'single',
    scope: 'single',
    root: 'single',
    force: 'boolean',
  }, 'hook install');
  if (positionals.length > 0 || !flags.target) {
    fail(hookUsage());
  }

  const target = flags.target.toLowerCase();
  if (!HOOK_TARGETS.includes(target)) {
    fail(`unsupported hook target "${flags.target}" (expected: ${HOOK_TARGETS.join(', ')})`);
  }
  const scope = (flags.scope || 'project').toLowerCase();
  if (!MCP_SCOPES.includes(scope)) {
    fail(`invalid hook install scope "${scope}" (expected: ${MCP_SCOPES.join(', ')})`);
  }
  const root = repositoryRoot(flags.root || process.cwd());
  const { configDir, configFile } = hookConfigLocation(target, scope, root);
  return {
    target,
    targetLabel: MCP_TARGET_LABELS[target],
    scope,
    root,
    force: Boolean(flags.force),
    configDir,
    configFile,
  };
}

function hookCommand(event, format) {
  return format === 'plain' ? `driftseal hook ${event}` : `driftseal hook ${event} --format ${format}`;
}

function kimiHookSection(eol = '\n') {
  const blocks = HOOK_EVENTS.map((event) =>
    [
      '[[hooks]]',
      `event = "${HOOK_EVENT_NAMES[event]}"`,
      `command = ${tomlString(hookCommand(event, 'plain'))}`,
      'timeout = 5',
    ].join(eol)
  );
  return blocks.join(eol + eol);
}

/** Ranges of [[hooks]] tables whose command invokes driftseal hook. */
function driftsealHookBlockRanges(content) {
  const tables = [
    ...content.matchAll(/^[ \t]*\[(?:\[[^\]\r\n]+\]|[^\]\r\n]+)\][ \t]*(?:#.*)?\r?$/gm),
  ];
  const ranges = [];
  for (let index = 0; index < tables.length; index++) {
    const start = tables[index].index;
    const end = index + 1 < tables.length ? tables[index + 1].index : content.length;
    const body = content.slice(start, end);
    if (
      /^[ \t]*\[\[hooks\]\]/.test(tables[index][0]) &&
      /^[ \t]*command[ \t]*=[ \t]*["']driftseal\s+hook\s/m.test(body)
    ) {
      ranges.push({ start, end, body });
    }
  }
  return ranges;
}

function installKimiHook(request) {
  const { configDir, configFile, force, scope, target, targetLabel } = request;
  const existed = fs.existsSync(configFile);
  const current = existed ? fs.readFileSync(configFile, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const section = kimiHookSection(eol);
  const ranges = driftsealHookBlockRanges(current);
  let updated;

  if (ranges.length === 0) {
    const separator =
      current.length === 0
        ? ''
        : current.endsWith(eol + eol)
          ? ''
          : current.endsWith(eol)
            ? eol
            : eol + eol;
    updated = current + separator + section + eol;
  } else {
    const existing = ranges
      .map((range) => range.body.trim().replace(/\r\n/g, '\n'))
      .join('\n\n');
    if (ranges.length === HOOK_EVENTS.length && existing === section.replace(/\r\n/g, '\n')) {
      printLine(`DriftSeal hooks are already installed for ${targetLabel} (${scope}): ${configFile}`);
      return { changed: false, target, scope, configFile };
    }
    if (!force) {
      fail(
        `${targetLabel} config already defines driftseal hooks in ${configFile}; ` +
          're-run with --force to replace those entries'
      );
    }
    let stripped = current;
    for (const range of [...ranges].reverse()) {
      stripped = stripped.slice(0, range.start) + stripped.slice(range.end);
    }
    stripped = stripped.replace(new RegExp(`(?:\\r?\\n){3,}$`), eol + eol);
    const separator =
      stripped.length === 0 || stripped.endsWith(eol + eol)
        ? ''
        : stripped.endsWith(eol)
          ? eol
          : eol + eol;
    updated = stripped + separator + section + eol;
  }

  ensureDirectoryDurable(configDir);
  atomicWriteFile(configFile, updated);
  printLine(`Installed DriftSeal hooks for ${targetLabel} (${scope}): ${configFile}`);
  return { changed: true, target, scope, configFile };
}

/**
 * Hook groups per JSON-config target. Codex gets only the prompt hook. Claude
 * Code also gets Stop, but its output is a UI-only systemMessage so the hook
 * does not force another model turn.
 */
function jsonHookGroups(target) {
  if (target === 'codex') {
    return {
      [HOOK_EVENT_NAMES.prompt]: [
        { hooks: [{ type: 'command', command: hookCommand('prompt', 'plain') }] },
      ],
    };
  }
  const groups = {};
  for (const event of HOOK_EVENTS) {
    groups[HOOK_EVENT_NAMES[event]] = [
      { hooks: [{ type: 'command', command: hookCommand(event, 'claude-code') }] },
    ];
  }
  return groups;
}

/** True when every hook group in the list is one of ours. */
function isDriftsealHookGroup(group) {
  return (
    jsonObject(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (hook) => jsonObject(hook) && typeof hook.command === 'string' && /\bdriftseal hook\s/.test(hook.command)
    )
  );
}

function installJsonHook(request) {
  const { configDir, configFile, force, scope, target, targetLabel } = request;
  const config = readJsonConfig(configFile, targetLabel, target);
  if (config.hooks === undefined) config.hooks = {};
  if (!jsonObject(config.hooks)) {
    fail(`${targetLabel} config field hooks must be a JSON object: ${configFile}`);
  }

  const groups = jsonHookGroups(target);
  let changed = false;
  let conflict = false;
  for (const eventName of Object.keys(groups)) {
    const existing = config.hooks[eventName];
    if (existing === undefined) {
      changed = true;
      continue;
    }
    if (!Array.isArray(existing)) {
      fail(`${targetLabel} config field hooks.${eventName} must be an array: ${configFile}`);
    }
    const ours = existing.filter(isDriftsealHookGroup);
    if (ours.length === 0) {
      changed = true;
    } else if (ours.some((group) => JSON.stringify(group) !== JSON.stringify(groups[eventName][0]))) {
      changed = true;
      conflict = true;
    }
  }

  if (!changed) {
    printLine(`DriftSeal hooks are already installed for ${targetLabel} (${scope}): ${configFile}`);
    return { changed: false, target, scope, configFile };
  }
  if (conflict && !force) {
    fail(
      `${targetLabel} config already defines driftseal hooks in ${configFile}; ` +
        're-run with --force to replace those entries'
    );
  }

  for (const [eventName, group] of Object.entries(groups)) {
    const existing = config.hooks[eventName] || [];
    config.hooks[eventName] = [...existing.filter((entry) => !isDriftsealHookGroup(entry)), ...group];
  }
  ensureDirectoryDurable(configDir);
  atomicWriteFile(configFile, JSON.stringify(config, null, 2) + '\n');
  printLine(`Installed DriftSeal hooks for ${targetLabel} (${scope}): ${configFile}`);
  return { changed: true, target, scope, configFile };
}

function installHook(request) {
  return request.target === 'kimi-code' ? installKimiHook(request) : installJsonHook(request);
}

function hookLogFile() {
  if (process.env.DRIFTSEAL_HOME) {
    const configured = logFile();
    return fs.existsSync(configured) ? configured : null;
  }
  let current = path.resolve(process.cwd());
  const root = gitWorktreeRoot(current);
  while (true) {
    const candidate = path.join(current, '.seal', 'outcomes', 'events.jsonl');
    if (fs.existsSync(candidate)) return candidate;
    if (root && path.resolve(root) === current) {
      const park = worktreeInProgressFile(current);
      if (park && fs.existsSync(park)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Advisory reminder text; null when no ancestor has an outcome log yet. */
function hookReminder(event, { readOnly = false } = {}) {
  const file = hookLogFile();
  if (!file) return null;
  if (event === 'prompt') {
    return (
      'DriftSeal reminder: if this round will change durable project content in this workspace ' +
      '(code, configuration, documentation, dependencies), ' +
      'begin an outcome first: driftseal begin "<coherent outcome>" --accept "<observable result>" ' +
      '--verify "<command>". ' +
      'Questions, read-only exploration, single-step checks, temporary work outside durable ' +
      'project content, and external state changes that do not write project content here need ' +
      'no outcome — skip this reminder when it does not apply.'
    );
  }
  const open = openOutcome(fold(readEvents({ file, readOnly })));
  if (open) {
    const reconciliation = open.decisions.length > 0 ? 'reconcile every linked decision, then ' : '';
    const verification = open.acceptance.length > 0
      ? `${reconciliation}inspect and run driftseal verify, then close it with driftseal end`
      : `${reconciliation}run the declared verification, then close it with driftseal end`;
    return (
      `DriftSeal reminder: outcome ${open.id} is still in_progress: "${open.outcome}". ` +
      `If its work is done, ${verification}; ` +
      'if this turn was unrelated, ignore this reminder.'
    );
  }
  return (
    'DriftSeal reminder: no outcome is open. If this round changed files without one, consider ' +
    'whether the work should have been logged; ignore this reminder when nothing changed.'
  );
}

function runHookReminder(event, argv, { readOnly = false } = {}) {
  const { positionals, flags } = parseArgs(argv, { format: 'single' }, `hook ${event}`);
  if (positionals.length > 0) fail(hookUsage());
  const format = (flags.format || 'plain').toLowerCase();
  if (!['plain', 'claude-code'].includes(format)) {
    fail(`unsupported hook output format "${flags.format}" (expected: plain, claude-code)`);
  }

  // Hooks must never block the agent: any failure exits quietly with no output.
  let reminder = null;
  try {
    reminder = hookReminder(event, { readOnly });
  } catch {
    reminder = null;
  }
  if (reminder === null) return { changed: false, event, format };
  if (format === 'claude-code') {
    const output =
      event === 'stop'
        ? { systemMessage: reminder }
        : {
            hookSpecificOutput: {
              hookEventName: HOOK_EVENT_NAMES[event],
              additionalContext: reminder,
            },
          };
    printLine(JSON.stringify(output));
  } else {
    printLine(reminder);
  }
  return { changed: true, event, format };
}

function gitCaptureRaw(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function gitCapture(args, cwd = process.cwd()) {
  const output = gitCaptureRaw(args, cwd);
  return output === null ? null : output.trim();
}

/**
 * Capture a single git value without touching the payload: only the one
 * newline git appends is removed, so paths that begin or end with whitespace
 * survive intact (`gitCapture` would trim them away).
 */
function gitCaptureLine(args, cwd = process.cwd()) {
  const output = gitCaptureRaw(args, cwd);
  if (output === null) return null;
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function isGitWorkTree(cwd = process.cwd()) {
  return gitCapture(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

/**
 * Hash the material Git-visible workspace contents rather than trusting the
 * current commit alone. Any tracked or untracked (non-ignored) content change
 * makes the verification stale.
 * The outcome event log is excluded because recording verification and closure
 * necessarily appends to it.
 */
function workspaceFingerprint(cwd = process.cwd()) {
  if (!isGitWorkTree(cwd)) return null;
  const root = gitCaptureLine(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return null;
  const listing = gitCaptureRaw(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    root
  );
  if (listing === null) return null;

  const excludedFile = path.resolve(logFile());
  const excludedLockPrefixes = [logDir(), decisionDir()].map((directory) =>
    path.resolve(directory, '.driftseal.lock')
  );
  const files = [...new Set(listing.split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const target = path.resolve(root, relative);
    if (
      target === excludedFile ||
      excludedLockPrefixes.some(
        (prefix) => target === prefix || target.startsWith(`${prefix}${path.sep}`) || target.startsWith(`${prefix}.stale.`)
      )
    ) {
      continue;
    }
    hash.update(relative, 'utf8');
    hash.update('\0');
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (err) {
      if (err.code === 'ENOENT') {
        hash.update('missing\0');
        continue;
      }
      throw err;
    }
    hash.update(String(stat.mode & 0o111));
    hash.update('\0');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(fs.readlinkSync(target));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(fs.readFileSync(target));
    } else if (stat.isDirectory()) {
      hash.update('directory\0');
      hash.update(gitCapture(['rev-parse', 'HEAD'], target) || 'no-head');
      hash.update('\0');
      hash.update(gitCaptureRaw(['status', '--porcelain=v1', '-z'], target) || '');
    } else {
      hash.update('other\0');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Warn (without mutating the index or .gitignore) when local log mode is on
 * but the default log paths are still tracked by git. The log directories are
 * resolved relative to the init cwd (init writes ./AGENTS.md there), so a
 * nested init checks its own logs rather than the repository root's.
 *
 * Paths are read from `ls-files -z` with `:(literal)` pathspecs because git's
 * human-readable listing C-quotes non-ASCII names and treats `*?[\` as
 * wildcards. The printed remediation uses the fixed name `.seal` and is meant
 * to be run from this directory: git resolves
 * those pathspecs against the init cwd, so the command stays paste-safe in
 * POSIX shells, cmd.exe, and PowerShell without embedding the repo-relative
 * prefix or any shell quoting.
 */
function warnIfDefaultLogsTracked(cwd = process.cwd()) {
  if (!isGitWorkTree(cwd)) return;
  const root = gitCaptureLine(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return;
  const prefix = gitCaptureLine(['rev-parse', '--show-prefix'], cwd);
  if (prefix === null) return;
  const logNames = ['.seal'];
  const logDirs = logNames.map((name) => `${prefix}${name}`);
  const listing = gitCaptureRaw(
    ['ls-files', '-z', '--', ...logDirs.map((name) => `:(literal)${name}`)],
    root
  );
  if (!listing) return;
  const files = listing.split('\0').filter((file) => file.length > 0);
  const trackedNames = logNames.filter((name) => {
    const dir = `${prefix}${name}`;
    return files.some((file) => file === dir || file.startsWith(`${dir}/`));
  });
  if (trackedNames.length === 0) return;
  const tracked = trackedNames.map((name) => `${prefix}${name}`);
  printLine(
    `warning: local log mode is on, but ${tracked.join(' and ')} ` +
      `${tracked.length === 1 ? 'is' : 'are'} still tracked by git; run ` +
      `\`git rm -r --cached -- ${trackedNames.join(' ')}\` from this directory ` +
      'and add them to .gitignore to keep the logs local'
  );
}

function gitOtherHead(cwd = process.cwd()) {
  return (
    gitCapture(['rev-parse', '--verify', 'MERGE_HEAD'], cwd) ||
    gitCapture(['rev-parse', '--verify', 'REBASE_HEAD'], cwd) ||
    gitCapture(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], cwd)
  );
}

function gitMergeBase(cwd = process.cwd()) {
  const other = gitOtherHead(cwd);
  if (!other) return null;
  return gitCapture(['merge-base', 'HEAD', other], cwd);
}

function gitMergeBaseFor(left, right, cwd = process.cwd()) {
  return gitCapture(['merge-base', left, right], cwd);
}

function gitReadFile(treeish, file, cwd = process.cwd()) {
  return gitCaptureRaw(['show', `${treeish}:${file}`], cwd);
}

function gitFindCommitForFile(file, repositoryPath, cwd = process.cwd()) {
  const blob = gitCapture(['hash-object', file], cwd);
  const history = gitCapture(['rev-list', '--all', '--reflog', '--', repositoryPath], cwd);
  if (!blob || !history) return null;
  for (const commit of history.split('\n')) {
    if (gitCapture(['rev-parse', `${commit}:${repositoryPath}`], cwd) === blob) return commit;
  }
  return null;
}

function gitMergeParents(cwd = process.cwd()) {
  const line = gitCapture(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd);
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length !== 3) return null;
  return { ours: parts[1], theirs: parts[2] };
}

function gitDecisionIds(treeish, cwd = process.cwd()) {
  const out = gitCapture(['ls-tree', '-r', '--name-only', treeish, '.seal/madr'], cwd);
  if (!out) return new Set();
  const ids = new Set();
  for (const file of out.split('\n')) {
    const match = path.basename(file).match(/^(\d{4,})-.*\.md$/);
    if (match) ids.add(normalizeDecisionId(match[1]));
  }
  return ids;
}

function gitDecisionEntries(treeish, cwd = process.cwd()) {
  const out = gitCapture(['ls-tree', '-r', '--name-only', treeish, '.seal/madr'], cwd);
  if (!out) return [];
  const entries = [];
  for (const file of out.split('\n')) {
    const name = path.basename(file);
    const match = name.match(/^(\d{4,})-.*\.md$/);
    if (!match) continue;
    const content = gitReadFile(treeish, file, cwd);
    if (content === null) continue;
    entries.push({
      id: normalizeDecisionId(match[1]),
      file: name,
      path: file,
      content,
    });
  }
  return entries;
}

function gitOutcomeRecords(treeish, cwd = process.cwd()) {
  const content = gitReadFile(treeish, '.seal/outcomes/events.jsonl', cwd);
  return content === null ? [] : parseJsonlRecords(content, `${treeish}:.seal/outcomes/events.jsonl`);
}

function canonicalEvent(event) {
  return Object.fromEntries(
    Object.entries(event)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function eventsEqual(left, right) {
  return JSON.stringify(canonicalEvent(left)) === JSON.stringify(canonicalEvent(right));
}

function commonPrefixLength(ours, theirs) {
  let index = 0;
  while (
    index < ours.length &&
    index < theirs.length &&
    eventsEqual(ours[index].event, theirs[index].event)
  ) {
    index += 1;
  }
  return index;
}

function recordsHavePrefix(records, prefix) {
  if (prefix.length > records.length) return false;
  return prefix.every((record, index) => eventsEqual(record.event, records[index].event));
}

function parseConflictContent(content) {
  if (!/^<<<<<<< /m.test(content)) return null;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const ours = [];
  const theirs = [];
  let mode = 'base';
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('<<<<<<< ')) {
      mode = 'ours';
      continue;
    }
    if (line.startsWith('||||||| ')) {
      mode = 'ancestor';
      continue;
    }
    if (line.startsWith('=======')) {
      mode = 'theirs';
      continue;
    }
    if (line.startsWith('>>>>>>> ')) {
      mode = 'base';
      continue;
    }
    if (mode === 'base') {
      ours.push(line);
      theirs.push(line);
    } else if (mode === 'ours') {
      ours.push(line);
    } else if (mode === 'theirs') {
      theirs.push(line);
    }
  }
  return { oursText: ours.join(eol), theirsText: theirs.join(eol) };
}

function collectDecisionIdsFromEvents(events) {
  const ids = new Set();
  for (const event of events) {
    if (Array.isArray(event.decisions)) {
      for (const id of event.decisions) ids.add(normalizeDecisionId(id));
    }
    if (event.decisionId) ids.add(normalizeDecisionId(event.decisionId));
  }
  return ids;
}

function nextDecisionIdFromIds(ids) {
  if (ids.size === 0) return '0001';
  let max = 0n;
  for (const id of ids) {
    const value = BigInt(id);
    if (value > max) max = value;
  }
  return String(max + 1n).padStart(4, '0');
}

function decisionSlugFromFile(file) {
  return file.replace(/^\d+-/, '').replace(/\.md$/, '');
}

function rewriteDecisionId(content, newId) {
  return content.replace(/^# [0-9]+\. /, `# ${String(BigInt(newId))}. `);
}

function splitDuplicateDecisions(entries) {
  const ours = [];
  const theirs = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) theirs.push(entry);
    else {
      seen.add(entry.id);
      ours.push(entry);
    }
  }
  return { ours, theirs };
}

function hasDuplicateDecisionIds(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) return true;
    seen.add(entry.id);
  }
  return false;
}

function isOutcomeStart(event) {
  return event.type === 'begin' || event.type === 'import';
}

function hasDuplicateOutcomeStarts(records) {
  const seen = new Set();
  for (const record of records) {
    if (!isOutcomeStart(record.event)) continue;
    if (seen.has(record.event.id)) return true;
    seen.add(record.event.id);
  }
  return false;
}

function planDecisionAbsorb({ oursEntries, theirsEntries, baseEntries = [], baseIds = new Set() }) {
  const mappings = [];
  const copies = [];
  const decisionMap = new Map();
  const hashMap = new Map();
  const usedIds = new Set(oursEntries.map((entry) => entry.id));
  const oursById = new Map();
  const baseById = new Map();
  for (const entry of oursEntries) {
    if (!oursById.has(entry.id)) oursById.set(entry.id, entry);
  }
  for (const entry of baseEntries) {
    if (!baseById.has(entry.id)) baseById.set(entry.id, entry);
  }

  for (const entry of theirsEntries) {
    const ours = oursById.get(entry.id);
    const theirsContent = entry.content !== undefined ? entry.content : fs.readFileSync(entry.path, 'utf8');
    if (!ours) {
      copies.push({
        fromFile: entry.file,
        toFile: entry.file,
        content: theirsContent,
        removeFile: null,
      });
      usedIds.add(entry.id);
      continue;
    }
    const oursContent = ours.content !== undefined ? ours.content : fs.readFileSync(ours.path, 'utf8');
    const oursHash = contentHash(oursContent);
    const theirsHash = contentHash(theirsContent);
    if (oursHash === theirsHash) {
      if (ours.file !== entry.file) {
        copies.push({
          fromFile: entry.file,
          toFile: ours.file,
          content: oursContent,
          removeFile: entry.file,
        });
      }
      continue;
    }

    const base = baseById.get(entry.id);
    if (base) {
      const baseContent = base.content !== undefined ? base.content : fs.readFileSync(base.path, 'utf8');
      const baseHash = contentHash(baseContent);
      if (oursHash === baseHash) {
        copies.push({
          fromFile: entry.file,
          toFile: ours.file,
          content: theirsContent,
          removeFile: entry.file !== ours.file ? entry.file : null,
        });
        continue;
      }
      if (theirsHash === baseHash) {
        if (entry.file !== ours.file) {
          copies.push({
            fromFile: entry.file,
            toFile: ours.file,
            content: oursContent,
            removeFile: entry.file,
          });
        }
        continue;
      }
      fail(
        `decision ${entry.id} was edited on both sides; resolve ${ours.file} manually before absorbing`
      );
    }
    if (baseIds.has(entry.id)) {
      fail(
        `decision ${entry.id} was edited on both sides or its base content is unavailable; ` +
          `resolve ${ours.file} manually before absorbing`
      );
    }
    const newId = nextDecisionIdFromIds(usedIds);
    usedIds.add(newId);
    decisionMap.set(entry.id, newId);
    mappings.push({ kind: 'decision', from: entry.id, to: newId });
    const rewritten = rewriteDecisionId(theirsContent, newId);
    const originalHash = contentHash(theirsContent);
    const rewrittenHash = contentHash(rewritten);
    if (originalHash !== rewrittenHash) hashMap.set(originalHash, rewrittenHash);
    copies.push({
      fromFile: entry.file,
      toFile: `${newId}-${decisionSlugFromFile(entry.file)}.md`,
      content: rewritten,
      removeFile: entry.file !== ours.file ? entry.file : null,
    });
  }
  return { decisionMap, hashMap, mappings, copies };
}

function remapEvent(event, intentMap, decisionMap, hashMap = new Map()) {
  const next = { ...event };
  if (intentMap.has(event.id)) next.id = intentMap.get(event.id);
  if (Array.isArray(next.decisions) && next.decisions.length > 0) {
    next.decisions = next.decisions.map((id) => {
      const normalized = normalizeDecisionId(id);
      return decisionMap.get(normalized) || id;
    });
  }
  if (next.decisionId) {
    const normalized = normalizeDecisionId(next.decisionId);
    if (decisionMap.has(normalized)) next.decisionId = decisionMap.get(normalized);
  }
  for (const field of ['oldHash', 'newHash', 'fileHash']) {
    if (typeof next[field] === 'string' && hashMap.has(next[field])) {
      next[field] = hashMap.get(next[field]);
    }
  }
  return next;
}

function rebindV2ContractHashes(records) {
  const contracts = new Map();
  return records.map((record) => {
    let event = record.event;
    if (event.type === 'begin' && event.logVersion === LOG_VERSION) {
      contracts.set(event.id, newOutcomeRecord(event));
    } else if (event.type === 'extend' && event.logVersion === LOG_VERSION) {
      const state = contracts.get(event.id);
      if (state) {
        state.extensions.push({
          extension: event.extension,
          acceptance: event.acceptance,
          verify: event.verify,
          decisions: event.decisions,
        });
        state.acceptance = [...new Set([...state.acceptance, ...event.acceptance])];
        if (event.verify) state.verify = event.verify;
        state.decisions = [...new Set([...state.decisions, ...event.decisions])];
        state.contractHash = outcomeContractHash(state);
      }
    } else if (event.logVersion === LOG_VERSION &&
      (event.type === 'verify' || (event.type === 'end' && event.status === 'completed'))) {
      const state = contracts.get(event.id);
      if (state && event.contractHash !== state.contractHash) {
        event = { ...event, contractHash: state.contractHash };
      }
    }
    return event === record.event ? record : { event };
  });
}

function dropDuplicateLaneAdds(oursEvents, theirsRecords) {
  const seen = new Set();
  for (const event of oursEvents) {
    if (event.type === 'lane_add') seen.add(event.lane);
  }
  return theirsRecords.filter((record) => {
    if (record.event.type !== 'lane_add') return true;
    if (seen.has(record.event.lane)) return false;
    seen.add(record.event.lane);
    return true;
  });
}

function remapTheirsRecords(theirsNew, oursUsedEvents, decisionMap, hashMap = new Map()) {
  const intentMap = new Map();
  const mappings = [];
  const used = [...oursUsedEvents];
  const records = theirsNew.map((record) => {
    let event = record.event;
    if (isOutcomeStart(event) && used.some((item) => isOutcomeStart(item) && item.id === event.id)) {
      const { date } = parseOutcomeId(event.id);
      const newId = nextIdForDate(date, used);
      intentMap.set(event.id, newId);
      mappings.push({ kind: 'outcome', from: event.id, to: newId });
    }
    event = remapEvent(event, intentMap, decisionMap, hashMap);
    used.push(event);
    return { event };
  });
  return { records: rebindV2ContractHashes(records), mappings };
}

function repairDuplicateOutcomeRecords(records, decisionMap, hashMap = new Map()) {
  const seenBegins = new Set();
  const seenLanes = new Set();
  const intentMap = new Map();
  const used = [];
  const mappings = [];
  const result = [];
  let incomingSide = false;
  for (const record of records) {
    let event = record.event;
    if (event.type === 'lane_add') {
      if (seenLanes.has(event.lane)) continue;
      seenLanes.add(event.lane);
    }
    if (isOutcomeStart(event) && seenBegins.has(event.id)) {
      incomingSide = true;
      const { date } = parseOutcomeId(event.id);
      const newId = nextIdForDate(date, used);
      intentMap.set(event.id, newId);
      mappings.push({ kind: 'outcome', from: event.id, to: newId });
    } else if (isOutcomeStart(event)) {
      seenBegins.add(event.id);
    }
    const remapped = remapEvent(
      event,
      intentMap,
      incomingSide ? decisionMap : new Map(),
      incomingSide ? hashMap : new Map()
    );
    const changed = remapped !== event && JSON.stringify(remapped) !== JSON.stringify(event);
    result.push(changed ? { event: remapped } : record);
    used.push(result.at(-1).event);
  }
  return { records: rebindV2ContractHashes(result), mappings, incomingSide };
}

function serializeRecords(records) {
  if (records.length === 0) return '';
  return `${records.map((record) => record.raw || JSON.stringify(record.event)).join('\n')}\n`;
}

function writeJsonl(file, records) {
  ensureDirectoryDurable(path.dirname(file));
  atomicWriteFile(file, serializeRecords(records));
}

function applyDecisionCopies(copies, dryRun) {
  if (dryRun || copies.length === 0) return;
  ensureDirectoryDurable(decisionDir());
  for (const item of copies) {
    atomicWriteFile(path.join(decisionDir(), item.toFile), item.content);
    if (item.removeFile && item.removeFile !== item.toFile) {
      const stale = path.join(decisionDir(), item.removeFile);
      if (fs.existsSync(stale)) {
        fs.unlinkSync(stale);
        fsyncDirectory(decisionDir());
      }
    }
  }
}

function countAbsorbedOutcomes(records) {
  return records.filter((record) => ['begin', 'import'].includes(record.event.type)).length;
}

function printAbsorbReport({ mappings, abandoned, outcomeCount }) {
  const remappedOutcomes = mappings.filter((mapping) => mapping.kind === 'outcome').length;
  const remappedDecisions = mappings.filter((mapping) => mapping.kind === 'decision').length;
  printLine(
    `absorbed ${outcomeCount} outcome(s), remapped ${remappedOutcomes} outcome id(s), ${remappedDecisions} decision id(s)`
  );
  for (const mapping of mappings) {
    const side = mapping.side || 'theirs';
    if (mapping.kind === 'outcome') printLine(`${mapping.from} (${side}) -> ${mapping.to}`);
    else printLine(`decision ${mapping.from} (${side}) -> ${mapping.to}`);
  }
  if (abandoned) printLine(`abandoned ${abandoned} during absorb`);
}

function abandonOpenIntent(records, targetId, side) {
  records.push({
    event: {
      logVersion: LOG_VERSION,
      schemaVersion: DEFAULT_WRITE_SCHEMA_VERSION,
      type: 'end',
      id: targetId,
      ts: new Date().toISOString(),
      status: 'abandoned',
      note: `abandoned during absorb (--abandon-${side})`,
      verifyResult: null,
      head: gitCapture(['rev-parse', 'HEAD']),
    },
  });
  return targetId;
}

function resolveOpenIntents(
  result,
  oursRecords,
  theirsRecords,
  abandon,
  { allowConflict = false, overlay = [], parkedOpen = null } = {}
) {
  const oursOpen = openOutcome(fold(oursRecords.map((record) => record.event)));
  const theirsOpen = openOutcome(fold(theirsRecords.map((record) => record.event)));
  try {
    openOutcome(fold([...result, ...overlay].map((record) => record.event)));
    return { abandoned: null, conflict: false, parkedClosed: false };
  } catch (err) {
    if (!(err instanceof DriftSealError) || !/multiple outcomes in progress/.test(err.message)) {
      throw err;
    }
    if (abandon === 'theirs' && theirsOpen) {
      return {
        abandoned: abandonOpenIntent(result, theirsOpen.id, 'theirs'),
        conflict: false,
        parkedClosed: false,
      };
    }
    // A parked intent is local by construction, so --abandon-ours targets it before the log.
    if (abandon === 'ours' && parkedOpen) {
      return {
        abandoned: abandonOpenIntent(overlay, parkedOpen.id, 'ours'),
        conflict: false,
        parkedClosed: true,
      };
    }
    if (abandon === 'ours' && oursOpen) {
      return {
        abandoned: abandonOpenIntent(result, oursOpen.id, 'ours'),
        conflict: false,
        parkedClosed: false,
      };
    }
    if (allowConflict) return { abandoned: null, conflict: true, parkedClosed: false };
    fail(`${err.message}; re-run with --abandon-theirs or --abandon-ours`);
  }
}

function mergeRecordStreams(ours, theirs, baseRecords) {
  const inferred = ours.slice(0, commonPrefixLength(ours, theirs));
  const prefix = baseRecords && baseRecords.length > 0 ? baseRecords : inferred;
  if (!recordsHavePrefix(ours, prefix) || !recordsHavePrefix(theirs, prefix)) {
    fail('cannot absorb: shared history does not match the base log');
  }
  return {
    base: prefix,
    oursNew: ours.slice(prefix.length),
    theirsNew: theirs.slice(prefix.length),
  };
}

function GITATTRIBUTES_MERGE_LINE() {
  return '.seal/outcomes/events.jsonl merge=driftseal';
}

function ensureGitAttributes() {
  const target = path.join(process.cwd(), '.gitattributes');
  const line = GITATTRIBUTES_MERGE_LINE();
  const legacyLine = '.intent-log/events.jsonl merge=driftseal';
  const existed = fs.existsSync(target);
  const current = existed ? fs.readFileSync(target, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  const filtered = lines.filter((entry) => entry.trim() !== legacyLine);
  if (!filtered.some((entry) => entry.trim() === line)) {
    const insertion = filtered.length > 0 && filtered.at(-1) === '' ? filtered.length - 1 : filtered.length;
    filtered.splice(insertion, 0, line);
  }
  let next = filtered.join(eol);
  if (!next.endsWith(eol)) next += eol;
  if (next === current) return { changed: false, target };
  atomicWriteFile(target, next);
  return { changed: true, target };
}

function ensureGitMergeDriver() {
  if (!isGitWorkTree()) return { changed: false, configured: false };
  const name = gitCapture(['config', '--local', '--get', 'merge.driftseal.name']);
  const driver = gitCapture(['config', '--local', '--get', 'merge.driftseal.driver']);
  const expectedName = 'DriftSeal outcome log merge';
  const expectedDriver = 'driftseal absorb --git %O %A %B';
  if (name === expectedName && driver === expectedDriver) {
    return { changed: false, configured: true };
  }
  execFileSync('git', ['config', '--local', 'merge.driftseal.name', expectedName], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['config', '--local', 'merge.driftseal.driver', expectedDriver], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { changed: true, configured: true };
}

function absorbUsage() {
  return (
    'usage: driftseal absorb [other-events.jsonl] [--decisions <dir>] [--abandon-theirs | --abandon-ours] [--dry-run]\n' +
    '   or: driftseal absorb --git <base> <ours> <theirs>'
  );
}

function loadAbsorbSide(file, label, { repairTail = false, allowMissing = false, allowLegacy = false } = {}) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return { records: [], conflict: false };
    fail(`outcome log not found: ${file}`);
  }
  let content = fs.readFileSync(file, 'utf8');
  if (repairTail && !/^<<<<<<< /m.test(content)) {
    readEvents({ file, repairTail: true });
    content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  const conflict = parseConflictContent(content);
  if (conflict) {
    return {
      ours: parseJsonlRecords(conflict.oursText, `${label} ours`, { allowLegacy }),
      theirs: parseJsonlRecords(conflict.theirsText, `${label} theirs`, { allowLegacy }),
      conflict: true,
    };
  }
  return { records: parseJsonlRecords(content, label, { allowLegacy }), conflict: false };
}

function finishAbsorb({
  result,
  oursRecords,
  theirsRecords,
  mappings,
  copies,
  abandon,
  dryRun,
  outputFile,
  outcomeCount,
  allowConflict = false,
  followupMessage = null,
}) {
  // An outcome parked in Git metadata is part of our side even though the log never saw it.
  const park = shouldAttachInProgress(outputFile) ? inProgressFile() : null;
  const plan = planInProgressOverlay(result.map((record) => record.event), park, {
    repairTail: true,
  });
  const overlay = plan && !plan.alreadyCommitted ? plan.records : [];
  const parkedOpen =
    overlay.length > 0 ? openOutcome(fold(overlay.map((record) => record.event))) : null;
  const parkMappings = plan
    ? plan.mappings.map((mapping) => ({ ...mapping, side: 'parked' }))
    : [];
  const allMappings = [...mappings, ...parkMappings];
  const { abandoned, conflict, parkedClosed } = resolveOpenIntents(
    result,
    oursRecords,
    theirsRecords,
    abandon,
    { allowConflict, overlay, parkedOpen }
  );
  // A parked overlay with nothing left open in it belongs in the tracked log, whether the
  // abandon flag just closed it or an interrupted end left it closed.
  const flushOverlay = parkedClosed || (overlay.length > 0 && !parkedOpen);
  const merged = flushOverlay ? [...result, ...overlay] : result;
  const effective = [...result, ...overlay].map((record) => record.event);
  fold(effective);
  if (!conflict) openOutcome(fold(effective));
  if (!dryRun) {
    writeJsonl(outputFile, merged);
    applyDecisionCopies(copies, dryRun);
    if (plan) {
      if (plan.alreadyCommitted || flushOverlay) discardInProgressLog(park);
      else if (plan.mappings.length > 0) writeJsonl(park, overlay);
    }
  }
  if (
    outcomeCount === 0 &&
    allMappings.length === 0 &&
    copies.length === 0 &&
    !abandoned &&
    !flushOverlay
  ) {
    printLine('nothing to absorb');
  } else {
    printAbsorbReport({
      mappings: allMappings,
      abandoned,
      outcomeCount,
    });
  }
  if (conflict) {
    printLine('multiple outcomes remain in progress; re-run with --abandon-theirs or --abandon-ours');
  }
  if (followupMessage) printLine(followupMessage);
  return {
    mappings: allMappings,
    abandoned,
    copies: copies.map((item) => item.toFile),
    outputFile,
    exitCode: conflict || followupMessage ? 1 : 0,
  };
}

function absorbFromStreams(ours, theirs, baseRecords, options) {
  const streams = mergeRecordStreams(ours, theirs, baseRecords);
  const decisionPlan = planDecisionAbsorb({
    oursEntries: options.oursDecisionEntries || [],
    theirsEntries: options.theirsDecisionEntries || [],
    baseEntries: options.baseDecisionEntries || [],
    baseIds: options.baseDecisionIds || new Set(),
  });
  const remapped = remapTheirsRecords(
    dropDuplicateLaneAdds(
      [...streams.base, ...streams.oursNew].map((record) => record.event),
      streams.theirsNew
    ),
    [...streams.base, ...streams.oursNew].map((record) => record.event),
    decisionPlan.decisionMap,
    decisionPlan.hashMap
  );
  const result = [...streams.base, ...streams.oursNew, ...remapped.records];
  return finishAbsorb({
    result,
    oursRecords: [...streams.base, ...streams.oursNew],
    theirsRecords: [...streams.base, ...remapped.records],
    mappings: [...remapped.mappings, ...decisionPlan.mappings],
    copies: decisionPlan.copies,
    abandon: options.abandon,
    dryRun: options.dryRun,
    outputFile: options.outputFile,
    allowConflict: options.allowConflict,
    followupMessage: options.followupMessage,
    outcomeCount: streams.theirsNew.filter((record) => ['begin', 'import'].includes(record.event.type)).length,
  });
}

function gitAbsorbRepairContext(records, decisionEntries) {
  const pending = gitOtherHead();
  if (pending) {
    return {
      ours: 'HEAD',
      theirs: pending,
      base: gitMergeBaseFor('HEAD', pending),
    };
  }
  if (!hasDuplicateDecisionIds(decisionEntries) && !hasDuplicateOutcomeStarts(records)) return null;
  const parents = gitMergeParents();
  if (!parents) return null;
  return {
    ...parents,
    base: gitMergeBaseFor(parents.ours, parents.theirs),
  };
}

function absorbFromGitContext(context, { abandon, dryRun, outputFile }) {
  const baseRecords = context.base ? gitOutcomeRecords(context.base) : [];
  return absorbFromStreams(
    gitOutcomeRecords(context.ours),
    gitOutcomeRecords(context.theirs),
    baseRecords,
    {
      abandon,
      dryRun,
      outputFile,
      oursDecisionEntries: gitDecisionEntries(context.ours),
      theirsDecisionEntries: gitDecisionEntries(context.theirs),
      baseDecisionEntries: context.base ? gitDecisionEntries(context.base) : [],
      baseDecisionIds: context.base
        ? gitDecisionIds(context.base)
        : collectDecisionIdsFromEvents(baseRecords.map((record) => record.event)),
    }
  );
}

function absorbLogs(otherFile, otherDecisions, { abandon, dryRun }) {
  const oursFile = logFile();
  const loaded = loadAbsorbSide(oursFile, oursFile, { repairTail: true, allowMissing: !otherFile });
  const currentDecisionEntries = !otherFile
    ? listDecisionEntries(decisionDir(), { allowDuplicates: true })
    : [];
  const gitContext = !otherFile
    ? gitAbsorbRepairContext(loaded.records || [], currentDecisionEntries)
    : null;
  if (gitContext) {
    return absorbFromGitContext(gitContext, { abandon, dryRun, outputFile: oursFile });
  }
  if (loaded.conflict) {
    const baseIds = collectDecisionIdsFromEvents(
      loaded.ours.slice(0, commonPrefixLength(loaded.ours, loaded.theirs)).map((record) => record.event)
    );
    const gitBase = gitMergeBase();
    const baseDecisionIds = gitBase ? gitDecisionIds(gitBase) : baseIds;
    return absorbFromStreams(loaded.ours, loaded.theirs, null, {
      abandon,
      dryRun,
      outputFile: oursFile,
      oursDecisionEntries: listDecisionEntries(decisionDir(), { allowDuplicates: true }),
      theirsDecisionEntries: otherDecisions
        ? listDecisionEntries(otherDecisions)
        : splitDuplicateDecisions(listDecisionEntries(decisionDir(), { allowDuplicates: true })).theirs,
      baseDecisionIds,
      baseDecisionEntries: gitBase ? gitDecisionEntries(gitBase) : [],
    });
  }

  if (!otherFile) {
    const oursEntries = currentDecisionEntries;
    const split = splitDuplicateDecisions(oursEntries);
    const gitBase = gitMergeBase();
    const decisionPlan = planDecisionAbsorb({
      oursEntries: split.ours,
      theirsEntries: split.theirs,
      baseEntries: gitBase ? gitDecisionEntries(gitBase) : [],
      baseIds: gitBase ? gitDecisionIds(gitBase) : new Set(),
    });
    const repaired = repairDuplicateOutcomeRecords(
      loaded.records,
      decisionPlan.decisionMap,
      decisionPlan.hashMap
    );
    if (decisionPlan.mappings.length > 0 && !repaired.incomingSide) {
      fail(
        'cannot determine which outcome records own the duplicate decision; ' +
          'run absorb during the merge or provide the incoming log and decision directory'
      );
    }
    const result = repaired.records;
    const mappings = [...repaired.mappings, ...decisionPlan.mappings];
    const remappedIds = new Set(
      mappings.filter((mapping) => mapping.kind === 'outcome').map((mapping) => mapping.to)
    );
    const oursRecords = result.filter((record) => !remappedIds.has(record.event.id));
    return finishAbsorb({
      result,
      oursRecords: oursRecords.length > 0 ? oursRecords : result,
      theirsRecords: result,
      mappings,
      copies: decisionPlan.copies,
      abandon,
      dryRun,
      outputFile: oursFile,
      outcomeCount: remappedIds.size,
    });
  }

  const theirs = loadAbsorbSide(otherFile, otherFile);
  if (theirs.conflict) fail(`incoming log still contains conflict markers: ${otherFile}`);
  const otherRoot = path.resolve(path.dirname(otherFile), '..', '..');
  const otherHead = isGitWorkTree(otherRoot) ? gitCapture(['rev-parse', 'HEAD'], otherRoot) : null;
  const gitBase = otherHead ? gitCapture(['merge-base', 'HEAD', otherHead]) : gitMergeBase();
  const baseDecisionIds = gitBase
    ? gitDecisionIds(gitBase)
    : collectDecisionIdsFromEvents(
        loaded.records
          .slice(0, commonPrefixLength(loaded.records, theirs.records))
          .map((record) => record.event)
      );
  return absorbFromStreams(loaded.records, theirs.records, null, {
    abandon,
    dryRun,
    outputFile: oursFile,
    oursDecisionEntries: listDecisionEntries(decisionDir()),
    theirsDecisionEntries: listDecisionEntries(otherDecisions || path.join(path.dirname(otherFile), '..', 'madr')),
    baseDecisionEntries: gitBase ? gitDecisionEntries(gitBase) : [],
    baseDecisionIds,
  });
}

function absorbGit(baseFile, oursFile, theirsFile, { abandon, dryRun }) {
  const base = loadAbsorbSide(baseFile, baseFile, { allowMissing: true, allowLegacy: true });
  const ours = loadAbsorbSide(oursFile, oursFile, { allowLegacy: true });
  const theirs = loadAbsorbSide(theirsFile, theirsFile, { allowLegacy: true });
  if (base.conflict || ours.conflict || theirs.conflict) {
    fail('git merge driver received a log that still contains conflict markers');
  }
  const otherHead =
    gitOtherHead() ||
    gitFindCommitForFile(theirsFile, '.seal/outcomes/events.jsonl') ||
    gitFindCommitForFile(theirsFile, '.intent-log/events.jsonl');
  const mergeBase = otherHead ? gitMergeBaseFor('HEAD', otherHead) : null;
  let followupMessage = null;
  if (!otherHead) {
    followupMessage =
      'incoming Git tree could not be identified safely; re-run driftseal absorb after Git stops the merge';
  } else {
    const decisionPlan = planDecisionAbsorb({
      oursEntries: gitDecisionEntries('HEAD'),
      theirsEntries: gitDecisionEntries(otherHead),
      baseEntries: mergeBase ? gitDecisionEntries(mergeBase) : [],
      baseIds: mergeBase
        ? gitDecisionIds(mergeBase)
        : collectDecisionIdsFromEvents(base.records.map((record) => record.event)),
    });
    const requiresDecisionRepair =
      decisionPlan.mappings.length > 0 ||
      decisionPlan.copies.some((copy) => copy.removeFile && copy.removeFile !== copy.toFile);
    if (requiresDecisionRepair) {
      followupMessage =
        'decision ids require worktree repair; run driftseal absorb, then stage the repaired logs';
    }
  }
  return absorbFromStreams(ours.records, theirs.records, base.records, {
    abandon,
    dryRun,
    outputFile: oursFile,
    allowConflict: !abandon,
    followupMessage,
  });
}

function appendVerificationSpawnError(file, error) {
  const stat = fs.statSync(file);
  let prefix = '';
  if (stat.size > 0) {
    const fd = fs.openSync(file, 'r');
    const lastByte = Buffer.alloc(1);
    try {
      fs.readSync(fd, lastByte, 0, 1, stat.size - 1);
    } finally {
      fs.closeSync(fd);
    }
    if (lastByte[0] !== 0x0a) prefix = '\n';
  }
  fs.appendFileSync(file, `${prefix}${error.message}\n`, 'utf8');
}

function digestAndReplayVerificationOutput(file, writer, hash) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(VERIFICATION_OUTPUT_CHUNK_BYTES);
  let bytes = 0;
  let lastCharacter = null;

  const display = (text) => {
    if (!text) return;
    writer(text);
    lastCharacter = text.at(-1);
  };

  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      bytes += count;
      display(decoder.write(chunk));
    }
    display(decoder.end());
  } finally {
    fs.closeSync(fd);
  }

  return { bytes, endsWithNewline: lastCharacter === '\n' };
}

function executeVerificationCommand(command) {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-verify-'));
  const stdoutFile = path.join(spool, 'stdout');
  const stderrFile = path.join(spool, 'stderr');
  let stdoutFd;
  let stderrFd;

  try {
    stdoutFd = fs.openSync(stdoutFile, 'wx', 0o600);
    stderrFd = fs.openSync(stderrFile, 'wx', 0o600);
    const started = process.hrtime.bigint();
    let result;
    try {
      result = spawnSync(command, {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      fs.closeSync(stdoutFd);
      stdoutFd = undefined;
      fs.closeSync(stderrFd);
      stderrFd = undefined;
    }
    const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
    if (result.error) appendVerificationSpawnError(stderrFile, result.error);

    const hash = crypto.createHash('sha256');
    const stdout = digestAndReplayVerificationOutput(stdoutFile, writeOutput, hash);
    if (stdout.bytes > 0 && !stdout.endsWithNewline) printLine();
    hash.update('\0');
    const stderr = digestAndReplayVerificationOutput(stderrFile, writeErrorOutput, hash);
    if (stderr.bytes > 0 && !stderr.endsWithNewline) printError();

    return {
      result,
      durationMs,
      outputHash: hash.digest('hex'),
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
    };
  } finally {
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    fs.rmSync(spool, { recursive: true, force: true });
  }
}

function runMachineVerification({ allowTrackedCommand = false } = {}) {
  const snapshot = withMutationLocks([logDir()], () => {
    const outcome = openOutcome(fold(readEvents({ repairTail: true })));
    if (!outcome) fail('no outcome in progress; nothing to verify');
    if (outcome.acceptance.length === 0) {
      fail(`outcome ${outcome.id} has no acceptance criteria; declare them with driftseal begin --accept`);
    }
    if (!outcome.verify) fail(`outcome ${outcome.id} has no verification command`);
    const park = inProgressFile();
    const parked = park ? parkedOpenOutcome(park) : null;
    const locallyProvenanced = hasMatchingLocalOutcomeProvenance(outcome);
    return {
      id: outcome.id,
      command: outcome.verify,
      contractHash: outcome.contractHash,
      requiresExplicitTrust:
        (!parked || parked.id !== outcome.id) && !locallyProvenanced,
    };
  });

  const displayedCommand = JSON.stringify(snapshot.command);
  printError(`verification command: ${displayedCommand}`);
  if (snapshot.requiresExplicitTrust && !allowTrackedCommand) {
    fail(
      `refusing to execute a verification command that DriftSeal cannot confirm was created locally: ${displayedCommand}\n` +
        'no matching local outcome provenance was found; ' +
        'inspect the command, then re-run with --allow-tracked-command only if you trust it'
    );
  }

  const execution = executeVerificationCommand(snapshot.command);
  const { result, durationMs, outputHash, stdoutBytes, stderrBytes } = execution;
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  const passed = exitCode === 0 && signal === null;
  const verificationEvent = {
    type: 'verify',
    id: snapshot.id,
    verificationId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    command: snapshot.command,
    contractHash: snapshot.contractHash,
    passed,
    exitCode,
    signal,
    durationMs,
    outputHash,
    stdoutBytes,
    stderrBytes,
    workspace: workspaceFingerprint(),
    head: gitCapture(['rev-parse', 'HEAD']),
  };

  const outcome = withMutationLocks([logDir()], () => {
    const events = readEvents({ repairTail: true });
    const current = openOutcome(fold(events));
    if (!current || current.id !== snapshot.id || current.verify !== snapshot.command ||
      current.contractHash !== snapshot.contractHash) {
      fail(`outcome ${snapshot.id} changed while its verification command was running`);
    }
    events.push(appendEvent(verificationEvent));
    return fold(events).find((candidate) => candidate.id === snapshot.id);
  });
  printLine(`${snapshot.id} verification ${passed ? 'passed' : 'failed'} (exit ${exitCode})`);
  return {
    outcome: publicOutcome(outcome),
    verification: publicVerification(outcome.verification),
    exitCode,
  };
}

const MIGRATION_PLAN_FORMAT = 'driftseal-v1-to-v2-plan';

function canonicalPath(file) {
  const resolved = path.resolve(file);
  const missing = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.push(path.basename(cursor));
    cursor = parent;
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.join(existing, ...missing.reverse());
}

function pathContains(parent, candidate) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveMigrationIdentityPath(location) {
  if (typeof location === 'string') return canonicalPath(location);
  if (location?.base === 'repository') return canonicalPath(path.resolve(process.cwd(), location.path));
  if (location?.base === 'absolute') return canonicalPath(location.path);
  return null;
}

function encodeMigrationIdentityPath(file) {
  const resolved = canonicalPath(file);
  const root = canonicalPath(process.cwd());
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return {
      base: 'repository',
      path: (relative || '.').split(path.sep).join('/'),
    };
  }
  return { base: 'absolute', path: resolved };
}

function defaultV1SourceLog() {
  const home = v1HomeEnv();
  if (home) {
    const configured = path.join(home, 'events.jsonl');
    if (fs.existsSync(configured)) return configured;
  }
  return path.join(process.cwd(), '.intent-log', 'events.jsonl');
}

function migrationPaths(flags = {}, { storedSource } = {}) {
  const sourceLog = canonicalPath(
    flags['source-log'] ||
      resolveMigrationIdentityPath(storedSource?.log) ||
      defaultV1SourceLog()
  );
  const sourceDecisions = canonicalPath(
    flags['source-decisions'] ||
      resolveMigrationIdentityPath(storedSource?.decisions) ||
      v1DecisionHomeEnv() ||
      path.join(process.cwd(), '.decision-log')
  );
  const destination = canonicalPath(flags.destination || sealRoot());
  for (const sourcePath of [sourceLog, sourceDecisions]) {
    if (pathContains(sourcePath, destination) || pathContains(destination, sourcePath)) {
      fail(`migration destination overlaps v1 source path: ${destination} and ${sourcePath}`);
    }
  }
  return { sourceLog, sourceDecisions, destination };
}

function legacyParkFile() {
  if (!isGitWorkTree()) return null;
  const gitPath = gitCapture(['rev-parse', '--git-path', 'driftseal-in-progress.jsonl']);
  return gitPath ? path.resolve(process.cwd(), gitPath) : null;
}

function legacyIntentLogFile() {
  return path.resolve(process.cwd(), '.intent-log', 'events.jsonl');
}

function legacyParkedIntent() {
  const park = legacyParkFile();
  if (!park || !fs.existsSync(park)) return null;
  try {
    const records = parseJsonlRecords(fs.readFileSync(park, 'utf8'), park, { allowLegacy: true });
    return openOutcome(fold(records.map((record) => record.event)));
  } catch {
    return null;
  }
}

function closeLegacyParkedIntent(status, note) {
  const parked = legacyParkedIntent();
  if (!parked) fail('no parked v1 intent to close');
  const park = legacyParkFile();
  const log = legacyIntentLogFile();
  const parkRecords = parseJsonlRecords(fs.readFileSync(park, 'utf8'), park, { allowLegacy: true });
  const logRecords = fs.existsSync(log)
    ? parseJsonlRecords(fs.readFileSync(log, 'utf8'), log, { allowLegacy: true })
    : [];
  const endEvent = {
    schemaVersion: LEGACY_EVENT_SCHEMA_VERSION,
    type: 'end',
    id: parked.id,
    ts: new Date().toISOString(),
    status,
    note: note || null,
  };
  writeJsonl(log, [
    ...logRecords,
    ...parkRecords,
    { raw: JSON.stringify(endEvent), event: normalizeEvent(endEvent, logRecords.length + parkRecords.length + 1) },
  ]);
  fs.unlinkSync(park);
  fsyncDirectory(path.dirname(park));
  const closed = fold([...logRecords, ...parkRecords].map((record) => record.event).concat(normalizeEvent(endEvent, 1)))
    .find((record) => record.id === parked.id);
  return closed || { ...parked, status, note: note || null, tsEnd: endEvent.ts };
}

function migrationDecisionFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { name: entry.name, file, bytes: fs.readFileSync(file) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function migrationMadrManifest(decisions) {
  return decisions.map((decision) => ({
    name: decision.name,
    sha256: crypto.createHash('sha256').update(decision.bytes).digest('hex'),
    bytes: decision.bytes.length,
  }));
}

function migrationSourceIdentity(snapshot) {
  return {
    log: encodeMigrationIdentityPath(snapshot.sourceLog),
    decisions: encodeMigrationIdentityPath(snapshot.sourceDecisions),
    logPresent: snapshot.sourceLogPresent,
  };
}

function migrationSourceMatchesSnapshot(source, snapshot) {
  return (
    source.logPresent === snapshot.sourceLogPresent &&
    sameResolvedPath(resolveMigrationIdentityPath(source.log), snapshot.sourceLog) &&
    sameResolvedPath(resolveMigrationIdentityPath(source.decisions), snapshot.sourceDecisions)
  );
}

function manifestDecisionId(name) {
  const match = name.match(/^(\d+)-/);
  if (!match) return null;
  try {
    return normalizeDecisionId(match[1]);
  } catch {
    return null;
  }
}

function latestMigrationReconciledHashes(events) {
  const latestReconciledHash = new Map();
  for (const record of fold(events)) {
    for (const update of record.decisionUpdates) {
      if (update.type === 'decision_reconcile_commit' && typeof update.fileHash === 'string') {
        latestReconciledHash.set(update.decisionId, update.fileHash);
      }
    }
  }
  return latestReconciledHash;
}

function validateMigrationMadrManifest(directory, manifest, events = []) {
  const latestReconciledHash = latestMigrationReconciledHashes(events);
  for (const entry of manifest) {
    const file = path.join(directory, entry.name);
    if (!fs.existsSync(file)) fail(`migrated MADR is missing: ${entry.name}`);
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const decisionId = manifestDecisionId(entry.name);
    const reconciledHash = decisionId ? latestReconciledHash.get(decisionId) : null;
    const expected = reconciledHash || entry.sha256;
    if (hash !== expected || (!reconciledHash && bytes.length !== entry.bytes)) {
      fail(`migrated MADR does not match the migration manifest: ${entry.name}`);
    }
  }
}

function migrationSourceContent(sourceLog, sourceDecisions) {
  const resolvedLog = canonicalPath(sourceLog);
  const resolvedDecisions = canonicalPath(sourceDecisions);
  const decisions = migrationDecisionFiles(resolvedDecisions);
  const sourceLogPresent = fs.existsSync(resolvedLog);
  const rawLog = sourceLogPresent ? fs.readFileSync(resolvedLog, 'utf8') : '';
  return {
    sourceLog: resolvedLog,
    sourceDecisions: resolvedDecisions,
    decisions,
    sourceLogPresent,
    rawLog,
  };
}

function hashMigrationSourceContent(content) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(migrationSourceIdentity(content)));
  hash.update('\0');
  hash.update(content.rawLog);
  const legacyHash = crypto.createHash('sha256');
  legacyHash.update(content.sourceLog);
  legacyHash.update('\0');
  legacyHash.update(content.rawLog);
  for (const decision of content.decisions) {
    hash.update('\0');
    hash.update(decision.name);
    hash.update('\0');
    hash.update(decision.bytes);
    legacyHash.update('\0');
    legacyHash.update(decision.name);
    legacyHash.update('\0');
    legacyHash.update(decision.bytes);
  }
  return {
    sourceFingerprint: hash.digest('hex'),
    legacySourceFingerprint: legacyHash.digest('hex'),
  };
}

function migrationSourceSnapshot(flags = {}, { storedSource } = {}) {
  const paths = migrationPaths(flags, { storedSource });
  const content = migrationSourceContent(paths.sourceLog, paths.sourceDecisions);
  if (!content.sourceLogPresent && content.decisions.length === 0) {
    fail(`v1 source not found: ${paths.sourceLog} or ${paths.sourceDecisions}`);
  }
  const park = legacyParkFile();
  if (park && fs.existsSync(park)) {
    fail(
      'v1 migration requires no open intent; close the parked v1 intent first:\n' +
        '  driftseal end --status abandoned --note "close parked v1 intent before migration"'
    );
  }
  const records = fold(
    parseJsonlRecords(content.rawLog, content.sourceLog, { allowLegacy: true })
      .map((record) => record.event)
  );
  if (records.some((record) => record.logVersion !== 1)) {
    fail('migration source is not a v1 intent log');
  }
  const open = records.filter((record) => record.status === 'in_progress');
  if (open.length > 0) {
    fail(`v1 migration requires every intent to be closed; still open: ${open.map((record) => record.id).join(', ')}`);
  }
  return {
    ...paths,
    ...content,
    records,
    ...hashMigrationSourceContent(content),
  };
}

function migrationInspection(snapshot) {
  return {
    format: MIGRATION_PLAN_FORMAT,
    sourceFingerprint: snapshot.sourceFingerprint,
    source: {
      log: snapshot.sourceLog,
      decisions: snapshot.sourceDecisions,
      logPresent: snapshot.sourceLogPresent,
    },
    destination: snapshot.destination,
    records: snapshot.records.map(publicOutcome),
    decisions: snapshot.decisions.map((decision) => ({ name: decision.name })),
    planSchema: {
      format: MIGRATION_PLAN_FORMAT,
      sourceFingerprint: snapshot.sourceFingerprint,
      groups: [
        {
          outcome: 'One coherent delivered outcome',
          summary: 'What the grouped v1 work ultimately achieved',
          sourceIds: ['YYYY-MM-DD-NNN'],
        },
      ],
      excluded: [
        {
          sourceId: 'YYYY-MM-DD-NNN',
          reason: 'Only already-reclaimed v1 noise may be excluded from visible outcomes',
        },
      ],
    },
  };
}

function readMigrationPlan(file, inline) {
  if (!file && !inline) fail('migration apply requires --plan <file>');
  if (file && inline) fail('migration apply accepts only one of --plan or structured plan input');
  let plan;
  try {
    plan = JSON.parse(inline || fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    fail(`cannot read migration plan: ${error.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('migration plan must be a JSON object');
  return plan;
}

function migrationFingerprints(snapshot) {
  return [snapshot.sourceFingerprint, snapshot.legacySourceFingerprint];
}

function migrationPlanDigest(sourceFingerprint, groups, excluded) {
  return contentHash(JSON.stringify({
    format: MIGRATION_PLAN_FORMAT,
    sourceFingerprint,
    groups,
    excluded,
  }));
}

function existingMigrationMatchesPlan(existing, validated, snapshot) {
  if (!migrationFingerprints(snapshot).includes(existing.sourceFingerprint)) return false;
  if (existing.planDigest === validated.planDigest) return true;
  return existing.planDigest === migrationPlanDigest(
    snapshot.legacySourceFingerprint,
    validated.groups,
    validated.excluded
  );
}

function validateMigrationPlan(plan, snapshot) {
  if (plan.format !== MIGRATION_PLAN_FORMAT) fail(`migration plan format must be ${MIGRATION_PLAN_FORMAT}`);
  if (!migrationFingerprints(snapshot).includes(plan.sourceFingerprint)) {
    fail('migration plan source fingerprint does not match the current v1 source');
  }
  if (!Array.isArray(plan.groups)) fail('migration plan groups must be an array');
  if (!Array.isArray(plan.excluded)) fail('migration plan excluded must be an array');
  const byId = new Map(snapshot.records.map((record) => [record.id, record]));
  const excluded = new Map();
  for (const item of plan.excluded) {
    if (!item || typeof item.sourceId !== 'string' || typeof item.reason !== 'string' || !item.reason.trim()) {
      fail('each migration exclusion requires sourceId and a non-empty reason');
    }
    const record = byId.get(item.sourceId);
    if (!record) fail(`migration exclusion references unknown v1 intent: ${item.sourceId}`);
    if (!record.reclaimed) fail(`only reclaimed v1 intents may be excluded: ${item.sourceId}`);
    if (excluded.has(item.sourceId)) fail(`duplicate migration exclusion: ${item.sourceId}`);
    excluded.set(item.sourceId, item.reason.trim());
  }
  const expected = snapshot.records.filter((record) => !excluded.has(record.id)).map((record) => record.id);
  const actual = [];
  const groups = plan.groups.map((group, index) => {
    if (!group || typeof group.outcome !== 'string' || !group.outcome.trim() ||
      typeof group.summary !== 'string' || !group.summary.trim() ||
      !Array.isArray(group.sourceIds) || group.sourceIds.length === 0) {
      fail(`migration group ${index + 1} requires outcome, summary, and sourceIds`);
    }
    const sourceIds = group.sourceIds.map(String);
    for (const id of sourceIds) {
      if (!byId.has(id)) fail(`migration group ${index + 1} references unknown v1 intent: ${id}`);
      if (excluded.has(id)) fail(`migration source ${id} is both grouped and excluded`);
      actual.push(id);
    }
    return { outcome: group.outcome.trim(), summary: group.summary.trim(), sourceIds };
  });
  if (actual.length !== new Set(actual).size) fail('migration groups contain a duplicate v1 intent');
  if (!isDeepStrictEqual(actual, expected)) {
    fail('migration groups must form an ordered, complete partition of all non-excluded v1 intents');
  }
  const excludedItems = [...excluded].map(([sourceId, reason]) => ({ sourceId, reason }));
  return {
    groups,
    excluded: excludedItems,
    sourceFingerprint: snapshot.sourceFingerprint,
    planDigest: migrationPlanDigest(snapshot.sourceFingerprint, groups, excludedItems),
  };
}

function storedV2Event(event) {
  return { logVersion: LOG_VERSION, schemaVersion: DEFAULT_WRITE_SCHEMA_VERSION, ...event };
}

function migrationImportEvent(snapshot, validated, group, events) {
  const byId = new Map(snapshot.records.map((record) => [record.id, record]));
  const sources = group.sourceIds.map((id) => byId.get(id));
  const first = sources[0];
  const last = sources.at(-1);
  const date = /^\d{4}-\d{2}-\d{2}/.test(first.tsBegin) ? first.tsBegin.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const decisions = [...new Set(sources.flatMap((source) => source.decisions))];
  return storedV2Event({
    type: 'import',
    id: nextIdForDate(date, events),
    ts: new Date().toISOString(),
    outcome: group.outcome,
    summary: group.summary,
    status: last.status,
    beganAt: first.tsBegin,
    endedAt: last.tsEnd,
    decisions,
    sources: sources.map(publicOutcome),
    sourceFingerprint: validated.sourceFingerprint,
    reclaimed: sources.every((source) => source.reclaimed),
    reclaimReason: sources.every((source) => source.reclaimed)
      ? sources.map((source) => source.reclaimReason).filter(Boolean).join('; ') || 'reclaimed in v1'
      : null,
    reclaimedAt: sources.every((source) => source.reclaimed) ? last.reclaimedAt : null,
    head: last.endHead || first.beginHead || null,
  });
}

function migrationMarkerEvent(snapshot, validated) {
  const byId = new Map(snapshot.records.map((record) => [record.id, record]));
  return storedV2Event({
    type: 'migration',
    id: 'v1-to-v2',
    ts: new Date().toISOString(),
    sourceFingerprint: validated.sourceFingerprint,
    planDigest: validated.planDigest,
    source: migrationSourceIdentity(snapshot),
    madrManifest: migrationMadrManifest(snapshot.decisions),
    excluded: validated.excluded.map((item) => ({
      ...item,
      source: publicOutcome(byId.get(item.sourceId)),
    })),
  });
}

function migrationEvents(snapshot, validated) {
  const events = [];
  for (const group of validated.groups) {
    events.push(migrationImportEvent(snapshot, validated, group, events));
  }
  events.push(migrationMarkerEvent(snapshot, validated));
  fold(events);
  return events;
}

function findMigrationEvent(file) {
  if (!fs.existsSync(file)) return null;
  let migration = null;
  for (const event of readEvents({ file, repairTail: false, readOnly: true })) {
    if (event.type === 'migration' && event.id === 'v1-to-v2') migration = event;
  }
  return migration;
}

function validateStagedMigration(directory, snapshot, { allowReconciled = false } = {}) {
  const stagedLog = path.join(directory, 'outcomes', 'events.jsonl');
  const events = readEvents({ file: stagedLog, readOnly: true });
  fold(events);
  if (allowReconciled) {
    validateMigrationMadrManifest(
      path.join(directory, 'madr'),
      migrationMadrManifest(snapshot.decisions),
      events
    );
    return;
  }
  for (const decision of snapshot.decisions) {
    const staged = path.join(directory, 'madr', decision.name);
    if (!fs.existsSync(staged) || !fs.readFileSync(staged).equals(decision.bytes)) {
      fail(`staged MADR does not match v1 byte-for-byte: ${decision.name}`);
    }
  }
}

function migrationRefreshPlan(destination, snapshot, validated, events) {
  const records = fold(events);
  const existingImports = records.filter((record) => record.imported);
  const sourceRecords = new Map(snapshot.records.map((record) => [record.id, record]));
  const importedBySource = new Map();
  const importedByGroup = new Map();
  for (const record of existingImports) {
    const key = JSON.stringify(record.imported.sourceIds);
    if (importedByGroup.has(key)) fail(`duplicate migrated v1 source group: ${record.imported.sourceIds.join(', ')}`);
    importedByGroup.set(key, record);
    for (const sourceId of record.imported.sourceIds) {
      if (importedBySource.has(sourceId)) fail(`v1 source was imported more than once: ${sourceId}`);
      importedBySource.set(sourceId, record);
    }
  }

  const newGroups = [];
  for (const group of validated.groups) {
    const key = JSON.stringify(group.sourceIds);
    const existing = importedByGroup.get(key);
    const overlap = group.sourceIds.filter((sourceId) => importedBySource.has(sourceId));
    if (!existing) {
      if (overlap.length > 0) {
        fail(`refreshed migration plan regroups already imported v1 sources: ${overlap.join(', ')}`);
      }
      newGroups.push(group);
      continue;
    }
    const sources = group.sourceIds.map((sourceId) => sourceRecords.get(sourceId));
    if (
      existing.outcome !== group.outcome ||
      existing.note !== group.summary ||
      !isDeepStrictEqual(existing.imported.sources, sources.map(publicOutcome))
    ) {
      fail(`refreshed migration plan changes an already imported v1 source group: ${group.sourceIds.join(', ')}`);
    }
  }
  for (const record of existingImports) {
    if (!validated.groups.some((group) => isDeepStrictEqual(group.sourceIds, record.imported.sourceIds))) {
      fail(`refreshed migration plan omits an already imported v1 source group: ${record.imported.sourceIds.join(', ')}`);
    }
  }

  const latestReconciledHash = latestMigrationReconciledHashes(events);
  const missingDecisions = [];
  for (const decision of snapshot.decisions) {
    const file = path.join(destination, 'madr', decision.name);
    if (!fs.existsSync(file)) {
      missingDecisions.push(decision);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (bytes.equals(decision.bytes)) continue;
    const decisionId = manifestDecisionId(decision.name);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!decisionId || latestReconciledHash.get(decisionId) !== hash) {
      fail(`migrated MADR conflicts with the current v1 source: ${decision.name}`);
    }
  }
  return { newGroups, missingDecisions };
}

function refreshMigration(destination, snapshot, validated, existing) {
  if (existing.source !== undefined && !migrationSourceMatchesSnapshot(existing.source, snapshot)) {
    fail('staged migration source identity does not match the current v1 source paths');
  }
  const destinationLog = path.join(destination, 'outcomes', 'events.jsonl');
  const events = readEvents({ file: destinationLog, readOnly: true });
  const refresh = migrationRefreshPlan(destination, snapshot, validated, events);
  const madrDirectory = path.join(destination, 'madr');
  ensureDirectoryDurable(madrDirectory);
  for (const decision of refresh.missingDecisions) {
    atomicWriteFile(path.join(madrDirectory, decision.name), decision.bytes);
  }
  for (const group of refresh.newGroups) {
    const event = migrationImportEvent(snapshot, validated, group, events);
    events.push(appendEventTo(destinationLog, event));
  }
  fold(events);
  appendEventTo(destinationLog, migrationMarkerEvent(snapshot, validated));
  validateStagedMigration(destination, snapshot, { allowReconciled: true });
  printLine(
    `refreshed staged v1-to-v2 migration with ${refresh.newGroups.length} additional outcome(s) ` +
    `and ${refresh.missingDecisions.length} MADR file(s)`
  );
  return {
    changed: true,
    refreshed: true,
    destination,
    sourceFingerprint: snapshot.sourceFingerprint,
    planDigest: validated.planDigest,
    importedOutcomes: refresh.newGroups.length,
    copiedDecisions: refresh.missingDecisions.length,
  };
}

function applyMigration(snapshot, validated) {
  const destination = snapshot.destination;
  const destinationLog = path.join(destination, 'outcomes', 'events.jsonl');
  if (fs.existsSync(destination)) {
    const existing = findMigrationEvent(destinationLog);
    if (existing && existingMigrationMatchesPlan(existing, validated, snapshot)) {
      validateStagedMigration(destination, snapshot, { allowReconciled: true });
      const manifest = migrationMadrManifest(snapshot.decisions);
      const source = migrationSourceIdentity(snapshot);
      if (existing.source !== undefined && !migrationSourceMatchesSnapshot(existing.source, snapshot)) {
        fail('staged migration source identity does not match the current v1 source paths');
      }
      if (
        existing.madrManifest === undefined ||
        existing.source === undefined ||
        !isDeepStrictEqual(existing.source, source) ||
        existing.sourceFingerprint !== snapshot.sourceFingerprint ||
        existing.planDigest !== validated.planDigest
      ) {
        appendEventTo(destinationLog, {
          type: 'migration',
          id: 'v1-to-v2',
          ts: new Date().toISOString(),
          sourceFingerprint: snapshot.sourceFingerprint,
          planDigest: validated.planDigest,
          source,
          madrManifest: manifest,
          excluded: existing.excluded,
        });
        printLine('upgraded the staged v1-to-v2 migration with source identity and a MADR integrity manifest');
        return {
          changed: true,
          upgraded: true,
          destination,
          sourceFingerprint: snapshot.sourceFingerprint,
          planDigest: validated.planDigest,
        };
      }
      if (!isDeepStrictEqual(existing.madrManifest, manifest)) {
        fail('staged migration MADR manifest does not match the current v1 source');
      }
      printLine('v1-to-v2 migration is already staged with the same source and plan');
      return { changed: false, destination, sourceFingerprint: snapshot.sourceFingerprint, planDigest: validated.planDigest };
    }
    if (existing) return refreshMigration(destination, snapshot, validated, existing);
    fail(`migration destination already exists with different content: ${destination}`);
  }
  ensureDirectoryDurable(path.dirname(destination));
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), `.${path.basename(destination)}.migrate-`));
  try {
    const outcomeDirectory = path.join(temporary, 'outcomes');
    const madrDirectory = path.join(temporary, 'madr');
    ensureDirectoryDurable(outcomeDirectory);
    ensureDirectoryDurable(madrDirectory);
    writeJsonl(path.join(outcomeDirectory, 'events.jsonl'), migrationEvents(snapshot, validated).map((event) => ({ event })));
    for (const decision of snapshot.decisions) {
      fs.copyFileSync(decision.file, path.join(madrDirectory, decision.name));
    }
    validateStagedMigration(temporary, snapshot);
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
    throw error;
  }
  const initResult = commands.init([]);
  printLine(`staged v1-to-v2 migration at ${destination}`);
  printLine('DriftSeal did not delete v1 data; review the staged outcome log, then remove the old paths manually.');
  return {
    changed: true,
    destination,
    sourceFingerprint: validated.sourceFingerprint,
    planDigest: validated.planDigest,
    importedOutcomes: validated.groups.length,
    excluded: validated.excluded.length,
    init: initResult,
  };
}

function gitTracksPath(target) {
  if (!isGitWorkTree()) return false;
  const root = gitWorktreeRoot();
  if (!root) return false;
  const resolved = canonicalPath(target);
  if (canonicalPath(root) !== resolved && !pathContains(root, resolved)) return false;
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  const listing = gitCaptureRaw(
    ['ls-files', '-z', '--', `:(literal)${relative}`, `:(literal)${relative}/`],
    root
  );
  if (!listing) return false;
  return listing.split('\0').some((file) => file.length > 0);
}

function displayV1RemovalPath(target) {
  const cwd = canonicalPath(process.cwd());
  const resolved = canonicalPath(target);
  const relative = path.relative(cwd, resolved).split(path.sep).join('/');
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return resolved;
}

function v1RemovalHint(snapshot) {
  const items = [];
  if (snapshot.sourceLogPresent && fs.existsSync(path.dirname(snapshot.sourceLog))) {
    items.push(path.dirname(snapshot.sourceLog));
  }
  if (fs.existsSync(snapshot.sourceDecisions)) items.push(snapshot.sourceDecisions);
  if (items.length === 0) return null;
  const tracked = items.every((item) => gitTracksPath(item));
  const shown = items.map((item) => {
    const relative = displayV1RemovalPath(item);
    return /[\s"'$]/.test(relative) ? JSON.stringify(relative) : relative;
  });
  const command = tracked && isGitWorkTree()
    ? `git rm -r -- ${shown.join(' ')}`
    : `rm -rf -- ${shown.join(' ')}`;
  return `after explicit user approval, remove the v1 source paths manually: ${command}`;
}

function checkMigration(snapshot, { sourceMissing = false } = {}) {
  const destinationLog = path.join(snapshot.destination, 'outcomes', 'events.jsonl');
  const migration = findMigrationEvent(destinationLog);
  if (!migration) fail(`no staged v1-to-v2 migration found at ${snapshot.destination}`);
  const destinationEvents = readEvents({ file: destinationLog, readOnly: true });
  fold(destinationEvents);
  const migratedMadr = path.join(snapshot.destination, 'madr');
  if (sourceMissing) {
    if (migration.source === undefined) {
      fail(
        'staged migration has no source path identity; restore the v1 source and re-run apply with the approved plan before deleting it'
      );
    }
    if (migration.madrManifest === undefined) {
      fail(
        'staged migration has no MADR integrity manifest; restore the v1 source and re-run apply with the approved plan before deleting it'
      );
    }
    validateMigrationMadrManifest(migratedMadr, migration.madrManifest, destinationEvents);
  } else {
    const expectedManifest = migrationMadrManifest(snapshot.decisions);
    validateMigrationMadrManifest(migratedMadr, expectedManifest, destinationEvents);
    if (migration.madrManifest !== undefined) {
      if (!isDeepStrictEqual(migration.madrManifest, expectedManifest)) {
        fail('staged migration MADR manifest does not match the current v1 source');
      }
      validateMigrationMadrManifest(migratedMadr, migration.madrManifest, destinationEvents);
    }
  }
  if (migration.source !== undefined && !migrationSourceMatchesSnapshot(migration.source, snapshot)) {
    fail('staged migration source identity does not match the v1 source paths used for check');
  }
  if (
    !sourceMissing &&
    ![snapshot.sourceFingerprint, snapshot.legacySourceFingerprint].includes(migration.sourceFingerprint)
  ) {
    fail('staged migration no longer matches the v1 source fingerprint');
  }
  if (sourceMissing) {
    printLine('v1-to-v2 migration complete; v1 source paths are absent and the v2 log is valid');
  } else {
    printLine('v1-to-v2 migration is valid and staged side-by-side with v1');
    const hint = v1RemovalHint(snapshot);
    if (hint) printLine(hint);
  }
  return {
    valid: true,
    complete: sourceMissing,
    destination: snapshot.destination,
    sourceFingerprint: migration.sourceFingerprint,
    planDigest: migration.planDigest,
  };
}

function listLaneSnapshot(records) {
  const catalog = records.lanes || emptyLaneCatalog();
  const { current, missing } = resolveCurrentLane(records);
  const lanes = [...catalog.keys()].map((name) => {
    const summary = laneSummary(records, name);
    return {
      ...publicLane(summary),
      current: name === current,
    };
  });
  return { current, missingCurrentLane: missing, lanes, total: records.length };
}

function printLaneSnapshot(snapshot) {
  warnMissingCurrentLane(snapshot.missingCurrentLane);
  const lines = snapshot.lanes.map((lane) => {
    const mark = lane.current ? '*' : ' ';
    const desc = lane.description ? ` — ${lane.description}` : '';
    const inferred = lane.inferred ? ' (inferred)' : '';
    return `${mark} ${lane.name}  ${lane.visible} visible / ${lane.count} in lane${desc}${inferred}`;
  });
  printLine(`current lane: ${snapshot.current}`);
  printLine(lines.join('\n'));
  return snapshot;
}

function showLanes(argv, { readOnly = false } = {}) {
  const { positionals } = parseArgs(argv, {}, 'lane show');
  const view = loadOutcomeView({ repairTail: true, readOnly });
  const snapshot = listLaneSnapshot(view.records);
  if (positionals.length === 0) return printLaneSnapshot(snapshot);
  if (positionals.length !== 1) fail(usageFor('lane show'));
  const name = normalizeLaneName(positionals[0]);
  const lane = snapshot.lanes.find((item) => item.name === name);
  if (!lane) fail(`unknown lane ${name}`);
  printLine(
    `${lane.current ? 'current ' : ''}lane: ${lane.name} (${lane.visible} visible / ${lane.count} in lane)`
  );
  if (lane.description) printLine(lane.description);
  return lane;
}

function addLane(argv) {
  const { positionals, flags } = parseArgs(argv, { desc: 'single' }, 'lane add');
  if (positionals.length !== 1) fail(usageFor('lane add'));
  const name = normalizeLaneName(positionals[0]);
  if (name === DEFAULT_LANE) fail(`lane ${DEFAULT_LANE} always exists`);
  const events = readEvents({ repairTail: true });
  const records = fold(events);
  const catalog = records.lanes || emptyLaneCatalog();
  const existing = catalog.get(name);
  if (existing && !existing.inferred) fail(`lane ${name} already exists`);
  const description = flags.desc && flags.desc.trim() ? flags.desc.trim() : null;
  appendEvent({
    type: 'lane_add',
    id: laneEventId(name),
    ts: new Date().toISOString(),
    lane: name,
    description,
  });
  printLine(`added lane ${name}`);
  return { name, description };
}

function switchLane(argv) {
  const { positionals } = parseArgs(argv, {}, 'lane switch');
  if (positionals.length !== 1) fail(usageFor('lane switch'));
  const name = normalizeLaneName(positionals[0]);
  const events = readEvents({ repairTail: true });
  const records = fold(events);
  const catalog = records.lanes || emptyLaneCatalog();
  if (!catalog.has(name)) fail(`unknown lane ${name}; add it with driftseal lane add ${name}`);
  const open = openOutcome(records);
  if (open) {
    fail(
      `outcome ${open.id} is still in_progress on lane ${open.lane || DEFAULT_LANE}; ` +
        'end it before switching lanes'
    );
  }
  writeCurrentLaneName(name);
  printLine(`switched to lane ${name}`);
  return { current: name };
}

function assignLane(argv) {
  const { positionals } = parseArgs(argv, {}, 'lane assign');
  if (positionals.length !== 2) fail(usageFor('lane assign'));
  const id = positionals[0];
  const name = normalizeLaneName(positionals[1]);
  const events = readEvents({ repairTail: true });
  const records = fold(events);
  const record = records.find((candidate) => candidate.id === id);
  if (!record) fail(`unknown outcome id: ${id}`);
  if (record.status === 'in_progress') fail(`cannot assign lane of in_progress outcome ${id}`);
  const catalog = records.lanes || emptyLaneCatalog();
  if (!catalog.has(name)) fail(`unknown lane ${name}; add it with driftseal lane add ${name}`);
  if ((record.lane || DEFAULT_LANE) === name) {
    printLine(`${id} already on lane ${name}`);
    return publicOutcome(record);
  }
  appendEvent({
    type: 'lane_assign',
    id,
    ts: new Date().toISOString(),
    lane: name,
  });
  printLine(`${id} assigned to lane ${name}`);
  return { ...publicOutcome(record), lane: name };
}

const commands = {
  begin(argv) {
    const { positionals, flags } = parseArgs(argv, {
      accept: 'multiple',
      verify: '-v',
      decision: 'multiple',
      force: 'boolean',
    }, 'begin');
    const outcome = positionals.join(' ').trim();
    if (!outcome) {
      fail(usageFor('begin'));
    }
    const acceptance = [...new Set((flags.accept || []).map((criterion) => criterion.trim()))];
    if (acceptance.some((criterion) => criterion.length === 0)) {
      fail('--accept requires a non-empty observable outcome');
    }
    if (acceptance.length > 0 && (!flags.verify || flags.verify.trim().length === 0)) {
      fail('--accept requires --verify with the exact machine verification command');
    }
    const requestedDecisions = flags.decision || [];
    const index = requestedDecisions.length > 0 ? decisionIndex() : [];
    const decisions = [
      ...new Set(requestedDecisions.map((id) => findDecision(id, index).id)),
    ];

    const events = readEvents({ repairTail: true });
    const records = fold(events);
    // A parked outcome and a merged-in one can both be open; --force clears every one of them.
    const open = records.filter((record) => record.status === 'in_progress');
    if (open.length > 1 && !flags.force) {
      fail(
          `multiple outcomes in progress: ${open.map((record) => record.id).join(', ')}\n` +
          'resolve them with driftseal absorb --abandon-ours or --abandon-theirs, ' +
          'or re-run with --force to abandon all of them'
      );
    }
    if (open.length === 1 && !flags.force) {
      fail(
        `outcome ${open[0].id} is still in_progress: "${open[0].outcome}"\n` +
          `end it first (driftseal end) or re-run with --force to abandon it`
      );
    }
    for (const record of open) {
      const status = closeIntentAsEscape(
        events,
        record,
        'abandoned',
        'superseded by --force',
        null
      );
      printError(`driftseal: ${status} ${record.id}`);
    }

    const id = nextId(events);
    const currentLane = currentLaneOrFail(records);
    events.push(appendEvent({
      type: 'begin',
      id,
      ts: new Date().toISOString(),
      outcome,
      acceptance,
      verify: flags.verify || null,
      decisions,
      ...(currentLane !== DEFAULT_LANE ? { lane: currentLane } : {}),
      head: gitCapture(['rev-parse', 'HEAD']),
    }));
    const record = fold(events).find((candidate) => candidate.id === id);
    printLine(id);
    return publicOutcome(record);
  },

  extend(argv) {
    const { positionals, flags } = parseArgs(argv, {
      accept: 'multiple',
      verify: '-v',
      decision: 'multiple',
    }, 'extend');
    const extension = positionals.join(' ').trim();
    if (!extension) fail(usageFor('extend'));
    const acceptance = [...new Set((flags.accept || []).map((criterion) => criterion.trim()))];
    if (acceptance.some((criterion) => criterion.length === 0)) {
      fail('--accept requires a non-empty observable result');
    }
    if (acceptance.length > 0 && (!flags.verify || flags.verify.trim().length === 0)) {
      fail('extending acceptance requires --verify with a cumulative verification command');
    }
    const events = readEvents({ repairTail: true });
    const current = openOutcome(fold(events));
    if (!current) fail('no outcome in progress; begin one before extending it');
    const requestedDecisions = flags.decision || [];
    const index = requestedDecisions.length > 0 ? decisionIndex() : [];
    const decisions = [...new Set(requestedDecisions.map((id) => findDecision(id, index).id))]
      .filter((id) => !current.decisions.includes(id));
    events.push(appendEvent({
      type: 'extend',
      id: current.id,
      ts: new Date().toISOString(),
      extension,
      acceptance: acceptance.filter((criterion) => !current.acceptance.includes(criterion)),
      verify: flags.verify || null,
      decisions,
      head: gitCapture(['rev-parse', 'HEAD']),
    }));
    const record = fold(events).find((candidate) => candidate.id === current.id);
    printLine(`${current.id} extended`);
    return publicOutcome(record);
  },

  verify(argv) {
    const { positionals, flags } = parseArgs(
      argv,
      { 'allow-tracked-command': 'boolean' },
      'verify'
    );
    if (positionals.length > 0) fail(usageFor('verify'));
    return runMachineVerification({ allowTrackedCommand: flags['allow-tracked-command'] === true });
  },

  end(argv) {
    const { positionals, flags } = parseArgs(argv, {
      status: '-s',
      note: '-n',
      'verify-result': '-r',
    }, 'end');
    const status = flags.status || 'completed';
    if (positionals.length > 1) fail(usageFor('end'));
    if (!END_STATUSES.includes(status)) {
      fail(`invalid status "${status}" (expected: ${END_STATUSES.join(', ')})`);
    }

    const parkedV1 = legacyParkedIntent();
    if (parkedV1) {
      if (positionals.length > 0 && positionals[0] !== parkedV1.id) {
        fail(`unknown outcome id: ${positionals[0]}`);
      }
      const closed = closeLegacyParkedIntent(status, flags.note);
      printLine(`${closed.id} ${status}`);
      return publicOutcome(closed);
    }

    let events = readEvents({ repairTail: true });
    let records = fold(events);
    let target;
    if (positionals.length > 0) {
      target = records.find((r) => r.id === positionals[0]);
      if (!target) fail(`unknown outcome id: ${positionals[0]}`);
      if (target.status !== 'in_progress') fail(`outcome ${target.id} already closed (${target.status})`);
    } else {
      target = openOutcome(records);
      if (!target) fail('no outcome in progress; nothing to end');
    }

    let completionWorkspace = null;
    let completionVerificationId = null;
    if (status === 'completed' && target.acceptance.length > 0) {
      if (!target.verification || !target.verification.passed) {
        fail(
          `cannot complete acceptance-bound outcome ${target.id} without successful machine verification; ` +
            'run: driftseal verify'
        );
      }
      completionWorkspace = workspaceFingerprint();
      if (completionWorkspace !== target.verification.workspace ||
        target.verification.contractHash !== target.contractHash) {
        fail(
          `cannot complete acceptance-bound outcome ${target.id}: contract or workspace changed after machine verification; ` +
            'run: driftseal verify'
        );
      }
      completionVerificationId = target.verification.verificationId;
    }

    if (['failed', 'abandoned'].includes(status)) {
      const terminalStatus = closeIntentAsEscape(
        events,
        target,
        status,
        flags.note,
        flags['verify-result']
      );
      const record = fold(events).find((candidate) => candidate.id === target.id);
      printLine(`${target.id} ${terminalStatus}`);
      return publicOutcome(record);
    }

    if (['completed', 'partial'].includes(status) && target.decisions.length > 0) {
      events = recoverPendingReconciliations(events, target.id);
      records = fold(events);
      target = records.find((record) => record.id === target.id);
    }

    if (['completed', 'partial'].includes(status) && target.decisions.length > 0) {
      const problems = [];
      const index = decisionIndex();
      for (const decisionId of target.decisions) {
        const updates = qualifyingDecisionUpdates(target, decisionId);
        if (updates.length === 0) {
          problems.push(`decision ${decisionId} was not reconciled`);
          continue;
        }
        const latest = updates.at(-1);
        const decision = findDecision(decisionId, index);
        if (latest.fileHash && contentHash(decision.content) !== latest.fileHash) {
          problems.push(`decision ${decisionId} changed after its latest reconciliation`);
        } else if (decision.status !== latest.toStatus) {
          problems.push(
            `decision ${decisionId} is ${decision.status}, but its latest reconciliation recorded ${latest.toStatus}`
          );
        }
      }
      if (problems.length > 0) {
        fail(
          `cannot close linked outcome ${target.id} as ${status}:\n` +
            problems.map((problem) => `  - ${problem}`).join('\n') +
            `\nrun: driftseal decision update <id> --note "<what changed or was confirmed>"`
        );
      }
    }

    events.push(appendEvent({
      type: 'end',
      id: target.id,
      ts: new Date().toISOString(),
      status,
      note: flags.note || null,
      verifyResult: flags['verify-result'] || null,
      verificationId: completionVerificationId,
      workspace: completionWorkspace,
      contractHash: target.contractHash,
      head: gitCapture(['rev-parse', 'HEAD']),
    }));
    const record = fold(events).find((candidate) => candidate.id === target.id);
    printLine(`${target.id} ${status}`);
    return publicOutcome(record);
  },

  status(argv, { readOnly = false } = {}) {
    const { positionals } = parseArgs(argv, {}, 'status');
    if (positionals.length > 0) fail(usageFor('status'));
    const parkedV1 = legacyParkedIntent();
    if (parkedV1) {
      printLine(render(parkedV1));
      printLine('parked v1 intent; close it with: driftseal end --status abandoned --note "close parked v1 intent before migration"');
      return publicOutcome(parkedV1);
    }
    const view = loadOutcomeView({ repairTail: true, readOnly });
    const records = view.records;
    const { current, missing } = resolveCurrentLane(records);
    warnMissingCurrentLane(missing);
    const customLanes = records.lanes && records.lanes.size > 1;
    if (customLanes || current !== DEFAULT_LANE) {
      printLine(renderLaneLine(records, current));
    }
    const open = openOutcome(records);
    if (!open) {
      printLine('no outcome in progress');
      return null;
    }
    printLine(render(open, { currentLane: current }));
    return publicOutcome(open);
  },

  log(argv, { readOnly = false } = {}) {
    const { positionals, flags } = parseArgs(argv, {
      last: '-n',
      all: 'boolean',
      'all-lanes': 'boolean',
    }, 'log');
    if (positionals.length > 0) fail(usageFor('log'));
    const n = flags.last === undefined ? null : positiveInteger(flags.last, '--last');
    const allLanes = flags['all-lanes'] === true;
    const parkedV1 = legacyParkedIntent();
    if (
      n !== null &&
      !allLanes &&
      !parkedV1 &&
      process.env._DRIFTSEAL_TEST_DISABLE_RECENT_INDEX !== '1'
    ) {
      const recent = tryLoadRecentOutcomeView(n, {
        includeReclaimed: flags.all === true,
        repairTail: true,
        readOnly,
      });
      if (recent) {
        const { state, records, current, missing } = recent;
        warnMissingCurrentLane(missing);
        const customLanes = state.lanes.size > 1;
        if (customLanes || current !== DEFAULT_LANE || missing) {
          const summary = indexedLaneSummary(state, current);
          printLine(`lane: ${current} (${summary.visible} visible / ${summary.count} in lane)`);
        }
        if (records.length === 0) {
          printLine('log is empty');
          return [];
        }
        printLine(records.map((record) => render(record, { currentLane: current })).join('\n\n'));
        return records.map(publicOutcome);
      }
    }
    if (process.env._DRIFTSEAL_TEST_REQUIRE_RECENT_INDEX === '1' && n !== null && !allLanes) {
      fail('recent lane index fast path was not used');
    }
    const view = loadOutcomeView({ repairTail: true, readOnly });
    let records = view.records;
    if (parkedV1 && !records.some((record) => record.id === parkedV1.id && record.status === 'in_progress')) {
      records = Object.assign([...records, parkedV1], { lanes: records.lanes });
    }
    const catalog = records.lanes || emptyLaneCatalog();
    const { current, missing } = resolveCurrentLane(view.records);
    warnMissingCurrentLane(missing);
    if (!allLanes) {
      records = Object.assign(selectLaneLogRecords(records, current), { lanes: catalog });
    }
    const visible = flags.all ? records : records.filter((record) => !record.reclaimed);
    const customLanes = catalog.size > 1;
    if (!allLanes && (customLanes || current !== DEFAULT_LANE || missing)) {
      printLine(renderLaneLine(view.records, current));
    }
    let shown = visible;
    if (n !== null) {
      shown = selectLastLogRecords(visible, current, n);
    }
    if (shown.length === 0) {
      printLine('log is empty');
      return [];
    }
    printLine(shown.map((record) => render(record, { currentLane: current })).join('\n\n'));
    return shown.map(publicOutcome);
  },

  lane(argv, { readOnly = false } = {}) {
    const [subcommand, ...rest] = argv;
    if (subcommand === '--help' || subcommand === '-h') throw new HelpRequested('lane');
    if (!subcommand || subcommand === 'show') {
      return showLanes(rest, { readOnly });
    }
    if (subcommand === 'add') return addLane(rest);
    if (subcommand === 'switch') return switchLane(rest);
    if (subcommand === 'assign') return assignLane(rest);
    fail(usageFor('lane'));
  },

  reclaim(argv) {
    const { positionals, flags } = parseArgs(argv, {
      reason: '-r',
      'older-than': 'single',
      force: 'boolean',
      'dry-run': 'boolean',
    }, 'reclaim');
    const reason = flags.reason && flags.reason.trim();
    if (!reason) {
      fail(usageFor('reclaim'));
    }
    let olderThanDays = 7;
    if (flags['older-than'] !== undefined) {
      olderThanDays = positiveInteger(flags['older-than'], '--older-than');
    }

    const records = fold(readEvents({ repairTail: true }));
    let targets;
    if (positionals.length > 0) {
      const ids = [...new Set(positionals)];
      targets = ids.map((id) => {
        const record = records.find((candidate) => candidate.id === id);
        if (!record) fail(`unknown outcome id: ${id}`);
        if (record.status === 'in_progress') {
          fail(`cannot reclaim outcome ${id} while it is in_progress`);
        }
        if (record.reclaimed) fail(`outcome ${id} is already reclaimed`);
        const routine = ['failed', 'abandoned'].includes(record.status) &&
          record.decisions.length === 0;
        if (!routine && !flags.force) {
          fail(
            `outcome ${id} is ${record.status}` +
              (record.decisions.length > 0 ? ' and linked to decisions' : '') +
              '; re-run with --force to reclaim it anyway'
          );
        }
        return record;
      });
    } else {
      if (flags.force) fail('--force requires explicit outcome ids');
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      targets = records.filter(
        (record) =>
          record.status !== 'in_progress' &&
          ['failed', 'abandoned'].includes(record.status) &&
          record.decisions.length === 0 &&
          !record.reclaimed &&
          Date.parse(record.tsEnd) < cutoff
      );
      if (targets.length === 0) {
        printLine('no reclaimable outcomes');
        return [];
      }
    }

    if (flags['dry-run']) {
      printLine(targets.map((record) => `${record.id} ${record.status} — ${record.outcome}`).join('\n'));
      return targets.map(publicOutcome);
    }

    let events = readEvents({ repairTail: true });
    for (const record of targets) {
      events.push(
        appendEvent({
          type: 'reclaim',
          id: record.id,
          ts: new Date().toISOString(),
          reason,
        })
      );
    }
    const reclaimed = fold(events).filter((record) =>
      targets.some((target) => target.id === record.id)
    );
    printLine(targets.map((record) => `${record.id} reclaimed`).join('\n'));
    return reclaimed.map(publicOutcome);
  },

  unreclaim(argv) {
    const { positionals, flags } = parseArgs(argv, { reason: '-r' }, 'unreclaim');
    const reason = flags.reason && flags.reason.trim();
    if (positionals.length !== 1 || !reason) {
      fail(usageFor('unreclaim'));
    }
    const events = readEvents({ repairTail: true });
    const record = fold(events).find((candidate) => candidate.id === positionals[0]);
    if (!record) fail(`unknown outcome id: ${positionals[0]}`);
    if (!record.reclaimed) fail(`outcome ${positionals[0]} is not reclaimed`);
    events.push(
      appendEvent({
        type: 'unreclaim',
        id: record.id,
        ts: new Date().toISOString(),
        reason,
      })
    );
    const restored = fold(events).find((candidate) => candidate.id === record.id);
    printLine(`${record.id} unreclaimed`);
    return publicOutcome(restored);
  },

  decision(argv) {
    const [subcommand, ...rest] = argv;
    if (subcommand === '--help' || subcommand === '-h') throw new HelpRequested('decision');
    if (subcommand === 'add') {
      const { positionals, flags } = parseArgs(rest, {
        context: '-c',
        outcome: '-o',
        status: '-s',
        driver: 'multiple',
        option: 'multiple',
        consequence: 'multiple',
      }, 'decision add');
      const title = positionals.join(' ').replace(/\s+/g, ' ').trim();
      const context = flags.context && flags.context.trim();
      const outcome = flags.outcome && flags.outcome.trim();
      if (!title || !context || !outcome) {
        fail(usageFor('decision add'));
      }
      const status = (flags.status || 'accepted').toLowerCase();
      if (!DECISION_STATUSES.includes(status)) {
        fail(`invalid decision status "${status}" (expected: ${DECISION_STATUSES.join(', ')})`);
      }

      const id = nextDecisionId();
      const paddedId = String(id).padStart(4, '0');
      const file = `${paddedId}-${slugify(title)}.md`;
      const content = renderDecision({
        id,
        title,
        date: new Date().toISOString().slice(0, 10),
        status,
        context,
        outcome,
        drivers: flags.driver || [],
        options: flags.option || [],
        consequences: flags.consequence || [],
      });
      ensureV2OutcomeLogExists();
      ensureDirectoryDurable(decisionDir());
      atomicCreateFile(path.join(decisionDir(), file), content);
      const decision = findDecision(String(id));
      printLine(path.join(decisionDir(), file));
      return publicDecision(decision, { includeContent: true });
    }

    if (subcommand === 'update') {
      const { positionals, flags } = parseArgs(rest, { status: '-s', note: '-n' }, 'decision update');
      const note = flags.note && flags.note.trim();
      if (positionals.length !== 1 || !note) {
        fail(usageFor('decision update'));
      }

      let events = readEvents({ repairTail: true });
      let records = fold(events);
      let outcome = openOutcome(records);
      if (!outcome) fail('decision update requires an outcome in progress');
      events = recoverPendingReconciliations(events, outcome.id);
      records = fold(events);
      outcome = openOutcome(records);
      const index = decisionIndex();
      const decision = findDecision(positionals[0], index);
      if (!outcome.decisions.includes(decision.id)) {
        fail(`decision ${decision.id} is not linked to outcome ${outcome.id}; declare it with driftseal begin or extend --decision ${decision.id}`);
      }

      const status = (flags.status || decision.status).toLowerCase();
      if (!DECISION_STATUSES.includes(status)) {
        fail(`invalid decision status "${status}" (expected: ${DECISION_STATUSES.join(', ')})`);
      }
      const update = prepareDecisionReconciliation(decision, outcome.id, status, note);
      const { target, content, ...prepareEvent } = update;
      appendEvent(prepareEvent);
      if (process.env._DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_PREPARE === '1') {
        fail('simulated interruption after reconciliation prepare');
      }
      atomicWriteFile(target, content);
      if (process.env._DRIFTSEAL_TEST_CRASH_AFTER_DECISION_WRITE === '1') {
        fail('simulated interruption after decision write');
      }
      appendEvent(reconciliationEvent('decision_reconcile_commit', update));
      const reconciled = findDecision(decision.id);
      printLine(`${decision.id} ${update.fromStatus} -> ${update.toStatus} (${outcome.id})`);
      return publicDecision(reconciled, { includeContent: true });
    }

    if (subcommand === 'list') {
      const { positionals, flags } = parseArgs(rest, { last: '-n', status: '-s', count: 'boolean' }, 'decision list');
      if (positionals.length > 0) {
        fail(usageFor('decision list'));
      }
      if (flags.count && flags.last) fail('--count cannot be combined with --last');
      const last = flags.last && positiveInteger(flags.last, '--last');
      const status = flags.status && flags.status.toLowerCase();
      if (status && !DECISION_STATUSES.includes(status)) {
        fail(`invalid decision status "${status}" (expected: ${DECISION_STATUSES.join(', ')})`);
      }
      const index = decisionIndex();
      if (flags.count && !status) {
        printLine(index.length);
        return { count: index.length };
      }
      let records = decisionCatalog(!status && last ? index.slice(-last) : index);
      if (status) {
        records = records.filter((record) => record.status === status);
      }
      if (status && last) records = records.slice(-last);
      if (flags.count) {
        printLine(records.length);
        return { count: records.length };
      }
      if (records.length === 0) {
        printLine(status ? `no decision records with status ${status}` : 'decision log is empty');
        return [];
      }
      printLine(
        records
          .map((record) => `[${record.id}] ${titleCase(record.status)} — ${record.title}\n  ${record.file}`)
          .join('\n')
      );
      return records.map(publicDecision);
    }

    if (subcommand === 'show') {
      const { positionals } = parseArgs(rest, {}, 'decision show');
      if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
        fail(usageFor('decision show'));
      }
      const decision = findDecision(positionals[0]);
      writeOutput(decision.content);
      return publicDecision(decision, { includeContent: true });
    }

    fail(usageFor('decision'));
  },

  mcp(argv) {
    const request = parseMcpInstallRequest(argv);
    return installMcp(request);
  },

  skill(argv) {
    return installSkill(parseSkillInstallRequest(argv));
  },

  hook(argv, { readOnly = false } = {}) {
    const [subcommand, ...rest] = argv;
    if (subcommand === '--help' || subcommand === '-h') throw new HelpRequested('hook');
    if (subcommand === 'install') {
      return installHook(parseHookInstallRequest(rest));
    }
    if (HOOK_EVENTS.includes(subcommand)) {
      return runHookReminder(subcommand, rest, { readOnly });
    }
    fail(hookUsage());
  },

  absorb(argv) {
    const { positionals, flags } = parseArgs(argv, {
      git: 'boolean',
      decisions: 'single',
      'abandon-theirs': 'boolean',
      'abandon-ours': 'boolean',
      'dry-run': 'boolean',
    }, 'absorb');
    if (flags['abandon-theirs'] && flags['abandon-ours']) {
      fail('cannot combine --abandon-theirs and --abandon-ours');
    }
    const abandon = flags['abandon-theirs'] ? 'theirs' : flags['abandon-ours'] ? 'ours' : null;
    const dryRun = Boolean(flags['dry-run']);

    if (flags.git) {
      if (positionals.length !== 3) fail(absorbUsage());
      if (flags.decisions) fail('--decisions cannot be combined with --git');
      return absorbGit(positionals[0], positionals[1], positionals[2], { abandon, dryRun });
    }
    if (positionals.length > 1) fail(absorbUsage());
    return absorbLogs(positionals[0], flags.decisions, { abandon, dryRun });
  },

  migrate(argv) {
    const [route, action, ...rest] = argv;
    if (route === '--help' || route === '-h' ||
      (route === 'v1-to-v2' && (action === '--help' || action === '-h'))) {
      throw new HelpRequested('migrate');
    }
    if (route !== 'v1-to-v2' || !['inspect', 'apply', 'check'].includes(action)) {
      fail(usageFor('migrate'));
    }
    const { positionals, flags } = parseArgs(rest, {
      'source-log': 'single',
      'source-decisions': 'single',
      destination: 'single',
      plan: 'single',
      'plan-json': 'single',
      json: 'boolean',
    }, 'migrate');
    if (positionals.length > 0) fail(usageFor('migrate'));
    if (action === 'inspect') {
      if (flags.plan || flags['plan-json']) fail('--plan is only valid with migration apply');
      const inspection = migrationInspection(migrationSourceSnapshot(flags));
      if (flags.json) printLine(JSON.stringify(inspection, null, 2));
      else {
        printLine(`v1 source ${inspection.sourceFingerprint}: ${inspection.records.length} closed intent(s), ${inspection.decisions.length} MADR file(s)`);
        printLine('Generate a driftseal-v1-to-v2-plan JSON document, then run migrate v1-to-v2 apply --plan <file>.');
      }
      return inspection;
    }
    if (action === 'apply') {
      if (flags.json) fail('--json is only valid with migration inspect or check');
      const destination = canonicalPath(flags.destination || sealRoot());
      const existing = findMigrationEvent(path.join(destination, 'outcomes', 'events.jsonl'));
      const snapshot = migrationSourceSnapshot(flags, { storedSource: existing?.source });
      const validated = validateMigrationPlan(readMigrationPlan(flags.plan, flags['plan-json']), snapshot);
      return applyMigration(snapshot, validated);
    }
    if (flags.plan || flags['plan-json']) fail('--plan is only valid with migration apply');
    const destination = canonicalPath(flags.destination || sealRoot());
    const existing = findMigrationEvent(path.join(destination, 'outcomes', 'events.jsonl'));
    const paths = migrationPaths(flags, { storedSource: existing?.source });
    let result;
    if (fs.existsSync(paths.sourceLog) || migrationDecisionFiles(paths.sourceDecisions).length > 0) {
      result = checkMigration(migrationSourceSnapshot(flags, { storedSource: existing?.source }));
    } else {
      result = checkMigration({
        ...paths,
        decisions: [],
        sourceLogPresent: existing?.source?.logPresent ?? false,
      }, { sourceMissing: true });
    }
    if (flags.json) printLine(JSON.stringify(result, null, 2));
    return result;
  },

  init(argv) {
    const { positionals, flags } = parseArgs(argv, { lang: 'single', 'local-log': 'boolean' }, 'init');
    if (positionals.length > 0) fail(usageFor('init'));
    const target = path.join(process.cwd(), 'AGENTS.md');
    const existed = fs.existsSync(target);
    const current = existed ? fs.readFileSync(target, 'utf8') : '';
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const language = resolveInitLogLanguage(flags.lang, current);
    const localLog = resolveInitLocalLog(flags['local-log'] === true, current);
    // Accept default blocks in the persisted language too, so a single run can
    // switch language and enable local mode on a default or v11 protocol.
    const sourceLanguages = [language];
    if (flags.lang !== undefined) {
      for (const persisted of persistedLogLanguages(current)) {
        if (!sourceLanguages.includes(persisted)) sourceLanguages.push(persisted);
      }
    }
    const intentBlock = protocolEol(intentProtocolBlock(PROTOCOL_VERSION, language, localLog), eol);
    const decisionBlock = protocolEol(decisionProtocolBlock(PROTOCOL_VERSION, language, localLog), eol);
    let updated = current;
    const intent = upgradeManagedBlock({
      content: updated,
      marker: INTENT_PROTOCOL_MARKER,
      endMarker: INTENT_PROTOCOL_END,
      versionPattern: /^<!-- driftseal-version: (\d+(?:\.\d+)?) -->\r?$/m,
      replacement: intentBlock,
      knownManagedBlocks: [
        ...sourceLanguages.flatMap((source) => [
          protocolEol(intentProtocolBlock(PROTOCOL_VERSION, source), eol),
          protocolEol(intentProtocolBlock(PROTOCOL_VERSION, source, true), eol),
          protocolEol(intentProtocolBlockV20(source), eol),
          protocolEol(intentProtocolBlockV20(source, true), eol),
          protocolEol(v1IntentProtocolBlock(14, source), eol),
          protocolEol(v1IntentProtocolBlock(14, source, true), eol),
          protocolEol(previousIntentProtocolBlock(13, source), eol),
          protocolEol(previousIntentProtocolBlock(13, source, true), eol),
          protocolEol(previousIntentProtocolBlock(12, source), eol),
          protocolEol(previousIntentProtocolBlock(12, source, true), eol),
          protocolEol(previousIntentProtocolBlock(11, source), eol),
          protocolEol(previousIntentProtocolBlock(11, source, true), eol),
        ]),
        protocolEol(previousIntentProtocolBlock(2), eol),
        protocolEol(previousIntentProtocolBlock(3), eol),
        protocolEol(previousIntentProtocolBlock(4), eol),
        protocolEol(previousIntentProtocolBlock(5), eol),
        protocolEol(previousIntentProtocolBlock(6), eol),
        protocolEol(previousIntentProtocolBlock(7), eol),
        protocolEol(previousIntentProtocolBlock(8), eol),
        protocolEol(previousIntentProtocolBlock(9), eol),
        protocolEol(previousIntentProtocolBlock(10), eol),
      ],
      knownLegacyBlocks: [protocolEol(legacyIntentProtocolBlock(), eol)],
    });
    updated = intent.content;
    const decision = upgradeManagedBlock({
      content: updated,
      marker: DECISION_PROTOCOL_MARKER,
      endMarker: DECISION_PROTOCOL_END,
      versionPattern: /^<!-- driftseal-decisions-version: (\d+(?:\.\d+)?) -->\r?$/m,
      replacement: decisionBlock,
      knownManagedBlocks: [
        ...sourceLanguages.flatMap((source) => [
          protocolEol(decisionProtocolBlock(PROTOCOL_VERSION, source), eol),
          protocolEol(decisionProtocolBlock(PROTOCOL_VERSION, source, true), eol),
          protocolEol(decisionProtocolBlock('2.0', source), eol),
          protocolEol(decisionProtocolBlock('2.0', source, true), eol),
          protocolEol(v1DecisionProtocolBlock(14, source), eol),
          protocolEol(v1DecisionProtocolBlock(14, source, true), eol),
          protocolEol(previousDecisionProtocolBlock(13, source), eol),
          protocolEol(previousDecisionProtocolBlock(13, source, true), eol),
          protocolEol(previousDecisionProtocolBlock(12, source), eol),
          protocolEol(previousDecisionProtocolBlock(12, source, true), eol),
          protocolEol(previousDecisionProtocolBlock(11, source), eol),
          protocolEol(previousDecisionProtocolBlock(11, source, true), eol),
        ]),
        protocolEol(previousDecisionProtocolBlock(2), eol),
        protocolEol(previousDecisionProtocolBlock(3), eol),
        protocolEol(previousDecisionProtocolBlock(4), eol),
        protocolEol(previousDecisionProtocolBlock(5), eol),
        protocolEol(previousDecisionProtocolBlock(6), eol),
        protocolEol(previousDecisionProtocolBlock(7), eol),
        protocolEol(previousDecisionProtocolBlock(8), eol),
        protocolEol(previousDecisionProtocolBlock(9), eol),
        protocolEol(previousDecisionProtocolBlock(10), eol),
      ],
      knownLegacyBlocks: [protocolEol(legacyDecisionProtocolBlock(), eol)],
    });
    updated = decision.content;

    const additions = [];
    if (!intent.found) additions.push(intentBlock);
    if (!decision.found) additions.push(decisionBlock);
    if (additions.length > 0) {
      if (!existed && updated.length === 0) updated = `# Agent instructions${eol}`;
      const separator =
        updated.length === 0 || updated.endsWith(eol + eol)
          ? ''
          : updated.endsWith(eol)
            ? eol
            : eol + eol;
      updated += separator + additions.join(eol + eol) + eol;
    }

    const attributes = ensureGitAttributes();
    let driver = { changed: false, configured: false };
    try {
      driver = ensureGitMergeDriver();
    } catch (err) {
      printLine(`warning: could not configure git merge driver: ${err && err.message ? err.message : err}`);
    }

    if (localLog) warnIfDefaultLogsTracked();

    if (updated === current && !attributes.changed && !driver.changed) {
      printLine('AGENTS.md already contains the DriftSeal protocols; nothing to do');
      return { changed: false, target };
    }
    if (updated !== current) {
      atomicWriteFile(target, updated);
      printLine(`DriftSeal protocol ${existed ? 'updated in' : 'written to'} ${target}`);
    }
    if (attributes.changed) {
      printLine(`Configured git merge attribute: ${attributes.target}`);
    }
    if (driver.changed) {
      printLine('Configured local git merge driver for DriftSeal outcome logs');
    }
    return { changed: true, target };
  },

  help() {
    printLine(`DriftSeal — Seal the outcome. Stop the drift.

Outcome-level write-ahead log for agent sessions.

usage:
  driftseal begin "<outcome>" [--accept "<observable result>"] [--verify "<command>"]
                 [--decision <id>] [--force]
  driftseal extend "<same-outcome addition>" [--accept "<observable result>"]
                 [--verify "<cumulative command>"] [--decision <id>]
  driftseal verify [--allow-tracked-command]
                                       run the declared command and bind its result
                                       to the current contract and Git-visible workspace
  driftseal end [id] [--status completed|partial|failed|abandoned] [--note "..."] [--verify-result "..."]
  driftseal status                     show the outcome currently in progress
  driftseal log [--last N] [--all] [--all-lanes]
                                 show outcome history (current lane; --all-lanes is global)
  driftseal lane                 show named outcome lanes and the current lane
  driftseal lane add <name> [--desc "..."]
  driftseal lane switch <name>
  driftseal lane assign <id> <name>
                                 partition outcome history by long-lived capability
  driftseal reclaim [id ...] --reason "<why>" [--older-than <days>] [--force] [--dry-run]
                                 hide meaningless closed records without deleting them
  driftseal unreclaim <id> --reason "<why>"
                                 restore a reclaimed record to the visible log
  driftseal absorb [other-events.jsonl] [--decisions <dir>]
                 [--abandon-theirs | --abandon-ours] [--dry-run]
                                 merge another outcome log, remapping colliding ids
  driftseal absorb --git <base> <ours> <theirs>
                                 git merge driver for .seal/outcomes/events.jsonl
  driftseal decision add "<title>" --context "..." --outcome "..." [options]
  driftseal decision update <id> [--status STATUS] --note "..."
                                 reconcile a linked decision in the open outcome
  driftseal decision list [--status STATUS] [--last N | --count]
                                 list or count filtered MADR decision records
  driftseal decision show <id>         print one MADR decision record
  driftseal skill install --target TARGET [--scope project|global] [--root <repository>] [--force]
                                 install the bundled use-driftseal skill (default: project)
                                 targets: codex, kimi-code, opencode, claude-code, cursor
  driftseal mcp install --target TARGET [--scope project|global] [--root <repository>] [--force]
                                 install the repository-pinned MCP server (default: project)
                                 targets: codex, kimi-code, opencode, claude-code, cursor
  driftseal hook install --target TARGET [--scope project|global] [--root <repository>] [--force]
                                 install advisory lifecycle hooks (default: project)
                                 targets: kimi-code (global only), claude-code, codex (prompt only)
  driftseal hook prompt|stop [--format plain|claude-code]
                                 emit the reminder a lifecycle hook injects; never blocks
  driftseal init [--lang <tag>] [--local-log]
                                 inject protocols into ./AGENTS.md and configure the git merge driver
                                 --lang sets the outcome/MADR log language (BCP 47, default: en)
                                 --local-log keeps the logs local and untracked instead of committing them
  driftseal migrate v1-to-v2 inspect [--json] [migration paths]
  driftseal migrate v1-to-v2 apply --plan <file> [migration paths]
  driftseal migrate v1-to-v2 check [migration paths]
                                 model-assisted, validated migration that never deletes v1 data

migration paths:
  --source-log <file>           v1 events.jsonl (default: $DRIFTSEAL_HOME/events.jsonl or .intent-log/events.jsonl)
  --source-decisions <dir>      v1 MADR directory (default: $DRIFTSEAL_DECISION_HOME or .decision-log)
  --destination <dir>           v2 seal root (default: $DRIFTSEAL_HOME or .seal)
  driftseal --version | -V             print the installed DriftSeal version
  driftseal help

decision add options:
  -s, --status proposed|accepted|rejected|deferred|deprecated|superseded (default: accepted)
  --driver "..."                repeat for each decision driver
  --option "..."                repeat for each considered option
  --consequence "..."           repeat for each consequence

seal root: $DRIFTSEAL_HOME, or .seal in the current directory
outcome log: <seal-root>/outcomes/events.jsonl
MADR records: <seal-root>/madr/
$DRIFTSEAL_DECISION_HOME is a v1-only default for migration source detection; v2 runtime ignores it.
In a Git worktree, begin parks an open outcome in Git metadata until end, so merge does not need a log-only commit.`);
    return null;
  },

  version() {
    printLine(PACKAGE_VERSION);
    return PACKAGE_VERSION;
  },
};

function requestedEndStatus(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--status' || argv[index] === '-s') return argv[index + 1];
    if (argv[index].startsWith('--status=')) return argv[index].slice('--status='.length);
  }
  return 'completed';
}

/**
 * Flags that consume the following token as their value, keyed by command or
 * subcommand, mirroring the value-taking entries of each parseArgs spec.
 */
const VALUE_TAKING_FLAGS = {
  begin: ['--accept', '--verify', '-v', '--decision'],
  extend: ['--accept', '--verify', '-v', '--decision'],
  end: ['--status', '-s', '--note', '-n', '--verify-result', '-r'],
  log: ['--last', '-n'],
  lane: ['--desc'],
  'lane add': ['--desc'],
  reclaim: ['--reason', '-r', '--older-than'],
  unreclaim: ['--reason', '-r'],
  absorb: ['--decisions'],
  init: ['--lang'],
  migrate: ['--source-log', '--source-decisions', '--destination', '--plan', '--plan-json'],
  'decision add': ['--context', '-c', '--outcome', '-o', '--status', '-s', '--driver', '--option', '--consequence'],
  'decision update': ['--status', '-s', '--note', '-n'],
  'decision list': ['--last', '-n', '--status', '-s'],
  'hook install': ['--target', '--scope', '--root'],
  'hook prompt': ['--format'],
  'hook stop': ['--format'],
  'mcp install': ['--target', '--scope', '--root'],
  'skill install': ['--target', '--scope', '--root'],
};

/**
 * Pre-lock help probe. A bare --help/-h token is help unless it is the value of
 * a known value-taking flag given without `=`, so a real mutation whose flag
 * value happens to be --help still enters the locked path and fails in parseArgs.
 */
function wantsHelpBeforeLock(cmd, rest) {
  const key = Object.hasOwn(VALUE_TAKING_FLAGS, `${cmd} ${rest[0]}`) ? `${cmd} ${rest[0]}` : cmd;
  const valueFlags = VALUE_TAKING_FLAGS[key] || [];
  return rest.some((arg, index) => {
    if (arg !== '--help' && arg !== '-h') return false;
    const previous = index > 0 ? rest[index - 1] : null;
    return previous === null || !valueFlags.includes(previous);
  });
}

function mutationResources(cmd, argv) {
  if (cmd === 'skill') return [parseSkillInstallRequest(argv).skillsDir];
  if (cmd === 'mcp') return [parseMcpInstallRequest(argv).configDir];
  if (cmd === 'hook') return [parseHookInstallRequest(argv.slice(1)).configDir];
  if (cmd === 'init') return [process.cwd()];
  if (cmd === 'migrate') return [process.cwd()];
  if (cmd === 'reclaim' || cmd === 'unreclaim') return [logDir()];
  if (cmd === 'lane') return [logDir()];
  if (cmd === 'absorb' && argv[0] === '--git') {
    const ours = argv[2];
    return ours ? [path.dirname(path.resolve(ours))] : [process.cwd()];
  }
  if (cmd === 'absorb') return [logDir(), decisionDir()];
  if (cmd === 'end' && legacyParkedIntent()) {
    return [path.dirname(legacyIntentLogFile())];
  }
  if (cmd === 'begin' && !argv.some((arg) => arg === '--decision' || arg.startsWith('--decision='))) {
    return [logDir()];
  }
  if (cmd === 'end' && ['failed', 'abandoned'].includes(requestedEndStatus(argv))) {
    return [logDir()];
  }
  return [logDir(), decisionDir()];
}

function usesV2RepositoryState(cmd, rest) {
  if (
    ['begin', 'extend', 'verify', 'end', 'status', 'log', 'lane', 'reclaim', 'unreclaim', 'absorb', 'decision', 'init'].includes(cmd)
  ) {
    return true;
  }
  return cmd === 'hook' && ['prompt', 'stop'].includes(rest[0]);
}

function looksLikeV2SealRoot(root) {
  const resolved = canonicalPath(root);
  if (fs.existsSync(path.join(resolved, 'outcomes', 'events.jsonl'))) return true;
  return resolved === canonicalPath(path.join(process.cwd(), '.seal'));
}

function isV2OutcomeLog(file) {
  const resolved = canonicalPath(file);
  if (resolved === canonicalPath(logFile()) && looksLikeV2SealRoot(sealRoot())) return true;
  const directory = path.dirname(resolved);
  return path.basename(resolved) === 'events.jsonl' &&
    path.basename(directory) === 'outcomes' &&
    looksLikeV2SealRoot(path.dirname(directory));
}

function isV2MadrDirectory(directory) {
  const resolved = canonicalPath(directory);
  if (resolved === canonicalPath(decisionDir()) && looksLikeV2SealRoot(sealRoot())) return true;
  return path.basename(resolved) === 'madr' && looksLikeV2SealRoot(path.dirname(resolved));
}

function existingV2SealRoots() {
  const roots = [];
  const seen = new Set();
  const consider = (root) => {
    const resolved = canonicalPath(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (fs.existsSync(path.join(resolved, 'outcomes', 'events.jsonl'))) roots.push(resolved);
  };
  consider(path.join(process.cwd(), '.seal'));
  consider(sealRoot());
  const cwd = canonicalPath(process.cwd());
  // setup() tests use cwd=os.tmpdir() with DRIFTSEAL_HOME in a child directory.
  // Never scan the system temp root: sibling test dirs would look like extra lineages.
  if (cwd !== canonicalPath(os.tmpdir())) {
    let names = [];
    try {
      names = fs.readdirSync(process.cwd());
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue;
      consider(path.join(process.cwd(), name));
    }
  }
  return roots;
}

function repositoryOutcomeLogFiles() {
  const files = [];
  const seen = new Set();
  const add = (file) => {
    const resolved = canonicalPath(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    files.push(file);
  };
  add(logFile());
  add(path.join(process.cwd(), '.seal', 'outcomes', 'events.jsonl'));
  for (const root of existingV2SealRoots()) {
    add(path.join(root, 'outcomes', 'events.jsonl'));
  }
  return files;
}

function indexedMigrationEvent(file) {
  if (
    canonicalPath(file) !== canonicalPath(logFile()) ||
    !laneIndexFile() ||
    !fs.existsSync(laneIndexFile())
  ) {
    return { usable: false, migration: null };
  }
  let index;
  try {
    index = openOutcomeIndex(laneIndexFile(), { readOnly: true });
    const source = index.source();
    if (!laneIndexMatchesFile(source, file)) {
      return { usable: false, migration: null };
    }
    let migration = index.migrationEvent();
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > source.indexedThrough) {
      consumeLogSlice(
        file,
        source.indexedThrough,
        (event) => {
          if (event.type === 'migration' && event.id === 'v1-to-v2') migration = event;
        },
        {
          readOnly: true,
          startLine: source.indexedLines || 0,
        }
      );
    }
    return { usable: true, migration };
  } catch {
    return { usable: false, migration: null };
  } finally {
    if (index) index.close();
  }
}

function repositoryMigrationEvent() {
  for (const file of repositoryOutcomeLogFiles()) {
    try {
      const indexed = indexedMigrationEvent(file);
      if (indexed.usable) {
        if (indexed.migration) return indexed.migration;
        continue;
      }
      const migration = findMigrationEvent(file);
      if (migration) return migration;
    } catch {
      // Conflicted or corrupt v2 logs are handled by the command, not by v1 detection.
    }
  }
  return null;
}

function v2KnownRecordIds() {
  const ids = new Set();
  for (const file of repositoryOutcomeLogFiles()) {
    if (!fs.existsSync(file)) continue;
    try {
      for (const event of readEvents({ file, repairTail: false, readOnly: true })) {
        if (event.type === 'import' && Array.isArray(event.sources)) {
          for (const source of event.sources) {
            if (source && typeof source.id === 'string') ids.add(source.id);
          }
        }
        if (event.type === 'migration' && Array.isArray(event.excluded)) {
          for (const item of event.excluded) {
            if (item && typeof item.sourceId === 'string') ids.add(item.sourceId);
          }
        }
      }
    } catch {
      // Unreadable v2 logs cannot attest that leftover v1 records are already present.
    }
  }
  return ids;
}

function migrationCoversCandidate(candidate, migration) {
  if (!migration || typeof migration.sourceFingerprint !== 'string') return false;
  try {
    const content = migrationSourceContent(candidate.sourceLog, candidate.sourceDecisions);
    const hashes = hashMigrationSourceContent(content);
    if ([hashes.sourceFingerprint, hashes.legacySourceFingerprint].includes(migration.sourceFingerprint)) {
      return true;
    }
    const beginIds = parseJsonlRecords(content.rawLog, content.sourceLog, { allowLegacy: true })
      .map((record) => record.event)
      .filter((event) => event.type === 'begin')
      .map((event) => event.id);
    const knownIds = v2KnownRecordIds();
    if (beginIds.some((id) => !knownIds.has(id))) return false;
    if (Array.isArray(migration.madrManifest)) {
      const expected = new Map(migration.madrManifest.map((entry) => [entry.name, entry.sha256]));
      for (const decision of content.decisions) {
        const sha256 = expected.get(decision.name);
        if (!sha256) return false;
        const actual = crypto.createHash('sha256').update(decision.bytes).digest('hex');
        if (actual !== sha256) return false;
      }
    }
    return beginIds.length > 0 || content.decisions.length > 0;
  } catch {
    return false;
  }
}

function unmigratedV1Source() {
  const migration = repositoryMigrationEvent();
  const defaultLog = path.resolve(process.cwd(), '.intent-log', 'events.jsonl');
  const defaultDecisions = path.resolve(process.cwd(), '.decision-log');
  const home = v1HomeEnv();
  const configuredLog = home ? path.resolve(home, 'events.jsonl') : null;
  const configuredDecisions = v1DecisionHomeEnv()
    ? path.resolve(v1DecisionHomeEnv())
    : defaultDecisions;
  const candidates = [{
    sourceLog: defaultLog,
    sourceDecisions: defaultDecisions,
  }];
  if (configuredLog) {
    candidates.push({
      sourceLog: configuredLog,
      sourceDecisions: configuredDecisions,
    });
  } else if (v1DecisionHomeEnv()) {
    candidates.push({
      sourceLog: defaultLog,
      sourceDecisions: configuredDecisions,
    });
  }
  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    const key = `${canonicalPath(candidate.sourceLog)}\0${canonicalPath(candidate.sourceDecisions)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hasLog = fs.existsSync(candidate.sourceLog) && !isV2OutcomeLog(candidate.sourceLog);
    const hasDecisions = !isV2MadrDirectory(candidate.sourceDecisions) &&
      migrationDecisionFiles(candidate.sourceDecisions).length > 0;
    if (!hasLog && !hasDecisions) continue;
    if (migration && migrationCoversCandidate(candidate, migration)) continue;
    found.push({ ...candidate, hasLog, hasDecisions });
  }
  if (found.length === 0) return null;
  const withLog = found.filter((candidate) => candidate.hasLog);
  const pool = withLog.length > 0 ? withLog : found;
  if (configuredLog) {
    const configured = pool.find((candidate) => canonicalPath(candidate.sourceLog) === canonicalPath(configuredLog));
    if (configured) return configured;
  }
  return pool[0];
}

function staleInheritedSealHome() {
  if (!process.env.DRIFTSEAL_HOME) return null;
  const home = canonicalPath(process.env.DRIFTSEAL_HOME);
  if (fs.existsSync(logFile())) return null;
  const others = existingV2SealRoots().filter((root) => root !== home);
  if (others.length === 0) return null;
  const defaultSeal = canonicalPath(path.join(process.cwd(), '.seal'));
  return {
    home,
    seal: others.includes(defaultSeal) ? defaultSeal : others[0],
  };
}

function suggestedMigrationDestination(source) {
  const configured = canonicalPath(sealRoot());
  const defaultSeal = canonicalPath(path.join(process.cwd(), '.seal'));
  if (
    pathContains(source.sourceLog, configured) ||
    pathContains(configured, source.sourceLog) ||
    pathContains(source.sourceDecisions, configured) ||
    pathContains(configured, source.sourceDecisions) ||
    fs.existsSync(path.join(configured, 'events.jsonl'))
  ) {
    return defaultSeal;
  }
  return configured;
}

function unmigratedV1Message(source) {
  const destination = suggestedMigrationDestination(source);
  const staged = repositoryMigrationEvent();
  const mismatch = staged
    ? 'it does not match the already staged v1-to-v2 migration; v2 repository commands are disabled until the extra v1 source is removed\n'
    : 'v2 repository commands are disabled until migration is staged\n';
  const parked = legacyParkedIntent();
  const parkHint = parked
    ? `a parked v1 intent ${parked.id} is still open; close it first:\n` +
      '  driftseal end --status abandoned --note "close parked v1 intent before migration"\n'
    : '';
  return (
    `unmigrated v1 state detected at ${source.sourceLog} or ${source.sourceDecisions}; ` +
    mismatch +
    parkHint +
    `run: driftseal migrate v1-to-v2 inspect --source-log ${JSON.stringify(source.sourceLog)} ` +
      `--source-decisions ${JSON.stringify(source.sourceDecisions)} --destination ${JSON.stringify(destination)}\n` +
    'if DRIFTSEAL_HOME points to v1 storage, unset or update it after migration'
  );
}

function assertV2RepositoryReady(cmd, rest) {
  if (!usesV2RepositoryState(cmd, rest)) return;
  if (cmd === 'absorb' && rest[0] === '--git') return;
  if (['end', 'status', 'log'].includes(cmd) && legacyParkedIntent()) return;
  const source = unmigratedV1Source();
  if (source) fail(unmigratedV1Message(source));
  const staleHome = staleInheritedSealHome();
  if (!staleHome) return;
  fail(
    `DRIFTSEAL_HOME points to ${staleHome.home}, which has no v2 outcome log, ` +
      `but this repository already has v2 state at ${staleHome.seal}; ` +
      'unset DRIFTSEAL_HOME or point it at the seal root'
  );
}

function dispatch(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-V') {
    if (rest.length > 0) fail('usage: driftseal --version | -V');
    return { data: commands.version(), exitCode: 0 };
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { data: commands.help(), exitCode: cmd ? 0 : 1 };
  }
  const fn = commands[cmd];
  if (!fn) fail(`unknown command: ${cmd} (run: driftseal help)`);
  try {
    // Help must print even while another session holds the mutation lock. The
    // probe is spec-aware so it never bypasses the lock for a real mutation: a
    // --help token consumed as a flag value is left for parseArgs to reject.
    if (wantsHelpBeforeLock(cmd, rest)) return { data: fn(rest), exitCode: 0 };
    assertV2RepositoryReady(cmd, rest);
    const mutates =
      ['begin', 'extend', 'end', 'init', 'skill', 'mcp', 'reclaim', 'unreclaim', 'absorb'].includes(cmd) ||
      (cmd === 'lane' && ['add', 'switch', 'assign'].includes(rest[0])) ||
      (cmd === 'migrate' && rest[1] === 'apply') ||
      (cmd === 'hook' && rest[0] === 'install') ||
      (cmd === 'decision' && ['add', 'update'].includes(rest[0]));
    const readsIntentLog =
      ['status', 'log'].includes(cmd) ||
      (cmd === 'lane' && (!rest[0] || rest[0] === 'show')) ||
      (cmd === 'hook' && ['prompt', 'stop'].includes(rest[0]));
    if (mutates || readsIntentLog) {
      if (readsIntentLog) {
        let resources;
        if (cmd === 'hook') {
          // Hooks read the nearest ancestor log, not the cwd-relative one: lock
          // the directory of the file the hook will actually read (the park a
          // writer flushes under that same lock lives in the repo's Git metadata).
          // With no ancestor log the hook prints nothing, so skip locking — this
          // also avoids creating a spurious <cwd>/.intent-log.
          const hookFile = hookLogFile();
          if (!hookFile) return { data: fn(rest), exitCode: 0 };
          resources = [path.dirname(hookFile)];
        } else if (legacyParkedIntent()) {
          resources = [path.dirname(legacyIntentLogFile())];
        } else {
          resources = [logDir()];
        }
        const locked = withMutationLocks(resources, () => fn(rest), {
          tryWaitMs: READ_ONLY_LOCK_WAIT_MS,
        });
        if (locked !== null) {
          return {
            data: locked.data,
            exitCode:
              locked.data && Number.isInteger(locked.data.exitCode) ? locked.data.exitCode : 0,
          };
        }
        // Degrade to a lock-free read-only read rather than blocking re-anchoring.
        if (cmd === 'hook') printError(READ_ONLY_NOTICE);
        else printLine(READ_ONLY_NOTICE);
        const data = fn(rest, { readOnly: true });
        return { data, exitCode: data && Number.isInteger(data.exitCode) ? data.exitCode : 0, readOnly: true };
      }
      const resources = mutationResources(cmd, rest);
      const data = withMutationLocks(resources, () => fn(rest));
      return { data, exitCode: data && Number.isInteger(data.exitCode) ? data.exitCode : 0 };
    }
    const data = fn(rest);
    return {
      data,
      exitCode: data && Number.isInteger(data.exitCode) ? data.exitCode : 0,
    };
  } catch (err) {
    if (err instanceof HelpRequested) {
      printLine(usageFor(err.usageKey) || usageFor(cmd) || 'run: driftseal help');
      return { data: null, exitCode: 0 };
    }
    throw err;
  }
}

function repositoryRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    fail('repository root must be a non-empty path');
  }
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`repository root does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) fail(`repository root is not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function runCommand(argv, { root = process.cwd(), isolateStorage = false, capture = true } = {}) {
  assertSupportedNode();
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    fail('command arguments must be an array of strings');
  }
  if (capture && activeOutput) fail('nested captured DriftSeal commands are not supported');

  const fixedRoot = repositoryRoot(root);
  const previousCwd = process.cwd();
  const previousIntentHome = process.env.DRIFTSEAL_HOME;
  const previousDecisionHome = process.env.DRIFTSEAL_DECISION_HOME;
  const output = { stdout: '', stderr: '', data: null, exitCode: 0, readOnly: false };
  const captures = capture
    ? { stdout: createBoundedOutputCapture(), stderr: createBoundedOutputCapture() }
    : null;
  const previousOutput = activeOutput;
  const finalizeCapturedOutput = () => {
    if (!captures) return;
    output.stdout = renderBoundedOutput(captures.stdout);
    output.stderr = renderBoundedOutput(captures.stderr);
  };

  try {
    process.chdir(fixedRoot);
    if (isolateStorage) {
      isolatedV1Detection = {
        home: process.env.DRIFTSEAL_HOME || null,
        decisions: process.env.DRIFTSEAL_DECISION_HOME || null,
      };
      delete process.env.DRIFTSEAL_HOME;
      delete process.env.DRIFTSEAL_DECISION_HOME;
    }
    if (capture) activeOutput = captures;
    const result = dispatch(argv);
    output.data = result.data;
    output.exitCode = result.exitCode;
    output.readOnly = result.readOnly === true;
    finalizeCapturedOutput();
    return output;
  } catch (err) {
    if (capture) {
      finalizeCapturedOutput();
      err.stdout = output.stdout;
      err.stderr = output.stderr;
    }
    throw err;
  } finally {
    activeOutput = previousOutput;
    process.chdir(previousCwd);
    isolatedV1Detection = null;
    if (previousIntentHome === undefined) delete process.env.DRIFTSEAL_HOME;
    else process.env.DRIFTSEAL_HOME = previousIntentHome;
    if (previousDecisionHome === undefined) delete process.env.DRIFTSEAL_DECISION_HOME;
    else process.env.DRIFTSEAL_DECISION_HOME = previousDecisionHome;
  }
}

function appendFlag(argv, flag, value) {
  if (value !== undefined && value !== null && value !== '') argv.push(flag, String(value));
}

function createApi({ root = process.cwd(), isolateStorage = false } = {}) {
  assertSupportedNode();
  const fixedRoot = repositoryRoot(root);
  let lastReadOnly = false;
  const call = (argv) => {
    const output = runCommand(argv, { root: fixedRoot, isolateStorage, capture: true });
    lastReadOnly = output.readOnly;
    return output.data;
  };
  return Object.freeze({
    root: fixedRoot,
    /** True when the most recent call fell back to a lock-free read-only snapshot. */
    get readOnly() {
      return lastReadOnly;
    },
    status() {
      return call(['status']);
    },
    begin({ outcome, acceptance = [], verify, decisions = [], force = false }) {
      const argv = ['begin', outcome];
      for (const criterion of acceptance) appendFlag(argv, '--accept', criterion);
      appendFlag(argv, '--verify', verify);
      for (const decision of decisions) appendFlag(argv, '--decision', decision);
      if (force) argv.push('--force');
      return call(argv);
    },
    extend({ extension, acceptance = [], verify, decisions = [] }) {
      const argv = ['extend', extension];
      for (const criterion of acceptance) appendFlag(argv, '--accept', criterion);
      appendFlag(argv, '--verify', verify);
      for (const decision of decisions) appendFlag(argv, '--decision', decision);
      return call(argv);
    },
    verify({ allowTrackedCommand = false } = {}) {
      return call(['verify', ...(allowTrackedCommand ? ['--allow-tracked-command'] : [])]);
    },
    end({ id, status, note, verifyResult } = {}) {
      const argv = ['end'];
      if (id) argv.push(String(id));
      appendFlag(argv, '--status', status);
      appendFlag(argv, '--note', note);
      appendFlag(argv, '--verify-result', verifyResult);
      return call(argv);
    },
    log({ last, all = false, allLanes = false } = {}) {
      const argv = ['log'];
      appendFlag(argv, '--last', last);
      if (all) argv.push('--all');
      if (allLanes) argv.push('--all-lanes');
      return call(argv);
    },
    lane() {
      return call(['lane']);
    },
    laneAdd({ name, description } = {}) {
      const argv = ['lane', 'add', String(name)];
      appendFlag(argv, '--desc', description);
      return call(argv);
    },
    laneSwitch({ name } = {}) {
      return call(['lane', 'switch', String(name)]);
    },
    laneAssign({ id, lane } = {}) {
      return call(['lane', 'assign', String(id), String(lane)]);
    },
    absorb({ otherLog, otherDecisions, abandon, dryRun = false } = {}) {
      if (abandon && !['ours', 'theirs'].includes(abandon)) {
        fail('absorb abandon must be "ours" or "theirs"');
      }
      const argv = ['absorb'];
      if (otherLog) argv.push(String(otherLog));
      appendFlag(argv, '--decisions', otherDecisions);
      if (abandon) argv.push(`--abandon-${abandon}`);
      if (dryRun) argv.push('--dry-run');
      return call(argv);
    },
    reclaim({ ids = [], reason, olderThan, force = false, dryRun = false }) {
      const argv = ['reclaim', ...ids.map(String), '--reason', reason];
      appendFlag(argv, '--older-than', olderThan);
      if (force) argv.push('--force');
      if (dryRun) argv.push('--dry-run');
      return call(argv);
    },
    unreclaim({ id, reason }) {
      return call(['unreclaim', String(id), '--reason', reason]);
    },
    decisionAdd({ title, context, outcome, status, drivers = [], options = [], consequences = [] }) {
      const argv = ['decision', 'add', title, '--context', context, '--outcome', outcome];
      appendFlag(argv, '--status', status);
      for (const driver of drivers) appendFlag(argv, '--driver', driver);
      for (const option of options) appendFlag(argv, '--option', option);
      for (const consequence of consequences) appendFlag(argv, '--consequence', consequence);
      return call(argv);
    },
    decisionUpdate({ id, status, note }) {
      const argv = ['decision', 'update', String(id), '--note', note];
      appendFlag(argv, '--status', status);
      return call(argv);
    },
    decisionList({ status, last, count = false } = {}) {
      const argv = ['decision', 'list'];
      appendFlag(argv, '--status', status);
      appendFlag(argv, '--last', last);
      if (count) argv.push('--count');
      return call(argv);
    },
    decisionShow({ id }) {
      return call(['decision', 'show', String(id)]);
    },
    migrationInspect({ sourceLog, sourceDecisions, destination } = {}) {
      const argv = ['migrate', 'v1-to-v2', 'inspect'];
      appendFlag(argv, '--source-log', sourceLog);
      appendFlag(argv, '--source-decisions', sourceDecisions);
      appendFlag(argv, '--destination', destination);
      return call(argv);
    },
    migrationApply({ plan, sourceLog, sourceDecisions, destination }) {
      const argv = ['migrate', 'v1-to-v2', 'apply', '--plan-json', JSON.stringify(plan)];
      appendFlag(argv, '--source-log', sourceLog);
      appendFlag(argv, '--source-decisions', sourceDecisions);
      appendFlag(argv, '--destination', destination);
      return call(argv);
    },
    migrationCheck({ sourceLog, sourceDecisions, destination } = {}) {
      const argv = ['migrate', 'v1-to-v2', 'check'];
      appendFlag(argv, '--source-log', sourceLog);
      appendFlag(argv, '--source-decisions', sourceDecisions);
      appendFlag(argv, '--destination', destination);
      return call(argv);
    },
    init() {
      return call(['init']);
    },
  });
}

function main() {
  try {
    assertSupportedNode();
    const result = dispatch(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`driftseal: error: ${message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DECISION_STATUSES,
  END_STATUSES,
  DriftSealError,
  createApi,
  runCommand,
};

if (require.main === module) main();
