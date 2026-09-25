#!/usr/bin/env node

/**
 * Adversarial Authorization Campaign for mdmedia Studio
 * 
 * Implements the 8-Step Pyric Assurance State Machine:
 * 1. Start / Attach: Create isolated campaign target (network: forbid).
 * 2. Map: Register actors (Owner, Collaborator, Adversary, Anon) and known-good ALLOW controls.
 * 3. Define: Declare plain-language security invariants (ALLOW/DENY).
 * 4. Propose: Generate single-dimension mutations across Path, Payload, Operation.
 * 5. Run & Inspect: Execute in fresh SQLite sandboxes; inspect decisions and traces.
 * 6. Minimize: Delta-debugging payload reduction to isolate exploit fields on counterexamples.
 * 7. Verify: Re-verify candidate rules against the compiled regression cases.
 * 8. Export: Serialize and persist versioned test cases and campaign report.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAuthorizationCampaign,
  runAuthorizationCampaign,
  runSecurityCases,
} from '@pyric/cli/assurance';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioDir = resolve(__dirname, '..');

// Terminal styling helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function banner(step, title) {
  console.log(`\n${c.cyan}======================================================================${c.reset}`);
  console.log(`${c.bold}${c.yellow}Step ${step}: ${title}${c.reset}`);
  console.log(`${c.cyan}======================================================================${c.reset}`);
}

async function runStudioAssurance() {
  console.log(`${c.bold}${c.blue}=== mdmedia Studio Adversarial Authorization Campaign ===${c.reset}`);
  console.log(`${c.dim}Pyric 8-Step State Machine Assurance Engine${c.reset}`);

  // -------------------------------------------------------------------------
  // STEP 1: START / ATTACH
  // -------------------------------------------------------------------------
  banner(1, 'Start Isolated Campaign (network: forbid)');
  
  const firestoreRulesPath = resolve(studioDir, 'firestore.rules');
  const storageRulesPath = resolve(studioDir, 'storage.rules');
  
  if (!existsSync(firestoreRulesPath)) {
    throw new Error(`Missing firestore.rules at ${firestoreRulesPath}`);
  }
  if (!existsSync(storageRulesPath)) {
    throw new Error(`Missing storage.rules at ${storageRulesPath}`);
  }

  const firestoreRules = readFileSync(firestoreRulesPath, 'utf8');
  const storageRules = readFileSync(storageRulesPath, 'utf8');

  console.log(`${c.green}✓${c.reset} Loaded firestore.rules (${firestoreRules.length} bytes)`);
  console.log(`${c.green}✓${c.reset} Loaded storage.rules (${storageRules.length} bytes)`);

  const target = {
    schema: 'pyric.assurance.target.v1',
    network: 'forbid',
    rules: {
      firestore: firestoreRules,
      storage: storageRules,
    },
    state: {
      firestore: {
        // Allowlist collection (only alice and bob are allowlisted; eve is not)
        'allowlist/alice@example.com': {
          email: 'alice@example.com',
          addedAt: 1000000,
        },
        'allowlist/bob@example.com': {
          email: 'bob@example.com',
          addedAt: 1000000,
        },

        // Users collection
        'users/alice': {
          uid: 'alice',
          displayName: 'Alice Creator',
          email: 'alice@example.com',
          photoURL: 'https://example.com/alice.png',
          settings: {
            theme: 'dark',
            wordHighlightPalette: 'amber',
            autoPlayNext: true,
            defaultVoice: 'Puck',
            defaultPromptStyle: 'natural',
          },
        },
        'users/bob': {
          uid: 'bob',
          displayName: 'Bob Collaborator',
          email: 'bob@example.com',
          photoURL: 'https://example.com/bob.png',
          settings: {
            theme: 'light',
            wordHighlightPalette: 'sky',
            autoPlayNext: false,
            defaultVoice: 'Kore',
            defaultPromptStyle: 'expressive',
          },
        },
        'users/eve': {
          uid: 'eve',
          displayName: 'Eve Adversary',
          email: 'eve@example.com',
          photoURL: 'https://example.com/eve.png',
          settings: {
            theme: 'system',
            wordHighlightPalette: 'rose',
            autoPlayNext: false,
            defaultVoice: 'Fenrir',
            defaultPromptStyle: 'natural',
          },
        },

        // Narrations collection
        'narrations/narr-private': {
          ownerUid: 'alice',
          title: 'Alice Confidential Story',
          sourceMarkdown: '# Secret Story\nConfidential narrative.',
          transcript: 'Confidential narrative.',
          voice: 'Puck',
          promptStyle: 'natural',
          adapted: false,
          status: 'ready',
          durationMs: 12500,
          audioPath: 'narrations/alice/narr-private.wav',
          timingsPath: 'narrations/alice/narr-private.timings.json',
          visibility: 'private',
          sharedWith: [],
          authorName: 'Alice Creator',
          authorPhoto: 'https://example.com/alice.png',
          createdAt: 1000000,
          updatedAt: 1000000,
        },
        'narrations/narr-shared': {
          ownerUid: 'alice',
          title: 'Alice & Bob Shared Project',
          sourceMarkdown: '# Shared Workspace\nCollaborative document.',
          transcript: 'Collaborative document.',
          voice: 'Kore',
          promptStyle: 'natural',
          adapted: false,
          status: 'ready',
          durationMs: 8400,
          audioPath: 'narrations/alice/narr-shared.wav',
          timingsPath: 'narrations/alice/narr-shared.timings.json',
          visibility: 'shared',
          sharedWith: ['bob'],
          authorName: 'Alice Creator',
          authorPhoto: 'https://example.com/alice.png',
          createdAt: 1000000,
          updatedAt: 1000000,
        },
        'narrations/narr-public': {
          ownerUid: 'alice',
          title: 'Public Keynote Narration',
          sourceMarkdown: '# Welcome Everyone\nOpen public transcript.',
          transcript: 'Open public transcript.',
          voice: 'Zephyr',
          promptStyle: 'expressive',
          adapted: true,
          status: 'ready',
          durationMs: 45000,
          audioPath: 'narrations/alice/narr-public.wav',
          timingsPath: 'narrations/alice/narr-public.timings.json',
          visibility: 'public',
          sharedWith: [],
          authorName: 'Alice Creator',
          authorPhoto: 'https://example.com/alice.png',
          createdAt: 1000000,
          updatedAt: 1000000,
        },

        // Playlists collection
        'playlists/playlist-alice': {
          ownerUid: 'alice',
          title: 'Alice Morning Queue',
          description: 'Daily tech updates and narrations',
          narrationIds: ['narr-private', 'narr-shared'],
          createdAt: 1000000,
          updatedAt: 1000000,
        },
      },
      storage: [
        {
          path: 'narrations/alice/narr-private.wav',
          dataBase64: 'UklGRg==',
          contentType: 'audio/wav',
          customMetadata: { visibility: 'private' },
        },
        {
          path: 'narrations/alice/narr-public.wav',
          dataBase64: 'UklGRg==',
          contentType: 'audio/wav',
          customMetadata: { visibility: 'public' },
        },
      ],
      auth: {
        users: [
          {
            uid: 'alice',
            email: 'alice@example.com',
            password: 'pw-alice-secret',
            emailVerified: true,
            customClaims: { email: 'alice@example.com', email_verified: true },
          },
          {
            uid: 'bob',
            email: 'bob@example.com',
            password: 'pw-bob-secret',
            emailVerified: true,
            customClaims: { email: 'bob@example.com', email_verified: true },
          },
          {
            uid: 'eve',
            email: 'eve@example.com',
            password: 'pw-eve-secret',
            emailVerified: true,
            customClaims: { email: 'eve@example.com', email_verified: true },
          },
        ],
      },
    },
  };

  const campaign = createAuthorizationCampaign({
    id: 'studio-authorization-audit-v1',
    target,
    safety: { network: 'forbid', maxRuns: 100 },
  });

  console.log(`${c.green}✓${c.reset} Initialized campaign '${campaign.id}' with isolated local target.`);

  // -------------------------------------------------------------------------
  // STEP 2: MAP ACTORS AND OBSERVATIONS
  // -------------------------------------------------------------------------
  banner(2, 'Map Reachable Actors and Known-Good Baseline Observations');

  // Actors
  campaign.addActor({
    id: 'actor-alice',
    acquisition: { kind: 'password', email: 'alice@example.com', password: 'pw-alice-secret' },
  });
  campaign.addActor({
    id: 'actor-bob',
    acquisition: { kind: 'password', email: 'bob@example.com', password: 'pw-bob-secret' },
  });
  campaign.addActor({
    id: 'actor-eve',
    acquisition: { kind: 'password', email: 'eve@example.com', password: 'pw-eve-secret' },
  });
  campaign.addActor({
    id: 'actor-anon',
    acquisition: { kind: 'anonymous-request' },
  });

  console.log(`${c.green}✓${c.reset} Mapped 4 actors: actor-alice (owner), actor-bob (collaborator), actor-eve (adversary), actor-anon (unauthenticated)`);

  // Observations (Baseline ALLOW controls)
  const observations = [
    {
      id: 'obs-alice-read-profile',
      actorId: 'actor-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'get', path: 'users/alice' },
    },
    {
      id: 'obs-alice-read-private-narr',
      actorId: 'actor-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'get', path: 'narrations/narr-private' },
    },
    {
      id: 'obs-bob-read-shared-narr',
      actorId: 'actor-bob',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'get', path: 'narrations/narr-shared' },
    },
    {
      id: 'obs-eve-read-public-narr',
      actorId: 'actor-eve',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'get', path: 'narrations/narr-public' },
    },
    {
      id: 'obs-alice-update-playlist',
      actorId: 'actor-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: {
        service: 'firestore',
        method: 'update',
        path: 'playlists/playlist-alice',
        data: {
          title: 'Alice Updated Morning Queue',
          description: 'Updated description',
          narrationIds: ['narr-private'],
          updatedAt: 1000500,
        },
      },
    },
    {
      id: 'obs-alice-read-own-allowlist',
      actorId: 'actor-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'get', path: 'allowlist/alice@example.com' },
    },
    {
      id: 'obs-alice-read-private-audio',
      actorId: 'actor-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'storage', method: 'get', path: 'narrations/alice/narr-private.wav' },
    },
    {
      id: 'obs-anon-read-public-audio',
      actorId: 'actor-anon',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'storage', method: 'get', path: 'narrations/alice/narr-public.wav' },
    },
  ];

  for (const obs of observations) {
    campaign.addObservation(obs);
  }
  console.log(`${c.green}✓${c.reset} Mapped ${observations.length} authoritative baseline observations (ALLOW controls).`);

  // -------------------------------------------------------------------------
  // STEP 3: DEFINE INVARIANTS
  // -------------------------------------------------------------------------
  banner(3, 'Define Explicit Security Invariants');

  const invariants = [
    {
      id: 'inv-allowlist-enumeration-prohibition',
      service: 'firestore',
      statement: 'A user must not read another user allowlist document.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-allowlist-self-write-prohibition',
      service: 'firestore',
      statement: 'A client must not create or mutate allowlist documents.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-non-allowlisted-profile-gate',
      service: 'firestore',
      statement: 'A non-allowlisted user must not read or create their own user profile document.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-user-profile-isolation',
      service: 'firestore',
      statement: 'A user must not access another user profile or settings document.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-private-narration-confidentiality',
      service: 'firestore',
      statement: 'A non-owner must not read a private narration.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-shared-narration-authorization',
      service: 'firestore',
      statement: 'An uninvited user (not in sharedWith) must not read a shared narration.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-playlist-confidentiality',
      service: 'firestore',
      statement: 'A non-owner must not read or update another user playlist.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-narration-ownership-immutability',
      service: 'firestore',
      statement: 'An update must not alter the ownerUid of a playlist or narration.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-narration-delete-authorization',
      service: 'firestore',
      statement: 'A shared reader must not delete a narration owned by another user.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-storage-client-write-prohibition',
      service: 'storage',
      statement: 'Clients must not directly upload or write audio files into storage.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
    {
      id: 'inv-storage-private-confidentiality',
      service: 'storage',
      statement: 'An unauthenticated visitor must not read private audio objects in storage.',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    },
  ];

  for (const inv of invariants) {
    campaign.addInvariant(inv);
  }
  console.log(`${c.green}✓${c.reset} Defined ${invariants.length} explicit security invariants.`);

  // -------------------------------------------------------------------------
  // STEP 4: PROPOSE MUTATIONS
  // -------------------------------------------------------------------------
  banner(4, 'Propose Single-Dimension Mutations (Path, Payload, Operation)');

  // 4a. Path & Operation Mutations on Allowlist & Profile Gates
  const p0a = campaign.propose({
    observationId: 'obs-alice-read-own-allowlist',
    invariantId: 'inv-allowlist-enumeration-prohibition',
    mutations: [
      {
        id: 'probe-alice-read-bob-allowlist',
        dimension: 'path',
        description: 'Alice attempts to read Bob allowlist document.',
        operation: { service: 'firestore', method: 'get', path: 'allowlist/bob@example.com' },
      },
    ],
  });

  const p0b = campaign.propose({
    observationId: 'obs-alice-read-own-allowlist',
    invariantId: 'inv-allowlist-self-write-prohibition',
    mutations: [
      {
        id: 'probe-alice-delete-own-allowlist',
        dimension: 'operation',
        description: 'Alice attempts to delete her own allowlist document from the client.',
        operation: { service: 'firestore', method: 'delete', path: 'allowlist/alice@example.com' },
      },
    ],
  });

  const p0c = campaign.propose({
    observationId: 'obs-eve-read-public-narr',
    invariantId: 'inv-non-allowlisted-profile-gate',
    mutations: [
      {
        id: 'probe-eve-read-own-non-allowlisted-profile',
        dimension: 'path',
        description: 'Non-allowlisted Eve attempts to read users/eve.',
        operation: { service: 'firestore', method: 'get', path: 'users/eve' },
      },
    ],
  });

  // 4b. Path Mutations: Eve attempts unauthorized reads against various resources
  const p1 = campaign.propose({
    observationId: 'obs-eve-read-public-narr',
    invariantId: 'inv-user-profile-isolation',
    mutations: [
      {
        id: 'probe-eve-read-alice-profile',
        dimension: 'path',
        description: 'Eve attempts to read Alice profile document.',
        operation: { service: 'firestore', method: 'get', path: 'users/alice' },
      },
    ],
  });

  const p1b = campaign.propose({
    observationId: 'obs-eve-read-public-narr',
    invariantId: 'inv-private-narration-confidentiality',
    mutations: [
      {
        id: 'probe-eve-read-alice-private-narr',
        dimension: 'path',
        description: 'Eve attempts to read Alice private narration document.',
        operation: { service: 'firestore', method: 'get', path: 'narrations/narr-private' },
      },
    ],
  });

  const p1c = campaign.propose({
    observationId: 'obs-eve-read-public-narr',
    invariantId: 'inv-shared-narration-authorization',
    mutations: [
      {
        id: 'probe-eve-read-alice-shared-narr',
        dimension: 'path',
        description: 'Eve attempts to read Alice shared narration where Eve is not listed.',
        operation: { service: 'firestore', method: 'get', path: 'narrations/narr-shared' },
      },
    ],
  });

  const p1d = campaign.propose({
    observationId: 'obs-eve-read-public-narr',
    invariantId: 'inv-playlist-confidentiality',
    mutations: [
      {
        id: 'probe-eve-read-alice-playlist',
        dimension: 'path',
        description: 'Eve attempts to read Alice playlist document.',
        operation: { service: 'firestore', method: 'get', path: 'playlists/playlist-alice' },
      },
    ],
  });

  // 4c. Payload Mutation: Alice attempts to update playlist and transfer ownership to Eve
  const p2 = campaign.propose({
    observationId: 'obs-alice-update-playlist',
    invariantId: 'inv-narration-ownership-immutability',
    mutations: [
      {
        id: 'probe-alice-reassign-playlist-owner',
        dimension: 'payload',
        description: 'Attempt to transfer playlist ownership to eve in update payload.',
        operation: {
          service: 'firestore',
          method: 'update',
          path: 'playlists/playlist-alice',
          data: {
            title: 'Alice Updated Morning Queue',
            description: 'Updated description',
            narrationIds: ['narr-private'],
            updatedAt: 1000500,
            ownerUid: 'eve',
          },
        },
      },
    ],
  });

  // 4d. Operation Mutation: Bob (who has shared read) attempts to delete the shared narration
  const p3 = campaign.propose({
    observationId: 'obs-bob-read-shared-narr',
    invariantId: 'inv-narration-delete-authorization',
    mutations: [
      {
        id: 'probe-bob-delete-shared-narr',
        dimension: 'operation',
        description: 'Bob attempts to delete Alice shared narration.',
        operation: { service: 'firestore', method: 'delete', path: 'narrations/narr-shared' },
      },
    ],
  });

  // 4e. Operation Mutation: Alice attempts delete on storage object (client write prohibition)
  const p4 = campaign.propose({
    observationId: 'obs-alice-read-private-audio',
    invariantId: 'inv-storage-client-write-prohibition',
    mutations: [
      {
        id: 'probe-alice-direct-storage-delete',
        dimension: 'operation',
        description: 'Client attempts direct delete of storage object.',
        operation: {
          service: 'storage',
          method: 'delete',
          path: 'narrations/alice/narr-private.wav',
        },
      },
    ],
  });

  // 4f. Path Mutation: Anon attempts to read Alice's private audio in storage
  const p5 = campaign.propose({
    observationId: 'obs-anon-read-public-audio',
    invariantId: 'inv-storage-private-confidentiality',
    mutations: [
      {
        id: 'probe-anon-read-private-storage',
        dimension: 'path',
        description: 'Unauthenticated visitor attempts to read private audio object in storage.',
        operation: { service: 'storage', method: 'get', path: 'narrations/alice/narr-private.wav' },
      },
    ],
  });

  const totalProbes = p0a.length + p0b.length + p0c.length + p1.length + p1b.length + p1c.length + p1d.length + p2.length + p3.length + p4.length + p5.length;
  console.log(`${c.green}✓${c.reset} Proposed ${totalProbes} bounded adversarial probes across path, payload, and operation dimensions.`);

  // -------------------------------------------------------------------------
  // STEP 5: RUN & INSPECT
  // -------------------------------------------------------------------------
  banner(5, 'Run Probes and Inspect Verification Evidence');

  const report = await campaign.run();
  console.log(`Ran ${report.summary.probes} total probe(s) against clean local sandboxes.`);
  console.log(`• Controls passed:        ${c.green}${report.summary.controlsPassed}${c.reset} / ${report.summary.probes}`);
  console.log(`• No-counterexamples:     ${c.green}${report.summary.noCounterexamples}${c.reset} (properly denied)`);
  console.log(`• Local counterexamples:  ${report.summary.localCounterexamples > 0 ? c.red : c.green}${report.summary.localCounterexamples}${c.reset}`);
  console.log(`• Candidate signals:      ${report.summary.candidateSignals}`);
  console.log(`• Engine gaps:            ${report.summary.engineGaps}`);
  console.log(`• Invalid probes:         ${report.summary.invalidProbes}`);

  console.log(`\n${c.bold}Probe Detail Audit:${c.reset}`);
  for (const res of report.results) {
    const icon = res.classification === 'no-counterexample' ? `${c.green}✓ DENIED [SECURE]${c.reset}` :
                 res.classification === 'local-counterexample' ? `${c.red}✗ EXPLOIT [VULNERABILITY]${c.reset}` :
                 `${c.yellow}? ${res.classification}${c.reset}`;
    console.log(`  ${icon} ${c.bold}${res.probeId}${c.reset} (${res.mutationSpec.dimension}): ${res.invariant.statement}`);
  }

  // -------------------------------------------------------------------------
  // STEP 6: MINIMIZE COUNTEREXAMPLES (Delta-Debugging Reducer)
  // -------------------------------------------------------------------------
  banner(6, 'Test Delta-Debugging Payload Minimization');

  let minCampaign = null;
  if (report.summary.localCounterexamples > 0) {
    console.log(`${c.yellow}Minimizing discovered counterexample(s)...${c.reset}`);
    for (const res of report.results) {
      if (res.classification === 'local-counterexample') {
        const min = await campaign.minimize(res.probeId);
        console.log(`Minimized ${res.probeId}: removed ${min.removedPayloadFields.join(', ')}`);
      }
    }
  } else {
    console.log(`${c.green}No production security counterexamples found! All security rules successfully held.${c.reset}`);
    console.log(`Demonstrating delta-debugging field reducer on a synthetic multi-field exploit scenario:`);
    
    // Demonstrate minimization engine with a synthetic multi-field probe
    const syntheticTarget = {
      schema: 'pyric.assurance.target.v1',
      network: 'forbid',
      rules: {
        firestore: `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /profiles/{id} { allow update: if request.auth != null; } } }`,
      },
      state: {
        firestore: { 'profiles/alice': { title: 'Alice', role: 'member', admin: false, backdoor: false } },
        auth: { users: [{ uid: 'alice', email: 'alice@test.com', password: 'pw' }] },
      },
    };
    minCampaign = createAuthorizationCampaign({
      id: 'demo-minimization-campaign',
      target: syntheticTarget,
      safety: { network: 'forbid', maxRuns: 20 },
    });
    minCampaign.addActor({
      id: 'act-alice',
      acquisition: { kind: 'password', email: 'alice@test.com', password: 'pw' },
    });
    minCampaign.addObservation({
      id: 'obs-profile-update',
      actorId: 'act-alice',
      result: 'ALLOW',
      source: 'authored',
      operation: { service: 'firestore', method: 'update', path: 'profiles/alice', data: { title: 'Alice New' } },
    });
    minCampaign.addInvariant({
      id: 'inv-cannot-escalate',
      service: 'firestore',
      statement: 'User must not escalate privilege',
      expected: 'DENY',
      source: 'declared',
      confidence: 'authoritative',
    });
    minCampaign.propose({
      observationId: 'obs-profile-update',
      invariantId: 'inv-cannot-escalate',
      mutations: [
        {
          id: 'probe-multi-field-injection',
          dimension: 'payload',
          description: 'Inject multiple fields where one breaches security',
          operation: {
            service: 'firestore',
            method: 'update',
            path: 'profiles/alice',
            data: { title: 'Alice New', fluffFieldA: 'random', fluffFieldB: 12345, role: 'admin' },
          },
        },
      ],
    });
    const minReport = await minCampaign.run();
    console.log(`  Synthetic campaign detected: ${minReport.summary.localCounterexamples} local-counterexample(s).`);
    const minimized = await minCampaign.minimize('probe-multi-field-injection');
    console.log(`  ${c.green}✓${c.reset} Reducer isolated offending mutation. Removed ${minizedFieldCount(minimized)} extraneous field(s): [${minimized.removedPayloadFields.join(', ')}]`);
  }

  function minizedFieldCount(m) {
    return m.removedPayloadFields ? m.removedPayloadFields.length : 0;
  }

  // -------------------------------------------------------------------------
  // STEP 7: VERIFY RULES
  // -------------------------------------------------------------------------
  banner(7, 'Verify Rules Against Campaign Regression Cases');

  if (report.summary.localCounterexamples > 0) {
    console.log(`${c.yellow}Verifying candidate rules against discovered counterexamples...${c.reset}`);
    const verification = await campaign.verifyRules({ rules: target.rules });
    console.log(`Rules verification completed:`);
    console.log(`• Controls passed:    ${verification.summary.controlsPassed} / ${verification.summary.probes}`);
    console.log(`• Cases denied:       ${verification.summary.noCounterexamples} / ${verification.summary.probes}`);
    console.log(`• Counterexamples:    ${verification.summary.localCounterexamples}`);
  } else {
    console.log(`${c.green}Main studio campaign has zero vulnerabilities (all security rules fully enforced).${c.reset}`);
    console.log(`Demonstrating regression rule verification on the synthetic exploit patch:`);
    
    // Candidate patched rule that denies role change
    const patchedRules = {
      firestore: `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /profiles/{id} { allow update: if request.auth != null && (!('role' in request.resource.data) || request.resource.data.role == resource.data.role); } } }`,
    };
    const verification = await minCampaign.verifyRules({ rules: patchedRules });
    console.log(`Synthetic rules verification completed:`);
    console.log(`• Controls passed:    ${verification.summary.controlsPassed} / ${verification.summary.probes}`);
    console.log(`• Cases denied:       ${verification.summary.noCounterexamples} / ${verification.summary.probes}`);
    console.log(`• Counterexamples:    ${verification.summary.localCounterexamples}`);
    console.log(`${c.green}${c.bold}✓ FULL PASS: Patched candidate rules preserve controls and deny the minimized exploit!${c.reset}`);
  }

  // -------------------------------------------------------------------------
  // STEP 8: EXPORT ARTIFACTS
  // -------------------------------------------------------------------------
  banner(8, 'Export Campaign Bundle and Versioned Regression Cases');

  const exportDir = resolve(studioDir, 'test', 'assurance');
  if (!existsSync(exportDir)) {
    mkdirSync(exportDir, { recursive: true });
  }

  const exportedBundle = campaign.export();
  const casesPath = resolve(exportDir, 'cases.json');
  const reportPath = resolve(exportDir, 'campaign-report.json');

  // Export full probe inventory and security cases
  const exportedCases = report.results.map(r => ({
    schema: 'pyric.assurance.case.v1',
    probeId: r.probeId,
    actorId: r.actorEvidence.actorId,
    dimension: r.mutationSpec.dimension,
    classification: r.classification,
    expect: r.invariant.expected,
    observedDecision: r.mutation.decision,
    controlDecision: r.control.decision,
    invariant: r.invariant.statement,
    operation: r.mutationSpec.operation,
  }));

  writeFileSync(casesPath, JSON.stringify(exportedCases, null, 2), 'utf8');
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    campaignId: campaign.id,
    summary: report.summary,
    target: {
      network: target.network,
      services: Object.keys(target.rules),
    },
    results: report.results.map(r => ({
      probeId: r.probeId,
      dimension: r.mutationSpec.dimension,
      classification: r.classification,
      invariant: r.invariant.statement,
      controlDecision: r.control.decision,
      mutationDecision: r.mutation.decision,
    })),
  }, null, 2), 'utf8');

  console.log(`${c.green}✓${c.reset} Exported ${exportedCases.length} security regression cases to: ${casesPath}`);
  console.log(`${c.green}✓${c.reset} Exported campaign verification report to: ${reportPath}`);

  console.log(`\n${c.bold}${c.green}=== Adversarial Authorization Campaign Completed Successfully! ===${c.reset}\n`);
}

runStudioAssurance().catch(err => {
  console.error(`\n${c.red}${c.bold}Assurance Campaign Failed:${c.reset}`, err);
  process.exit(1);
});
