// ------------------------------------------------------------------
// Paste your Firebase project's web config here.
// Get this from: Firebase Console → Project Settings → General →
// "Your apps" → Web app → SDK setup and configuration → Config
// ------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID",
};

// Change this to whatever PIN your admin should use.
// Note: this is a simple convenience lock, not real security —
// anyone who opens dev tools could bypass it. Fine for an internal
// team tool, not for anything sensitive.
export const ADMIN_PIN = "2468";
