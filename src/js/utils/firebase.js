import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCk5YTf80Tv2RP0prWbj1uhlBoHHEvGdRs",
  authDomain: "tradelog-8d1f7.firebaseapp.com",
  projectId: "tradelog-8d1f7",
  storageBucket: "tradelog-8d1f7.firebasestorage.app",
  messagingSenderId: "411167542084",
  appId: "1:411167542084:web:203376e578fd22fe0c2511",
  measurementId: "G-GBSVVQMKGP"
};

const app = initializeApp(firebaseConfig);
try {
  getAnalytics(app);
} catch {
  // analytics unavailable (SSR, adblock, unsupported) - app works without it
}

export const auth = getAuth(app);
export const db = getFirestore(app);

// Security boundary: every Firestore path in syncManager.js is keyed by the
// Firebase Auth UID below — never by username. Firestore rules allow only
// `users/{uid}/...` where uid == request.auth.uid, so a null uid must never
// reach any read/write; it fails closed here instead.
export const SIGNED_OUT_ERROR = 'Not signed in. Please log in to enable cloud sync.';

/** Resolve the current Firebase Auth UID, or null when signed out. Never throws. */
export function getCurrentUid() {
  try {
    return auth && auth.currentUser && auth.currentUser.uid
      ? String(auth.currentUser.uid)
      : null;
  } catch {
    return null;
  }
}

/** Fail-closed UID gate for sync paths. Returns {success, uid} or {success:false, error}. */
export function requireUid() {
  const uid = getCurrentUid();
  if (!uid) return { success: false, error: SIGNED_OUT_ERROR };
  return { success: true, uid };
}
