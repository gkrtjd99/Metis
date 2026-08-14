import { randomBytes } from "node:crypto";
import { transaction } from "./db.js";
import { invariant } from "./errors.js";
import { now } from "./util.js";

function token() {
  return randomBytes(24).toString("hex");
}

function expiresAt(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000).toISOString();
}

export function controllerCredentials(run) {
  return {
    sessionId: run.controller_session_id,
    owner: run.controller_owner,
    fencingToken: Number(run.controller_fencing_token ?? 0),
    token: run.controller_token,
    expiresAt: run.controller_expires_at
  };
}

export function controllerStatus(db, runId) {
  const row = db.prepare(`
    SELECT id, status, controller_session_id, controller_owner,
      controller_fencing_token, controller_token, controller_expires_at
    FROM runs WHERE id = ?
  `).get(runId);
  invariant(row, "RUN_NOT_FOUND", `Run ${runId} was not found.`);
  return {
    runId: row.id,
    runStatus: row.status,
    ...controllerCredentials(row),
    expired: !row.controller_expires_at || Date.parse(row.controller_expires_at) <= Date.now()
  };
}

export function assertController(db, runId, credentials, options = {}) {
  const status = controllerStatus(db, runId);
  invariant(credentials && typeof credentials === "object", "CONTROLLER_REQUIRED", "Controller credentials are required for this state change.");
  invariant(status.sessionId === credentials.sessionId, "CONTROLLER_FENCED", "Another controller session owns this run.");
  invariant(status.owner === credentials.owner, "CONTROLLER_FENCED", "The controller owner does not match.");
  invariant(status.token === credentials.token, "CONTROLLER_FENCED", "The controller token does not match.");
  invariant(status.fencingToken === Number(credentials.fencingToken), "CONTROLLER_FENCED", "The controller fencing token is stale.");
  invariant(!status.expired, "CONTROLLER_EXPIRED", "The controller lease expired. Use explicit takeover.");
  if (options.heartbeat) return heartbeatController(db, runId, credentials, options.leaseSeconds);
  return status;
}

export function heartbeatController(db, runId, credentials, leaseSeconds = 90) {
  const current = controllerStatus(db, runId);
  invariant(current.sessionId === credentials.sessionId
    && current.owner === credentials.owner
    && current.token === credentials.token
    && current.fencingToken === Number(credentials.fencingToken), "CONTROLLER_FENCED", "The controller lease is stale.");
  invariant(!current.expired, "CONTROLLER_EXPIRED", "The controller lease expired. Use explicit takeover.");
  const expiry = expiresAt(leaseSeconds);
  const result = db.prepare(`
    UPDATE runs SET controller_expires_at = ?, updated_at = ?
    WHERE id = ? AND controller_session_id = ? AND controller_token = ? AND controller_fencing_token = ?
  `).run(expiry, now(), runId, credentials.sessionId, credentials.token, Number(credentials.fencingToken));
  invariant(result.changes === 1, "CONTROLLER_FENCED", "The controller lease changed concurrently.");
  return controllerStatus(db, runId);
}

export function takeoverController(db, runId, input = {}) {
  const owner = String(input.owner ?? "metis-main").trim();
  const sessionId = String(input.sessionId ?? `session-${process.pid}-${Date.now()}`).trim();
  invariant(owner && sessionId, "CONTROLLER_IDENTITY", "Controller owner and session ID are required.");
  return transaction(db, () => {
    const current = controllerStatus(db, runId);
    invariant(input.force === true || current.expired, "CONTROLLER_ACTIVE", "The current controller lease is still active.");
    const nextFence = current.fencingToken + 1;
    const nextToken = token();
    const expiry = expiresAt(input.leaseSeconds ?? 90);
    const result = db.prepare(`
      UPDATE runs SET controller_session_id = ?, controller_owner = ?, controller_fencing_token = ?,
        controller_token = ?, controller_expires_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND controller_fencing_token = ?
    `).run(sessionId, owner, nextFence, nextToken, expiry, now(), runId, current.fencingToken);
    invariant(result.changes === 1, "CONTROLLER_RACE", "Controller ownership changed concurrently.");
    return controllerStatus(db, runId);
  });
}

export function newControllerLease(input = {}) {
  const owner = String(input.owner ?? "metis-main").trim();
  const sessionId = String(input.sessionId ?? `session-${process.pid}-${Date.now()}`).trim();
  invariant(owner && sessionId, "CONTROLLER_IDENTITY", "Controller owner and session ID are required.");
  return {
    sessionId,
    owner,
    fencingToken: 1,
    token: token(),
    expiresAt: expiresAt(input.leaseSeconds ?? 90)
  };
}
