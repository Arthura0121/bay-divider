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

1. Create a new GitHub repo, upload all 5 files to the root (`index.html`,
   `app.js`, `firebase-config.js`, `calculator.html`, `README.md`).
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
- The day resets at 10:00 AM local time each day (matching the shift) for
  the "hours worked" math, but the live roster itself clears at midnight —
  nothing carries over into the next day's view.
- Nothing is ever deleted. The admin dashboard has a **History** tab where
  you can pick any past date (or tap one of the last 7 days) and see who
  worked which bay, for how long, every bay switch, and a full
  timestamped activity log for that day.

## Notifications

Everyone (lifeguards and admin) gets a notification bell (🔔) once they've
identified themselves (picked a name, or entered the admin PIN). It fires
for:

- Someone checking into, moving between, or checking out of a bay
- A bay opening or closing
- A position (Chair 1/2, Jetty, Walker) turning on or off
- A bay dropping below the headcount its open positions need (and a
  follow-up when it's back to full coverage)
- A guard who's been on the same bay for 3+ hours straight, as a rotation
  reminder
- New chat messages

These show up two ways: as an in-app banner across the top (works
whenever the site is open, on any device), and — if the browser grants
permission — as a real OS-level notification when the tab is in the
background. **Important limitation:** there's no push server behind this,
so the OS notification only works while the browser is still running
(tab open or backgrounded). If someone fully closes the browser or the
site, they won't get anything until they reopen it. True closed-app push
notifications would need Firebase Cloud Messaging plus a service worker —
a bigger addition, possible later if it turns out to matter.

## Just want the calculator?

If someone just wants to work out a time split without checking into the
live system — no name, no PIN — there's a link on the landing screen (and
inside both the lifeguard and admin views) to `calculator.html`. It's the
same 4-position, 10am–6pm splitter, but standalone: nothing it does talks
to Firebase or affects the live bay data.

## Team chat

Both lifeguards and the admin share one live chat, opened with the 💬
button. New messages show as a normal notification-bell entry, plus a
bigger pop-up banner across the top if the chat panel isn't already open
(tap it to jump straight into the conversation). Like the rest of the
day's data, chat resets at midnight — it's not meant as a permanent
message history, just same-day coordination.
