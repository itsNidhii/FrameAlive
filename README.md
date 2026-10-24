# PicsAlive — Your Memories, Beyond the Picture

**PicsAlive** is an elegant, emotionally engaging web application that connects printed physical photographs to living video memories. When anyone points their phone camera at a registered photograph, PicsAlive instantly recognizes the image and opens an immersive, full-screen playback of the real memory with sound and motion.

---

## Key Features

- **Brand-New Editorial Design System**: Tailored powder-blue and deep burgundy palette, warm ivory surfaces, and refined typography (Playfair Display serif + Inter sans-serif).
- **Public Showcase & Discovery**: Visitors can explore the interactive memories showcase, understand the 5-step process, and watch an embedded demonstration video (configurable via YouTube URL).
- **Secure Per-User Account Ownership**: Every photograph and linked video belongs exclusively to the user who registered it. Users only see and scan their own registered memories.
- **Real Cloud Authentication**: Supports Email/Password sign-up/sign-in as well as Google OAuth.
- **In-Browser AR Target Compilation**: Compiles `.mind` feature descriptors directly inside the browser using MindAR compiler.
- **Immersive Playback Experience**: Replaces tiny 3D overlays with a dedicated full-screen video player featuring a cute animated loading transition, full audio controls, and one-tap "Scan Again" functionality.
- **Production-Ready Serverless Deployment**: Fully optimized for static hosting on Vercel with seamless Cloud Firestore and Firebase Storage integration.

---

## Technology Architecture

- **Frontend**: Vanilla HTML5, CSS3 Custom Properties (Design Tokens), Modular JavaScript (ES6+).
- **Recognition Engine**: [MindAR.js](https://hiukim.github.io/mind-ar-js-doc/) + A-Frame for in-browser visual feature detection and optical tracking.
- **Authentication**: Firebase Authentication (Email/Password + Google Identity).
- **Database**: Cloud Firestore (scoped collections under `users/{userId}/memories/{memoryId}`).
- **Media Storage**: Firebase Storage (user-scoped storage paths `users/{userId}/memories/{memoryId}/`).
- **Hosting & Deployment**: Vercel (static site with clean URL rewrites).

---

## Quick Start (Local Development)

### Running with any static server:
```bash
# Serve the frontend directory:
python3 -m http.server 8000 --directory public
```
Visit `http://localhost:8000` in your browser.

### Running with the optional Python backend:
```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

---

## Firebase Setup Guide

PicsAlive is pre-configured to use **Firebase Auth**, **Firestore**, and **Firebase Storage** for multi-device sync and user security.

### 1. Create a Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Click **Add project** and name it `picsalive`.
3. Disable Google Analytics (optional) and click **Create project**.

### 2. Enable Authentication
1. In the left sidebar, navigate to **Build** → **Authentication**.
2. Click **Get Started**.
3. Under **Sign-in method**, enable:
   - **Email/Password**
   - **Google** (select your project support email and save)

### 3. Create Cloud Firestore
1. Navigate to **Build** → **Firestore Database**.
2. Click **Create database**.
3. Choose your nearest cloud location.
4. Start in **Production mode** (or Test mode for development).
5. In the **Rules** tab, paste the following security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Only authenticated users can access their own document and memories
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /memories/{memoryId} {
        allow read, write, delete: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```
Click **Publish**.

### 4. Enable Firebase Storage
1. Navigate to **Build** → **Storage**.
2. Click **Get Started** and accept the defaults.
3. In the **Rules** tab, paste the following rules:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/memories/{memoryId}/{allPaths=**} {
      allow read, write, delete: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```
Click **Publish**.

### 5. Link Your Credentials
1. In Firebase Console, go to **Project Settings** (gear icon) → **General**.
2. Under **Your apps**, click the Web icon (`</>`) to register a web app.
3. Copy the `firebaseConfig` object and paste it into:
   - `frontend/js/firebase-config.js`
   - `public/js/firebase-config.js`

```javascript
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "picsalive-xxx.firebaseapp.com",
  projectId: "picsalive-xxx",
  storageBucket: "picsalive-xxx.appspot.com",
  messagingSenderId: "...",
  appId: "1:...:web:..."
};
```

---

## Configuring the YouTube Demonstration Video

To change the demo video displayed on the landing page:
1. Open `frontend/index.html` (and `public/index.html`).
2. Update the `PICSALIVE_DEMO_YOUTUBE_URL` variable:
```javascript
const PICSALIVE_DEMO_YOUTUBE_URL = "https://www.youtube.com/watch?v=YOUR_VIDEO_ID";
```
Save the file. PicsAlive automatically converts any standard YouTube link into a privacy-respecting, responsive embed.

---

## Renaming the GitHub Repository to PicsAlive

To complete the branding migration on GitHub:
1. Go to your repository on GitHub: `https://github.com/itsNidhii/FrameAlive`.
2. Click **Settings** (tab at the top).
3. Under **Repository name**, change `FrameAlive` to `PicsAlive` (or `picsalive`).
4. Click **Rename**.
5. Update your local git remote if desired:
```bash
git remote set-url origin git@github.com:itsNidhii/PicsAlive.git
```

---

## Deploying to Vercel

The project includes an optimized `vercel.json` with clean URL rewrites.

To deploy or update on Vercel:
```bash
git add .
git commit -m "PicsAlive: complete redesign, branding, and user accounts"
git push origin main
```
Vercel will automatically build and deploy the latest version.
