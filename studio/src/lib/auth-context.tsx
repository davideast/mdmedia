'use client';

/**
 * Session state for the whole studio: who is signed in, their profile and
 * settings, and the four actions that change them.
 *
 * The profile document is live — `onSnapshot` keeps settings in sync across
 * tabs — and the subscription is torn down the moment the session ends.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { onSnapshot, type Unsubscribe } from 'firebase/firestore';

import { auth } from '@/lib/firebase';
import {
  checkEmailAllowlist,
  saveProfileFields,
  saveSettings,
  toUserProfile,
  upsertUserProfile,
  userRef,
} from '@/lib/users';
import type { UserProfile, UserSettings } from '@/lib/types';
import { useConnectivity } from '@/lib/connectivity';

export interface AuthUser {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
}

export interface AuthState {
  user: AuthUser | null;
  profile: UserProfile | null;
  loading: boolean;
  accessDenied: boolean;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  updateProfile: (patch: { displayName?: string; bio?: string }) => Promise<void>;
}

function toAuthUser(user: User): AuthUser {
  return {
    uid: user.uid,
    displayName: user.displayName ?? '',
    email: user.email ?? '',
    photoURL: user.photoURL ?? '',
  };
}

const AuthContext = createContext<AuthState | null>(null);
const LAST_APPROVED_KEY = 'mdmedia.offline-last-approved.v1';
const OFFLINE_LOCK_KEY = 'mdmedia.offline-locked.v1';

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const connectivity = useConnectivity();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  // The live profile subscription, replaced on every session change.
  const profileUnsubscribe = useRef<Unsubscribe | null>(null);
  // Read by the action callbacks so they never close over a stale session.
  const uidRef = useRef<string | null>(null);
  // Async session guard so superseded auth state transitions abort immediately
  // and never attach orphaned Firestore listeners.
  const loadSessionRef = useRef(0);
  const localSessionRef = useRef(false);

  const grantKey = (uid: string) => `mdmedia.offline-grant.v1.${uid}`;

  useEffect(() => {
    const stopProfile = () => {
      profileUnsubscribe.current?.();
      profileUnsubscribe.current = null;
    };

    const unsubscribeAuth = onAuthStateChanged(auth(), (firebaseUser) => {
      const sessionId = ++loadSessionRef.current;
      stopProfile();

      if (!firebaseUser) {
        uidRef.current = null;
        localSessionRef.current = false;
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const nextUser = toAuthUser(firebaseUser);

      void (async () => {
        const decision = await Promise.race([
          checkEmailAllowlist(nextUser.email),
          new Promise<'unavailable'>((resolve) => window.setTimeout(() => resolve('unavailable'), 4500)),
        ]);
        if (loadSessionRef.current !== sessionId) return;

        const approvedBefore = window.localStorage.getItem(grantKey(nextUser.uid)) === nextUser.email.toLowerCase();
        if (decision === 'denied' || (decision === 'unavailable' && !approvedBefore)) {
          uidRef.current = null;
          setUser(null);
          setProfile(null);
          setAccessDenied(decision === 'denied');
          if (decision === 'denied') {
            window.localStorage.removeItem(grantKey(nextUser.uid));
            await signOut(auth());
          }
          setLoading(false);
          return;
        }

        if (decision === 'allowed') {
          window.localStorage.setItem(grantKey(nextUser.uid), nextUser.email.toLowerCase());
          window.localStorage.setItem(LAST_APPROVED_KEY, JSON.stringify(nextUser));
          window.localStorage.removeItem(OFFLINE_LOCK_KEY);
        }

        setAccessDenied(false);
        uidRef.current = nextUser.uid;
        localSessionRef.current = false;
        setUser(nextUser);
        setLoading(false);

        if (decision === 'allowed') void upsertUserProfile({
          uid: nextUser.uid,
          displayName: nextUser.displayName,
          email: nextUser.email,
          photoURL: nextUser.photoURL,
        }).catch(() => {
          // A transient write failure is not a session failure: the snapshot
          // below still delivers the profile once it is reachable.
        });

        if (loadSessionRef.current !== sessionId) return;

        profileUnsubscribe.current = onSnapshot(
          userRef(nextUser.uid),
          (snapshot) => {
            if (loadSessionRef.current !== sessionId) return;
            setProfile(snapshot.exists() ? toUserProfile(snapshot) : null);
            setLoading(false);
          },
          () => {
            if (loadSessionRef.current !== sessionId) return;
            setProfile(null);
            setLoading(false);
          },
        );
      })();
    });

    return () => {
      loadSessionRef.current++;
      stopProfile();
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    if (connectivity === 'online' && localSessionRef.current) {
      localSessionRef.current = false;
      if (!auth().currentUser) {
        uidRef.current = null;
        queueMicrotask(() => {
          setUser(null);
          setProfile(null);
        });
      }
      return;
    }
    if (connectivity !== 'offline' || loading || user || auth().currentUser || window.localStorage.getItem(OFFLINE_LOCK_KEY)) return;
    try {
      const cached = JSON.parse(window.localStorage.getItem(LAST_APPROVED_KEY) || 'null') as AuthUser | null;
      if (!cached?.uid || !cached.email) return;
      if (window.localStorage.getItem(grantKey(cached.uid)) !== cached.email.toLowerCase()) return;
      localSessionRef.current = true;
      uidRef.current = cached.uid;
      queueMicrotask(() => setUser(cached));
    } catch { /* No approved account has been stored on this device. */ }
  }, [connectivity, loading, user]);

  useEffect(() => {
    const recheck = () => {
      const current = auth().currentUser;
      if (!current?.email) return;
      void checkEmailAllowlist(current.email).then((decision) => {
        if (auth().currentUser?.uid !== current.uid) return;
        if (decision === 'allowed') {
          window.localStorage.setItem(grantKey(current.uid), current.email!.toLowerCase());
          if (uidRef.current === null) window.location.reload();
        }
        if (decision === 'denied') {
          window.localStorage.removeItem(grantKey(current.uid));
          setAccessDenied(true);
          void signOut(auth());
        }
      });
    };
    window.addEventListener('online', recheck);
    if (connectivity === 'online') recheck();
    return () => window.removeEventListener('online', recheck);
  }, [connectivity]);

  const signIn = useCallback(async () => {
    setAccessDenied(false);
    await signInWithPopup(auth(), new GoogleAuthProvider());
  }, []);

  const signOutUser = useCallback(async () => {
    window.localStorage.setItem(OFFLINE_LOCK_KEY, '1');
    localSessionRef.current = false;
    uidRef.current = null;
    setUser(null);
    setProfile(null);
    await signOut(auth());
  }, []);

  const updateSettings = useCallback(async (patch: Partial<UserSettings>) => {
    const uid = uidRef.current;
    if (!uid) return;
    saveSettings(uid, patch);
  }, []);

  const updateProfile = useCallback(async (patch: { displayName?: string; bio?: string }) => {
    const uid = uidRef.current;
    if (!uid) return;
    saveProfileFields(uid, patch);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      loading,
      accessDenied,
      signIn,
      signOutUser,
      updateSettings,
      updateProfile,
    }),
    [user, profile, loading, accessDenied, signIn, signOutUser, updateSettings, updateProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) {
    throw new Error('useAuth must be used within AuthProvider.');
  }
  return state;
}
