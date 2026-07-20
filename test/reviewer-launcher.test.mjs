import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initializeControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";
import {
  launchDetachedReviewer,
  recoverDueReviewers
} from "../src/reviewer-launcher.mjs";

const LAUNCH_INPUT = {
  nodeExecutable: "/usr/bin/node",
  cliFile: "/runtime/bin/agent-feedback-loop.mjs",
  home: "/tmp/afl-home",
  jobId: "job-1",
  launchEpoch: 7
};

function recoveryStoreFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "afl-reviewer-recovery-"));
  let currentNow = new Date("2026-07-20T00:00:00.000Z");
  const store = initializeControlStore({
    paths: pathsFor(home),
    now: () => new Date(currentNow)
  });
  const source = store.captureSessionEvent({
    event_uid: "reviewer-launcher-source",
    session_uid: "reviewer-launcher-session",
    cli: "codex",
    project_id: "reviewer-launcher-project",
    context_epoch: 1,
    source_event_id: "reviewer-launcher-source-event",
    role: "user",
    referent_event_uid: null,
    content_hash: "a".repeat(64),
    encrypted_raw_ref: path.join(home, "reviewer-launcher.enc"),
    completeness: "prompt_only"
  });
  const candidate = store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    sourceIdentity: "codex:reviewer-launcher-session:reviewer-launcher-source-event:none"
  });

  return {
    candidate,
    store,
    advance(milliseconds) {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    },
    close() {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("darwin and linux launch through one exact detached direct-spawn contract", () => {
  for (const platform of ["darwin", "linux"]) {
    let unrefCalls = 0;
    let errorListener = null;
    const result = launchDetachedReviewer({
      ...LAUNCH_INPUT,
      platform,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/source-home",
        TMPDIR: "/tmp/source-tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "UTF-8",
        TZ: "UTC",
        AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST: "SAFE_OPERATOR",
        SAFE_OPERATOR: "allowed",
        AFL_REVIEW_CONTEXT_FILE: "/tmp/context.json",
        SECRET_TOKEN: "must-not-leak",
        PROMPT_BODY: "must-not-leak"
      },
      spawnImpl(command, args, options) {
        assert.equal(command, "/usr/bin/node");
        assert.deepEqual(args, [
          "/runtime/bin/agent-feedback-loop.mjs",
          "reviewer-run",
          "--home",
          "/tmp/afl-home",
          "--job-id",
          "job-1"
        ]);
        assert.deepEqual(options, {
          cwd: "/runtime/bin",
          detached: true,
          stdio: "ignore",
          env: {
            PATH: "/usr/bin:/bin",
            HOME: "/tmp/source-home",
            TMPDIR: "/tmp/source-tmp",
            LANG: "en_US.UTF-8",
            LC_ALL: "C.UTF-8",
            LC_CTYPE: "UTF-8",
            TZ: "UTC",
            SAFE_OPERATOR: "allowed",
            AFL_REVIEW_CONTEXT_FILE: "/tmp/context.json"
          },
          windowsHide: true
        });
        return {
          once(event, listener) {
            assert.equal(event, "error");
            errorListener = listener;
          },
          unref() {
            unrefCalls += 1;
          }
        };
      }
    });

    assert.deepEqual(result, { attempted: true, reason: "spawn_attempted" });
    assert.equal(unrefCalls, 1);
    assert.equal(typeof errorListener, "function");
    assert.doesNotThrow(() => errorListener(new Error("late child error")));
  }
});

test("unsupported and invalid launcher inputs fail before spawn with bounded reasons", () => {
  let spawnCalls = 0;
  const spawnImpl = () => {
    spawnCalls += 1;
    throw new Error("must not spawn");
  };

  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "win32", spawnImpl }),
    { attempted: false, reason: "unsupported_platform" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "darwin", nodeExecutable: "node", spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "linux", cliFile: "bin/agent-feedback-loop.mjs", spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "linux", home: "tmp/afl-home", spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "linux", jobId: "   ", spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "darwin", launchEpoch: 0, spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.deepEqual(
    launchDetachedReviewer({ ...LAUNCH_INPUT, platform: "darwin", launchEpoch: 1.5, spawnImpl }),
    { attempted: false, reason: "invalid_input" }
  );
  assert.equal(spawnCalls, 0);
});

test("synchronous spawn and unref failures return bounded machine results", (t) => {
  const logged = [];
  t.mock.method(console, "error", (...values) => logged.push(values.join(" ")));
  t.mock.method(console, "warn", (...values) => logged.push(values.join(" ")));
  const spawnFailure = launchDetachedReviewer({
    ...LAUNCH_INPUT,
    platform: "darwin",
    spawnImpl() {
      throw new Error("synthetic spawn failure with secret text");
    }
  });
  assert.deepEqual(spawnFailure, { attempted: false, reason: "spawn_failed" });

  const missingUnref = launchDetachedReviewer({
    ...LAUNCH_INPUT,
    platform: "linux",
    spawnImpl() {
      return { once() {} };
    }
  });
  assert.deepEqual(missingUnref, { attempted: false, reason: "spawn_failed" });

  const unrefFailure = launchDetachedReviewer({
    ...LAUNCH_INPUT,
    platform: "linux",
    spawnImpl() {
      return {
        once() {},
        unref() { throw new Error("synthetic unref failure"); }
      };
    }
  });
  assert.deepEqual(unrefFailure, { attempted: false, reason: "spawn_failed" });
  assert.equal(logged.some((value) => /secret text|synthetic unref failure/.test(value)), false);
});

test("recovery scans stable due order and hard-caps reservation and launch at one", () => {
  const calls = [];
  const store = {
    listRecoverableReviewJobs({ limit }) {
      assert.equal(limit, 1);
      calls.push("list:1");
      return [
        { job_id: "job-first", created_at: "2026-07-20T00:00:00.000Z" },
        { job_id: "job-second", created_at: "2026-07-20T00:00:01.000Z" },
        { job_id: "job-third", created_at: "2026-07-20T00:00:02.000Z" }
      ];
    },
    reserveReviewLaunch({ jobId, cooldownMs }) {
      assert.ok(Number.isInteger(cooldownMs) && cooldownMs >= 0);
      calls.push(`reserve:${jobId}`);
      return { launch: true, launchEpoch: 4, reason: "reserved" };
    },
    recordReviewLaunchFailure() {
      throw new Error("successful launch must not be released");
    }
  };

  const result = recoverDueReviewers({
    store,
    limit: 999,
    launchReviewer(jobId, launchEpoch) {
      calls.push(`launch:${jobId}:${launchEpoch}`);
      return { attempted: true, reason: "spawn_attempted" };
    }
  });

  assert.deepEqual(result, { scanned: 1, attempted: 1 });
  assert.deepEqual(calls, ["list:1", "reserve:job-first", "launch:job-first:4"]);
});

test("synchronous launch failure releases the matching epoch for immediate recovery", (t) => {
  const fixture = recoveryStoreFixture();
  t.after(() => fixture.close());
  const launched = [];

  const result = recoverDueReviewers({
    store: fixture.store,
    launchReviewer(jobId, launchEpoch) {
      launched.push([jobId, launchEpoch]);
      return launchDetachedReviewer({
        ...LAUNCH_INPUT,
        platform: "darwin",
        jobId,
        launchEpoch,
        spawnImpl() {
          throw new Error("synchronous fixture spawn failure");
        }
      });
    }
  });

  assert.deepEqual(result, { scanned: 1, attempted: 1 });
  assert.deepEqual(launched, [[fixture.candidate.jobId, 1]]);
  assert.deepEqual(
    fixture.store.listRecoverableReviewJobs({ limit: 1 }).map((job) => job.job_id),
    [fixture.candidate.jobId]
  );
  assert.deepEqual(
    fixture.store.database.prepare(`SELECT event_type, reason_code, lease_epoch
      FROM review_job_events WHERE job_id=? AND event_type='launch_failed'`).all(fixture.candidate.jobId)
      .map((row) => ({ ...row })),
    [{ event_type: "launch_failed", reason_code: "spawn_failed", lease_epoch: 1 }]
  );
});

test("a stale synchronous failure cannot release a newer store reservation", (t) => {
  const fixture = recoveryStoreFixture();
  t.after(() => fixture.close());
  let newerReservation;

  const result = recoverDueReviewers({
    store: fixture.store,
    launchReviewer(jobId, launchEpoch) {
      assert.equal(launchEpoch, 1);
      fixture.advance(60_000);
      newerReservation = fixture.store.reserveReviewLaunch({ jobId, cooldownMs: 5_000 });
      return { attempted: false, reason: "spawn_failed" };
    }
  });

  assert.deepEqual(result, { scanned: 1, attempted: 1 });
  assert.deepEqual(newerReservation, { launch: true, launchEpoch: 2, reason: "reserved" });
  const current = fixture.store.database.prepare(
    "SELECT launch_epoch, next_launch_at, error_code FROM reviewer_jobs WHERE job_id=?"
  ).get(fixture.candidate.jobId);
  assert.equal(Number(current.launch_epoch), 2);
  assert.ok(current.next_launch_at);
  assert.equal(current.error_code, null);
  assert.deepEqual(fixture.store.listRecoverableReviewJobs({ limit: 1 }), []);
  assert.equal(fixture.store.database.prepare(`SELECT COUNT(*) AS count FROM review_job_events
    WHERE job_id=? AND event_type='launch_failed'`).get(fixture.candidate.jobId).count, 0);
});

test("recovery keeps store and launcher failures prompt-safe", () => {
  assert.deepEqual(recoverDueReviewers({
    store: {
      listRecoverableReviewJobs() { throw new Error("database unavailable"); }
    },
    launchReviewer() { throw new Error("must not launch"); }
  }), { scanned: 0, attempted: 0 });

  assert.deepEqual(recoverDueReviewers({
    store: {
      listRecoverableReviewJobs() { return [{ job_id: "job-reserve-failure" }]; },
      reserveReviewLaunch() { throw new Error("database locked"); }
    },
    launchReviewer() { throw new Error("must not launch"); }
  }), { scanned: 1, attempted: 0 });

  assert.deepEqual(recoverDueReviewers({
    store: {
      listRecoverableReviewJobs() { return [{ job_id: "job-cooldown" }]; },
      reserveReviewLaunch() { return { launch: false, launchEpoch: 4, reason: "cooldown" }; }
    },
    launchReviewer() { throw new Error("must not launch without a reservation"); }
  }), { scanned: 1, attempted: 0 });

  const released = [];
  assert.deepEqual(recoverDueReviewers({
    store: {
      listRecoverableReviewJobs() { return [{ job_id: "job-launch-failure" }]; },
      reserveReviewLaunch() { return { launch: true, launchEpoch: 3, reason: "reserved" }; },
      recordReviewLaunchFailure(value) {
        released.push(value);
        throw new Error("release failure remains prompt-safe");
      }
    },
    launchReviewer() { throw new Error("synchronous launcher failure"); }
  }), { scanned: 1, attempted: 1 });
  assert.deepEqual(released, [{
    jobId: "job-launch-failure",
    launchEpoch: 3,
    reasonCode: "spawn_failed"
  }]);
});
