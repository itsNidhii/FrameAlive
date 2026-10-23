# LiveFrame - make a photo play a video (web version, free, open source)

Point a phone camera at a photo. A video plays on top of it. No app, no QR code.
This project is a free, open-source web version of the idea behind FrameALIVE.

---

## 1. What FrameALIVE actually is (important)

I read their landing page. It is **not** "AI turns a photo into a video".
It is **image-recognition augmented reality (AR)**:

1. The creator uploads **a photo + a video** and links them.
2. Later, anyone scans the **printed photo** with the FrameALIVE app.
3. The app **recognises that exact photo** and plays the linked video on top of it.

So the "magic" is: *camera sees picture -> computer recognises which picture -> plays the video that belongs to it.*
No generative AI is needed for this. It is classic computer vision (feature matching).
The page also says scanning works "via web scan" (their website), not only in the app, so a browser version is realistic.

> If what you really want is "AI makes a video **from** a photo", that is a different feature.
> See **Phase 2** below - it can be added on top of this project.

---

## 2. Can it use the normal phone camera instead of an app camera?

**Yes, through the browser.** A website is allowed to ask for the phone's camera
(the browser feature is called `getUserMedia`). It is the same physical camera. The user opens
your website, taps **Start**, allows the camera, and the page shows the live camera feed and
tracks the photo.

What is **not** possible: the phone's built-in *Camera app* cannot recognise your photo and
open your site by itself (only QR codes / Google Lens do that). So the user must open your
website first (bookmark it, add it to the home screen, or use a short link).

Requirements:
- The page must be served over **https://** (browsers block the camera on plain http, except `localhost`).
- The user must tap a button once (browsers need a tap before they allow camera and sound).

---

## 3. How it works (plain words)

```
CREATE (once, on create.html)
  photo ──► browser "learns" the photo (finds ~hundreds of unique points)
            -> makes a small file: target.mind
  photo + video + target.mind ──► server saves them in data/<id>/

SCAN (every time, on /s/<id>)
  phone camera ──► MindAR looks at every camera frame
                   "do I see the points from target.mind?"
                   yes -> it works out where the photo is in 3D
                   -> A-Frame draws the video exactly on top of the photo
```

Key idea: **the heavy work (learning the photo, recognising it) happens inside the user's
browser**. Your server only stores files. That is why this can be hosted for free.

---

## 4. Tech stack and why

| Part | Tool | Why we use it |
|------|------|---------------|
| Image recognition + tracking | **MindAR.js** (MIT) | Free, open source, runs fully in the browser, made for "recognise an image and attach something to it". Replaces the paid cloud recognition (Vuforia, 8th Wall). |
| Drawing the video on the photo | **A-Frame** (MIT) | Simple 3D/AR scene in HTML. MindAR has an official A-Frame plugin. |
| Backend | **FastAPI** (Python, MIT) | Tiny, fast to write, you already know Python (AI/ML). Handles uploads and serves files. |
| Video conversion | **ffmpeg** (optional) | iPhone videos are often HEVC/.mov and will not play on Android/Chrome. ffmpeg converts to H.264 .mp4 and shrinks to 720p. |
| Storage | Plain folders (`data/<id>/`) | No database to set up. Good enough for an MVP. |
| Frontend | Plain HTML + CSS + JS | No build step, nothing to install. Easy to read and change. |
| Tunnel for phone testing | **Cloudflare quick tunnel** | Free https link to your laptop, no account needed. |
| Hosting (free) | **Hugging Face Spaces** (Docker) or **Render** free tier | Both can run the included `Dockerfile`. |

**API keys needed: none.** Everything above is free and open source.

---

## 5. Project structure

```
photo-to-video-web/
├── README.md              <- this file
├── requirements.txt       <- Python packages
├── Dockerfile             <- for free hosting
├── .gitignore
├── backend/
│   └── main.py            <- FastAPI server (upload, serve files)
├── frontend/
│   ├── index.html         <- landing page
│   ├── create.html        <- upload photo + video, learn the photo in-browser
│   ├── scan.html          <- camera + AR playback page
│   └── style.css
└── data/                  <- created automatically; one folder per photo
```

---

## 6. Run it on your computer (Antigravity or any editor)

1. Open this folder in Antigravity (File -> Open Folder) and open its terminal.
2. Install Python 3.10+ if you do not have it.
3. Run:

```bash
python -m venv .venv

# Windows:
.venv\Scripts\activate
# Mac / Linux:
source .venv/bin/activate

pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

4. (Optional but recommended) install **ffmpeg** so phone videos get converted:
   Windows `winget install ffmpeg`, Mac `brew install ffmpeg`, Ubuntu `sudo apt install ffmpeg`.
   Without ffmpeg, use `.mp4` videos (H.264) only.
5. Open `http://localhost:8000` -> **Create**.

### Test on your real phone (needs https)

Your phone cannot use `http://your-laptop-ip` for the camera. Use a free tunnel:

1. Install `cloudflared` (Cloudflare's free tool): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. In a **second terminal**:

```bash
cloudflared tunnel --url http://localhost:8000
```

3. It prints an `https://something.trycloudflare.com` address.
4. **Open that https address on your laptop** and create your photo there
   (the scan link is built from the address you used when creating, so do not create on `localhost`).
5. Open the scan link on your phone, tap **Start camera**, and point at the photo
   on your laptop screen or a printout.

---

## 7. Put it online for free

**Hugging Face Spaces (Docker)**
1. Create a free account -> New Space -> SDK: **Docker**.
2. Upload these files (or connect GitHub). The `Dockerfile` already uses port 7860.
3. In Space settings add a secret `CREATE_PASSCODE` (a password only you know)
   so strangers cannot upload to your server.

**Render**: New -> Web Service -> connect your GitHub repo -> Runtime: Docker -> free instance.
Add the `CREATE_PASSCODE` environment variable.

**Important free-tier limits** (check each provider's current terms):
- Free servers usually have **temporary disk**. Uploaded files can disappear when the server restarts.
  For real use, move files to free object storage (Cloudflare R2 or Supabase Storage free tiers) - see Phase 2.
- Free servers may sleep when idle, so the first request can be slow.

---

## 8. Tips for photos that scan well

- Lots of detail and contrast: faces in busy scenes, posters, textured products. Good.
- Avoid: plain backgrounds, mostly sky, flat-colour logos, very blurry or very dark photos.
- Print on matte paper if you can; glossy paper reflects light and hides detail.
- Use video with the same shape (portrait/landscape) as the photo. Otherwise the video is fitted inside the photo area.

---

## 9. Honest limits

- Browser AR is good, but a native app (ARKit/ARCore) tracks more smoothly, especially on cheap phones.
- Right now each photo has its own scan link (`/s/<id>`). FrameALIVE's app finds the right video for *any* photo you scan. That needs Phase 2 (merging all photos into one recognition file).
- FrameALIVE says "patent pending". Recognising images to trigger media is a well-known technique (many tools do it), but if you plan to sell a competing product, do not copy their name, logo or design, and consider a short legal check.
- Licences: MindAR, A-Frame, FastAPI, ffmpeg (as used here) allow free personal and commercial use. Read each licence before shipping a product.

---

## 10. Phase 2 roadmap

1. **Scan any photo, no link.** One page "Scan" that recognises all uploaded photos.
   MindAR supports many targets in one `.mind` file. Keep all source photos, recompile them together
   (browser or a small Node script using MindAR's offline compiler), and map `targetIndex` -> video.
2. **Persistent storage.** Store files in Cloudflare R2 / Supabase Storage, metadata in SQLite/Postgres.
3. **Accounts + dashboard.** List, edit, delete your photos. Scan counts (simple analytics) for business clients.
4. **Branding for business.** Custom logo on the start screen, call-to-action button (WhatsApp, website) shown over the video.
5. **QR/short links** to print next to a photo as a backup.
6. **AI photo -> video (optional).** Open-weight image-to-video models exist (for example Stable Video Diffusion, LTX-Video, Wan).
   They need a GPU. Free routes: Google Colab, or a Hugging Face Space. Flow: user uploads photo ->
   AI makes a 3-5 second clip -> clip is attached as the video in this project. Free GPU limits change often, so check before relying on them.

### Prompt to paste into the Antigravity agent for Phase 2

```
This project is a FastAPI + MindAR.js + A-Frame web app (see README.md).
Implement Phase 2 item 1: a /scan page that recognises ALL uploaded photos
without a per-photo link. Keep every photo's source image on the server,
build one combined .mind file with all targets (MindAR image compiler),
store a mapping targetIndex -> experience id, and on targetFound play the
matching video. Rebuild the combined file whenever a photo is added or
deleted. Keep it free/open source, no paid APIs, and do not change the
existing per-photo /s/<id> flow.
```
