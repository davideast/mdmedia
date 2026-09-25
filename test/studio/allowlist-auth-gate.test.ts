import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Allowlist Account Creation & Access Gate', () => {
  const modulesRules = readFileSync(
    resolve(import.meta.dir, '../../studio/firestore.modules.rules'),
    'utf8',
  );
  const compiledRules = readFileSync(
    resolve(import.meta.dir, '../../studio/firestore.rules'),
    'utf8',
  );
  const adminSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/firebase-admin.ts'),
    'utf8',
  );
  const usersSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/users.ts'),
    'utf8',
  );
  const authContextSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/auth-context.tsx'),
    'utf8',
  );
  const signInGateSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/components/shell/sign-in-gate.tsx'),
    'utf8',
  );

  describe('Firestore Security Rules (authored modules & compiled artifact)', () => {
    it('defines hasVerifiedEmail() and isAllowlisted() with bracket-safe claim access and lowercase email lookup', () => {
      expect(modulesRules).toContain("import { hasClaim } from 'membership';");
      expect(modulesRules).toContain('function hasVerifiedEmail()');
      expect(modulesRules).toContain("hasClaim('email')");
      expect(modulesRules).toContain("request.auth.token['email'] is string");
      expect(modulesRules).toContain("hasClaim('email_verified')");
      expect(modulesRules).toContain("request.auth.token['email_verified'] == true");
      expect(modulesRules).toContain('function isAllowlisted()');
      expect(modulesRules).toContain(
        "exists(/databases/$(database)/documents/allowlist/$(request.auth.token['email'].lower()))",
      );

      // Compiled artifact parity
      expect(compiledRules).toContain('function hasClaim(claim)');
      expect(compiledRules).toContain('function hasVerifiedEmail()');
      expect(compiledRules).toContain('function isAllowlisted()');
    });

    it('restricts /allowlist/{email} to self-only get and forbids client list and write', () => {
      expect(modulesRules).toContain('match /allowlist/{email}');
      expect(modulesRules).toContain("request.auth.token['email'].lower() == email");
      expect(modulesRules).toContain('allow list, write: if false;');
    });

    it('gates /users/{uid} read and write operations on isOwner(uid) && isAllowlisted()', () => {
      expect(modulesRules).not.toContain('allow read, write: if isOwner(uid);');
      expect(modulesRules).toContain('allow get: if isOwner(uid) && isAllowlisted();');
      expect(modulesRules).toContain('allow create, update: if isOwner(uid) && isAllowlisted();');
      expect(modulesRules).toContain('allow list, delete: if false;');
    });

    it('gates /narrations/{narrationId} and /playlists/{playlistId} mutations on isAllowlisted()', () => {
      expect(modulesRules).toContain('allow create: if false;');
      expect(modulesRules).toContain("allow update: if isAllowlisted()");
      expect(modulesRules).toContain(".hasOnly(['title', 'visibility', 'sharedWith', 'sharedWithLabels', 'updatedAt'])");
      expect(modulesRules).toContain('allow delete: if isAllowlisted() && isOwner(resource.data.ownerUid);');
      expect(modulesRules).toContain(
        "allow create: if isAllowlisted()\n        && isOwner(request.resource.data.ownerUid)\n        && hasRequired(['ownerUid', 'title', 'description', 'narrationIds', 'createdAt', 'updatedAt'])",
      );
    });
  });

  describe('Server Admin SDK verifyIdToken Allowlist Gate', () => {
    it('requires verified email and allowlist/{email} existence before returning decoded.uid', () => {
      expect(adminSource).toContain('const email = decoded.email?.trim().toLowerCase();');
      expect(adminSource).toContain('decoded.email_verified !== true');
      expect(adminSource).toContain("adminDb().collection('allowlist').doc(email).get()");
      expect(adminSource).toContain('if (!allowlistDoc.exists) return null;');
    });
  });

  describe('Client Allowlist Pre-Check & AuthProvider Session Gate', () => {
    it('normalizes email to lowercase in allowlistRef and isEmailAllowlisted', () => {
      expect(usersSource).toContain("doc(db(), 'allowlist', email.trim().toLowerCase())");
      expect(usersSource).toContain('export async function isEmailAllowlisted(email: string): Promise<boolean>');
    });

    it('guards async allowlist resolution with loadSessionRef.current and signs out non-allowlisted users before provisioning users/{uid}', () => {
      expect(authContextSource).toContain('const sessionId = ++loadSessionRef.current;');
      expect(authContextSource).toContain('const allowed = await isEmailAllowlisted(nextUser.email);');
      expect(authContextSource).toContain('if (loadSessionRef.current !== sessionId) return;');
      expect(authContextSource).toContain('setAccessDenied(true);');
      expect(authContextSource).toContain('await signOut(auth());');

      const allowlistCheckIdx = authContextSource.indexOf('await isEmailAllowlisted(nextUser.email)');
      const upsertProfileIdx = authContextSource.indexOf('void upsertUserProfile({');
      const snapshotIdx = authContextSource.indexOf('profileUnsubscribe.current = onSnapshot(');

      expect(allowlistCheckIdx).toBeGreaterThan(-1);
      expect(upsertProfileIdx).toBeGreaterThan(allowlistCheckIdx);
      expect(snapshotIdx).toBeGreaterThan(allowlistCheckIdx);
    });

    it('surfaces accessDenied in SignInGate and removes open account creation copy', () => {
      expect(signInGateSource).toContain('const { signIn, accessDenied } = useAuth();');
      expect(signInGateSource).toContain('role="alert"');
      expect(signInGateSource).toContain('not on the studio allowlist');
      expect(signInGateSource).not.toContain('New here? Continuing with Google creates your account.');
    });
  });

  describe('Allowlist Management Script (studio/scripts/allowlist.mjs)', () => {
    it('normalizes emails to lowercase and validates email syntax', async () => {
      const { normalizeEmail, isValidEmail, parseArgs } = await import(
        '../../studio/scripts/allowlist.mjs'
      );

      expect(normalizeEmail('  Alice.Creator@Example.COM ')).toBe('alice.creator@example.com');
      expect(isValidEmail('alice@example.com')).toBe(true);
      expect(isValidEmail('not-an-email')).toBe(false);

      // Explicit subcommand
      const parsedSet = parseArgs(['set', 'Alice@Example.com', 'bob@example.com', '--local', '--note', 'Founders']);
      expect(parsedSet.command).toBe('set');
      expect(parsedSet.emails).toEqual(['Alice@Example.com', 'bob@example.com']);
      expect(parsedSet.options.local).toBe(true);
      expect(parsedSet.options.note).toBe('Founders');

      // Shorthand when passing emails directly
      const parsedShorthand = parseArgs(['alice@example.com', 'bob@example.com']);
      expect(parsedShorthand.command).toBe('add');
      expect(parsedShorthand.emails).toEqual(['alice@example.com', 'bob@example.com']);
    });
  });
});
