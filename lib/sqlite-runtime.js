'use strict';

const MINIMUM_NODE = Object.freeze({ major: 22, minor: 13, display: '22.13.0' });

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
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const { DatabaseSync } = loadNodeSqlite();

module.exports = {
  DatabaseSync,
  MINIMUM_NODE,
  assertSupportedNode,
};
