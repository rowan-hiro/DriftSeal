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
 * Decision log: $DRIFTSEAL_DECISION_HOME, or .decision-log/ in cwd.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

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
const PROTOCOL_VERSION = 7;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_INIT_STALE_MS = 5 * 1000;
const MAX_DECISION_SLUG_LENGTH = 180;

class DriftSealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriftSealError';
  }
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

function readEvents({ repairTail = false } = {}) {
  const file = logFile();
  if (!fs.existsSync(file)) return [];
  let content = fs.readFileSync(file, 'utf8');
  const rawLines = content.split('\n');
  if (content.length > 0 && !content.endsWith('\n')) {
    const tail = rawLines.at(-1);
    try {
      JSON.parse(tail);
    } catch {
      if (!repairTail) fail(`corrupt final log line in ${file}`);
      const validLength = content.lastIndexOf('\n') + 1;
      const fd = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(fd, Buffer.byteLength(content.slice(0, validLength), 'utf8'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      content = content.slice(0, validLength);
    }
  }
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return normalizeEvent(JSON.parse(line), i + 1);
      } catch (err) {
        if (err instanceof DriftSealError) throw err;
        fail(`corrupt log line ${i + 1} in ${file}`);
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

function appendEvent(event) {
  ensureDirectoryDurable(logDir());
  const file = logFile();
  const existed = fs.existsSync(file);
  const storedEvent = { schemaVersion: EVENT_SCHEMA_VERSION, ...event };
  const line = Buffer.from(
    JSON.stringify(storedEvent) + '\n',
    'utf8'
  );
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
  if (!existed) fsyncDirectory(logDir());
  return storedEvent;
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

function acquireMutationLock(resource) {
  ensureDirectoryDurable(resource);
  const lock = path.join(resource, '.driftseal.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt > 0 || !clearStaleLock(lock)) {
        fail(`another DriftSeal mutation is in progress (lock: ${lock})`);
      }
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

function withMutationLocks(resources, action) {
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
    for (const root of roots) releases.push(acquireMutationLock(root));
    return action();
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
        decisions: Array.isArray(ev.decisions) ? ev.decisions : [],
        schemaVersion: ev.schemaVersion || 1,
        decisionPrepares: [],
        decisionTerminals: [],
        decisionUpdates: [],
        status: 'in_progress',
        tsEnd: null,
        note: null,
        verifyResult: null,
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

function nextId(events) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let maxSeq = 0;
  for (const ev of events) {
    if (ev.type === 'begin' && typeof ev.id === 'string' && ev.id.startsWith(today + '-')) {
      const seq = parseInt(ev.id.slice(today.length + 1), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  return `${today}-${String(maxSeq + 1).padStart(3, '0')}`;
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

function decisionIndex() {
  if (!fs.existsSync(decisionDir())) return [];
  const entries = [];
  const ids = new Map();
  for (const entry of fs.readdirSync(decisionDir(), { withFileTypes: true })) {
    const match = entry.name.match(/^(\d{4,})-.*\.md$/);
    if (!match) continue;
    const fullPath = path.join(decisionDir(), entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) fail(`decision record must not be a symbolic link: ${entry.name}`);
    if (!stat.isFile()) fail(`decision record is not a regular file: ${entry.name}`);
    const id = normalizeDecisionId(match[1]);
    if (ids.has(id)) fail(`duplicate decision id ${id}: ${ids.get(id)}, ${entry.name}`);
    ids.set(id, entry.name);
    entries.push({ id, file: entry.name, path: fullPath });
  }
  return entries.sort(compareDecisionEntries);
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
function parseArgs(argv, spec) {
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

function intentProtocolBlock(version = PROTOCOL_VERSION) {
  return `${INTENT_PROTOCOL_MARKER}
<!-- driftseal-version: ${version} -->

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (\`driftseal\`) to prevent agent drift. Every work round:

1. **Write intent first**, before modifying, creating, or deleting files, or
   making any other change that may need a rollback:
   \`driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"\`.
   Add one \`--decision <id>\` for each existing decision this round may change.
   Single-step commands that only build, check, or record work already done
   (compiling, running tests, \`git add\`/\`git commit\`) need no intent.
2. **Execute only the intent.** Scope change? Close the current intent
   (\`driftseal end -s partial|abandoned -n "<why>"\`) and \`driftseal begin\` a new one.
3. **Verify, then close**: run the declared verification, then
   \`driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<verify output>"\`.
   Never report success without closing the intent.
   Before closing a linked intent as \`completed\` or \`partial\`, reconcile every
   declared decision with \`driftseal decision update <id> --status <status> --note "<why>"\`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   Do not edit a decision after reconciling it; run \`decision update\` again so
   the final content hash is recorded. Interrupted reconciliation is recovered
   by the next linked \`decision update\` or successful \`end\`. Closing as
   \`failed\` or \`abandoned\` cancels pending recovery for that intent.
   An authorized Git commit that only stages and records the verified changes and
   just-closed log finalizes that round without requiring a new intent. Any content
   change made while preparing the commit does require a new intent.
4. **Re-anchor after context loss**: run \`driftseal status\` and \`driftseal log --last 3\` before
   doing anything else. The open intent is the source of truth: resume it when its
   objective still matches the current task; otherwise close it (\`partial\` or
   \`abandoned\`, with a note) and \`begin\` a new one.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
\`.intent-log/events.jsonl\` (or anything under \`$DRIFTSEAL_HOME\`) directly; use
\`driftseal\` commands or the MCP tools. Retire meaningless closed records with
\`driftseal reclaim [id ...] --reason "<why>"\` — it appends a marker, never
deletes log lines; \`driftseal unreclaim <id> --reason "<why>"\` restores one.

Log: \`.intent-log/events.jsonl\` (override with \`$DRIFTSEAL_HOME\`); commit it with the code.
${INTENT_PROTOCOL_END}`;
}

function previousIntentProtocolBlock(version) {
  const v6 = intentProtocolBlock(version).replace(
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

function decisionProtocolBlock(version = PROTOCOL_VERSION) {
  return `${DECISION_PROTOCOL_MARKER}
<!-- driftseal-decisions-version: ${version} -->

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history: a rejected or deferred path worth
revisiting, non-obvious rationale behind a long-lived or costly-to-reverse accepted
choice, or a deprecated or superseded decision. Do not record routine, local,
readily reversible choices.

\`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"\`

Add one \`--driver\`, \`--option\`, or \`--consequence\` flag per item. Use
\`--status proposed|accepted|rejected|deferred|deprecated|superseded\` when needed.
Use \`proposed\` for a choice still under active consideration. Use \`deferred\`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with \`driftseal decision list --status deferred --count\`,
then review them with \`driftseal decision list --status deferred\`.
When an intent declares an existing decision with \`--decision <id>\`, use
\`driftseal decision update\` to record its status transition or explicit confirmation.
Commit \`.decision-log/\` with the code.
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
  return decisionProtocolBlock(version).replace(' --driver "<decision driver>"', '');
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
    if (block !== replacement && !knownManagedBlocks.includes(block)) {
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

const commands = {
  begin(argv) {
    const { positionals, flags } = parseArgs(argv, {
      verify: '-v',
      decision: 'multiple',
      force: 'boolean',
    });
    const intent = positionals.join(' ').trim();
    if (!intent) {
      fail('usage: driftseal begin "<intent>" [--verify "<how to verify>"] [--decision <id>] [--force]');
    }
    const requestedDecisions = flags.decision || [];
    const index = requestedDecisions.length > 0 ? decisionIndex() : [];
    const decisions = [
      ...new Set(requestedDecisions.map((id) => findDecision(id, index).id)),
    ];

    const events = readEvents({ repairTail: true });
    const records = fold(events);
    const open = openIntent(records);
    if (open) {
      if (!flags.force) {
        fail(
          `intent ${open.id} is still in_progress: "${open.intent}"\n` +
            `end it first (driftseal end) or re-run with --force to abandon it`
        );
      }
      const status = closeIntentAsEscape(
        events,
        open,
        'abandoned',
        'superseded by --force',
        null
      );
      printError(`driftseal: ${status} ${open.id}`);
    }

    const id = nextId(events);
    events.push(appendEvent({
      type: 'begin',
      id,
      ts: new Date().toISOString(),
      intent,
      verify: flags.verify || null,
      decisions,
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
    });
    const status = flags.status || 'completed';
    if (positionals.length > 1) fail('usage: driftseal end [id] [options]');
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
    }));
    const record = fold(events).find((candidate) => candidate.id === target.id);
    printLine(`${target.id} ${status}`);
    return publicIntent(record);
  },

  status(argv) {
    const { positionals } = parseArgs(argv, {});
    if (positionals.length > 0) fail('usage: driftseal status');
    const open = openIntent(fold(readEvents({ repairTail: true })));
    if (!open) {
      printLine('no intent in progress');
      return null;
    }
    printLine(render(open));
    return publicIntent(open);
  },

  log(argv) {
    const { positionals, flags } = parseArgs(argv, { last: '-n', all: 'boolean' });
    if (positionals.length > 0) fail('usage: driftseal log [--last N] [--all]');
    let records = fold(readEvents({ repairTail: true }));
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
    });
    const reason = flags.reason && flags.reason.trim();
    if (!reason) {
      fail(
        'usage: driftseal reclaim [id ...] --reason "<why>" [--older-than <days>] [--force] [--dry-run]'
      );
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
    const { positionals, flags } = parseArgs(argv, { reason: '-r' });
    const reason = flags.reason && flags.reason.trim();
    if (positionals.length !== 1 || !reason) {
      fail('usage: driftseal unreclaim <id> --reason "<why>"');
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
    if (subcommand === 'add') {
      const { positionals, flags } = parseArgs(rest, {
        context: '-c',
        outcome: '-o',
        status: '-s',
        driver: 'multiple',
        option: 'multiple',
        consequence: 'multiple',
      });
      const title = positionals.join(' ').replace(/\s+/g, ' ').trim();
      const context = flags.context && flags.context.trim();
      const outcome = flags.outcome && flags.outcome.trim();
      if (!title || !context || !outcome) {
        fail('usage: driftseal decision add "<title>" --context "..." --outcome "..." [options]');
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
      const { positionals, flags } = parseArgs(rest, { status: '-s', note: '-n' });
      const note = flags.note && flags.note.trim();
      if (positionals.length !== 1 || !note) {
        fail('usage: driftseal decision update <id> [--status <status>] --note "<what changed or was confirmed>"');
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
      const { positionals, flags } = parseArgs(rest, { last: '-n', status: '-s', count: 'boolean' });
      if (positionals.length > 0) {
        fail('usage: driftseal decision list [--status STATUS] [--last N | --count]');
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
      const { positionals } = parseArgs(rest, {});
      if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
        fail('usage: driftseal decision show <id>');
      }
      const decision = findDecision(positionals[0]);
      writeOutput(decision.content);
      return publicDecision(decision, { includeContent: true });
    }

    fail('usage: driftseal decision add|update|list|show (run: driftseal help)');
  },

  init(argv) {
    const { positionals } = parseArgs(argv, {});
    if (positionals.length > 0) fail('usage: driftseal init');
    const target = path.join(process.cwd(), 'AGENTS.md');
    const existed = fs.existsSync(target);
    const current = existed ? fs.readFileSync(target, 'utf8') : '';
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const intentBlock = protocolEol(intentProtocolBlock(), eol);
    const decisionBlock = protocolEol(decisionProtocolBlock(), eol);
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

    if (updated === current) {
      printLine('AGENTS.md already contains the DriftSeal protocols; nothing to do');
      return { changed: false, target };
    }
    atomicWriteFile(target, updated);
    printLine(`DriftSeal protocol ${existed ? 'updated in' : 'written to'} ${target}`);
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
  driftseal decision add "<title>" --context "..." --outcome "..." [options]
  driftseal decision update <id> [--status STATUS] --note "..."
                                 reconcile a linked decision in the open intent
  driftseal decision list [--status STATUS] [--last N | --count]
                                 list or count filtered MADR decision records
  driftseal decision show <id>         print one MADR decision record
  driftseal init                       inject intent and decision protocols into ./AGENTS.md
  driftseal help

decision add options:
  -s, --status proposed|accepted|rejected|deferred|deprecated|superseded (default: accepted)
  --driver "..."                repeat for each decision driver
  --option "..."                repeat for each considered option
  --consequence "..."           repeat for each consequence

intent log: $DRIFTSEAL_HOME/events.jsonl, or .intent-log/events.jsonl
decision log: $DRIFTSEAL_DECISION_HOME, or .decision-log/ in the current directory`);
    return null;
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
  if (cmd === 'init') return [process.cwd()];
  if (cmd === 'reclaim' || cmd === 'unreclaim') return [logDir()];
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
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { data: commands.help(), exitCode: cmd ? 0 : 1 };
  }
  const fn = commands[cmd];
  if (!fn) fail(`unknown command: ${cmd} (run: driftseal help)`);
  const mutates =
    ['begin', 'end', 'init', 'reclaim', 'unreclaim'].includes(cmd) ||
    (cmd === 'decision' && ['add', 'update'].includes(rest[0]));
  const readsIntentLog = ['status', 'log'].includes(cmd);
  if (mutates || readsIntentLog) {
    const resources = readsIntentLog ? [logDir()] : mutationResources(cmd, rest);
    return { data: withMutationLocks(resources, () => fn(rest)), exitCode: 0 };
  }
  return { data: fn(rest), exitCode: 0 };
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
