"""
Photo-to-Video AR web app - backend (FastAPI).

What this server does:
  1. Receives photo + video + compiled target file (.mind) from the creator page.
  2. Stores them on disk in data/<id>/.
  3. Serves the scan page (/s/<id>) and the files it needs (/files/<id>/...).
  4. Serves the static frontend (HTML/CSS/JS).

No API key needed. Runs locally and deploys seamlessly to Vercel.
"""

import json
import os
import re
import secrets
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------- config
BASE_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = BASE_DIR / "public"
PUBLIC_FILES_DIR = PUBLIC_DIR / "files"
SEED_FILE = BASE_DIR / "backend" / "experiences.json"

# Use public/files if present, fallback to data/
DATA_DIR = PUBLIC_FILES_DIR if PUBLIC_FILES_DIR.exists() else (BASE_DIR / "data")
FRONTEND_DIR = (BASE_DIR / "public") if (BASE_DIR / "public" / "index.html").exists() else (BASE_DIR / "frontend")

# Ephemeral fallback for serverless platforms with read-only filesystems (e.g., Vercel)
TMP_DATA_DIR = Path("/tmp/data")

try:
    TMP_DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

MAX_PHOTO_BYTES = 8 * 1024 * 1024      # 8 MB
MAX_VIDEO_BYTES = 80 * 1024 * 1024     # 80 MB
MAX_TARGET_BYTES = 30 * 1024 * 1024    # 30 MB (.mind file)

PHOTO_EXT = {".jpg", ".jpeg", ".png"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm"}

# Optional: set CREATE_PASSCODE in your environment so only you can create
# experiences on a public server. Leave empty for local testing.
CREATE_PASSCODE = os.environ.get("CREATE_PASSCODE", "")

ID_RE = re.compile(r"^[a-f0-9]{8}$")

app = FastAPI(title="Photo-to-Video AR")

# ---------------------------------------------------------------- helpers
ALL_TARGETS_PATH = DATA_DIR / "_all_targets.mind"


def get_all_experiences():
    """Retrieve all valid experiences sorted by creation time."""
    exps = []
    seen = set()

    # 1. Load seed metadata if available (guarantees fast loading on serverless)
    if SEED_FILE.exists():
        try:
            seeds = json.loads(SEED_FILE.read_text())
            for item in seeds:
                if item.get("id") and item["id"] not in seen:
                    exps.append(item)
                    seen.add(item["id"])
        except Exception:
            pass

    # 2. Check disk /tmp and local data folders for any new experiences
    for d in [DATA_DIR, TMP_DATA_DIR]:
        if not d.exists():
            continue
        for folder in sorted(d.iterdir()):
            if not folder.is_dir() or folder.name.startswith("_") or folder.name in seen:
                continue
            meta_file = folder / "meta.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                    exps.append(meta)
                    seen.add(folder.name)
                except Exception:
                    pass

    exps.sort(key=lambda x: x.get("created", 0))
    return exps


def build_all_targets():
    """Concatenate target.mind msgpack dataLists into one combined .mind file."""
    import msgpack
    exps = get_all_experiences()
    all_data = []
    for exp in exps:
        for d in [DATA_DIR, TMP_DATA_DIR]:
            mind_file = d / exp["id"] / "target.mind"
            if mind_file.exists():
                try:
                    with mind_file.open("rb") as f:
                        d_unpacked = msgpack.unpack(f)
                        items = d_unpacked.get("dataList", [])
                        all_data.extend(items)
                except Exception:
                    pass
                break
    combined = {"v": 2, "dataList": all_data}
    packed = msgpack.packb(combined)
    target_path = TMP_DATA_DIR / "_all_targets.mind"
    try:
        ALL_TARGETS_PATH.write_bytes(packed)
        target_path = ALL_TARGETS_PATH
    except Exception:
        try:
            target_path.write_bytes(packed)
        except Exception:
            pass
    return target_path


def save_upload(upload: UploadFile, dest: Path, max_bytes: int) -> None:
    """Stream an upload to disk and refuse it if it is too big."""
    size = 0
    with dest.open("wb") as out:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"{upload.filename} is too large")
            out.write(chunk)


def to_web_mp4(src: Path, dest: Path) -> bool:
    """
    Convert any phone video (iPhone .mov / HEVC) to H.264 mp4 so it plays in
    every browser. Needs ffmpeg installed. Returns True if it worked.
    """
    if not shutil.which("ffmpeg"):
        return False
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-vf", "scale='min(720,iw)':-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(dest),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=600)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def check_id(exp_id: str) -> Path:
    if not ID_RE.match(exp_id):
        raise HTTPException(404, "Not found")
    for d in [DATA_DIR, TMP_DATA_DIR]:
        folder = d / exp_id
        if (folder / "meta.json").exists():
            return folder
    raise HTTPException(404, "Not found")


# ---------------------------------------------------------------- API
@app.post("/api/create")
def create_experience(
    title: str = Form("Untitled"),
    photo_w: int = Form(...),
    photo_h: int = Form(...),
    photo: UploadFile = File(...),
    video: UploadFile = File(...),
    target: UploadFile = File(...),
    x_passcode: str = Header(default=""),
):
    if CREATE_PASSCODE and not secrets.compare_digest(x_passcode, CREATE_PASSCODE):
        raise HTTPException(401, "Wrong passcode")

    if photo_w <= 0 or photo_h <= 0 or photo_w > 20000 or photo_h > 20000:
        raise HTTPException(400, "Bad photo size")

    photo_ext = Path(photo.filename or "").suffix.lower()
    video_ext = Path(video.filename or "").suffix.lower()
    if photo_ext not in PHOTO_EXT:
        raise HTTPException(400, "Photo must be .jpg or .png")
    if video_ext not in VIDEO_EXT:
        raise HTTPException(400, "Video must be .mp4, .mov, .m4v or .webm")
    if not (target.filename or "").lower().endswith(".mind"):
        raise HTTPException(400, "Target must be a .mind file")

    exp_id = uuid.uuid4().hex[:8]
    folder = DATA_DIR / exp_id
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except Exception:
        folder = TMP_DATA_DIR / exp_id
        folder.mkdir(parents=True, exist_ok=True)

    try:
        photo_name = f"photo{photo_ext}"
        save_upload(photo, folder / photo_name, MAX_PHOTO_BYTES)
        save_upload(target, folder / "target.mind", MAX_TARGET_BYTES)

        raw_video = folder / f"original{video_ext}"
        save_upload(video, raw_video, MAX_VIDEO_BYTES)

        video_name = "video.mp4"
        if to_web_mp4(raw_video, folder / video_name):
            raw_video.unlink(missing_ok=True)
        elif video_ext == ".mp4":
            raw_video.rename(folder / video_name)   # no ffmpeg: trust the mp4
        else:
            raw_video.rename(folder / f"video{video_ext}")
            video_name = f"video{video_ext}"

        meta = {
            "id": exp_id,
            "title": title.strip()[:80] or "Untitled",
            "photo": photo_name,
            "video": video_name,
            "photo_w": photo_w,
            "photo_h": photo_h,
            "created": int(time.time()),
        }
        (folder / "meta.json").write_text(json.dumps(meta))
        # Rebuild combined universal targets file
        try:
            build_all_targets()
        except Exception:
            pass
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)   # never leave half-made folders
        raise

    return {"id": exp_id, "scan_url": f"/s/{exp_id}"}


@app.api_route("/api/experiences", methods=["GET", "HEAD"])
def list_experiences():
    """List all experiences with their assigned targetIndex for universal AR scanning."""
    raw = get_all_experiences()
    result = []
    for idx, exp in enumerate(raw):
        exp_id = exp["id"]
        base = f"/files/{exp_id}"
        result.append({
            "targetIndex": idx,
            "id": exp_id,
            "title": exp.get("title", "Untitled"),
            "photo_url": f"{base}/{exp['photo']}",
            "video_url": f"{base}/{exp['video']}",
            "photo_w": exp["photo_w"],
            "photo_h": exp["photo_h"],
            "ratio": exp["photo_h"] / exp["photo_w"] if exp["photo_w"] else 1.0,
            "created": exp.get("created", 0),
        })
    return {"count": len(result), "experiences": result}


@app.api_route("/api/all_targets.mind", methods=["GET", "HEAD"])
def get_all_targets():
    """Serve the merged MindAR target file containing all registered photos."""
    tmp_path = TMP_DATA_DIR / "_all_targets.mind"
    if tmp_path.exists():
        return FileResponse(tmp_path, media_type="application/octet-stream")
    if ALL_TARGETS_PATH.exists():
        return FileResponse(ALL_TARGETS_PATH, media_type="application/octet-stream")
    built_path = build_all_targets()
    return FileResponse(built_path, media_type="application/octet-stream")


@app.api_route("/api/experiences/{exp_id}", methods=["GET", "HEAD"])
def get_experience(exp_id: str):
    if not ID_RE.match(exp_id):
        raise HTTPException(404, "Not found")

    # Check filesystem first
    for d in [DATA_DIR, TMP_DATA_DIR]:
        meta_file = d / exp_id / "meta.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
            base = f"/files/{exp_id}"
            return {
                **meta,
                "photo_url": f"{base}/{meta['photo']}",
                "video_url": f"{base}/{meta['video']}",
                "target_url": f"{base}/target.mind",
            }

    # Check seed file
    if SEED_FILE.exists():
        try:
            seeds = json.loads(SEED_FILE.read_text())
            for item in seeds:
                if item.get("id") == exp_id:
                    base = f"/files/{exp_id}"
                    return {
                        **item,
                        "photo_url": f"{base}/{item['photo']}",
                        "video_url": f"{base}/{item['video']}",
                        "target_url": f"{base}/target.mind",
                    }
        except Exception:
            pass

    raise HTTPException(404, "Not found")


@app.api_route("/files/{exp_id}/{filename}", methods=["GET", "HEAD"])
def serve_file(exp_id: str, filename: str):
    if not ID_RE.match(exp_id):
        raise HTTPException(404, "Not found")
    if filename == "meta.json" or filename.startswith("original") or filename.startswith("_"):
        raise HTTPException(404, "Not found")
    for d in [DATA_DIR, TMP_DATA_DIR]:
        f = d / exp_id / filename
        if f.exists() and f.is_file():
            return FileResponse(f)
    raise HTTPException(404, "Not found")


@app.api_route("/scan", methods=["GET", "HEAD"])
def universal_scan_page():
    """Direct route for the camera scanner from homepage."""
    scan_file = FRONTEND_DIR / "scan.html"
    if not scan_file.exists():
        scan_file = BASE_DIR / "frontend" / "scan.html"
    return FileResponse(scan_file)


@app.api_route("/s/{exp_id}", methods=["GET", "HEAD"])
def scan_page(exp_id: str):
    scan_file = FRONTEND_DIR / "scan.html"
    if not scan_file.exists():
        scan_file = BASE_DIR / "frontend" / "scan.html"
    return FileResponse(scan_file)


@app.get("/favicon.ico")
def favicon():
    style = FRONTEND_DIR / "style.css"
    if style.exists():
        return FileResponse(style, status_code=204)
    return FileResponse(BASE_DIR / "frontend" / "style.css", status_code=204)


# Mount static frontend for local development
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
