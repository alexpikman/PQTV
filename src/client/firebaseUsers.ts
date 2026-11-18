import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './firebaseApp.js';
import blueprint from '../../firebase-blueprint.json' with { type: 'json' };

const BOOTSTRAPPED_ADMIN_EMAILS = ['alexpqtr@gmail.com', 'alex.pikman@gmail.com'];

const userProps = blueprint.entities.UserProfile.properties;
const UID_REGEX = new RegExp(userProps.uid.pattern);
const LOGIN_REGEX = new RegExp(userProps.login.pattern);

export interface FirestoreUserRecord {
  id: string;
  uid: string;
  login: string;
  name: string;
  email?: string;
  playlists: string[];
  enabled: boolean;
  role: 'user' | 'admin';
  online: boolean;
  last_ping: number;
  last_ua: string;
  created_at: number;
}

function sanitizeLogin(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, userProps.login.maxLength);
  if (cleaned.length >= userProps.login.minLength && LOGIN_REGEX.test(cleaned)) {
    return cleaned;
  }
  return ('u_' + cleaned).slice(0, userProps.login.maxLength).padEnd(3, '0');
}

function validateUserPayload(input: {
  uid: string;
  login: string;
  name: string;
  playlists: string[];
}): { uid: string; login: string; name: string; playlists: string[] } {
  const uid = input.uid.trim().slice(0, userProps.uid.maxLength);
  if (!UID_REGEX.test(uid)) {
    throw new Error('Некорректный ID пользователя');
  }
  const login = input.login.trim().slice(0, userProps.login.maxLength);
  if (!LOGIN_REGEX.test(login)) {
    throw new Error('Логин: 3–32 символа (латиница, цифры, _ - .)');
  }
  const name = (input.name.trim() || login).slice(0, userProps.name.maxLength);
  const playlists = Array.isArray(input.playlists)
    ? input.playlists
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim().slice(0, 64))
        .slice(0, 20)
    : [];

  return { uid, login, name, playlists };
}

function tsToSeconds(val: unknown): number {
  if (val instanceof Timestamp) return Math.floor(val.toMillis() / 1000);
  if (typeof val === 'number') return val;
  return 0;
}

function mapDocToUser(id: string, data: Record<string, unknown>): FirestoreUserRecord {
  const lastPingSec = tsToSeconds(data.lastPing);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id,
    uid: String(data.uid || id),
    login: String(data.login || ''),
    name: String(data.name || ''),
    playlists: Array.isArray(data.playlists) ? (data.playlists as string[]) : [],
    enabled: Boolean(data.enabled),
    role: data.role === 'admin' ? 'admin' : 'user',
    online: lastPingSec > 0 && nowSec - lastPingSec < 90,
    last_ping: lastPingSec,
    last_ua: String(data.lastUa || ''),
    created_at: tsToSeconds(data.createdAt),
  };
}

async function isCurrentUserAdmin(user: User | null): Promise<boolean> {
  if (!user || !user.emailVerified) return false;
  if (user.email && BOOTSTRAPPED_ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  const adminPath = `admins/${user.uid}`;
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, adminPath);
  }
}

export const PQTVFirebase = {
  onAuthChange(cb: (info: { signedIn: boolean; isAdmin: boolean; uid: string; email: string; displayName: string }) => void) {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        cb({ signedIn: false, isAdmin: false, uid: '', email: '', displayName: '' });
        return;
      }
      let admin = false;
      try {
        admin = await isCurrentUserAdmin(user);
      } catch {
        admin = false;
      }
      cb({
        signedIn: true,
        isAdmin: admin,
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || user.email || '',
      });
    });
  },

  async signInWithGoogle() {
    const cred = await signInWithPopup(auth, googleProvider);
    const admin = await isCurrentUserAdmin(cred.user);
    return {
      uid: cred.user.uid,
      email: cred.user.email || '',
      displayName: cred.user.displayName || '',
      isAdmin: admin,
      idToken: await cred.user.getIdToken(),
    };
  },

  async signOutGoogle() {
    await signOut(auth);
  },

  async signInUnified(): Promise<{
    ok: boolean;
    role?: 'admin' | 'viewer';
    redirectTo?: string;
    adminToken?: string;
    csrfToken?: string;
    watchToken?: string;
    pendingApproval?: boolean;
    error?: string;
  }> {
    const cred = await signInWithPopup(auth, googleProvider);
    const user = cred.user;
    if (!user.emailVerified) {
      return { ok: false, error: 'Email аккаунта Google не подтверждён' };
    }

    const isAdmin = await isCurrentUserAdmin(user);

    // Ensure viewer profile exists in Firestore so admins can approve them
    if (!isAdmin) {
      const userPath = `users/${user.uid}`;
      const userRef = doc(db, 'users', user.uid);
      let snap;
      try {
        snap = await getDoc(userRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, userPath);
      }

      if (!snap.exists()) {
        const baseLogin = sanitizeLogin(
          (user.email || user.displayName || user.uid).split('@')[0] || user.uid
        );
        const displayName = (user.displayName || baseLogin).slice(0, userProps.name.maxLength);

        const batch = writeBatch(db);
        batch.set(userRef, {
          uid: user.uid,
          login: baseLogin,
          name: displayName,
          playlists: [],
          enabled: false,
          role: 'user',
          lastPing: serverTimestamp(),
          lastUa: navigator.userAgent.slice(0, 120),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, 'users', user.uid, 'private', 'info'), {
          uid: user.uid,
          email: (user.email || '').slice(0, 160),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        try {
          await batch.commit();
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, userPath);
        }
      } else {
        try {
          await updateDoc(userRef, {
            lastPing: serverTimestamp(),
            lastUa: navigator.userAgent.slice(0, 120),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // ignore non-critical ping update failure
        }
      }
    }

    const idToken = await user.getIdToken();
    const res = await fetch('/api/auth/unified-google-login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({}),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        pendingApproval: Boolean(data.pendingApproval),
        error: data.error || 'Ошибка входа через Google',
      };
    }
    return {
      ok: true,
      role: data.role,
      redirectTo: data.redirectTo,
      adminToken: data.adminToken,
      csrfToken: data.csrfToken,
      watchToken: data.watchToken,
    };
  },

  subscribeAdminUsers(
    onData: (users: FirestoreUserRecord[]) => void,
    onError: (err: Error) => void
  ) {
    const path = 'users';
    const q = query(collection(db, 'users'));
    return onSnapshot(
      q,
      async (snapshot) => {
        const list: FirestoreUserRecord[] = [];
        for (const d of snapshot.docs) {
          const mapped = mapDocToUser(d.id, d.data());
          try {
            const piiSnap = await getDoc(doc(db, 'users', d.id, 'private', 'info'));
            if (piiSnap.exists()) {
              mapped.email = String(piiSnap.data().email || '');
            }
          } catch {
            // Optional private info
          }
          list.push(mapped);
        }
        list.sort((a, b) => b.created_at - a.created_at);
        onData(list);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, path);
        } catch (wrapped) {
          onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
        }
      }
    );
  },

  async saveUserAdmin(payload: {
    id?: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    role?: 'user' | 'admin';
  }): Promise<string> {
    const docId =
      payload.id && payload.id.trim() !== ''
        ? payload.id.trim()
        : 'u_' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');

    const clean = validateUserPayload({
      uid: docId,
      login: payload.login,
      name: payload.name,
      playlists: payload.playlists,
    });

    const userPath = `users/${docId}`;
    const ref = doc(db, 'users', docId);
    let existingSnap;
    try {
      existingSnap = await getDoc(ref);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }

    if (!existingSnap.exists()) {
      try {
        await setDoc(ref, {
          uid: clean.uid,
          login: clean.login,
          name: clean.name,
          playlists: clean.playlists,
          enabled: Boolean(payload.enabled),
          role: payload.role === 'admin' ? 'admin' : 'user',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, userPath);
      }
    } else {
      try {
        await updateDoc(ref, {
          login: clean.login,
          name: clean.name,
          playlists: clean.playlists,
          enabled: Boolean(payload.enabled),
          role: payload.role === 'admin' ? 'admin' : 'user',
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, userPath);
      }
    }
    return docId;
  },

  async deleteUserAdmin(userId: string): Promise<void> {
    const cleanId = userId.trim();
    if (!UID_REGEX.test(cleanId)) throw new Error('Invalid user ID');
    const privatePath = `users/${cleanId}/private/info`;
    try {
      const piiRef = doc(db, 'users', cleanId, 'private', 'info');
      const piiSnap = await getDoc(piiRef);
      if (piiSnap.exists()) {
        await deleteDoc(piiRef);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, privatePath);
    }
    const userPath = `users/${cleanId}`;
    try {
      await deleteDoc(doc(db, 'users', cleanId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, userPath);
    }
  },

  async importLocalUsers(
    localUsers: Array<{
      id: string;
      login: string;
      name: string;
      playlists: string[];
      enabled: boolean;
    }>
  ): Promise<number> {
    let imported = 0;
    for (const u of localUsers) {
      const ref = doc(db, 'users', u.id);
      let snap;
      try {
        snap = await getDoc(ref);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${u.id}`);
      }
      if (!snap.exists()) {
        await this.saveUserAdmin({
          id: u.id,
          login: u.login,
          name: u.name || u.login,
          playlists: u.playlists || [],
          enabled: Boolean(u.enabled),
          role: 'user',
        });
        imported++;
      }
    }
    return imported;
  },

  async authenticateViewerWithGoogle(): Promise<{
    ok: boolean;
    pendingApproval?: boolean;
    error?: string;
  }> {
    const cred = await signInWithPopup(auth, googleProvider);
    const user = cred.user;
    if (!user.emailVerified) {
      return { ok: false, error: 'Email аккаунта Google не подтверждён' };
    }

    const userPath = `users/${user.uid}`;
    const userRef = doc(db, 'users', user.uid);
    let snap;
    try {
      snap = await getDoc(userRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }

    const isAdmin = await isCurrentUserAdmin(user);

    if (!snap.exists()) {
      const baseLogin = sanitizeLogin(
        (user.email || user.displayName || user.uid).split('@')[0] || user.uid
      );
      const displayName = (user.displayName || baseLogin).slice(0, userProps.name.maxLength);

      const batch = writeBatch(db);
      batch.set(userRef, {
        uid: user.uid,
        login: baseLogin,
        name: displayName,
        playlists: [],
        enabled: false,
        role: 'user',
        lastPing: serverTimestamp(),
        lastUa: navigator.userAgent.slice(0, 120),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'users', user.uid, 'private', 'info'), {
        uid: user.uid,
        email: (user.email || '').slice(0, 160),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, userPath);
      }

      if (!isAdmin) {
        return { ok: false, pendingApproval: true };
      }
    } else {
      try {
        await updateDoc(userRef, {
          lastPing: serverTimestamp(),
          lastUa: navigator.userAgent.slice(0, 120),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, userPath);
      }
    }

    const latestSnap = await getDoc(userRef);
    const profile = latestSnap.exists() ? latestSnap.data() : {};
    const enabled = isAdmin || Boolean(profile.enabled);
    if (!enabled) {
      return { ok: false, pendingApproval: true };
    }

    const idToken = await user.getIdToken();
    const res = await fetch('/watch/api/firebase-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        login: profile.login || user.email || user.uid,
        name: profile.name || user.displayName || 'Пользователь',
        playlists: Array.isArray(profile.playlists) ? profile.playlists : [],
        enabled,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return { ok: false, error: errData.error || 'Ошибка авторизации' };
    }
    return { ok: true };
  },

  async pingViewerPresence(): Promise<void> {
    const user = auth.currentUser;
    if (!user) return;
    const userPath = `users/${user.uid}`;
    try {
      const q = query(collection(db, 'users'), where('uid', '==', user.uid));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, 'users', user.uid), {
          lastPing: serverTimestamp(),
          lastUa: navigator.userAgent.slice(0, 120),
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // Ignore heartbeat failures silently when viewer is using password-only session
    }
  },
};

declare global {
  interface Window {
    PQTVFirebase: typeof PQTVFirebase;
  }
}

window.PQTVFirebase = PQTVFirebase;
