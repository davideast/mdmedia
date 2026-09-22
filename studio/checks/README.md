# Studio Structural Checks (`ast-grep`)

This directory contains AST-based structural linting and verification rules for the Studio frontend using [`ast-grep`](https://ast-grep.github.io/).

These checks enforce Firestore CQRS, optimistic mutation dispatch, and offline resilience guidelines documented in [`AGENTS.md`](../AGENTS.md).

## Rules

### 1. `no-awaited-firestore-mutation`
- **File:** [`rules/no-awaited-firestore-mutation.yml`](./rules/no-awaited-firestore-mutation.yml)
- **What it flags:** Awaiting client-side Firestore mutations:
  - `await deleteDoc(...)`
  - `await updateDoc(...)`
  - `await setDoc(...)`
  - `await addDoc(...)`
  - `await batch.commit(...)`
- **Why:** In Firestore Web SDK, mutations apply to the local offline cache immediately and synchronously notify `onSnapshot` listeners. The SDK automatically queues the write for background network synchronization with automatic retry and server reconciliation. Awaiting mutations in UI handlers blocks modal dismissals, causes frozen loading states, and throws/stalls when the client is offline.
- **Remediation:**
  - Dispatch mutations optimistically (fire-and-forget, e.g. `void deleteDoc(ref).catch(...)`).
  - Dismiss dialogs and clear editing state immediately upon user confirmation.
  - To create documents with known IDs offline, pre-allocate the reference synchronously using `doc(collection)` and dispatch `setDoc` rather than awaiting `addDoc`.

### 2. `no-client-run-transaction`
- **File:** [`rules/no-client-run-transaction.yml`](./rules/no-client-run-transaction.yml)
- **What it flags:** Client-side usage of `runTransaction(...)`.
- **Why:** Client-side Firestore transactions require an active network connection to acquire and verify server read-locks before committing. When offline or on high-latency networks, `runTransaction` fails immediately.
- **Remediation:**
  - For offline-capable user mutations, use direct optimistic document mutations (`deleteDoc`, `setDoc`, `updateDoc`, `arrayUnion`, `arrayRemove`).
  - For operations requiring atomic cross-document invariants or server privilege, delegate to an authorized backend route handler in `/api/` using the Firebase Admin SDK (`adminDb().runTransaction(...)`).

## Exclusions

Server-side files and tests are excluded from client checks:
- Route handlers: `**/app/api/**`
- Server modules: `**/*server*`, `**/firebase-admin*`
- Test files: `**/*.test.*`, `**/test/**`
- Build artifacts & dependencies: `**/.next/**`, `**/node_modules/**`

## Usage

From the `studio/` directory:

```bash
# Run CQRS structural checks across the codebase
npm run check:cqrs

# Run the rule test suite (verifies valid/invalid test baselines)
npm run test:checks

# Interactive fix / review session
ast-grep scan -c checks/sgconfig.yml --interactive
```

## Adding Rules & Tests

- Rule definitions live in [`rules/*.yml`](./rules/).
- Rule test cases live in [`rule-tests/*-test.yml`](./rule-tests/).
- Update snapshot baselines after modifying tests:
  ```bash
  ast-grep test -U -c checks/sgconfig.yml
  ```
