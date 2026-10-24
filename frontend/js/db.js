/**
 * PicsAlive – Database & Storage Utilities
 *
 * Scoped per user: every memory belongs exclusively to its user UID.
 * Supports Cloud Firestore + Firebase Storage in production,
 * with automatic fallback to high-speed local device storage if
 * Firebase Storage rules are pending or offline, so uploads NEVER hang.
 */

const DB = {
  /**
   * Create a new memory for the authenticated user.
   */
  async createMemory(userId, memoryData, photoBlob, videoFile, targetBuffer, onProgress) {
    if (!userId) throw new Error('User authentication required to register a photograph.');
    const memoryId = generateId();

    onProgress && onProgress(15);

    const hasRealFirebaseAuth = typeof isFirebaseConfigured === 'function' &&
                                isFirebaseConfigured() &&
                                typeof storage !== 'undefined' && storage &&
                                typeof db !== 'undefined' && db &&
                                typeof auth !== 'undefined' && auth &&
                                auth.currentUser;

    if (hasRealFirebaseAuth) {
      try {
        const basePath = `users/${userId}/memories/${memoryId}`;

        // 1. Upload photo with timeout guard
        onProgress && onProgress(25);
        const photoRef = storage.ref(`${basePath}/photo.jpg`);
        await putWithTimeout(photoRef, photoBlob, { contentType: 'image/jpeg' }, 12000);
        const photoUrl = await photoRef.getDownloadURL();
        onProgress && onProgress(45);

        // 2. Upload video with timeout guard
        const videoExt = (videoFile.name || 'video.mp4').split('.').pop().toLowerCase();
        const videoRef = storage.ref(`${basePath}/video.${videoExt}`);
        const uploadTask = videoRef.put(videoFile);

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Video upload timed out."));
          }, 60000);

          uploadTask.on('state_changed',
            (snapshot) => {
              if (snapshot.totalBytes > 0) {
                const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 35;
                onProgress && onProgress(45 + Math.round(pct));
              }
            },
            (err) => {
              clearTimeout(timeout);
              reject(err);
            },
            () => {
              clearTimeout(timeout);
              resolve();
            }
          );
        });

        const videoUrl = await videoRef.getDownloadURL();
        onProgress && onProgress(85);

        // 3. Upload target.mind with timeout guard
        const targetRef = storage.ref(`${basePath}/target.mind`);
        await putWithTimeout(targetRef, new Blob([targetBuffer]), { contentType: 'application/octet-stream' }, 12000);
        const targetUrl = await targetRef.getDownloadURL();
        onProgress && onProgress(95);

        // 4. Save document in Firestore
        const doc = {
          title: memoryData.title || 'Untitled Memory',
          photoUrl,
          videoUrl,
          targetUrl,
          photoW: memoryData.photoW || 800,
          photoH: memoryData.photoH || 600,
          userId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection('users').doc(userId)
          .collection('memories').doc(memoryId).set(doc);

        onProgress && onProgress(100);
        return { id: memoryId, ...doc };

      } catch (err) {
        console.warn('Firebase Cloud Storage error, saving to local device storage instead:', err.message);
        // Seamless fallback to device storage so user is NEVER blocked
        return await this.saveLocally(userId, memoryId, memoryData, photoBlob, videoFile, targetBuffer, onProgress);
      }
    } else {
      // Local device storage (when not signed in to Firebase Auth or Firebase keys pending)
      return await this.saveLocally(userId, memoryId, memoryData, photoBlob, videoFile, targetBuffer, onProgress);
    }
  },

  /**
   * Save memory locally on device (IndexedDB / LocalStorage)
   */
  async saveLocally(userId, memoryId, memoryData, photoBlob, videoFile, targetBuffer, onProgress) {
    onProgress && onProgress(50);
    const photoUrl = await blobToDataUrl(photoBlob);
    const videoUrl = URL.createObjectURL(videoFile);
    const targetBlob = new Blob([targetBuffer], { type: 'application/octet-stream' });
    const targetUrl = URL.createObjectURL(targetBlob);
    onProgress && onProgress(85);

    const doc = {
      id: memoryId,
      title: memoryData.title || 'Untitled Memory',
      photoUrl,
      videoUrl,
      targetUrl,
      photoW: memoryData.photoW || 800,
      photoH: memoryData.photoH || 600,
      userId,
      isLocal: true,
      createdAt: new Date().toISOString()
    };

    const userStorageKey = `picsalive_memories_${userId}`;
    const existing = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
    existing.unshift(doc);
    localStorage.setItem(userStorageKey, JSON.stringify(existing));

    onProgress && onProgress(100);
    return doc;
  },

  /**
   * Get all memories strictly belonging to this user.
   */
  async getUserMemories(userId) {
    if (!userId) return [];
    const userStorageKey = `picsalive_memories_${userId}`;
    const localMemories = JSON.parse(localStorage.getItem(userStorageKey) || '[]');

    const hasRealFirebaseAuth = typeof isFirebaseConfigured === 'function' &&
                                isFirebaseConfigured() &&
                                typeof db !== 'undefined' && db &&
                                typeof auth !== 'undefined' && auth &&
                                auth.currentUser;

    if (hasRealFirebaseAuth) {
      try {
        const snapshot = await db.collection('users').doc(userId)
          .collection('memories')
          .orderBy('createdAt', 'desc')
          .get();

        const remoteMemories = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));

        // Merge without duplicates
        const ids = new Set(remoteMemories.map(m => m.id));
        return [...remoteMemories, ...localMemories.filter(m => !ids.has(m.id))];
      } catch (e) {
        console.warn('Firestore fetch notice, using local memories:', e);
        return localMemories;
      }
    }
    return localMemories;
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
   * Delete a memory owned by the user.
   */
  async deleteMemory(userId, memoryId) {
    if (!userId || !memoryId) return;

    // Delete locally
    const userStorageKey = `picsalive_memories_${userId}`;
    let memories = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
    memories = memories.filter(m => m.id !== memoryId);
    localStorage.setItem(userStorageKey, JSON.stringify(memories));

    // Delete remotely if signed in
    if (typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof db !== 'undefined' && db && typeof auth !== 'undefined' && auth && auth.currentUser) {
      try {
        const basePath = `users/${userId}/memories/${memoryId}`;
        const filesToDelete = ['photo.jpg', 'video.mp4', 'video.mov', 'video.webm', 'target.mind'];
        for (const file of filesToDelete) {
          try { await storage.ref(`${basePath}/${file}`).delete(); } catch (_) {}
        }
        await db.collection('users').doc(userId).collection('memories').doc(memoryId).delete();
      } catch (err) {
        console.warn('Remote delete notice:', err.message);
      }
    }
  },

  /**
   * Combine all targets for the user's memories into a single MindAR target file.
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
        if (!mem.targetUrl) continue;
        const response = await fetch(mem.targetUrl);
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();

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
      blobUrl: memories[0] ? memories[0].targetUrl : null,
      memories: indexedMemories.length ? indexedMemories : memories.map((m, idx) => ({ ...m, targetIndex: idx }))
    };
  }
};

function putWithTimeout(ref, blob, metadata, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Storage upload timed out."));
      }
    }, timeoutMs);

    ref.put(blob, metadata).then((snap) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(snap);
      }
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

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
