'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  SqliteUnavailableError,
  getDatabaseSync,
} = require('./sqlite-runtime.js');

const INDEX_SCHEMA_VERSION = 5;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventHash(event) {
  return crypto.createHash('sha256').update(canonicalJson(event)).digest();
}

function digestRow(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest();
}

function sameBlob(actual, expected) {
  return actual instanceof Uint8Array && Buffer.from(actual).equals(expected);
}

function outcomeRowHash(row) {
  return digestRow({
    id: row.id,
    ordinal: Number(row.ordinal),
    lane: row.lane,
    status: row.status,
    reclaimed: Number(row.reclaimed),
    recordJson: row.record_json,
    firstByte: Number(row.first_byte),
    lastByte: Number(row.last_byte),
  });
}

function laneRowHash(row) {
  return digestRow({
    name: row.name,
    description: row.description || null,
    addedAt: row.added_at || null,
    inferred: Number(row.inferred),
    sequence: Number(row.sequence),
    count: Number(row.outcome_count),
    visible: Number(row.visible_count),
  });
}

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
    const DatabaseSync = getDatabaseSync();
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
        sequence INTEGER NOT NULL UNIQUE,
        outcome_count INTEGER NOT NULL DEFAULT 0,
        visible_count INTEGER NOT NULL DEFAULT 0,
        row_hash BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        lane TEXT NOT NULL,
        status TEXT NOT NULL,
        reclaimed INTEGER NOT NULL CHECK (reclaimed IN (0, 1)),
        record_json TEXT NOT NULL,
        first_byte INTEGER NOT NULL,
        last_byte INTEGER NOT NULL,
        row_hash BLOB NOT NULL
      );
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
        event_hash BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcomes_lane_visible_ordinal
        ON outcomes(lane, reclaimed, ordinal DESC);
      CREATE INDEX IF NOT EXISTS outcomes_open_ordinal
        ON outcomes(status, ordinal);
      CREATE INDEX IF NOT EXISTS events_identity
        ON events(type, outcome_id, ts, start_byte);
      INSERT INTO meta(key, value) VALUES ('projectionDirty', 'false')
        ON CONFLICT(key) DO NOTHING;
      CREATE TRIGGER IF NOT EXISTS lanes_dirty_insert AFTER INSERT ON lanes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS lanes_dirty_update AFTER UPDATE ON lanes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS lanes_dirty_delete AFTER DELETE ON lanes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS outcomes_dirty_insert AFTER INSERT ON outcomes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS outcomes_dirty_update AFTER UPDATE ON outcomes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS outcomes_dirty_delete AFTER DELETE ON outcomes
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS reconciliations_dirty_insert AFTER INSERT ON reconciliations
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS reconciliations_dirty_update AFTER UPDATE ON reconciliations
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS reconciliations_dirty_delete AFTER DELETE ON reconciliations
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS events_dirty_insert AFTER INSERT ON events
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS events_dirty_update AFTER UPDATE ON events
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
      CREATE TRIGGER IF NOT EXISTS events_dirty_delete AFTER DELETE ON events
        WHEN (SELECT value FROM meta WHERE key = 'projectionDirty') != 'true'
        BEGIN UPDATE meta SET value = 'true' WHERE key = 'projectionDirty'; END;
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

  setSource(source, lastBuild) {
    this.setMetadata('source', source);
    this.setMetadata('lastBuild', lastBuild);
  }

  projectionTrusted() {
    return this.metadata('projectionDirty') === false;
  }

  acceptProjection() {
    this.setMetadata('projectionDirty', false);
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

  replaceFromFoldState(state, indexedEvents) {
    this.clear();
    const counts = new Map(
      [...state.lanes.keys()].map((name) => [name, { count: 0, visible: 0 }])
    );
    for (const record of state.records.values()) {
      if (!counts.has(record.lane)) counts.set(record.lane, { count: 0, visible: 0 });
      const lane = counts.get(record.lane);
      lane.count += 1;
      if (!record.reclaimed) lane.visible += 1;
    }
    const insertLane = this.db.prepare(
      `INSERT INTO lanes(
         name, description, added_at, inferred, sequence,
         outcome_count, visible_count, row_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let sequence = 0;
    for (const lane of state.lanes.values()) {
      const summary = counts.get(lane.name) || { count: 0, visible: 0 };
      const row = {
        name: lane.name,
        description: lane.description || null,
        added_at: lane.addedAt || null,
        inferred: lane.inferred === true ? 1 : 0,
        sequence: sequence++,
        outcome_count: summary.count,
        visible_count: summary.visible,
      };
      insertLane.run(
        row.name,
        row.description,
        row.added_at,
        row.inferred,
        row.sequence,
        row.outcome_count,
        row.visible_count,
        laneRowHash(row)
      );
    }

    const ranges = new Map();
    const insertEvent = this.db.prepare(
      `INSERT INTO events(start_byte, end_byte, type, outcome_id, ts, event_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let migration = null;
    for (const indexed of indexedEvents) {
      const { event, startByte, endByte } = indexed;
      if (event.type === 'begin' || event.type === 'import') {
        ranges.set(event.id, { firstByte: startByte, lastByte: endByte });
      } else if (event.id && ranges.has(event.id)) {
        ranges.get(event.id).lastByte = endByte;
      }
      insertEvent.run(
        startByte,
        endByte,
        event.type,
        event.id || null,
        event.ts || null,
        eventHash(event)
      );
      if (event.type === 'migration' && event.id === 'v1-to-v2') migration = event;
    }

    const insertOutcome = this.db.prepare(
      `INSERT INTO outcomes(
         id, ordinal, lane, status, reclaimed, record_json,
         first_byte, last_byte, row_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let ordinal = 0; ordinal < state.order.length; ordinal += 1) {
      const id = state.order[ordinal];
      const record = state.records.get(id);
      const range = ranges.get(id);
      const row = {
        id,
        ordinal,
        lane: record.lane,
        status: record.status,
        reclaimed: record.reclaimed ? 1 : 0,
        record_json: JSON.stringify(record),
        first_byte: range.firstByte,
        last_byte: range.lastByte,
      };
      insertOutcome.run(
        row.id,
        row.ordinal,
        row.lane,
        row.status,
        row.reclaimed,
        row.record_json,
        row.first_byte,
        row.last_byte,
        outcomeRowHash(row)
      );
    }

    const insertReconciliation = this.db.prepare(
      `INSERT INTO reconciliations(id, outcome_id, data_json)
       VALUES (?, ?, ?)`
    );
    for (const [id, reconciliation] of state.reconciliations) {
      insertReconciliation.run(
        id,
        reconciliation.prepare.id,
        JSON.stringify(reconciliation)
      );
    }
    if (migration) this.setMetadata('migration', migration);
  }

  laneCatalog() {
    const rows = this.db
      .prepare(
        `SELECT name, description, added_at, inferred, sequence,
                outcome_count, visible_count, row_hash
         FROM lanes
         ORDER BY sequence`
      )
      .all();
    for (const row of rows) {
      if (!sameBlob(row.row_hash, laneRowHash(row))) {
        throw new OutcomeIndexError(`invalid SQLite outcome index lane row: ${row.name}`);
      }
    }
    return new Map(rows.map((row) => [row.name, laneRow(row)]));
  }

  refreshLaneHash(name) {
    const row = this.db
      .prepare(
        `SELECT name, description, added_at, inferred, sequence,
                outcome_count, visible_count
         FROM lanes
         WHERE name = ?`
      )
      .get(name);
    if (!row) throw new OutcomeIndexError(`missing SQLite outcome index lane row: ${name}`);
    this.db
      .prepare('UPDATE lanes SET row_hash = ? WHERE name = ?')
      .run(laneRowHash(row), name);
  }

  loadFoldState(event, defaultLane) {
    const lanes = new Map(
      [...this.laneCatalog()].map(([name, lane]) => [
          name,
          {
            name,
            description: lane.description || null,
            addedAt: lane.addedAt || null,
            head: null,
            inferred: lane.inferred === true,
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
        .prepare(
          `SELECT id, ordinal, lane, status, reclaimed, record_json,
                  first_byte, last_byte, row_hash
           FROM outcomes
           WHERE id = ?`
        )
        .get(event.id);
      if (row) {
        records.set(event.id, this.recordForRow(row));
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
    const touchedLanes = new Set();
    if (event.type === 'lane_add') touchedLanes.add(event.lane);
    if (
      event.id &&
      state.records.has(event.id) &&
      ['begin', 'import', 'lane_assign'].includes(event.type)
    ) {
      touchedLanes.add(state.records.get(event.id).lane);
    }
    const lanesToHash = new Set(touchedLanes);
    for (const name of touchedLanes) {
      const lane = state.lanes.get(name);
      this.db
        .prepare(
          `INSERT INTO lanes(
             name, description, added_at, inferred, sequence,
             outcome_count, visible_count, row_hash
           ) VALUES (
             ?, ?, ?, ?,
             COALESCE((SELECT MAX(sequence) + 1 FROM lanes), 0),
             0, 0, zeroblob(32)
           )
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
      const row = {
        id: record.id,
        ordinal,
        lane: record.lane,
        status: record.status,
        reclaimed: record.reclaimed ? 1 : 0,
        record_json: JSON.stringify(record),
        first_byte: firstByte,
        last_byte: endByte,
      };
      this.db
        .prepare(
          `INSERT INTO outcomes(
             id, ordinal, lane, status, reclaimed, record_json,
             first_byte, last_byte, row_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             lane = excluded.lane,
             status = excluded.status,
             reclaimed = excluded.reclaimed,
             record_json = excluded.record_json,
             last_byte = excluded.last_byte,
             row_hash = excluded.row_hash`
        )
        .run(
          row.id,
          row.ordinal,
          row.lane,
          row.status,
          row.reclaimed,
          row.record_json,
          row.first_byte,
          row.last_byte,
          outcomeRowHash(row)
        );
      if (!existing) {
        lanesToHash.add(record.lane);
        this.db
          .prepare(
            `UPDATE lanes
             SET outcome_count = outcome_count + 1,
                 visible_count = visible_count + ?
             WHERE name = ?`
          )
          .run(record.reclaimed ? 0 : 1, record.lane);
      } else if (existing.lane !== record.lane) {
        lanesToHash.add(existing.lane);
        lanesToHash.add(record.lane);
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
        lanesToHash.add(record.lane);
        this.db
          .prepare(
            `UPDATE lanes
             SET visible_count = visible_count + ?
             WHERE name = ?`
          )
          .run(record.reclaimed ? -1 : 1, record.lane);
      }
    }
    for (const name of lanesToHash) this.refreshLaneHash(name);
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
        eventHash(event)
      );
  }

  applyEvent(event, startByte, endByte, { applyFoldEvent, defaultLane }) {
    const state = this.loadFoldState(event, defaultLane);
    applyFoldEvent(state, event);
    this.persistFoldState(state, event, startByte, endByte);
    if (event.type === 'migration' && event.id === 'v1-to-v2') {
      this.setMetadata('migration', event);
    }
  }

  recordForRow(row, { includeOrdinal = false } = {}) {
    if (!sameBlob(row.row_hash, outcomeRowHash(row))) {
      throw new OutcomeIndexError(`invalid SQLite outcome index row: ${row.id}`);
    }
    const record = parseJson(row.record_json, `outcome ${row.id}`);
    if (
      record.id !== row.id ||
      record.lane !== row.lane ||
      record.status !== row.status ||
      Boolean(record.reclaimed) !== (Number(row.reclaimed) === 1)
    ) {
      throw new OutcomeIndexError(`inconsistent SQLite outcome index row: ${row.id}`);
    }
    if (includeOrdinal) record.ordinal = Number(row.ordinal);
    return record;
  }

  recordsForRows(rows) {
    return rows.map((row) => this.recordForRow(row, { includeOrdinal: true }));
  }

  queryAll() {
    return this.recordsForRows(
      this.db
        .prepare(
          `SELECT id, ordinal, lane, status, reclaimed, record_json,
                  first_byte, last_byte, row_hash
           FROM outcomes
           ORDER BY ordinal`
        )
        .all()
    );
  }

  queryRecent(lane, count, { includeReclaimed = false } = {}) {
    const laneRows = this.db
      .prepare(
        `SELECT id, ordinal, lane, status, reclaimed, record_json,
                first_byte, last_byte, row_hash
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
        `SELECT id, ordinal, lane, status, reclaimed, record_json,
                first_byte, last_byte, row_hash
         FROM outcomes
         WHERE status = 'in_progress'
         ORDER BY ordinal`
      )
      .all()
      .filter((row) => !kept.has(row.id));
    return this.recordsForRows([...laneRows, ...openRows].sort((left, right) => left.ordinal - right.ordinal));
  }

  migrationEvent() {
    return this.metadata('migration');
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
    const expected = events.map(eventHash);
    for (const candidate of candidates) {
      const stored = statement
        .all(candidate.start_byte, events.length)
        .map((row) => row.event_hash);
      if (stored.some((hash) => !(hash instanceof Uint8Array))) {
        throw new OutcomeIndexError('invalid SQLite outcome index event hash');
      }
      if (
        stored.length === events.length &&
        stored.every((hash, index) => sameBlob(hash, expected[index]))
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
  SqliteUnavailableError,
  OutcomeIndex,
  openOutcomeIndex,
  removeIndexFiles,
  temporaryIndexPath,
};
