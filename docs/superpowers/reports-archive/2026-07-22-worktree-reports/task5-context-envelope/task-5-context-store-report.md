# Task 5 Private Probe Context Artifact Report

## Status

Implemented the digest-addressed private artifact lifecycle in the existing Task 5
envelope module. No Guard command, receipt, real HOME, Store/controller/runner/adapter,
CLI, index/runtime, package, or documentation path was touched.

## Implemented interface

- `new ConvergenceProbeContextStore({ root, keyProvider })`
- `put(evidence)` canonicalizes and validates the version-1 evidence, computes its
  lowercase SHA-256 digest, encrypts it with the existing `BlobKeyProvider` and AFL1
  AES-256-GCM envelope, and atomically publishes `<digest>.enc` without clobbering.
  It returns only `{ digest, created }`; concurrent identical publication produces one
  `created: true` result and idempotent replays return `created: false`.
- `read(digest)` opens with no-follow semantics, verifies exact owner/mode/type/link
  count, inode and file snapshot stability, decrypts, checks the plaintext digest before
  parsing, requires canonical JSON, and returns detached deeply frozen evidence.
- `remove(digest)` validates and decrypts the same safe artifact before an in-root
  identity-checked quarantine/remove operation. Missing artifacts return `false`.
- `pruneOrphans(liveDigests)` accepts a strict `Set` of live digests, inspects at most
  32 sorted directory entries, and removes only valid non-live artifacts older than
  24 hours. Its result contains counts/digests, never paths.
- Context roots/files are exact `0700`/`0600`. Permissive, symlinked, unowned,
  truncated, corrupt, wrong-key, replaced, and digest-mismatched inputs fail closed;
  the store never repairs modes and emits no logs.
- `crypto-store.mjs` gained only `encryptAesGcmBuffer` and `decryptAesGcmBuffer`.
  `EncryptedBlobStore` now calls those same helpers while retaining its existing
  chmod/legacy path semantics.

## TDD evidence

### RED

Command:

```text
node --test test/convergence-probe-context.test.mjs
```

Before implementation: 0 passing, 1 failing file. The expected failure was the missing
named export `ConvergenceProbeContextStore`.

### GREEN

Focused command:

```text
node --test test/convergence-probe-context.test.mjs
```

Result: 21/21 passing, 0 failing.

Legacy crypto regression command:

```text
node --test test/convergence-probe-context.test.mjs test/capture.test.mjs
```

Result: 47/47 passing, 0 failing (21 context/envelope tests and 26 existing capture/
legacy encrypted-blob tests). Tests ran with temporary macOS directories and did not
touch real HOME.

## Files changed for this commit

- `src/convergence-probe-context.mjs`
- `test/convergence-probe-context.test.mjs`
- `src/crypto-store.mjs`

This report remains uncommitted.

## Self-review and unintegrated boundaries

- Self-review found no plaintext/path/log return channel and no legacy behavior change
  beyond extracting the already-used AES-GCM Buffer mechanics.
- Context path construction, Store references, transaction rollback, runner cleanup,
  explicit-command prune invocation, and package export remain later integration work.
