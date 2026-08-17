#!/usr/bin/env node
'use strict';

/**
 * DriftSeal — Seal the intent. Stop the drift.
 *
 * Intent-level write-ahead log and MADR decision log for agentic coding sessions.
 *
 * Protocol per work round:
 *   1. driftseal begin "<intent>" [--verify "<how to verify>"]   (before changes that may need a rollback)
 *   2. execute the intent
 *   3. driftseal end [--status ...] [--note ...] [--verify-result ...]  (reconcile against intent)
 *
 * Events are appended to an append-only JSONL log (WAL semantics):
 *   { "type": "begin", "id", "ts", "intent", "verify" }
 *   { "type": "end",   "id", "ts", "status", "note", "verifyResult" }
 *
 * Intent log: $DRIFTSEAL_HOME/events.jsonl, or .intent-log/events.jsonl in cwd.
 * In a Git worktree, an open intent is parked in Git metadata until end.
 * Decision log: $DRIFTSEAL_DECISION_HOME, or .decision-log/ in cwd.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { isDeepStrictEqual } = require('util');
const { execFileSync } = require('child_process');
const { version: PACKAGE_VERSION } = require('../package.json');

const END_STATUSES = ['completed', 'partial', 'failed', 'abandoned'];
const DECISION_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'deferred',
  'deprecated',
  'superseded',
];
const EVENT_SCHEMA_VERSION = 3;
const PROTOCOL_VERSION = 12;
const DEFAULT_LOG_LANGUAGE = 'en';
const IN_PROGRESS_GIT_PATH = 'driftseal-in-progress.jsonl';
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_INIT_STALE_MS = 5 * 1000;
const READ_ONLY_NOTICE = '(read-only: another mutation holds the lock; tail repair skipped)';
const READ_ONLY_LOCK_WAIT_MS = Number(process.env._DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS) || 1500;
const MAX_DECISION_SLUG_LENGTH = 180;

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
    begin: 'usage: driftseal begin "<intent>" [--verify "<how to verify>"] [--decision <id>] [--force]',
    end: 'usage: driftseal end [id] [options]',
    status: 'usage: driftseal status',
    log: 'usage: driftseal log [--last N] [--all]',
    reclaim:
      'usage: driftseal reclaim [id ...] --reason "<why>" [--older-than <days>] [--force] [--dry-run]',
    unreclaim: 'usage: driftseal unreclaim <id> --reason "<why>"',
    absorb: absorbUsage(),
    init: 'usage: driftseal init [--lang <tag>] [--local-log]',
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

function printLine(value = '') {
  const text = String(value);
  if (activeOutput) {
    activeOutput.stdout += text + '\n';
    return;
  }
  console.log(text);
}

function printError(value = '') {
  const text = String(value);
  if (activeOutput) {
    activeOutput.stderr += text + '\n';
    return;
  }
  console.error(text);
}

function writeOutput(value) {
  const text = String(value);
  if (activeOutput) {
    activeOutput.stdout += text;
    return;
  }
  process.stdout.write(text);
}

if (process.env._DRIFTSEAL_TEST_UMASK) {
  process.umask(Number.parseInt(process.env._DRIFTSEAL_TEST_UMASK, 8));
}

function logDir() {
  return process.env.DRIFTSEAL_HOME || path.join(process.cwd(), '.intent-log');
}

function logFile() {
  return path.join(logDir(), 'events.jsonl');
}

function decisionDir() {
  return process.env.DRIFTSEAL_DECISION_HOME || path.join(process.cwd(), '.decision-log');
}

function normalizeEvent(event, line) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail(`invalid event object on log line ${line}`);
  }
  if (
    event.schemaVersion !== undefined &&
    (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1)
  ) {
    fail(`invalid event schema version on log line ${line}`);
  }
  if (event.schemaVersion > EVENT_SCHEMA_VERSION) {
    fail(
      `event schema ${event.schemaVersion} requires a newer DriftSeal client (supported: ${EVENT_SCHEMA_VERSION})`
    );
  }
  if (typeof event.type !== 'string' || typeof event.id !== 'string' || event.id.length === 0) {
    fail(`invalid event type or intent id on log line ${line}`);
  }

  if (event.type === 'begin') {
    if (typeof event.intent !== 'string' || event.intent.trim().length === 0) {
      fail(`invalid begin event on log line ${line}`);
    }
    if (!Array.isArray(event.decisions) && event.decisions !== undefined) {
      fail(`invalid decisions list on log line ${line}`);
    }
    const decisions = (event.decisions || []).map(normalizeDecisionId);
    if (new Set(decisions).size !== decisions.length) {
      fail(`duplicate linked decision on log line ${line}`);
    }
    return { ...event, decisions };
  }

  if (event.type === 'end') {
    if (!END_STATUSES.includes(event.status)) fail(`invalid end event on log line ${line}`);
    return event;
  }

  if (event.type === 'reclaim' || event.type === 'unreclaim') {
    if (typeof event.reason !== 'string' || event.reason.trim().length === 0) {
      fail(`invalid ${event.type} event on log line ${line}`);
    }
    return event;
  }

  if (
    event.type === 'decision_reconcile' ||
    event.type === 'decision_reconcile_prepare' ||
    event.type === 'decision_reconcile_commit' ||
    event.type === 'decision_reconcile_abort' ||
    event.type === 'decision_reconcile_cancel'
  ) {
    const schemaVersion = event.schemaVersion || 1;
    if (event.type === 'decision_reconcile' && schemaVersion >= 2) {
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
      !['failed', 'abandoned'].includes(event.intentStatus)
    ) {
      fail(`invalid reconciliation cancellation on log line ${line}`);
    }
    return { ...event, decisionId };
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

function isParkableIntentLog() {
  if (process.env.DRIFTSEAL_HOME) return false;
  const root = gitWorktreeRoot();
  if (!root) return false;
  return path.resolve(logFile()) === path.resolve(root, '.intent-log', 'events.jsonl');
}

function inProgressFile() {
  if (!isParkableIntentLog()) return null;
  return worktreeInProgressFile();
}

function liveWorktreeIntentLog() {
  const root = gitWorktreeRoot();
  if (!root) return null;
  return path.resolve(root, '.intent-log', 'events.jsonl');
}

function sameResolvedPath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function shouldAttachInProgress(file) {
  if (process.env.DRIFTSEAL_HOME) return false;
  const live = liveWorktreeIntentLog();
  return live !== null && sameResolvedPath(file, live);
}

function readJsonlRecordsFromFile(file, { repairTail = false, readOnly = false } = {}) {
  if (!fs.existsSync(file)) return [];
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

function readEvents({ repairTail = false, readOnly = false, file = logFile() } = {}) {
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

function parseJsonlRecords(content, source = 'log') {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return { raw: line, event: normalizeEvent(JSON.parse(line), i + 1) };
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

function appendEventTo(file, event) {
  ensureDirectoryDurable(path.dirname(file));
  const existed = fs.existsSync(file);
  const storedEvent = { schemaVersion: EVENT_SCHEMA_VERSION, ...event };
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
 * Returns the intent ids it had to remap.
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
    plan.mappings.filter((mapping) => mapping.kind === 'intent').map((mapping) => [mapping.from, mapping.to])
  );
}

function parkedOpenIntent(park) {
  if (!fs.existsSync(park)) return null;
  const records = readJsonlRecordsFromFile(park, { repairTail: true });
  return openIntent(fold(records.map((record) => record.event)));
}

function appendEvent(event) {
  const park = inProgressFile();
  if (!park) return appendEventTo(logFile(), event);

  const open = parkedOpenIntent(park);
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

function atomicWriteFile(target, content) {
  const existed = fs.existsSync(target);
  const mode = existed ? fs.statSync(target).mode & 0o777 : 0o644;
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

/** Fold the event stream into one record per intent. */
function fold(events) {
  const records = new Map();
  const reconciliations = new Map();
  const order = [];
  for (const ev of events) {
    if (ev.type === 'begin') {
      if (records.has(ev.id)) fail(`duplicate begin event for intent id: ${ev.id}`);
      records.set(ev.id, {
        id: ev.id,
        tsBegin: ev.ts,
        intent: ev.intent,
        verify: ev.verify || null,
        beginHead: ev.head || null,
        decisions: Array.isArray(ev.decisions) ? ev.decisions : [],
        schemaVersion: ev.schemaVersion || 1,
        decisionPrepares: [],
        decisionTerminals: [],
        decisionUpdates: [],
        status: 'in_progress',
        tsEnd: null,
        note: null,
        verifyResult: null,
        endHead: null,
        reclaimed: false,
        reclaimReason: null,
        reclaimedAt: null,
      });
      order.push(ev.id);
    } else if (ev.type === 'reclaim' || ev.type === 'unreclaim') {
      const rec = records.get(ev.id);
      if (!rec) fail(`${ev.type} event references unknown intent id: ${ev.id}`);
      if (ev.type === 'reclaim') {
        if (rec.status === 'in_progress') {
          fail(`cannot reclaim intent ${ev.id} while it is in_progress`);
        }
        if (rec.reclaimed) fail(`duplicate reclaim event for intent id: ${ev.id}`);
        rec.reclaimed = true;
        rec.reclaimReason = ev.reason;
        rec.reclaimedAt = ev.ts;
      } else {
        if (!rec.reclaimed) fail(`unreclaim event for intent id that is not reclaimed: ${ev.id}`);
        rec.reclaimed = false;
        rec.reclaimReason = null;
        rec.reclaimedAt = null;
      }
    } else if (ev.type === 'end') {
      const rec = records.get(ev.id);
      if (!rec) fail(`end event references unknown intent id: ${ev.id}`);
      if (rec.status !== 'in_progress') {
        fail(`duplicate end event for intent id: ${ev.id}`);
      }
      const conflictingCancellation = rec.decisionTerminals.find(
        (terminal) =>
          terminal.type === 'decision_reconcile_cancel' &&
          terminal.intentStatus !== ev.status
      );
      if (conflictingCancellation) {
        fail(
          `intent ${ev.id} was closed as ${ev.status} after reconciliation recovery was cancelled for ${conflictingCancellation.intentStatus}`
        );
      }
      if (
        ['completed', 'partial'].includes(ev.status) &&
        rec.decisions.length > 0 &&
        ((rec.schemaVersion >= 2 && (ev.schemaVersion || 1) < 2) ||
          rec.decisions.some(
            (decisionId) => qualifyingDecisionUpdates(rec, decisionId).length === 0
          ))
      ) {
        fail(`linked intent ${ev.id} was closed without reconciling every declared decision`);
      }
      rec.status = ev.status;
      rec.tsEnd = ev.ts;
      rec.note = ev.note || null;
      rec.verifyResult = ev.verifyResult || null;
      rec.endHead = ev.head || null;
    } else if (ev.type === 'decision_reconcile_prepare') {
      const rec = records.get(ev.id);
      if (!rec) fail(`decision reconciliation references unknown intent id: ${ev.id}`);
      if (rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after intent ${ev.id} was closed`);
      }
      if (!rec.decisions.includes(ev.decisionId)) {
        fail(`decision reconciliation references unlinked decision ${ev.decisionId}`);
      }
      if (reconciliations.has(ev.reconciliationId)) {
        fail(`duplicate reconciliation id: ${ev.reconciliationId}`);
      }
      rec.decisionPrepares.push(ev);
      reconciliations.set(ev.reconciliationId, { prepare: ev, terminal: null });
    } else if (ev.type === 'decision_reconcile') {
      const rec = records.get(ev.id);
      if (!rec) fail(`decision reconciliation references unknown intent id: ${ev.id}`);
      if (rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after intent ${ev.id} was closed`);
      }
      if (rec.schemaVersion >= 2) {
        fail(`linked schema-v2 intent ${rec.id} contains a legacy decision reconciliation`);
      }
      rec.decisionUpdates.push(ev);
    } else if (
      ev.type === 'decision_reconcile_commit' ||
      ev.type === 'decision_reconcile_abort' ||
      ev.type === 'decision_reconcile_cancel'
    ) {
      const rec = records.get(ev.id);
      const reconciliation = reconciliations.get(ev.reconciliationId);
      if (rec && rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after intent ${ev.id} was closed`);
      }
      if (
        !rec ||
        !reconciliation ||
        reconciliation.prepare.id !== ev.id ||
        reconciliation.prepare.decisionId !== ev.decisionId
      ) {
        fail(`decision reconciliation terminal has no matching prepare: ${ev.reconciliationId}`);
      }
      if (reconciliation.terminal) {
        fail(`decision reconciliation already has a terminal event: ${ev.reconciliationId}`);
      }
      const priorCancellation = rec.decisionTerminals.find(
        (terminal) => terminal.type === 'decision_reconcile_cancel'
      );
      if (
        ev.type === 'decision_reconcile_cancel' &&
        priorCancellation &&
        priorCancellation.intentStatus !== ev.intentStatus
      ) {
        fail(`intent ${ev.id} has conflicting reconciliation cancellation statuses`);
      }
      if (
        ev.type === 'decision_reconcile_commit' &&
        (reconciliation.prepare.newHash !== ev.fileHash ||
          reconciliation.prepare.fromStatus !== ev.fromStatus ||
          reconciliation.prepare.toStatus !== ev.toStatus)
      ) {
        fail(`decision reconciliation commit does not match prepare: ${ev.reconciliationId}`);
      }
      reconciliation.terminal = ev;
      rec.decisionTerminals.push(ev);
      if (ev.type === 'decision_reconcile_commit') rec.decisionUpdates.push(ev);
    }
  }
  return order.map((id) => records.get(id));
}

function qualifyingDecisionUpdates(record, decisionId) {
  return record.decisionUpdates.filter((update) => {
    if (update.decisionId !== decisionId) return false;
    if (record.schemaVersion < 2) return true;
    return (
      update.type === 'decision_reconcile_commit' &&
      (update.schemaVersion || 1) >= 2 &&
      typeof update.fileHash === 'string'
    );
  });
}

function openIntent(records) {
  const open = records.filter((record) => record.status === 'in_progress');
  if (open.length > 1) fail(`multiple intents in progress: ${open.map((record) => record.id).join(', ')}`);
  return open[0] || null;
}

function parseIntentId(id) {
  const match = String(id).match(/^(\d{4}-\d{2}-\d{2})-(\d+)$/);
  if (!match) fail(`invalid intent id: ${id}`);
  return { date: match[1], seq: Number.parseInt(match[2], 10) };
}

function nextIdForDate(date, events) {
  let maxSeq = 0;
  const prefix = `${date}-`;
  for (const ev of events) {
    if (ev.type === 'begin' && typeof ev.id === 'string' && ev.id.startsWith(prefix)) {
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

function prepareDecisionReconciliation(decision, intentId, status, note) {
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
  const history = `${historyHeading}<!-- driftseal-reconciliation: ${reconciliationId} -->${eol}### ${ts} — Intent \`${intentId}\`${eol}${eol}Status: ${titleCase(fromStatus)} → ${titleCase(status)}${eol}${eol}${normalizedNote}${eol}`;
  const separator = updated.endsWith(eol + eol) ? '' : updated.endsWith(eol) ? eol : eol + eol;
  const nextContent = updated + separator + history;
  return {
    type: 'decision_reconcile_prepare',
    id: intentId,
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

function pendingReconciliations(events, intentId) {
  const prepares = new Map();
  const finished = new Set();
  for (const event of events) {
    if (event.id !== intentId) continue;
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

function recoverPendingReconciliations(events, intentId) {
  const pending = pendingReconciliations(events, intentId);
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

function cancelPendingReconciliations(events, intentId, intentStatus) {
  for (const prepare of pendingReconciliations(events, intentId)) {
    const cancellation = {
      type: 'decision_reconcile_cancel',
      id: prepare.id,
      decisionId: prepare.decisionId,
      reconciliationId: prepare.reconciliationId,
      ts: new Date().toISOString(),
      intentStatus,
      note: `automatic recovery cancelled because intent closed as ${intentStatus}`,
    };
    events.push(appendEvent(cancellation));
  }
  return events;
}

function escapeCancellationStatus(record) {
  const cancellation = record.decisionTerminals.find(
    (terminal) => terminal.type === 'decision_reconcile_cancel'
  );
  return cancellation ? cancellation.intentStatus : null;
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

function render(rec) {
  const lines = [`[${rec.id}] ${rec.status}`];
  lines.push(`  intent: ${rec.intent}`);
  if (rec.decisions.length > 0) lines.push(`  decisions: ${rec.decisions.join(', ')}`);
  if (rec.verify) lines.push(`  verify: ${rec.verify}`);
  if (rec.verifyResult) lines.push(`  verify-result: ${rec.verifyResult}`);
  if (rec.note) lines.push(`  note: ${rec.note}`);
  if (rec.beginHead || rec.endHead) {
    lines.push(`  head: ${rec.beginHead || '-'}..${rec.endHead || '-'}`);
  }
  lines.push(`  began: ${rec.tsBegin}` + (rec.tsEnd ? `  ended: ${rec.tsEnd}` : ''));
  if (rec.reclaimed) lines.push(`  reclaimed: ${rec.reclaimReason}`);
  return lines.join('\n');
}

function publicIntent(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    intent: rec.intent,
    verify: rec.verify,
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

function intentProtocolBlock(version = PROTOCOL_VERSION, language = DEFAULT_LOG_LANGUAGE, localLog = false) {
  return `${INTENT_PROTOCOL_MARKER}
<!-- driftseal-version: ${version} -->
<!-- driftseal-log-language: ${language} -->${localLog ? '\n<!-- driftseal-local-log: true -->' : ''}

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (\`driftseal\`) to prevent agent drift. Every work round:

This \`AGENTS.md\` protocol is the source of truth. Use the \`driftseal\` CLI by
default; the companion skill only helps discover and resume the workflow, while
MCP and lifecycle hooks are optional adapters.

${intentLogLanguageParagraph(language)}

1. **Write intent first**, before modifying, creating, or deleting files, or
   making any other non-Git change that may need a rollback:
   \`driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"\`.
   Add one \`--decision <id>\` for each existing decision this round may change.
   Git operations never need an intent and are not included in the intent log;
   Git maintains their history. This includes inspection, branch and worktree
   management, staging, commits, merges, rebases, cherry-picks, tags, and pushes.
   A command whose result can be reconstructed from Git state (for example a
   patch file regenerated from a commit range, or a scratch harness that
   re-runs) needs no intent; content that will be committed and cannot be
   reconstructed (for example a .gitignore edit) does.
   Single-step commands that only build or check work already done, such as
   compiling or running tests, also need no intent.
   Size an intent to the smallest unit that leaves the tree self-consistent
   and can be verified on its own.
2. **Execute only the intent.** Scope change? Close the current intent
   (\`driftseal end -s partial|abandoned -n "<why>"\`) and \`driftseal begin\` a new one.
3. **Verify, then close**: run the declared verification, then
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<what the verification showed, written for the next agent>"\`.
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
   even though they do not require an intent. Any non-Git content change made while
   preparing a Git operation does require a new intent, per the step 1 test.
4. **Re-anchor after context loss**: run \`driftseal status\` and \`driftseal log --last 3\` before
   doing anything else. The open intent is the source of truth: resume it when its
   objective still matches the current task; otherwise close it (\`partial\` or
   \`abandoned\`, with a note) and \`begin\` a new one.

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

function previousIntentProtocolBlock(version) {
  const v11 = intentProtocolBlock(version, DEFAULT_LOG_LANGUAGE)
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
  const v10 = stripIntentLogLanguage(v11);
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

function previousDecisionProtocolBlock(version) {
  if (version >= 11) return decisionProtocolBlock(version, DEFAULT_LOG_LANGUAGE);
  const v10 = stripDecisionLogLanguage(decisionProtocolBlock(version, DEFAULT_LOG_LANGUAGE));
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
    const version = Number(versionMatch[1]);
    if (!Number.isSafeInteger(version) || version < 1) {
      fail(`invalid protocol version in block beginning with ${marker}`);
    }
    if (version > PROTOCOL_VERSION) {
      fail(
        `protocol version ${version} requires a newer DriftSeal client (supported: ${PROTOCOL_VERSION})`
      );
    }
    if (
      block !== replacement &&
      !knownManagedBlocks.includes(block) &&
      protocolBlockKey(block) !== protocolBlockKey(replacement)
    ) {
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
  'df8bc7035de1a19faf307c92f9bb0f4052e683d1a94881c2c5d5cbef48b67568', // dc9899d 1.1.7 parked intents in absorb (current)
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
      project: path.join(root, '.kimi', 'skills'),
      global: path.join(home, '.kimi', 'skills'),
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
    const candidate = path.join(current, '.intent-log', 'events.jsonl');
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

/** Advisory reminder text; null when no ancestor has an intent log yet. */
function hookReminder(event, { readOnly = false } = {}) {
  const file = hookLogFile();
  if (!file) return null;
  if (event === 'prompt') {
    return (
      'DriftSeal reminder: if this round will modify files or anything else that may need a ' +
      'rollback, begin an intent first: driftseal begin "<intent>" --verify "<check>". ' +
      'Questions, read-only exploration, and single-step checks need no intent — skip this ' +
      'reminder when it does not apply.'
    );
  }
  const open = openIntent(fold(readEvents({ file, readOnly })));
  if (open) {
    return (
      `DriftSeal reminder: intent ${open.id} is still in_progress: "${open.intent}". ` +
      'If its work is done, run the declared verification and close it with driftseal end; ' +
      'if this turn was unrelated, ignore this reminder.'
    );
  }
  return (
    'DriftSeal reminder: no intent is open. If this round changed files without one, consider ' +
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

function isGitWorkTree(cwd = process.cwd()) {
  return gitCapture(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
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
  const out = gitCapture(['ls-tree', '-r', '--name-only', treeish, '.decision-log'], cwd);
  if (!out) return new Set();
  const ids = new Set();
  for (const file of out.split('\n')) {
    const match = path.basename(file).match(/^(\d{4,})-.*\.md$/);
    if (match) ids.add(normalizeDecisionId(match[1]));
  }
  return ids;
}

function gitDecisionEntries(treeish, cwd = process.cwd()) {
  const out = gitCapture(['ls-tree', '-r', '--name-only', treeish, '.decision-log'], cwd);
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

function gitIntentRecords(treeish, cwd = process.cwd()) {
  const content = gitReadFile(treeish, '.intent-log/events.jsonl', cwd);
  return content === null ? [] : parseJsonlRecords(content, `${treeish}:.intent-log/events.jsonl`);
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

function hasDuplicateIntentBegins(records) {
  const seen = new Set();
  for (const record of records) {
    if (record.event.type !== 'begin') continue;
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

function remapTheirsRecords(theirsNew, oursUsedEvents, decisionMap, hashMap = new Map()) {
  const intentMap = new Map();
  const mappings = [];
  const used = [...oursUsedEvents];
  const records = theirsNew.map((record) => {
    let event = record.event;
    if (event.type === 'begin' && used.some((item) => item.type === 'begin' && item.id === event.id)) {
      const { date } = parseIntentId(event.id);
      const newId = nextIdForDate(date, used);
      intentMap.set(event.id, newId);
      mappings.push({ kind: 'intent', from: event.id, to: newId });
    }
    event = remapEvent(event, intentMap, decisionMap, hashMap);
    used.push(event);
    return { event };
  });
  return { records, mappings };
}

function repairDuplicateIntentRecords(records, decisionMap, hashMap = new Map()) {
  const seenBegins = new Set();
  const intentMap = new Map();
  const used = [];
  const mappings = [];
  const result = [];
  let incomingSide = false;
  for (const record of records) {
    let event = record.event;
    if (event.type === 'begin' && seenBegins.has(event.id)) {
      incomingSide = true;
      const { date } = parseIntentId(event.id);
      const newId = nextIdForDate(date, used);
      intentMap.set(event.id, newId);
      mappings.push({ kind: 'intent', from: event.id, to: newId });
    } else if (event.type === 'begin') {
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
  return { records: result, mappings, incomingSide };
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

function countAbsorbedIntents(records) {
  return records.filter((record) => record.event.type === 'begin').length;
}

function printAbsorbReport({ mappings, abandoned, intentCount }) {
  const remappedIntents = mappings.filter((mapping) => mapping.kind === 'intent').length;
  const remappedDecisions = mappings.filter((mapping) => mapping.kind === 'decision').length;
  printLine(
    `absorbed ${intentCount} intent(s), remapped ${remappedIntents} intent id(s), ${remappedDecisions} decision id(s)`
  );
  for (const mapping of mappings) {
    const side = mapping.side || 'theirs';
    if (mapping.kind === 'intent') printLine(`${mapping.from} (${side}) -> ${mapping.to}`);
    else printLine(`decision ${mapping.from} (${side}) -> ${mapping.to}`);
  }
  if (abandoned) printLine(`abandoned ${abandoned} during absorb`);
}

function abandonOpenIntent(records, targetId, side) {
  records.push({
    event: {
      schemaVersion: EVENT_SCHEMA_VERSION,
      type: 'end',
      id: targetId,
      ts: new Date().toISOString(),
      status: 'abandoned',
      note: `abandoned during absorb (--abandon-${side})`,
      verifyResult: null,
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
  const oursOpen = openIntent(fold(oursRecords.map((record) => record.event)));
  const theirsOpen = openIntent(fold(theirsRecords.map((record) => record.event)));
  try {
    openIntent(fold([...result, ...overlay].map((record) => record.event)));
    return { abandoned: null, conflict: false, parkedClosed: false };
  } catch (err) {
    if (!(err instanceof DriftSealError) || !/multiple intents in progress/.test(err.message)) {
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
  return '.intent-log/events.jsonl merge=driftseal';
}

function ensureGitAttributes() {
  const target = path.join(process.cwd(), '.gitattributes');
  const line = GITATTRIBUTES_MERGE_LINE();
  const existed = fs.existsSync(target);
  const current = existed ? fs.readFileSync(target, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  if (lines.some((entry) => entry.trim() === line)) return { changed: false, target };
  const prefix = current.length === 0 || current.endsWith('\n') || current.endsWith('\r\n') ? '' : eol;
  const next = `${current}${prefix}${line}${eol}`;
  atomicWriteFile(target, next);
  return { changed: true, target };
}

function ensureGitMergeDriver() {
  if (!isGitWorkTree()) return { changed: false, configured: false };
  const name = gitCapture(['config', '--local', '--get', 'merge.driftseal.name']);
  const driver = gitCapture(['config', '--local', '--get', 'merge.driftseal.driver']);
  const expectedName = 'DriftSeal intent log merge';
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

function loadAbsorbSide(file, label, { repairTail = false, allowMissing = false } = {}) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return { records: [], conflict: false };
    fail(`intent log not found: ${file}`);
  }
  let content = fs.readFileSync(file, 'utf8');
  if (repairTail && !/^<<<<<<< /m.test(content)) {
    readEvents({ file, repairTail: true });
    content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  const conflict = parseConflictContent(content);
  if (conflict) {
    return {
      ours: parseJsonlRecords(conflict.oursText, `${label} ours`),
      theirs: parseJsonlRecords(conflict.theirsText, `${label} theirs`),
      conflict: true,
    };
  }
  return { records: parseJsonlRecords(content, label), conflict: false };
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
  intentCount,
  allowConflict = false,
  followupMessage = null,
}) {
  // An intent parked in Git metadata is part of our side even though the log never saw it.
  const park = shouldAttachInProgress(outputFile) ? inProgressFile() : null;
  const plan = planInProgressOverlay(result.map((record) => record.event), park, {
    repairTail: true,
  });
  const overlay = plan && !plan.alreadyCommitted ? plan.records : [];
  const parkedOpen =
    overlay.length > 0 ? openIntent(fold(overlay.map((record) => record.event))) : null;
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
  if (!conflict) openIntent(fold(effective));
  if (!dryRun) {
    writeJsonl(outputFile, merged);
    applyDecisionCopies(copies, dryRun);
    if (plan) {
      if (plan.alreadyCommitted || flushOverlay) discardInProgressLog(park);
      else if (plan.mappings.length > 0) writeJsonl(park, overlay);
    }
  }
  if (
    intentCount === 0 &&
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
      intentCount,
    });
  }
  if (conflict) {
    printLine('multiple intents remain in progress; re-run with --abandon-theirs or --abandon-ours');
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
    streams.theirsNew,
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
    intentCount: streams.theirsNew.filter((record) => record.event.type === 'begin').length,
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
  if (!hasDuplicateDecisionIds(decisionEntries) && !hasDuplicateIntentBegins(records)) return null;
  const parents = gitMergeParents();
  if (!parents) return null;
  return {
    ...parents,
    base: gitMergeBaseFor(parents.ours, parents.theirs),
  };
}

function absorbFromGitContext(context, { abandon, dryRun, outputFile }) {
  const baseRecords = context.base ? gitIntentRecords(context.base) : [];
  return absorbFromStreams(
    gitIntentRecords(context.ours),
    gitIntentRecords(context.theirs),
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
    const repaired = repairDuplicateIntentRecords(
      loaded.records,
      decisionPlan.decisionMap,
      decisionPlan.hashMap
    );
    if (decisionPlan.mappings.length > 0 && !repaired.incomingSide) {
      fail(
        'cannot determine which intent records own the duplicate decision; ' +
          'run absorb during the merge or provide the incoming log and decision directory'
      );
    }
    const result = repaired.records;
    const mappings = [...repaired.mappings, ...decisionPlan.mappings];
    const remappedIds = new Set(
      mappings.filter((mapping) => mapping.kind === 'intent').map((mapping) => mapping.to)
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
      intentCount: remappedIds.size,
    });
  }

  const theirs = loadAbsorbSide(otherFile, otherFile);
  if (theirs.conflict) fail(`incoming log still contains conflict markers: ${otherFile}`);
  const otherRoot = path.resolve(path.dirname(otherFile), '..');
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
    theirsDecisionEntries: listDecisionEntries(otherDecisions || path.join(path.dirname(otherFile), '..', '.decision-log')),
    baseDecisionEntries: gitBase ? gitDecisionEntries(gitBase) : [],
    baseDecisionIds,
  });
}

function absorbGit(baseFile, oursFile, theirsFile, { abandon, dryRun }) {
  const base = loadAbsorbSide(baseFile, baseFile, { allowMissing: true });
  const ours = loadAbsorbSide(oursFile, oursFile);
  const theirs = loadAbsorbSide(theirsFile, theirsFile);
  if (base.conflict || ours.conflict || theirs.conflict) {
    fail('git merge driver received a log that still contains conflict markers');
  }
  const otherHead =
    gitOtherHead() || gitFindCommitForFile(theirsFile, '.intent-log/events.jsonl');
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

const commands = {
  begin(argv) {
    const { positionals, flags } = parseArgs(argv, {
      verify: '-v',
      decision: 'multiple',
      force: 'boolean',
    }, 'begin');
    const intent = positionals.join(' ').trim();
    if (!intent) {
      fail(usageFor('begin'));
    }
    const requestedDecisions = flags.decision || [];
    const index = requestedDecisions.length > 0 ? decisionIndex() : [];
    const decisions = [
      ...new Set(requestedDecisions.map((id) => findDecision(id, index).id)),
    ];

    const events = readEvents({ repairTail: true });
    const records = fold(events);
    // A parked intent and a merged-in one can both be open; --force clears every one of them.
    const open = records.filter((record) => record.status === 'in_progress');
    if (open.length > 1 && !flags.force) {
      fail(
        `multiple intents in progress: ${open.map((record) => record.id).join(', ')}\n` +
          'resolve them with driftseal absorb --abandon-ours or --abandon-theirs, ' +
          'or re-run with --force to abandon all of them'
      );
    }
    if (open.length === 1 && !flags.force) {
      fail(
        `intent ${open[0].id} is still in_progress: "${open[0].intent}"\n` +
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
    events.push(appendEvent({
      type: 'begin',
      id,
      ts: new Date().toISOString(),
      intent,
      verify: flags.verify || null,
      decisions,
      head: gitCapture(['rev-parse', 'HEAD']),
    }));
    const record = fold(events).find((candidate) => candidate.id === id);
    printLine(id);
    return publicIntent(record);
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

    let events = readEvents({ repairTail: true });
    let records = fold(events);
    let target;
    if (positionals.length > 0) {
      target = records.find((r) => r.id === positionals[0]);
      if (!target) fail(`unknown intent id: ${positionals[0]}`);
      if (target.status !== 'in_progress') fail(`intent ${target.id} already closed (${target.status})`);
    } else {
      target = openIntent(records);
      if (!target) fail('no intent in progress; nothing to end');
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
      return publicIntent(record);
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
          `cannot close linked intent ${target.id} as ${status}:\n` +
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
      head: gitCapture(['rev-parse', 'HEAD']),
    }));
    const record = fold(events).find((candidate) => candidate.id === target.id);
    printLine(`${target.id} ${status}`);
    return publicIntent(record);
  },

  status(argv, { readOnly = false } = {}) {
    const { positionals } = parseArgs(argv, {}, 'status');
    if (positionals.length > 0) fail(usageFor('status'));
    const open = openIntent(fold(readEvents({ repairTail: true, readOnly })));
    if (!open) {
      printLine('no intent in progress');
      return null;
    }
    printLine(render(open));
    return publicIntent(open);
  },

  log(argv, { readOnly = false } = {}) {
    const { positionals, flags } = parseArgs(argv, { last: '-n', all: 'boolean' }, 'log');
    if (positionals.length > 0) fail(usageFor('log'));
    let records = fold(readEvents({ repairTail: true, readOnly }));
    if (!flags.all) records = records.filter((record) => !record.reclaimed);
    if (flags.last) {
      const n = positiveInteger(flags.last, '--last');
      records = records.slice(-n);
    }
    if (records.length === 0) {
      printLine('log is empty');
      return [];
    }
    printLine(records.map(render).join('\n\n'));
    return records.map(publicIntent);
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
        if (!record) fail(`unknown intent id: ${id}`);
        if (record.status === 'in_progress') {
          fail(`cannot reclaim intent ${id} while it is in_progress`);
        }
        if (record.reclaimed) fail(`intent ${id} is already reclaimed`);
        const routine = ['failed', 'abandoned'].includes(record.status) &&
          record.decisions.length === 0;
        if (!routine && !flags.force) {
          fail(
            `intent ${id} is ${record.status}` +
              (record.decisions.length > 0 ? ' and linked to decisions' : '') +
              '; re-run with --force to reclaim it anyway'
          );
        }
        return record;
      });
    } else {
      if (flags.force) fail('--force requires explicit intent ids');
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
        printLine('no reclaimable intents');
        return [];
      }
    }

    if (flags['dry-run']) {
      printLine(targets.map((record) => `${record.id} ${record.status} — ${record.intent}`).join('\n'));
      return targets.map(publicIntent);
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
    return reclaimed.map(publicIntent);
  },

  unreclaim(argv) {
    const { positionals, flags } = parseArgs(argv, { reason: '-r' }, 'unreclaim');
    const reason = flags.reason && flags.reason.trim();
    if (positionals.length !== 1 || !reason) {
      fail(usageFor('unreclaim'));
    }
    const events = readEvents({ repairTail: true });
    const record = fold(events).find((candidate) => candidate.id === positionals[0]);
    if (!record) fail(`unknown intent id: ${positionals[0]}`);
    if (!record.reclaimed) fail(`intent ${positionals[0]} is not reclaimed`);
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
    return publicIntent(restored);
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
      let intent = openIntent(records);
      if (!intent) fail('decision update requires an intent in progress');
      events = recoverPendingReconciliations(events, intent.id);
      records = fold(events);
      intent = openIntent(records);
      const index = decisionIndex();
      const decision = findDecision(positionals[0], index);
      if (!intent.decisions.includes(decision.id)) {
        fail(`decision ${decision.id} is not linked to intent ${intent.id}; declare it with driftseal begin --decision ${decision.id}`);
      }

      const status = (flags.status || decision.status).toLowerCase();
      if (!DECISION_STATUSES.includes(status)) {
        fail(`invalid decision status "${status}" (expected: ${DECISION_STATUSES.join(', ')})`);
      }
      const update = prepareDecisionReconciliation(decision, intent.id, status, note);
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
      printLine(`${decision.id} ${update.fromStatus} -> ${update.toStatus} (${intent.id})`);
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

  init(argv) {
    const { positionals, flags } = parseArgs(argv, { lang: 'single', 'local-log': 'boolean' }, 'init');
    if (positionals.length > 0) fail(usageFor('init'));
    const target = path.join(process.cwd(), 'AGENTS.md');
    const existed = fs.existsSync(target);
    const current = existed ? fs.readFileSync(target, 'utf8') : '';
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const language = resolveInitLogLanguage(flags.lang, current);
    const localLog = resolveInitLocalLog(flags['local-log'] === true, current);
    const intentBlock = protocolEol(intentProtocolBlock(PROTOCOL_VERSION, language, localLog), eol);
    const decisionBlock = protocolEol(decisionProtocolBlock(PROTOCOL_VERSION, language, localLog), eol);
    let updated = current;
    const intent = upgradeManagedBlock({
      content: updated,
      marker: INTENT_PROTOCOL_MARKER,
      endMarker: INTENT_PROTOCOL_END,
      versionPattern: /^<!-- driftseal-version: (\d+) -->\r?$/m,
      replacement: intentBlock,
      knownManagedBlocks: [
        protocolEol(previousIntentProtocolBlock(2), eol),
        protocolEol(previousIntentProtocolBlock(3), eol),
        protocolEol(previousIntentProtocolBlock(4), eol),
        protocolEol(previousIntentProtocolBlock(5), eol),
        protocolEol(previousIntentProtocolBlock(6), eol),
        protocolEol(previousIntentProtocolBlock(7), eol),
        protocolEol(previousIntentProtocolBlock(8), eol),
        protocolEol(previousIntentProtocolBlock(9), eol),
        protocolEol(previousIntentProtocolBlock(10), eol),
        protocolEol(previousIntentProtocolBlock(11), eol),
      ],
      knownLegacyBlocks: [protocolEol(legacyIntentProtocolBlock(), eol)],
    });
    updated = intent.content;
    const decision = upgradeManagedBlock({
      content: updated,
      marker: DECISION_PROTOCOL_MARKER,
      endMarker: DECISION_PROTOCOL_END,
      versionPattern: /^<!-- driftseal-decisions-version: (\d+) -->\r?$/m,
      replacement: decisionBlock,
      knownManagedBlocks: [
        protocolEol(previousDecisionProtocolBlock(2), eol),
        protocolEol(previousDecisionProtocolBlock(3), eol),
        protocolEol(previousDecisionProtocolBlock(4), eol),
        protocolEol(previousDecisionProtocolBlock(5), eol),
        protocolEol(previousDecisionProtocolBlock(6), eol),
        protocolEol(previousDecisionProtocolBlock(7), eol),
        protocolEol(previousDecisionProtocolBlock(8), eol),
        protocolEol(previousDecisionProtocolBlock(9), eol),
        protocolEol(previousDecisionProtocolBlock(10), eol),
        protocolEol(previousDecisionProtocolBlock(11), eol),
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
      printLine('Configured local git merge driver for DriftSeal intent logs');
    }
    return { changed: true, target };
  },

  help() {
    printLine(`DriftSeal — Seal the intent. Stop the drift.

Intent-level write-ahead log for agent sessions.

usage:
  driftseal begin "<intent>" [--verify "<how to verify>"] [--decision <id>] [--force]
  driftseal end [id] [--status completed|partial|failed|abandoned] [--note "..."] [--verify-result "..."]
  driftseal status                     show the intent currently in progress (re-anchor after drift)
  driftseal log [--last N] [--all]     show intent history (--all includes reclaimed records)
  driftseal reclaim [id ...] --reason "<why>" [--older-than <days>] [--force] [--dry-run]
                                 hide meaningless closed records without deleting them
  driftseal unreclaim <id> --reason "<why>"
                                 restore a reclaimed record to the visible log
  driftseal absorb [other-events.jsonl] [--decisions <dir>]
                 [--abandon-theirs | --abandon-ours] [--dry-run]
                                 merge another intent log, remapping colliding ids
  driftseal absorb --git <base> <ours> <theirs>
                                 git merge driver for .intent-log/events.jsonl
  driftseal decision add "<title>" --context "..." --outcome "..." [options]
  driftseal decision update <id> [--status STATUS] --note "..."
                                 reconcile a linked decision in the open intent
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
                                 --lang sets the intent/decision log language (BCP 47, default: en)
                                 --local-log keeps the logs local and untracked instead of committing them
  driftseal --version | -V             print the installed DriftSeal version
  driftseal help

decision add options:
  -s, --status proposed|accepted|rejected|deferred|deprecated|superseded (default: accepted)
  --driver "..."                repeat for each decision driver
  --option "..."                repeat for each considered option
  --consequence "..."           repeat for each consequence

intent log: $DRIFTSEAL_HOME/events.jsonl, or .intent-log/events.jsonl
decision log: $DRIFTSEAL_DECISION_HOME, or .decision-log/ in the current directory
In a Git worktree, begin parks an open intent in Git metadata until end, so merge does not need a log-only commit.`);
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

function mutationResources(cmd, argv) {
  if (cmd === 'skill') return [parseSkillInstallRequest(argv).skillsDir];
  if (cmd === 'mcp') return [parseMcpInstallRequest(argv).configDir];
  if (cmd === 'hook') return [parseHookInstallRequest(argv.slice(1)).configDir];
  if (cmd === 'init') return [process.cwd()];
  if (cmd === 'reclaim' || cmd === 'unreclaim') return [logDir()];
  if (cmd === 'absorb') return [logDir(), decisionDir()];
  if (cmd === 'begin' && !argv.some((arg) => arg === '--decision' || arg.startsWith('--decision='))) {
    return [logDir()];
  }
  if (cmd === 'end' && ['failed', 'abandoned'].includes(requestedEndStatus(argv))) {
    return [logDir()];
  }
  return [logDir(), decisionDir()];
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
    // Help must print even while another session holds the mutation lock. A bare
    // --help/-h token that does not follow a flag token is always parsed as a flag
    // by parseArgs, so this probe can never bypass the lock for a real mutation.
    const wantsHelp = rest.some(
      (arg, index) =>
        (arg === '--help' || arg === '-h') && (index === 0 || !rest[index - 1].startsWith('-'))
    );
    if (wantsHelp) return { data: fn(rest), exitCode: 0 };
    const mutates =
      ['begin', 'end', 'init', 'skill', 'mcp', 'reclaim', 'unreclaim', 'absorb'].includes(cmd) ||
      (cmd === 'hook' && rest[0] === 'install') ||
      (cmd === 'decision' && ['add', 'update'].includes(rest[0]));
    const readsIntentLog =
      ['status', 'log'].includes(cmd) || (cmd === 'hook' && ['prompt', 'stop'].includes(rest[0]));
    if (mutates || readsIntentLog) {
      const resources = readsIntentLog ? [logDir()] : mutationResources(cmd, rest);
      if (readsIntentLog) {
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
        return { data, exitCode: data && Number.isInteger(data.exitCode) ? data.exitCode : 0 };
      }
      const data = withMutationLocks(resources, () => fn(rest));
      return { data, exitCode: data && Number.isInteger(data.exitCode) ? data.exitCode : 0 };
    }
    return { data: fn(rest), exitCode: 0 };
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
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    fail('command arguments must be an array of strings');
  }
  if (capture && activeOutput) fail('nested captured DriftSeal commands are not supported');

  const fixedRoot = repositoryRoot(root);
  const previousCwd = process.cwd();
  const previousIntentHome = process.env.DRIFTSEAL_HOME;
  const previousDecisionHome = process.env.DRIFTSEAL_DECISION_HOME;
  const output = { stdout: '', stderr: '', data: null, exitCode: 0 };
  const previousOutput = activeOutput;

  try {
    process.chdir(fixedRoot);
    if (isolateStorage) {
      delete process.env.DRIFTSEAL_HOME;
      delete process.env.DRIFTSEAL_DECISION_HOME;
    }
    if (capture) activeOutput = output;
    const result = dispatch(argv);
    output.data = result.data;
    output.exitCode = result.exitCode;
    return output;
  } catch (err) {
    if (capture) {
      err.stdout = output.stdout;
      err.stderr = output.stderr;
    }
    throw err;
  } finally {
    activeOutput = previousOutput;
    process.chdir(previousCwd);
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
  const fixedRoot = repositoryRoot(root);
  const call = (argv) => runCommand(argv, { root: fixedRoot, isolateStorage, capture: true }).data;
  return Object.freeze({
    root: fixedRoot,
    status() {
      return call(['status']);
    },
    begin({ intent, verify, decisions = [], force = false }) {
      const argv = ['begin', intent];
      appendFlag(argv, '--verify', verify);
      for (const decision of decisions) appendFlag(argv, '--decision', decision);
      if (force) argv.push('--force');
      return call(argv);
    },
    end({ id, status, note, verifyResult } = {}) {
      const argv = ['end'];
      if (id) argv.push(String(id));
      appendFlag(argv, '--status', status);
      appendFlag(argv, '--note', note);
      appendFlag(argv, '--verify-result', verifyResult);
      return call(argv);
    },
    log({ last, all = false } = {}) {
      const argv = ['log'];
      appendFlag(argv, '--last', last);
      if (all) argv.push('--all');
      return call(argv);
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
    init() {
      return call(['init']);
    },
  });
}

function main() {
  try {
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
