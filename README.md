# Bay Board — setup

This is a real-time, multi-phone version of the bay splitter: everyone's
phone talks to the same shared database, so a bay move on one phone shows
up instantly on everyone else's.

It's 3 files: `index.html`, `app.js`, `firebase-config.js`. No build step —
just static files, deployable straight to GitHub Pages.

## 1. Create a free Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
   Name it anything (e.g. "bay-board"). You can decline Google Analytics.
2. Once created, click the **`</>`** (web) icon to register a web app.
   Give it any nickname, skip Firebase Hosting (we're using GitHub Pages).
3. Firebase will show you a `firebaseConfig` object — copy it.

## 2. Turn on Firestore

1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose a region close to you, start in **production mode**.
3. Go to the **Rules** tab and replace the rules with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```

   ⚠️ **This makes the database fully open** — anyone with your site's
   Firebase config (visible in the page source) could read or write to it
   directly, bypassing the admin PIN. That's fine for an internal team
   tool where the data isn't sensitive, but don't put anything private in
   here. Locking this down properly means adding real Firebase
   Authentication — let me know if you want that later.

## 3. Fill in your config

Open `firebase-config.js` and paste in the values Firebase gave you in
step 1, e.g.:

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "bay-board-xxxxx.firebaseapp.com",
  projectId: "bay-board-xxxxx",
  storageBucket: "bay-board-xxxxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef",
};
```

Also change `ADMIN_PIN` in the same file to whatever PIN your admin
should use.

## 4. Deploy to GitHub Pages

1. Create a new GitHub repo, upload all 3 files to the root.
2. Repo **Settings → Pages** → set source to your main branch, root folder.
3. GitHub gives you a live URL after a minute or two.

## How it works day to day

- **Lifeguards** open the site, tap "I'm a Lifeguard," enter their name once
  (remembered on that phone after), and tap whichever bay they're on.
  Tapping a different bay automatically closes out their time on the old
  one and starts the clock on the new one.
- **Admin** taps "I'm the Admin," enters the PIN, and can flip bays or
  individual positions (Chair 1/2, Jetty, Walker) on and off, see who's
  where and for how long, and manually move a guard if they forget their
  phone.
- The day resets at 10:00 AM local time each day (matching the shift).
