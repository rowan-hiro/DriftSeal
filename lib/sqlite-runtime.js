'use strict';

const MINIMUM_NODE = Object.freeze({ major: 22, minor: 13, display: '22.13.0' });

class SqliteUnavailableError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SqliteUnavailableError';
  }
}

function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor)) {
    return;
  }
  throw new Error(`DriftSeal requires Node.js ${MINIMUM_NODE.display} or newer; found ${version}`);
}

function warningType(args) {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') return first.type || first.name || null;
  return null;
}

function warningMessage(warning) {
  if (warning instanceof Error) return warning.message;
  return String(warning);
}

function loadNodeSqlite() {
  assertSupportedNode();
  if (process.env._DRIFTSEAL_TEST_DISABLE_SQLITE === '1') {
    throw new SqliteUnavailableError('node:sqlite is unavailable in this runtime');
  }
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(warning, ...args) {
    if (
      warningType(args) === 'ExperimentalWarning' &&
      /\bSQLite\b/i.test(warningMessage(warning))
    ) {
      return;
    }
    return Reflect.apply(originalEmitWarning, this, [warning, ...args]);
  };
  try {
    return require('node:sqlite');
  } catch (error) {
    if (error instanceof SqliteUnavailableError) throw error;
    throw new SqliteUnavailableError('node:sqlite is unavailable in this runtime', error);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

let databaseSync;

function getDatabaseSync() {
  if (!databaseSync) ({ DatabaseSync: databaseSync } = loadNodeSqlite());
  return databaseSync;
}

module.exports = {
  MINIMUM_NODE,
  SqliteUnavailableError,
  assertSupportedNode,
  getDatabaseSync,
};
