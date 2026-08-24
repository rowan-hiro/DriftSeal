'use strict';

function createOutcomeFold({ fail, contentHash, logVersion, defaultLane }) {
  if (typeof fail !== 'function' || typeof contentHash !== 'function') {
    throw new TypeError('createOutcomeFold requires fail and contentHash functions');
  }

  function emptyLaneCatalog() {
    return new Map([
      [
        defaultLane,
        {
          name: defaultLane,
          description: null,
          addedAt: null,
          head: null,
        },
      ],
    ]);
  }

  function outcomeContractHash(record) {
    return contentHash(
      JSON.stringify({
        outcome: record.outcome,
        extensions: record.extensions.map(({ extension, acceptance, verify, decisions }) => ({
          extension,
          acceptance,
          verify,
          decisions,
        })),
        acceptance: record.acceptance,
        verify: record.verify,
        decisions: record.decisions,
      })
    );
  }

  function newOutcomeRecord(ev) {
    const record = {
      id: ev.id,
      tsBegin: ev.ts,
      outcome: ev.outcome,
      extensions: [],
      acceptance: Array.isArray(ev.acceptance) ? ev.acceptance : [],
      verify: ev.verify || null,
      beginHead: ev.head || null,
      decisions: Array.isArray(ev.decisions) ? ev.decisions : [],
      logVersion: ev.logVersion || 1,
      schemaVersion: ev.schemaVersion || 1,
      lane: ev.lane || defaultLane,
      decisionPrepares: [],
      decisionTerminals: [],
      decisionUpdates: [],
      verificationAttempts: [],
      verification: null,
      status: 'in_progress',
      tsEnd: null,
      note: null,
      verifyResult: null,
      endHead: null,
      reclaimed: false,
      reclaimReason: null,
      reclaimedAt: null,
      imported: null,
      contractHash: null,
    };
    record.contractHash = outcomeContractHash(record);
    return record;
  }

  function qualifyingDecisionUpdates(record, decisionId) {
    return record.decisionUpdates.filter((update) => {
      if (update.decisionId !== decisionId) return false;
      if (record.logVersion === 1 && record.schemaVersion < 2) return true;
      return (
        update.type === 'decision_reconcile_commit' &&
        (update.logVersion === logVersion || (update.schemaVersion || 1) >= 2) &&
        typeof update.fileHash === 'string'
      );
    });
  }

  function applyFoldEvent(state, ev) {
    const { records, reconciliations, order, lanes } = state;
    const ensureLane = (name) => {
      if (lanes.has(name)) return;
      lanes.set(name, {
        name,
        description: null,
        addedAt: null,
        head: null,
        inferred: true,
      });
    };
    if (ev.type === 'begin') {
      if (records.has(ev.id)) fail(`duplicate begin event for outcome id: ${ev.id}`);
      const record = newOutcomeRecord(ev);
      ensureLane(record.lane);
      records.set(ev.id, record);
      order.push(ev.id);
      return;
    }
    if (ev.type === 'import') {
      if (records.has(ev.id)) fail(`duplicate imported outcome id: ${ev.id}`);
      const record = newOutcomeRecord({
        ...ev,
        ts: ev.beganAt,
        acceptance: [],
        verify: null,
      });
      ensureLane(record.lane);
      record.status = ev.status;
      record.tsEnd = ev.endedAt;
      record.note = ev.summary || null;
      record.reclaimed = ev.reclaimed === true;
      record.reclaimReason = ev.reclaimReason || null;
      record.reclaimedAt = ev.reclaimedAt || null;
      record.imported = {
        sourceIds: ev.sources.map((source) => source.id),
        sourceFingerprint: ev.sourceFingerprint,
        sources: ev.sources,
      };
      records.set(ev.id, record);
      order.push(ev.id);
      return;
    }
    if (ev.type === 'migration') return;
    if (ev.type === 'lane_add') {
      const existing = lanes.get(ev.lane);
      if (existing && !existing.inferred) {
        if (ev.description) existing.description = ev.description;
        return;
      }
      lanes.set(ev.lane, {
        name: ev.lane,
        description: ev.description || null,
        addedAt: ev.ts,
        head: existing ? existing.head : null,
        inferred: false,
      });
      return;
    }
    if (ev.type === 'lane_assign') {
      const rec = records.get(ev.id);
      if (!rec) fail(`lane assign references unknown outcome id: ${ev.id}`);
      if (rec.status === 'in_progress') fail(`cannot assign lane of in_progress outcome ${ev.id}`);
      ensureLane(ev.lane);
      rec.lane = ev.lane;
      return;
    }
    if (ev.type === 'extend') {
      const rec = records.get(ev.id);
      if (!rec) fail(`extension references unknown outcome id: ${ev.id}`);
      if (rec.status !== 'in_progress') fail(`extension occurred after outcome ${ev.id} was closed`);
      rec.extensions.push({
        extension: ev.extension,
        acceptance: ev.acceptance,
        verify: ev.verify,
        decisions: ev.decisions,
        extendedAt: ev.ts,
        head: ev.head || null,
      });
      rec.acceptance = [...new Set([...rec.acceptance, ...ev.acceptance])];
      if (ev.verify) rec.verify = ev.verify;
      rec.decisions = [...new Set([...rec.decisions, ...ev.decisions])];
      rec.contractHash = outcomeContractHash(rec);
      rec.verification = null;
      rec.decisionUpdates = [];
      return;
    }
    if (ev.type === 'verify') {
      const rec = records.get(ev.id);
      if (!rec) fail(`verification event references unknown outcome id: ${ev.id}`);
      if (rec.status !== 'in_progress') fail(`verification occurred after outcome ${ev.id} was closed`);
      if (rec.acceptance.length === 0 || !rec.verify) {
        fail(`verification event references outcome ${ev.id} without acceptance criteria`);
      }
      if (ev.command !== rec.verify) fail(`verification command does not match outcome ${ev.id}`);
      if (rec.logVersion === logVersion && ev.contractHash !== rec.contractHash) {
        fail(`verification contract does not match outcome ${ev.id}`);
      }
      rec.verificationAttempts.push(ev);
      rec.verification = ev;
      return;
    }
    if (ev.type === 'reclaim' || ev.type === 'unreclaim') {
      const rec = records.get(ev.id);
      if (!rec) fail(`${ev.type} event references unknown outcome id: ${ev.id}`);
      if (ev.type === 'reclaim') {
        if (rec.status === 'in_progress') fail(`cannot reclaim outcome ${ev.id} while it is in_progress`);
        if (rec.reclaimed) fail(`duplicate reclaim event for outcome id: ${ev.id}`);
        rec.reclaimed = true;
        rec.reclaimReason = ev.reason;
        rec.reclaimedAt = ev.ts;
      } else {
        if (!rec.reclaimed) fail(`unreclaim event for outcome id that is not reclaimed: ${ev.id}`);
        rec.reclaimed = false;
        rec.reclaimReason = null;
        rec.reclaimedAt = null;
      }
      return;
    }
    if (ev.type === 'end') {
      const rec = records.get(ev.id);
      if (!rec) fail(`end event references unknown outcome id: ${ev.id}`);
      if (rec.status !== 'in_progress') fail(`duplicate end event for outcome id: ${ev.id}`);
      const conflictingCancellation = rec.decisionTerminals.find(
        (terminal) =>
          terminal.type === 'decision_reconcile_cancel' &&
          terminal.outcomeStatus !== ev.status
      );
      if (conflictingCancellation) {
        fail(
          `outcome ${ev.id} was closed as ${ev.status} after reconciliation recovery was cancelled for ${conflictingCancellation.outcomeStatus}`
        );
      }
      if (
        ['completed', 'partial'].includes(ev.status) &&
        rec.decisions.length > 0 &&
        ((rec.logVersion === 1 &&
          rec.schemaVersion >= 2 &&
          (ev.schemaVersion || 1) < 2) ||
          rec.decisions.some(
            (decisionId) => qualifyingDecisionUpdates(rec, decisionId).length === 0
          ))
      ) {
        fail(
          `linked outcome ${ev.id} was closed without reconciling every declared decision`
        );
      }
      if (ev.status === 'completed' && rec.acceptance.length > 0) {
        if (!rec.verification || !rec.verification.passed) {
          fail(
            `acceptance-bound outcome ${ev.id} was completed without successful machine verification`
          );
        }
        if (
          (rec.logVersion === 1 && (ev.schemaVersion || 1) < 4) ||
          ev.verificationId !== rec.verification.verificationId ||
          (ev.workspace ?? null) !== rec.verification.workspace ||
          (rec.logVersion === logVersion &&
            (ev.contractHash !== rec.contractHash ||
              rec.verification.contractHash !== rec.contractHash))
        ) {
          fail(
            `acceptance-bound outcome ${ev.id} was completed with stale machine verification`
          );
        }
      }
      rec.status = ev.status;
      rec.tsEnd = ev.ts;
      rec.note = ev.note || null;
      rec.verifyResult = ev.verifyResult || null;
      rec.endHead = ev.head || null;
      return;
    }
    if (ev.type === 'decision_reconcile_prepare') {
      const rec = records.get(ev.id);
      if (!rec) fail(`decision reconciliation references unknown outcome id: ${ev.id}`);
      if (rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after outcome ${ev.id} was closed`);
      }
      if (!rec.decisions.includes(ev.decisionId)) {
        fail(`decision reconciliation references unlinked decision ${ev.decisionId}`);
      }
      if (reconciliations.has(ev.reconciliationId)) {
        fail(`duplicate reconciliation id: ${ev.reconciliationId}`);
      }
      rec.decisionPrepares.push(ev);
      reconciliations.set(ev.reconciliationId, {
        prepare: ev,
        terminal: null,
        contractHash: rec.contractHash,
      });
      return;
    }
    if (ev.type === 'decision_reconcile') {
      const rec = records.get(ev.id);
      if (!rec) fail(`decision reconciliation references unknown outcome id: ${ev.id}`);
      if (rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after outcome ${ev.id} was closed`);
      }
      if (rec.logVersion === 1 && rec.schemaVersion >= 2) {
        fail(
          `linked legacy schema-v2 outcome ${rec.id} contains a legacy decision reconciliation`
        );
      }
      rec.decisionUpdates.push(ev);
      return;
    }
    if (
      ev.type === 'decision_reconcile_commit' ||
      ev.type === 'decision_reconcile_abort' ||
      ev.type === 'decision_reconcile_cancel'
    ) {
      const rec = records.get(ev.id);
      const reconciliation = reconciliations.get(ev.reconciliationId);
      if (rec && rec.status !== 'in_progress') {
        fail(`decision reconciliation occurred after outcome ${ev.id} was closed`);
      }
      if (
        !rec ||
        !reconciliation ||
        reconciliation.prepare.id !== ev.id ||
        reconciliation.prepare.decisionId !== ev.decisionId
      ) {
        fail(
          `decision reconciliation terminal has no matching prepare: ${ev.reconciliationId}`
        );
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
        priorCancellation.outcomeStatus !== ev.outcomeStatus
      ) {
        fail(`outcome ${ev.id} has conflicting reconciliation cancellation statuses`);
      }
      if (
        ev.type === 'decision_reconcile_commit' &&
        (reconciliation.prepare.newHash !== ev.fileHash ||
          reconciliation.prepare.fromStatus !== ev.fromStatus ||
          reconciliation.prepare.toStatus !== ev.toStatus)
      ) {
        fail(
          `decision reconciliation commit does not match prepare: ${ev.reconciliationId}`
        );
      }
      reconciliation.terminal = ev;
      rec.decisionTerminals.push(ev);
      if (
        ev.type === 'decision_reconcile_commit' &&
        reconciliation.contractHash === rec.contractHash
      ) {
        rec.decisionUpdates.push(ev);
      }
    }
  }

  function foldState(events) {
    const state = {
      records: new Map(),
      reconciliations: new Map(),
      order: [],
      lanes: emptyLaneCatalog(),
    };
    for (const event of events) applyFoldEvent(state, event);
    return state;
  }

  function fold(events) {
    const state = foldState(events);
    const folded = state.order.map((id) => state.records.get(id));
    folded.lanes = state.lanes;
    return folded;
  }

  return Object.freeze({
    applyFoldEvent,
    emptyLaneCatalog,
    fold,
    foldState,
    newOutcomeRecord,
    outcomeContractHash,
    qualifyingDecisionUpdates,
  });
}

module.exports = {
  createOutcomeFold,
};
