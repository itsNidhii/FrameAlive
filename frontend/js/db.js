/**
 * PicsAlive – Database & Cross-Device Cloud Sync Utilities
 *
 * Scoped per user: every memory belongs exclusively to its user UID.
 * Supports multi-device sync across iPhone, Android, Mac, and Windows.
 *
 * 3-Tier Storage Engine:
 *  1. Local IndexedDB: Instant local caching for zero latency on current device.
 *  2. FastAPI Backend: Persistent disk storage when running locally or on server.
 *  3. Cloud Firestore: Real-time cloud synchronization (metadata + media chunks)
 *     compatible with free Firebase Spark tier (requires NO Blaze upgrade).
 */

const IDB_NAME = 'PicsAlive_DB';
const IDB_VERSION = 2;
const IDB_STORE = 'memories';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  /**
   * Create a new memory for the authenticated user and sync across devices.
   */
  async createMemory(userId, memoryData, photoBlob, videoFile, targetBuffer, onProgress) {
    if (!userId) throw new Error('User authentication required to register a photograph.');
    const memoryId = generateId();

    onProgress && onProgress(15);

    // 1. Prepare photo thumbnail (Data URL)
    const photoUrl = await blobToDataUrl(photoBlob);
    onProgress && onProgress(30);

    // 2. Prepare target and video blobs
    const targetBlob = new Blob([targetBuffer], { type: 'application/octet-stream' });
    const targetUrl = URL.createObjectURL(targetBlob);
    const videoUrl = URL.createObjectURL(videoFile);
    onProgress && onProgress(45);

    const record = {
      id: memoryId,
      userId: userId,
      title: memoryData.title || 'Untitled Memory',
      photoUrl: photoUrl,
      videoBlob: videoFile,
      targetBlob: targetBlob,
      videoUrl: videoUrl,
      targetUrl: targetUrl,
      photoW: memoryData.photoW || 800,
      photoH: memoryData.photoH || 600,
      videoType: videoFile.type || 'video/mp4',
      videoSize: videoFile.size || 0,
      backendVideoUrl: `/files/${memoryId}/video.mp4`,
      backendTargetUrl: `/files/${memoryId}/target.mind`,
      createdAt: new Date().toISOString()
    };

    // 3. Save persistently to IndexedDB on device (fast local cache)
    try {
      const idb = await openIDB();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (idbErr) {
      console.warn('IndexedDB write notice, falling back to localStorage:', idbErr);
      const userStorageKey = `picsalive_memories_${userId}`;
      const existing = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
      existing.unshift({
        ...record,
        videoBlob: null,
        targetBlob: null
      });
      localStorage.setItem(userStorageKey, JSON.stringify(existing));
    }
    onProgress && onProgress(60);

    // 4. Send to FastAPI backend API if available
    let backendSuccess = false;
    try {
      const fd = new FormData();
      fd.append('id', memoryId);
      fd.append('user_id', userId);
      fd.append('title', record.title);
      fd.append('photo_w', String(record.photoW));
      fd.append('photo_h', String(record.photoH));
      fd.append('photo', photoBlob, 'photo.jpg');
      fd.append('target', targetBlob, 'target.mind');
      fd.append('video', videoFile, videoFile.name || 'video.mp4');

      const res = await fetch('/api/create', { method: 'POST', body: fd });
      if (res.ok) {
        backendSuccess = true;
      }
    } catch (apiErr) {
      console.warn('Backend API upload notice (running in serverless or offline mode):', apiErr.message);
    }
    onProgress && onProgress(75);

    // 5. Sync metadata and media chunks to Cloud Firestore for cross-device sync
    if (typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db) {
      try {
        const firestoreDoc = {
          id: memoryId,
          userId: userId,
          title: record.title,
          photoUrl: record.photoUrl,
          photoW: record.photoW,
          photoH: record.photoH,
          backendVideoUrl: `/files/${memoryId}/video.mp4`,
          backendTargetUrl: `/files/${memoryId}/target.mind`,
          videoType: record.videoType,
          videoSize: record.videoSize,
          hasCloudMedia: true,
          docType: 'memory',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // Write root memory document
        await db.collection('users').doc(userId).collection('memories').doc(memoryId).set(firestoreDoc);

        // Upload target.mind features to Firestore so other devices can track it
        const targetBase64 = arrayBufferToBase64(targetBuffer);
        await db.collection('users').doc(userId).collection('memories').doc(`${memoryId}_target`).set({
          id: `${memoryId}_target`,
          memoryId: memoryId,
          docType: 'target',
          data: targetBase64
        });

        // Upload video chunks to Firestore for videos <= 15MB (serverless cloud sync)
        if (videoFile.size > 0 && videoFile.size <= 15 * 1024 * 1024) {
          const videoBuffer = await videoFile.arrayBuffer();
          const chunkSize = 500 * 1024; // 500KB chunks -> ~666KB base64, comfortably under 1MB Firestore doc limit
          const totalChunks = Math.ceil(videoBuffer.byteLength / chunkSize);
          const chunkWrites = [];

          for (let i = 0; i < totalChunks; i++) {
            const slice = videoBuffer.slice(i * chunkSize, (i + 1) * chunkSize);
            const sliceBase64 = arrayBufferToBase64(slice);
            chunkWrites.push(
              db.collection('users').doc(userId).collection('memories').doc(`${memoryId}_v${i}`).set({
                id: `${memoryId}_v${i}`,
                memoryId: memoryId,
                docType: 'video_chunk',
                chunkIdx: i,
                totalChunks: totalChunks,
                data: sliceBase64
              })
            );
          }
          await Promise.all(chunkWrites);
        }
      } catch (e) {
        console.warn('Firestore cloud sync notice:', e.message);
      }
    }

    onProgress && onProgress(100);
    return record;
  },

  /**
   * Get all memories strictly belonging to this user, synchronized across all devices.
   */
  async getUserMemories(userId) {
    if (!userId) return [];

    const localMap = new Map();

    // 1. Read from persistent local IndexedDB
    try {
      const idb = await openIDB();
      const localRecords = await new Promise((resolve) => {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });

      localRecords.filter(m => m.userId === userId).forEach(m => {
        if (m.videoBlob && !m.videoUrl) m.videoUrl = URL.createObjectURL(m.videoBlob);
        if (m.targetBlob && !m.targetUrl) m.targetUrl = URL.createObjectURL(m.targetBlob);
        localMap.set(m.id, m);
      });
    } catch (err) {
      console.warn('IndexedDB read notice:', err);
    }

    // Fallback: merge with localStorage cache (only records that strictly belong to this user)
    try {
      const userStorageKey = `picsalive_memories_${userId}`;
      const localList = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
      localList
        .filter(m => m.userId === userId)   // strict: skip unowned old records
        .forEach(m => {
          if (!localMap.has(m.id)) localMap.set(m.id, m);
        });
    } catch (_) {}

    // 2. Fetch from Cloud Firestore (source of truth across devices)
    const cloudMemories = [];
    if (typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db) {
      try {
        const snap = await db.collection('users').doc(userId).collection('memories').get();
        snap.forEach(doc => {
          const data = doc.data();
          // Filter out internal media chunk documents
          if (doc.id.includes('_target') || doc.id.includes('_v') || data.docType === 'target' || data.docType === 'video_chunk') {
            return;
          }
          let createdAtStr = new Date().toISOString();
          if (data.createdAt) {
            createdAtStr = data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt;
          }
          cloudMemories.push({
            id: doc.id,
            userId: data.userId || userId,
            title: data.title || 'Untitled Memory',
            photoUrl: data.photoUrl,
            photoW: data.photoW || 800,
            photoH: data.photoH || 600,
            backendVideoUrl: data.backendVideoUrl || `/files/${doc.id}/video.mp4`,
            backendTargetUrl: data.backendTargetUrl || `/files/${doc.id}/target.mind`,
            videoType: data.videoType || 'video/mp4',
            videoSize: data.videoSize || 0,
            hasCloudMedia: data.hasCloudMedia || false,
            createdAt: createdAtStr
          });
        });
      } catch (fsErr) {
        console.warn('Firestore cloud memories fetch notice:', fsErr.message);
      }
    }

    // 3. Fetch from FastAPI backend API if available
    const backendMemories = [];
    try {
      const res = await fetch(`/api/user-memories?user_id=${encodeURIComponent(userId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.memories) {
          data.memories.forEach(m => backendMemories.push(m));
        }
      }
    } catch (_) {}

    // 4. Merge all sources
    const merged = new Map();

    // Add cloud memories first
    cloudMemories.forEach(m => merged.set(m.id, m));

    // Merge backend memories
    backendMemories.forEach(m => {
      if (merged.has(m.id)) {
        const existing = merged.get(m.id);
        merged.set(m.id, {
          ...existing,
          ...m,
          videoUrl: m.videoUrl || existing.backendVideoUrl,
          targetUrl: m.targetUrl || existing.backendTargetUrl
        });
      } else {
        merged.set(m.id, m);
      }
    });

    // Merge local memories (which contain original local blobs on the creation device)
    // STRICT: only include local memories that belong to this userId
    localMap.forEach((lm, id) => {
      if ((lm.userId || '') !== userId) return;   // never leak unowned old memories
      if (merged.has(id)) {
        const remote = merged.get(id);
        merged.set(id, {
          ...remote,
          ...lm,
          videoBlob: lm.videoBlob || remote.videoBlob,
          targetBlob: lm.targetBlob || remote.targetBlob,
          videoUrl: lm.videoUrl || remote.videoUrl || remote.backendVideoUrl,
          targetUrl: lm.targetUrl || remote.targetUrl || remote.backendTargetUrl
        });
      } else {
        merged.set(id, lm);
      }
    });

    // Final safety pass: remove anything not owned by this user
    merged.forEach((m, id) => {
      if ((m.userId || '') !== userId) merged.delete(id);
    });

    const result = Array.from(merged.values());
    result.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    // Opportunistically cache cloud memories into local IndexedDB for offline capability
    try {
      const idb = await openIDB();
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      result.forEach(m => {
        if (!localMap.has(m.id)) {
          tx.objectStore(IDB_STORE).put({
            id: m.id,
            userId: m.userId,
            title: m.title,
            photoUrl: m.photoUrl,
            photoW: m.photoW,
            photoH: m.photoH,
            backendVideoUrl: m.backendVideoUrl,
            backendTargetUrl: m.backendTargetUrl,
            videoType: m.videoType,
            videoSize: m.videoSize,
            createdAt: m.createdAt
          });
        }
      });
    } catch (_) {}

    return result;
  },

  /**
   * Get a single memory by ID for the current user.
   */
  async getMemory(userId, memoryId) {
    if (!userId || !memoryId) return null;
    const memories = await this.getUserMemories(userId);
    return memories.find(m => m.id === memoryId) || null;
  },

  /**
   * Ensure that video URL is ready for playback on any device.
   * If memory was created on another device, resolves from local blob, backend file, or Firestore chunks.
   */
  async getMemoryVideoUrl(userId, memory) {
    if (!memory) return null;

    // 1. Already have a working blob URL or object
    if (memory.videoBlob) {
      if (!memory.videoUrl) memory.videoUrl = URL.createObjectURL(memory.videoBlob);
      return memory.videoUrl;
    }
    if (memory.videoUrl && memory.videoUrl.startsWith('blob:')) {
      return memory.videoUrl;
    }

    // 2. Check if backend video URL is reachable
    const candidates = [
      memory.backendVideoUrl,
      memory.videoUrl,
      `/files/${memory.id}/video.mp4`
    ].filter(Boolean);

    for (const url of candidates) {
      try {
        const headRes = await fetch(url, { method: 'HEAD' });
        if (headRes.ok) {
          memory.videoUrl = url;
          return url;
        }
      } catch (_) {}
    }

    // 3. Fallback: Reconstruct video from Cloud Firestore chunks
    if (typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db && userId) {
      try {
        const snap = await db.collection('users').doc(userId).collection('memories')
          .where('memoryId', '==', memory.id)
          .where('docType', '==', 'video_chunk')
          .get();

        if (!snap.empty) {
          const chunks = [];
          snap.forEach(doc => {
            const data = doc.data();
            chunks.push(data);
          });
          chunks.sort((a, b) => a.chunkIdx - b.chunkIdx);

          const byteArrays = chunks.map(c => new Uint8Array(base64ToArrayBuffer(c.data)));
          const videoBlob = new Blob(byteArrays, { type: memory.videoType || 'video/mp4' });
          const blobUrl = URL.createObjectURL(videoBlob);
          memory.videoBlob = videoBlob;
          memory.videoUrl = blobUrl;

          // Cache reconstructed blob to local IndexedDB
          try {
            const idb = await openIDB();
            const tx = idb.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({
              ...memory,
              videoBlob,
              videoUrl: blobUrl
            });
          } catch (_) {}

          return blobUrl;
        }
      } catch (fsErr) {
        console.warn('Reconstructing video from Firestore notice:', fsErr);
      }
    }

    return memory.videoUrl || `/files/${memory.id}/video.mp4`;
  },

  /**
   * Delete a memory owned by the user across local device, Firestore, and backend.
   */
  async deleteMemory(userId, memoryId) {
    if (!userId || !memoryId) return;

    // 1. Delete locally from IndexedDB
    try {
      const idb = await openIDB();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(memoryId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {}

    // Delete from localStorage fallback
    try {
      const userStorageKey = `picsalive_memories_${userId}`;
      let memories = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
      memories = memories.filter(m => m.id !== memoryId);
      localStorage.setItem(userStorageKey, JSON.stringify(memories));
    } catch (_) {}

    // 2. Delete remotely from Cloud Firestore
    if (typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db) {
      try {
        const memRef = db.collection('users').doc(userId).collection('memories');
        // Delete main doc
        await memRef.doc(memoryId).delete().catch(() => {});
        // Delete target doc
        await memRef.doc(`${memoryId}_target`).delete().catch(() => {});

        // Delete any video chunk docs
        const chunkSnap = await memRef.where('memoryId', '==', memoryId).get().catch(() => null);
        if (chunkSnap && !chunkSnap.empty) {
          const batch = db.batch();
          chunkSnap.forEach(doc => batch.delete(doc.ref));
          await batch.commit().catch(() => {});
        }
      } catch (e) {
        console.warn('Firestore delete notice:', e);
      }
    }

    // 3. Delete from FastAPI backend
    try {
      await fetch(`/api/user-memories/${encodeURIComponent(memoryId)}?user_id=${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
    } catch (_) {}
  },

  /**
   * Combine all targets for the user's memories into a single MindAR target file for AR scanning.
   */
  async getUserTargets(userId) {
    const memories = await this.getUserMemories(userId);

    if (memories.length === 0) {
      return { blobUrl: null, memories: [] };
    }

    const allDataItems = [];
    const indexedMemories = [];

    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i];
      try {
        let buffer = null;

        // 1. Memory has a local targetBlob
        if (mem.targetBlob) {
          buffer = await mem.targetBlob.arrayBuffer();
        }
        // 2. Memory has a targetUrl (backend or remote)
        else if (mem.targetUrl || mem.backendTargetUrl) {
          const url = mem.targetUrl || mem.backendTargetUrl;
          try {
            const res = await fetch(url);
            if (res.ok) buffer = await res.arrayBuffer();
          } catch (_) {}
        }

        // 3. Fallback: Fetch target from Firestore if not yet cached on this device
        if (!buffer && typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db && userId) {
          try {
            const targetDoc = await db.collection('users').doc(userId).collection('memories').doc(`${mem.id}_target`).get();
            if (targetDoc.exists && targetDoc.data().data) {
              buffer = base64ToArrayBuffer(targetDoc.data().data);
              // Cache to local memory record
              mem.targetBlob = new Blob([buffer], { type: 'application/octet-stream' });
              mem.targetUrl = URL.createObjectURL(mem.targetBlob);
            }
          } catch (_) {}
        }

        if (!buffer) continue;

        if (typeof msgpack !== 'undefined') {
          const decoded = msgpack.decode(new Uint8Array(buffer));
          const dataList = decoded.dataList || [];

          if (dataList.length > 0) {
            const targetIndex = allDataItems.length;
            allDataItems.push(...dataList);
            indexedMemories.push({
              ...mem,
              targetIndex,
              ratio: (mem.photoH / mem.photoW) || 1.0
            });
          }
        } else {
          indexedMemories.push({
            ...mem,
            targetIndex: i,
            ratio: (mem.photoH / mem.photoW) || 1.0
          });
        }
      } catch (e) {
        console.warn(`Could not load target for memory ${mem.id}:`, e);
      }
    }

    if (allDataItems.length > 0 && typeof msgpack !== 'undefined') {
      const combined = { v: 2, dataList: allDataItems };
      const packed = msgpack.encode(combined);
      const blob = new Blob([packed], { type: 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      return { blobUrl, memories: indexedMemories };
    }

    return {
      blobUrl: memories[0] ? (memories[0].targetUrl || (memories[0].targetBlob ? URL.createObjectURL(memories[0].targetBlob) : null)) : null,
      memories: indexedMemories.length ? indexedMemories : memories.map((m, idx) => ({ ...m, targetIndex: idx }))
    };
  }
};

function generateId() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
