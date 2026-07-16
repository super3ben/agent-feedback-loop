import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { deliverNotificationBatch } from "../src/notification-delivery.mjs";
import { openStore } from "../src/store.mjs";

async function deliveryFixture(id, kind = "reviewed_no_lesson") {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-delivery-"));
  const paths = pathsFor(home);
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  const store = openStore({ paths });
  const event = {
    event_uid: `${id}-event`,
    session_uid: `codex:install:${id}-session`,
    event_seq: 1,
    context_epoch: 1,
    project_id: `${id}-project`,
    source_event_id: `${id}-event`,
    role: "user",
    redacted_text: "user feedback",
    content_hash: `${id}-hash`,
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(event);
  store.submitReviewerJob({ job_id: `${id}-job`, project_id: event.project_id, prompt_version: "v1" });
  const payload = kind === "review_completed" ? { severity: "Major", lesson_count: 0 } : {};
  const notification = store.createNotification({
    sessionUid: event.session_uid,
    contextEpoch: 1,
    kind,
    jobId: `${id}-job`,
    eventUid: kind === "review_queued" ? event.event_uid : null,
    payload,
    language: "en"
  });
  return { store, event, notification };
}

test("native acceptance is idempotent and does not activate system fallback", async () => {
  const { store, notification } = await deliveryFixture("native-accepted");
  const calls = [];
  const logs = [];
  const adapters = {
    codex_thread: {
      async probe({ delivery, notification: source }) {
        calls.push(`probe:${delivery.transport}:${source.kind}`);
        return { supported: true };
      },
      async deliver({ delivery }) {
        calls.push(`deliver:${delivery.transport}`);
        return { status: "accepted", ackId: "thread-ack-1" };
      }
    },
    system: {
      async probe() { calls.push("probe:system"); return { supported: true }; },
      async deliver() { calls.push("deliver:system"); return { status: "accepted", ackId: "system-ack-1" }; }
    }
  };

  const first = await deliverNotificationBatch({
    store,
    adapters,
    ownerId: "delivery-worker",
    nowMs: 1_000,
    leaseMs: 30_000,
    limit: 8,
    log: (entry) => logs.push(entry)
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.accepted, 1);
  assert.deepEqual(calls, ["probe:codex_thread:reviewed_no_lesson", "deliver:codex_thread"]);
  assert.equal(store.listNotificationDeliveries({
    notificationId: notification.notification_id,
    transport: "system"
  }).length, 0);
  assert.equal(store.listNotificationDeliveries({
    notificationId: notification.notification_id,
    transport: "audit"
  })[0].state, "audited_only");
  assert.equal(logs.some((entry) => entry.event === "notification.delivery.accepted" && entry.transport === "codex_thread"), true);

  const second = await deliverNotificationBatch({
    store,
    adapters,
    ownerId: "delivery-worker",
    nowMs: 2_000,
    leaseMs: 30_000,
    limit: 8,
    log: (entry) => logs.push(entry)
  });
  assert.equal(second.claimed, 0);
  assert.equal(calls.length, 2);
  store.close();
});

test("native unsupported activates system fallback while audit remains immutable", async () => {
  const { store, notification } = await deliveryFixture("native-unsupported", "review_completed");
  const calls = [];
  const adapters = {
    codex_thread: {
      async probe() { calls.push("probe:native"); return { supported: false, reasonCode: "native_unavailable" }; },
      async deliver() { throw new Error("unsupported transport must not deliver"); }
    },
    system: {
      async probe() { calls.push("probe:system"); return { supported: true }; },
      async deliver() { calls.push("deliver:system"); return { status: "accepted", ackId: "fallback-ack" }; }
    }
  };
  const first = await deliverNotificationBatch({
    store, adapters, ownerId: "fallback-worker", nowMs: 1_000, leaseMs: 30_000, limit: 8
  });
  assert.equal(first.unsupported, 1);
  assert.equal(first.fallbackActivated, 1);
  assert.equal(store.listNotificationDeliveries({
    notificationId: notification.notification_id,
    transport: "system"
  })[0].state, "pending");

  const second = await deliverNotificationBatch({
    store, adapters, ownerId: "fallback-worker", nowMs: 2_000, leaseMs: 30_000, limit: 8
  });
  assert.equal(second.accepted, 1);
  assert.deepEqual(calls, ["probe:native", "probe:system", "deliver:system"]);
  assert.equal(store.listNotificationDeliveries({
    notificationId: notification.notification_id,
    transport: "audit"
  })[0].state, "audited_only");
  store.close();
});

test("native terminal failure activates system but retry backoff does not", async () => {
  const terminalFixture = await deliveryFixture("native-terminal");
  const terminalAdapters = {
    codex_thread: {
      async probe() { return { supported: true }; },
      async deliver() { return { status: "failed", reasonCode: "delivery_rejected" }; }
    },
    system: {
      async probe() { return { supported: true }; },
      async deliver() { return { status: "accepted", ackId: "system-terminal-fallback" }; }
    }
  };
  const terminal = await deliverNotificationBatch({
    store: terminalFixture.store,
    adapters: terminalAdapters,
    ownerId: "terminal-worker",
    nowMs: 1_000,
    leaseMs: 30_000,
    limit: 8
  });
  assert.equal(terminal.failed, 1);
  assert.equal(terminal.fallbackActivated, 1);
  assert.equal(terminalFixture.store.listNotificationDeliveries({
    notificationId: terminalFixture.notification.notification_id,
    transport: "system"
  })[0].state, "pending");
  terminalFixture.store.close();

  const retryFixture = await deliveryFixture("native-retry");
  let attempt = 0;
  const retryAdapters = {
    codex_thread: {
      async probe() { return { supported: true }; },
      async deliver() {
        attempt += 1;
        return attempt === 1
          ? { status: "retry", reasonCode: "transport_error" }
          : { status: "accepted", ackId: "retry-ack" };
      }
    },
    system: {
      async probe() { throw new Error("retry must not activate system"); },
      async deliver() { throw new Error("retry must not activate system"); }
    }
  };
  const retry = await deliverNotificationBatch({
    store: retryFixture.store,
    adapters: retryAdapters,
    ownerId: "retry-worker",
    nowMs: 1_000,
    leaseMs: 30_000,
    limit: 8
  });
  assert.equal(retry.retrying, 1);
  const failedDelivery = retryFixture.store.listNotificationDeliveries({
    notificationId: retryFixture.notification.notification_id,
    transport: "codex_thread"
  })[0];
  assert.equal(failedDelivery.next_attempt_at, 61_000);
  assert.equal(retryFixture.store.listNotificationDeliveries({
    notificationId: retryFixture.notification.notification_id,
    transport: "system"
  }).length, 0);
  assert.equal((await deliverNotificationBatch({
    store: retryFixture.store,
    adapters: retryAdapters,
    ownerId: "retry-worker",
    nowMs: 60_999,
    leaseMs: 30_000,
    limit: 8
  })).claimed, 0);
  assert.equal((await deliverNotificationBatch({
    store: retryFixture.store,
    adapters: retryAdapters,
    ownerId: "retry-worker",
    nowMs: 61_000,
    leaseMs: 30_000,
    limit: 8
  })).accepted, 1);
  retryFixture.store.close();
});

test("candidate and queued semantic events remain audited-only and are never dispatched", async () => {
  const candidateFixture = await deliveryFixture("candidate-audit", "candidate_captured");
  const queuedFixture = await deliveryFixture("queued-audit", "review_queued");
  let calls = 0;
  const adapters = {
    codex_thread: {
      async probe() { calls += 1; return { supported: true }; },
      async deliver() { calls += 1; return { status: "accepted", ackId: "unexpected" }; }
    }
  };
  for (const fixture of [candidateFixture, queuedFixture]) {
    assert.deepEqual(fixture.store.listNotificationDeliveries({
      notificationId: fixture.notification.notification_id
    }).map((row) => [row.transport, row.state]), [
      ["audit", "audited_only"],
      ["codex_thread", "audited_only"]
    ]);
    assert.equal((await deliverNotificationBatch({
      store: fixture.store,
      adapters,
      ownerId: "audit-worker",
      nowMs: 1_000,
      leaseMs: 30_000,
      limit: 8
    })).claimed, 0);
    fixture.store.close();
  }
  assert.equal(calls, 0);
});
