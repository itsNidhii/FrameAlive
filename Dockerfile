# Free hosting: works on Hugging Face Spaces (Docker), Render, Fly.io, Railway.
FROM python:3.12-slim

# ffmpeg converts phone videos (iPhone .mov / HEVC) to web-safe H.264 mp4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend
RUN mkdir -p data

# Hugging Face Spaces uses 7860; Render/others pass $PORT.
ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}"]
