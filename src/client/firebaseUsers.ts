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
import {
  bumpCloudManifestRevision,
  clearSourceIndexInCloud,
  createCategoryInCloud,
  deleteCategoryFromCloud,
  listCategoriesFromCloud,
  CloudApkState,
  CloudExportPayload,
  CloudStreamingSettings,
  CloudUiSettings,
  deletePlaylistFromCloud,
  fetchAdminWatchCloudState,
  fetchApkStateFromCloud,
  fetchStreamingSettingsFromCloud,
  fetchUiSettingsFromCloud,
  fetchViewerCloudState,
  getCloudManifestStatus,
  loadFullCloudSnapshot,
  pushFullLocalToCloud,
  saveAdminSettingsToCloud,
  saveApkStateToCloud,
  saveCatalogToCloud,
  saveEpgToCloud,
  saveLocalUserCredentialsToCloud,
  savePlaylistToCloud,
  saveSourceIndexToCloud,
  saveSourcesToCloud,
  saveStreamingSettingsToCloud,
  saveUiSettingsToCloud,
} from './firebaseDb.js';

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
        .slice(0, 50)
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

export interface FirestoreInviteRecord {
  id: string;
  emailHash: string;
  email: string;
  name: string;
  playlists: string[];
  enabled: boolean;
  invitedByUid: string;
  claimedUid: string;
  created_at: number;
  updated_at: number;
}

export interface FirestoreChannelAlertItem {
  name: string;
  group: string;
  reason: string;
}

export interface FirestoreChannelAlertRecord {
  id: string;
  uid: string;
  userLogin: string;
  userName: string;
  totalChannels: number;
  unavailableCount: number;
  items: FirestoreChannelAlertItem[];
  resolved: boolean;
  created_at: number;
  updated_at: number;
}

async function sha256Hex(text: string): Promise<string> {
  const normalized = text.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchMyInvite(user: User): Promise<{
  emailHash: string;
  name: string;
  playlists: string[];
  enabled: boolean;
} | null> {
  const email = (user.email || '').trim().toLowerCase();
  if (!email || !user.emailVerified) return null;
  const emailHash = await sha256Hex(email);
  try {
    const snap = await getDoc(doc(db, 'invites', emailHash));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      emailHash,
      name: typeof d.name === 'string' ? d.name : '',
      playlists: Array.isArray(d.playlists)
        ? (d.playlists as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 20)
        : [],
      enabled: Boolean(d.enabled),
    };
  } catch {
    // Firestore returns permission-denied when no matching /invites/{emailHash}/private/info exists
    return null;
  }
}

async function ensureViewerProfileInFirestore(user: User): Promise<void> {
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }

  if (!snap.exists()) {
    const invite = await fetchMyInvite(user);
    const baseLogin = sanitizeLogin(
      (user.email || user.displayName || user.uid).split('@')[0] || user.uid
    );
    const displayName = (
      (invite && invite.name) ||
      user.displayName ||
      baseLogin
    ).slice(0, userProps.name.maxLength);

    const batch = writeBatch(db);
    const userPayload: Record<string, unknown> = {
      uid: user.uid,
      login: baseLogin,
      name: displayName,
      playlists: invite ? invite.playlists : [],
      enabled: invite ? Boolean(invite.enabled) : false,
      role: 'user',
      lastPing: serverTimestamp(),
      lastUa: navigator.userAgent.slice(0, 120),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (invite) {
      userPayload.inviteId = invite.emailHash;
    }

    batch.set(userRef, userPayload);
    batch.set(doc(db, 'users', user.uid, 'private', 'info'), {
      uid: user.uid,
      email: (user.email || '').slice(0, 160),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    if (invite) {
      batch.update(doc(db, 'invites', invite.emailHash), {
        claimedUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }

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

  async isSignedInAdmin(): Promise<boolean> {
    try {
      return await isCurrentUserAdmin(auth.currentUser);
    } catch {
      return false;
    }
  },

  async getAdminIdToken(): Promise<string | null> {
    const user = auth.currentUser;
    if (!user || !(await isCurrentUserAdmin(user))) return null;
    return user.getIdToken();
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
    if (!isAdmin) {
      await ensureViewerProfileInFirestore(user);
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
      const existingRole = existingSnap.data()?.role === 'admin' ? 'admin' : 'user';
      const nextRole = payload.role === 'admin' ? 'admin' : existingRole;
      try {
        await updateDoc(ref, {
          login: clean.login,
          name: clean.name,
          playlists: clean.playlists,
          enabled: Boolean(payload.enabled),
          role: nextRole,
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

  // ===== GOOGLE EMAIL INVITES =====
  subscribeAdminInvites(
    onData: (invites: FirestoreInviteRecord[]) => void,
    onError: (err: Error) => void
  ) {
    const path = 'invites';
    const q = query(collection(db, 'invites'));
    return onSnapshot(
      q,
      async (snapshot) => {
        const list: FirestoreInviteRecord[] = [];
        for (const d of snapshot.docs) {
          const data = d.data();
          let email = '';
          try {
            const piiSnap = await getDoc(doc(db, 'invites', d.id, 'private', 'info'));
            if (piiSnap.exists()) {
              email = String(piiSnap.data().email || '');
            }
          } catch {
            // Optional private info
          }
          list.push({
            id: d.id,
            emailHash: String(data.emailHash || d.id),
            email,
            name: String(data.name || ''),
            playlists: Array.isArray(data.playlists) ? (data.playlists as string[]) : [],
            enabled: Boolean(data.enabled),
            invitedByUid: String(data.invitedByUid || ''),
            claimedUid: String(data.claimedUid || ''),
            created_at: tsToSeconds(data.createdAt),
            updated_at: tsToSeconds(data.updatedAt),
          });
        }
        list.sort((a, b) => b.updated_at - a.updated_at);
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

  async saveInviteAdmin(payload: {
    email: string;
    name: string;
    playlists: string[];
    enabled: boolean;
  }): Promise<string> {
    const currentUser = auth.currentUser;
    if (!currentUser || !(await isCurrentUserAdmin(currentUser))) {
      throw new Error('Для облачного приглашения войдите через Google как администратор');
    }
    const cleanEmail = payload.email.trim().toLowerCase().slice(0, 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      throw new Error('Введите корректный Google Email');
    }
    const emailHash = await sha256Hex(cleanEmail);
    const cleanName = (payload.name.trim() || cleanEmail.split('@')[0] || 'Пользователь').slice(0, 80);
    const cleanPlaylists = Array.isArray(payload.playlists)
      ? payload.playlists
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => p.trim().slice(0, 64))
          .slice(0, 50)
      : [];

    const invitePath = `invites/${emailHash}`;
    const inviteRef = doc(db, 'invites', emailHash);
    const piiRef = doc(db, 'invites', emailHash, 'private', 'info');

    let existingSnap;
    try {
      existingSnap = await getDoc(inviteRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, invitePath);
    }

    const batch = writeBatch(db);
    if (!existingSnap.exists()) {
      batch.set(inviteRef, {
        emailHash,
        name: cleanName,
        playlists: cleanPlaylists,
        enabled: Boolean(payload.enabled),
        invitedByUid: currentUser.uid,
        claimedUid: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(piiRef, {
        emailHash,
        email: cleanEmail,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(inviteRef, {
        name: cleanName,
        playlists: cleanPlaylists,
        enabled: Boolean(payload.enabled),
        updatedAt: serverTimestamp(),
      });
      batch.update(piiRef, {
        email: cleanEmail,
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, invitePath);
    }
    return emailHash;
  },

  async deleteInviteAdmin(emailHash: string): Promise<void> {
    const cleanHash = emailHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(cleanHash)) throw new Error('Invalid invite ID');
    try {
      const piiRef = doc(db, 'invites', cleanHash, 'private', 'info');
      const piiSnap = await getDoc(piiRef);
      if (piiSnap.exists()) {
        await deleteDoc(piiRef);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `invites/${cleanHash}/private/info`);
    }
    try {
      await deleteDoc(doc(db, 'invites', cleanHash));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `invites/${cleanHash}`);
    }
  },

  // ===== CHANNEL AVAILABILITY ALERTS =====
  async reportViewerUnavailable(payload: {
    userLogin: string;
    userName: string;
    totalChannels: number;
    items: FirestoreChannelAlertItem[];
  }): Promise<void> {
    const user = auth.currentUser;
    if (!user || !user.emailVerified) return;

    const cleanItems = Array.isArray(payload.items)
      ? payload.items
          .filter((it) => it && typeof it.name === 'string' && it.name.trim() && typeof it.reason === 'string' && it.reason.trim())
          .slice(0, 50)
          .map((it) => ({
            name: it.name.trim().slice(0, 120),
            group: (it.group || '').trim().slice(0, 80),
            reason: it.reason.trim().slice(0, 200),
          }))
      : [];

    // Viewers only write non-empty alert reports (rules require resolved == false for viewer writes)
    if (cleanItems.length === 0) return;

    const alertPath = `channel_alerts/${user.uid}`;
    const alertRef = doc(db, 'channel_alerts', user.uid);
    const totalChannels = Math.max(0, Math.min(50000, Math.floor(Number(payload.totalChannels) || 0)));
    const userLogin = (payload.userLogin || user.email || user.uid).trim().slice(0, 64) || user.uid;
    const userName = (payload.userName || user.displayName || userLogin).trim().slice(0, 80) || userLogin;

    try {
      const snap = await getDoc(alertRef);
      if (!snap.exists()) {
        await setDoc(alertRef, {
          uid: user.uid,
          userLogin,
          userName,
          totalChannels,
          unavailableCount: cleanItems.length,
          items: cleanItems,
          resolved: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(alertRef, {
          userLogin,
          userName,
          totalChannels,
          unavailableCount: cleanItems.length,
          items: cleanItems,
          resolved: false,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // Best-effort Firestore alert sync alongside Express report endpoint
    }
  },

  subscribeAdminAlerts(
    onData: (alerts: FirestoreChannelAlertRecord[]) => void,
    onError: (err: Error) => void
  ) {
    const path = 'channel_alerts';
    const q = query(collection(db, 'channel_alerts'));
    return onSnapshot(
      q,
      (snapshot) => {
        const list: FirestoreChannelAlertRecord[] = [];
        for (const d of snapshot.docs) {
          const data = d.data();
          const rawItems = Array.isArray(data.items) ? data.items : [];
          list.push({
            id: d.id,
            uid: String(data.uid || d.id),
            userLogin: String(data.userLogin || ''),
            userName: String(data.userName || ''),
            totalChannels: Number(data.totalChannels) || 0,
            unavailableCount: Number(data.unavailableCount) || rawItems.length,
            items: rawItems.map((it: Record<string, unknown>) => ({
              name: String(it.name || ''),
              group: String(it.group || ''),
              reason: String(it.reason || ''),
            })),
            resolved: Boolean(data.resolved),
            created_at: tsToSeconds(data.createdAt),
            updated_at: tsToSeconds(data.updatedAt),
          });
        }
        list.sort((a, b) => b.updated_at - a.updated_at);
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

  async resolveAlertAdmin(alertId: string, resolved = true): Promise<void> {
    const cleanId = alertId.trim();
    if (!UID_REGEX.test(cleanId)) return;
    const alertPath = `channel_alerts/${cleanId}`;
    try {
      await updateDoc(doc(db, 'channel_alerts', cleanId), {
        resolved: Boolean(resolved),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, alertPath);
    }
  },

  async deleteAlertAdmin(alertId: string): Promise<void> {
    const cleanId = alertId.trim();
    if (!UID_REGEX.test(cleanId)) return;
    const alertPath = `channel_alerts/${cleanId}`;
    try {
      await deleteDoc(doc(db, 'channel_alerts', cleanId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, alertPath);
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

    const isAdmin = await isCurrentUserAdmin(user);
    if (!isAdmin) {
      await ensureViewerProfileInFirestore(user);
    }

    const userRef = doc(db, 'users', user.uid);
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

  listCategoriesFromCloud,
  createCategoryInCloud,
  deleteCategoryFromCloud,

  // ===== FULL DATABASE CLOUD PERSISTENCE =====
  getCloudManifestStatus,
  bumpCloudManifestRevision,
  savePlaylistToCloud,
  deletePlaylistFromCloud,
  saveSourcesToCloud,
  saveSourceIndexToCloud,
  clearSourceIndexInCloud,
  saveEpgToCloud,
  saveCatalogToCloud,
  saveStreamingSettingsToCloud,
  fetchStreamingSettingsFromCloud,
  saveUiSettingsToCloud,
  fetchUiSettingsFromCloud,
  saveApkStateToCloud,
  fetchApkStateFromCloud,
  saveLocalUserCredentialsToCloud,
  saveAdminSettingsToCloud,
  pushFullLocalToCloud(data: CloudExportPayload) {
    return pushFullLocalToCloud(data);
  },
  loadFullCloudSnapshot,

  async hydrateViewerFromCloud(watchToken?: string): Promise<{
    restored: number;
    streaming: CloudStreamingSettings | null;
    uiSettings: CloudUiSettings | null;
    apkState: CloudApkState | null;
  }> {
    const user = auth.currentUser;
    if (!user || !user.emailVerified) {
      return { restored: 0, streaming: null, uiSettings: null, apkState: null };
    }
    const admin = await isCurrentUserAdmin(user);
    try {
      let cloud: {
        streaming: CloudStreamingSettings | null;
        uiSettings: CloudUiSettings | null;
        apkState: CloudApkState | null;
        playlists: Array<{ name: string; channels: unknown[] }>;
      };
      if (admin) {
        cloud = await fetchAdminWatchCloudState();
      } else {
        const uSnap = await getDoc(doc(db, 'users', user.uid));
        if (!uSnap.exists()) return { restored: 0, streaming: null, uiSettings: null, apkState: null };
        const ud = uSnap.data();
        if (!ud.enabled) return { restored: 0, streaming: null, uiSettings: null, apkState: null };
        const playlists = Array.isArray(ud.playlists) ? (ud.playlists as string[]) : [];
        cloud = await fetchViewerCloudState(playlists);
      }
      if (cloud.playlists.length === 0 && !cloud.streaming && !cloud.uiSettings && !cloud.apkState) {
        return { restored: 0, streaming: null, uiSettings: null, apkState: null };
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (watchToken) headers['X-Watch-Token'] = watchToken;
      const res = await fetch('/watch/api/cloud/hydrate-playlists', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          playlists: cloud.playlists,
          streaming: cloud.streaming,
          uiSettings: cloud.uiSettings,
          apkState: cloud.apkState,
        }),
      });
      const json = await res.json().catch(() => ({}));
      return {
        restored: Number(json.restored) || 0,
        streaming: (json.streaming || cloud.streaming || null) as CloudStreamingSettings | null,
        uiSettings: (json.uiSettings || cloud.uiSettings || null) as CloudUiSettings | null,
        apkState: (cloud.apkState || null) as CloudApkState | null,
      };
    } catch {
      return { restored: 0, streaming: null, uiSettings: null, apkState: null };
    }
  },
};

declare global {
  interface Window {
    PQTVFirebase: typeof PQTVFirebase;
  }
}

window.PQTVFirebase = PQTVFirebase;
