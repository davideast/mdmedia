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
import { DEFAULT_SETTINGS, DEFAULT_VOICE, settingsDefaultVoice, type VoiceChoice } from '@/lib/types';
import {
  type MutationFeedback,
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
  /** Saved default when usable; Kore while an ElevenLabs grant is unverified or absent. */
  defaultReader: VoiceChoice;
  loading: boolean;
  accessDenied: boolean;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
  updateSettings: (patch: Partial<UserSettings>, feedback?: MutationFeedback) => Promise<void>;
  updateProfile: (patch: { displayName?: string; bio?: string }, feedback?: MutationFeedback) => Promise<void>;
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
  const [checkedDefault, setCheckedDefault] = useState<{ uid: string; id: string; allowed: boolean } | null>(null);

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

      setLoading(true);
      setProfile(null);
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
        // Online Settings must mount with the first saved profile, so uncontrolled
        // fields hydrate correctly. Previously approved offline sessions may open
        // Downloads without waiting for an unreachable profile service.
        if (decision === 'unavailable') setLoading(false);

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
      // Initial auth/profile loading owns this decision. A concurrent allowlist
      // reply must not reload the page before that session has been accepted.
      if (loading) return;
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
  }, [connectivity, loading]);
  // A saved default is only a preference. Keep it intact if a grant is missing;
  // use Kore for drafts until access can be verified.
  const preferredDefault = profile ? settingsDefaultVoice(profile.settings) : null;
  const preferredProvider = preferredDefault?.provider;
  const preferredId = preferredDefault?.id;
  const preferredName = preferredDefault?.name;
  const elevenLabsDefaultId = preferredProvider === 'elevenlabs' ? preferredId : null;
  const ownerUid = user?.uid;
  const defaultReader = useMemo<VoiceChoice>(() => {
    if (preferredProvider === 'elevenlabs'
      && (checkedDefault?.uid !== ownerUid || checkedDefault?.id !== preferredId
        || checkedDefault?.allowed !== true)) {
      return { provider: 'gemini', id: DEFAULT_VOICE, name: DEFAULT_VOICE };
    }
    return preferredProvider && preferredId && preferredName
      ? { provider: preferredProvider, id: preferredId, name: preferredName }
      : settingsDefaultVoice(DEFAULT_SETTINGS);
  }, [preferredProvider, preferredId, preferredName, ownerUid,
    checkedDefault?.uid, checkedDefault?.id, checkedDefault?.allowed]);
  useEffect(() => {
    if (!ownerUid || !elevenLabsDefaultId || connectivity !== 'online') return;
    const controller = new AbortController();
    let latestRequest = 0;
    const checkAccess = () => {
      void (async () => {
        const request = ++latestRequest;
        try {
          const token = await auth().currentUser?.getIdToken();
          if (!token || controller.signal.aborted) return;
          const response = await fetch(`/api/voices?id=${encodeURIComponent(elevenLabsDefaultId)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if ((response.ok || response.status === 404) && !controller.signal.aborted
            && request === latestRequest) {
            setCheckedDefault({ uid: ownerUid, id: elevenLabsDefaultId, allowed: response.ok });
          }
        } catch {
          // Network/provider errors are not evidence that a grant was revoked.
        }
      })();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') checkAccess(); };
    checkAccess();
    window.addEventListener('focus', checkAccess);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.removeEventListener('focus', checkAccess);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ownerUid, elevenLabsDefaultId, connectivity]);

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

  const updateSettings = useCallback(async (patch: Partial<UserSettings>, feedback?: MutationFeedback) => {
    const uid = uidRef.current;
    if (!uid) return;
    saveSettings(uid, patch, feedback);
  }, []);

  const updateProfile = useCallback(async (patch: { displayName?: string; bio?: string }, feedback?: MutationFeedback) => {
    const uid = uidRef.current;
    if (!uid) return;
    saveProfileFields(uid, patch, feedback);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      defaultReader,
      loading,
      accessDenied,
      signIn,
      signOutUser,
      updateSettings,
      updateProfile,
    }),
    [user, profile, defaultReader, loading, accessDenied, signIn, signOutUser, updateSettings, updateProfile],
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
