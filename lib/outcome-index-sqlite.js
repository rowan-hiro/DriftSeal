'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('./sqlite-runtime.js');

const INDEX_SCHEMA_VERSION = 3;

class OutcomeIndexError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OutcomeIndexError';
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new OutcomeIndexError(`invalid JSON in SQLite outcome index ${label}`, error);
  }
}

function laneRow(row) {
  return {
    name: row.name,
    description: row.description || null,
    addedAt: row.added_at || null,
    head: null,
    inferred: row.inferred === 1,
    count: Number(row.outcome_count || 0),
    visible: Number(row.visible_count || 0),
  };
}

class OutcomeIndex {
  constructor(file, { readOnly = false } = {}) {
    this.file = file;
    this.readOnly = readOnly;
    this.db = new DatabaseSync(file, {
      open: true,
      readOnly,
      enableForeignKeyConstraints: false,
    });
    try {
      if (readOnly) {
        const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
        if (version !== INDEX_SCHEMA_VERSION) {
          throw new OutcomeIndexError(`unsupported SQLite outcome index schema: ${version}`);
        }
      } else {
        this.initialize();
      }
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  initialize() {
    const currentVersion = Number(
      this.db.prepare('PRAGMA user_version').get().user_version
    );
    if (currentVersion !== 0 && currentVersion !== INDEX_SCHEMA_VERSION) {
      throw new OutcomeIndexError(
        `unsupported SQLite outcome index schema: ${currentVersion}`
      );
    }
    if (currentVersion === INDEX_SCHEMA_VERSION) {
      return;
    }
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS lanes (
        name TEXT PRIMARY KEY,
        description TEXT,
        added_at TEXT,
        inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
        outcome_count INTEGER NOT NULL DEFAULT 0,
        visible_count INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        lane TEXT NOT NULL,
        status TEXT NOT NULL,
        reclaimed INTEGER NOT NULL CHECK (reclaimed IN (0, 1)),
        record_json TEXT NOT NULL,
        first_byte INTEGER NOT NULL,
        last_byte INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS reconciliations (
        id TEXT PRIMARY KEY,
        outcome_id TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        start_byte INTEGER PRIMARY KEY,
        end_byte INTEGER NOT NULL,
        type TEXT NOT NULL,
        outcome_id TEXT,
        ts TEXT,
        event_hash TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS outcomes_lane_visible_ordinal
        ON outcomes(lane, reclaimed, ordinal DESC);
      CREATE INDEX IF NOT EXISTS outcomes_open_ordinal
        ON outcomes(status, ordinal);
      CREATE INDEX IF NOT EXISTS events_identity
        ON events(type, outcome_id, ts, start_byte);
      PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
    `);
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version !== INDEX_SCHEMA_VERSION) {
      throw new Error(`unsupported SQLite outcome index schema: ${version}`);
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  transaction(action) {
    this.db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA temp_store = MEMORY;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  integrityCheck() {
    const row = this.db.prepare('PRAGMA quick_check').get();
    return row && row.quick_check === 'ok';
  }

  metadata(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? parseJson(row.value, `metadata ${key}`) : null;
  }

  setMetadata(key, value) {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, JSON.stringify(value));
  }

  source() {
    return this.metadata('source');
  }

  lastBuild() {
    return this.metadata('lastBuild');
  }

  setSource(source, lastBuild) {
    this.setMetadata('source', source);
    this.setMetadata('lastBuild', lastBuild);
  }

  clear() {
    this.db.exec(`
      DELETE FROM reconciliations;
      DELETE FROM events;
      DELETE FROM outcomes;
      DELETE FROM lanes;
      DELETE FROM meta;
    `);
  }

  ensureLane(name) {
    this.db
      .prepare(
        `INSERT INTO lanes(
           name, description, added_at, inferred, outcome_count, visible_count
         ) VALUES (?, NULL, NULL, 0, 0, 0)
         ON CONFLICT(name) DO NOTHING`
      )
      .run(name);
  }

  laneCatalog() {
    const rows = this.db
      .prepare(
        `SELECT name, description, added_at, inferred, outcome_count, visible_count
         FROM lanes
         ORDER BY name`
      )
      .all();
    return new Map(rows.map((row) => [row.name, laneRow(row)]));
  }

  loadFoldState(event, defaultLane) {
    const lanes = new Map(
      this.db
        .prepare('SELECT name, description, added_at, inferred FROM lanes')
        .all()
        .map((row) => [
          row.name,
          {
            name: row.name,
            description: row.description || null,
            addedAt: row.added_at || null,
            head: null,
            inferred: row.inferred === 1,
          },
        ])
    );
    if (!lanes.has(defaultLane)) {
      lanes.set(defaultLane, {
        name: defaultLane,
        description: null,
        addedAt: null,
        head: null,
      });
    }
    const records = new Map();
    const order = [];
    if (event.id) {
      const row = this.db
        .prepare('SELECT record_json FROM outcomes WHERE id = ?')
        .get(event.id);
      if (row) {
        records.set(event.id, parseJson(row.record_json, `outcome ${event.id}`));
        order.push(event.id);
      }
    }
    const reconciliations = new Map();
    if (event.reconciliationId) {
      const row = this.db
        .prepare('SELECT data_json FROM reconciliations WHERE id = ?')
        .get(event.reconciliationId);
      if (row) {
        reconciliations.set(
          event.reconciliationId,
          parseJson(row.data_json, `reconciliation ${event.reconciliationId}`)
        );
      }
    }
    return { records, reconciliations, order, lanes };
  }

  persistFoldState(state, event, startByte, endByte) {
    for (const lane of state.lanes.values()) {
      this.db
        .prepare(
          `INSERT INTO lanes(name, description, added_at, inferred)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             added_at = excluded.added_at,
             inferred = excluded.inferred`
        )
        .run(
          lane.name,
          lane.description || null,
          lane.addedAt || null,
          lane.inferred === true ? 1 : 0
        );
    }
    if (event.id && state.records.has(event.id)) {
      const record = state.records.get(event.id);
      const existing = this.db
        .prepare(
          'SELECT ordinal, lane, reclaimed, first_byte FROM outcomes WHERE id = ?'
        )
        .get(event.id);
      const ordinal = existing
        ? Number(existing.ordinal)
        : Number(
            this.db
              .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM outcomes')
              .get().next
          );
      const firstByte = existing ? Number(existing.first_byte) : startByte;
      this.db
        .prepare(
          `INSERT INTO outcomes(
             id, ordinal, lane, status, reclaimed, record_json, first_byte, last_byte
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             lane = excluded.lane,
             status = excluded.status,
             reclaimed = excluded.reclaimed,
             record_json = excluded.record_json,
             last_byte = excluded.last_byte`
        )
        .run(
          record.id,
          ordinal,
          record.lane,
          record.status,
          record.reclaimed ? 1 : 0,
          JSON.stringify(record),
          firstByte,
          endByte
        );
      if (!existing) {
        this.db
          .prepare(
            `UPDATE lanes
             SET outcome_count = outcome_count + 1,
                 visible_count = visible_count + ?
             WHERE name = ?`
          )
          .run(record.reclaimed ? 0 : 1, record.lane);
      } else if (existing.lane !== record.lane) {
        this.db
          .prepare(
            `UPDATE lanes
             SET outcome_count = outcome_count - 1,
                 visible_count = visible_count - ?
             WHERE name = ?`
          )
          .run(existing.reclaimed === 1 ? 0 : 1, existing.lane);
        this.db
          .prepare(
            `UPDATE lanes
             SET outcome_count = outcome_count + 1,
                 visible_count = visible_count + ?
             WHERE name = ?`
          )
          .run(record.reclaimed ? 0 : 1, record.lane);
      } else if (existing.reclaimed !== (record.reclaimed ? 1 : 0)) {
        this.db
          .prepare(
            `UPDATE lanes
             SET visible_count = visible_count + ?
             WHERE name = ?`
          )
          .run(record.reclaimed ? -1 : 1, record.lane);
      }
    }
    for (const [id, reconciliation] of state.reconciliations) {
      this.db
        .prepare(
          `INSERT INTO reconciliations(id, outcome_id, data_json)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             outcome_id = excluded.outcome_id,
             data_json = excluded.data_json`
        )
        .run(id, reconciliation.prepare.id, JSON.stringify(reconciliation));
    }
    this.db
      .prepare(
        `INSERT INTO events(start_byte, end_byte, type, outcome_id, ts, event_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        startByte,
        endByte,
        event.type,
        event.id || null,
        event.ts || null,
        crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')
      );
  }

  applyEvent(event, startByte, endByte, { applyFoldEvent, defaultLane }) {
    const state = this.loadFoldState(event, defaultLane);
    applyFoldEvent(state, event);
    this.persistFoldState(state, event, startByte, endByte);
  }

  recordsForRows(rows) {
    return rows.map((row) => {
      const record = parseJson(row.record_json, `outcome ${row.id}`);
      record.ordinal = Number(row.ordinal);
      return record;
    });
  }

  queryAll() {
    return this.recordsForRows(
      this.db
        .prepare('SELECT id, ordinal, record_json FROM outcomes ORDER BY ordinal')
        .all()
    );
  }

  queryRecent(lane, count, { includeReclaimed = false } = {}) {
    const laneRows = this.db
      .prepare(
        `SELECT id, ordinal, record_json
         FROM outcomes
         WHERE lane = ? AND (? = 1 OR reclaimed = 0)
         ORDER BY ordinal DESC
         LIMIT ?`
      )
      .all(lane, includeReclaimed ? 1 : 0, count)
      .reverse();
    const kept = new Set(laneRows.map((row) => row.id));
    const openRows = this.db
      .prepare(
        `SELECT id, ordinal, record_json
         FROM outcomes
         WHERE status = 'in_progress'
         ORDER BY ordinal`
      )
      .all()
      .filter((row) => !kept.has(row.id));
    return this.recordsForRows([...laneRows, ...openRows].sort((left, right) => left.ordinal - right.ordinal));
  }

  queryLane(lane, { includeReclaimed = true } = {}) {
    return this.recordsForRows(
      this.db
        .prepare(
          `SELECT id, ordinal, record_json
           FROM outcomes
           WHERE (lane = ? OR status = 'in_progress')
             AND (? = 1 OR reclaimed = 0)
           ORDER BY ordinal`
        )
        .all(lane, includeReclaimed ? 1 : 0)
    );
  }

  lookupOutcome(id) {
    const row = this.db
      .prepare('SELECT id, ordinal, record_json FROM outcomes WHERE id = ?')
      .get(id);
    return row ? this.recordsForRows([row])[0] : null;
  }

  openOutcomes() {
    return this.recordsForRows(
      this.db
        .prepare(
          `SELECT id, ordinal, record_json
           FROM outcomes
           WHERE status = 'in_progress'
           ORDER BY ordinal`
        )
        .all()
    );
  }

  outcomeStartEvents() {
    return this.db
      .prepare(
        `SELECT type, outcome_id
         FROM events
         WHERE type IN ('begin', 'import')
         ORDER BY start_byte`
      )
      .all()
      .map((row) => ({ type: row.type, id: row.outcome_id }));
  }

  containsEventSequence(events) {
    if (!Array.isArray(events) || events.length === 0) return false;
    const head = events[0];
    const candidates = this.db
      .prepare(
        `SELECT start_byte
         FROM events
         WHERE type = ?
           AND outcome_id IS ?
           AND ts IS ?
         ORDER BY start_byte DESC`
      )
      .all(head.type, head.id || null, head.ts || null);
    const statement = this.db.prepare(
      `SELECT event_hash
       FROM events
       WHERE start_byte >= ?
       ORDER BY start_byte
       LIMIT ?`
    );
    for (const candidate of candidates) {
      const stored = statement
        .all(candidate.start_byte, events.length)
        .map((row) => row.event_hash);
      const expected = events.map((event) =>
        crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')
      );
      if (
        stored.length === events.length &&
        stored.every((hash, index) => hash === expected[index])
      ) {
        return true;
      }
    }
    return false;
  }

  explainRecent() {
    return this.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, ordinal, record_json
         FROM outcomes
         WHERE lane = ? AND reclaimed = 0
         ORDER BY ordinal DESC
         LIMIT ?`
      )
      .all('main', 3);
  }
}

function openOutcomeIndex(file, options) {
  return new OutcomeIndex(file, options);
}

function temporaryIndexPath(file) {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
}

function removeIndexFiles(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  OutcomeIndexError,
  OutcomeIndex,
  openOutcomeIndex,
  removeIndexFiles,
  temporaryIndexPath,
};
