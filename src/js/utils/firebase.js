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
