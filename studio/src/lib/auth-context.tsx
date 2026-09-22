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
  saveProfileFields,
  saveSettings,
  toUserProfile,
  upsertUserProfile,
  userRef,
} from '@/lib/users';
import type { UserProfile, UserSettings } from '@/lib/types';

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

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // The live profile subscription, replaced on every session change.
  const profileUnsubscribe = useRef<Unsubscribe | null>(null);
  // Read by the action callbacks so they never close over a stale session.
  const uidRef = useRef<string | null>(null);

  useEffect(() => {
    const stopProfile = () => {
      profileUnsubscribe.current?.();
      profileUnsubscribe.current = null;
    };

    const unsubscribeAuth = onAuthStateChanged(auth(), (firebaseUser) => {
      stopProfile();

      if (!firebaseUser) {
        uidRef.current = null;
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const nextUser = toAuthUser(firebaseUser);
      uidRef.current = nextUser.uid;
      setUser(nextUser);

      void upsertUserProfile({
        uid: nextUser.uid,
        displayName: nextUser.displayName,
        email: nextUser.email,
        photoURL: nextUser.photoURL,
      }).catch(() => {
        // A transient write failure is not a session failure: the snapshot
        // below still delivers the profile once it is reachable.
      });

      profileUnsubscribe.current = onSnapshot(
        userRef(nextUser.uid),
        (snapshot) => {
          setProfile(snapshot.exists() ? toUserProfile(snapshot) : null);
          setLoading(false);
        },
        () => {
          setProfile(null);
          setLoading(false);
        },
      );
    });

    return () => {
      stopProfile();
      unsubscribeAuth();
    };
  }, []);

  const signIn = useCallback(async () => {
    await signInWithPopup(auth(), new GoogleAuthProvider());
  }, []);

  const signOutUser = useCallback(async () => {
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
    () => ({ user, profile, loading, signIn, signOutUser, updateSettings, updateProfile }),
    [user, profile, loading, signIn, signOutUser, updateSettings, updateProfile],
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
