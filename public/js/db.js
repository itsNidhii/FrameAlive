/**
 * PicsAlive – Database & Storage Utilities
 *
 * Scoped per user: every memory belongs exclusively to its user UID.
 * Supports Cloud Firestore + Firebase Storage in production,
 * and browser storage for testing before Firebase keys are entered.
 */

const DB = {
  /**
   * Create a new memory for the authenticated user.
   */
  async createMemory(userId, memoryData, photoBlob, videoFile, targetBuffer, onProgress) {
    if (!userId) throw new Error('User authentication required to register a photograph.');
    const memoryId = generateId();

    onProgress && onProgress(10);

    if (isFirebaseConfigured() && storage && db) {
      const basePath = `users/${userId}/memories/${memoryId}`;

      // 1. Upload photo
      const photoRef = storage.ref(`${basePath}/photo.jpg`);
      await photoRef.put(photoBlob, { contentType: 'image/jpeg' });
      const photoUrl = await photoRef.getDownloadURL();
      onProgress && onProgress(35);

      // 2. Upload video
      const videoExt = (videoFile.name || 'video.mp4').split('.').pop().toLowerCase();
      const videoRef = storage.ref(`${basePath}/video.${videoExt}`);
      const uploadTask = videoRef.put(videoFile);

      await new Promise((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => {
            const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 45;
            onProgress && onProgress(35 + Math.round(pct));
          },
          reject,
          resolve
        );
      });
      const videoUrl = await videoRef.getDownloadURL();
      onProgress && onProgress(85);

      // 3. Upload .mind target file
      const targetRef = storage.ref(`${basePath}/target.mind`);
      await targetRef.put(new Blob([targetBuffer]), { contentType: 'application/octet-stream' });
      const targetUrl = await targetRef.getDownloadURL();
      onProgress && onProgress(95);

      // 4. Save metadata to Firestore under user subcollection
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
    } else {
      // Local fallback mode: convert files to object URLs / base64 and store under user's private key
      onProgress && onProgress(40);
      const photoUrl = await blobToDataUrl(photoBlob);
      const videoUrl = URL.createObjectURL(videoFile);
      const targetBlob = new Blob([targetBuffer], { type: 'application/octet-stream' });
      const targetUrl = URL.createObjectURL(targetBlob);
      onProgress && onProgress(80);

      const doc = {
        id: memoryId,
        title: memoryData.title || 'Untitled Memory',
        photoUrl,
        videoUrl,
        targetUrl,
        photoW: memoryData.photoW || 800,
        photoH: memoryData.photoH || 600,
        userId,
        createdAt: new Date().toISOString()
      };

      const userStorageKey = `picsalive_memories_${userId}`;
      const existing = JSON.parse(localStorage.getItem(userStorageKey) || '[]');
      existing.unshift(doc);
      localStorage.setItem(userStorageKey, JSON.stringify(existing));

      onProgress && onProgress(100);
      return doc;
    }
  },

  /**
   * Get all memories strictly belonging to this user.
   */
  async getUserMemories(userId) {
    if (!userId) return [];

    if (isFirebaseConfigured() && db) {
      const snapshot = await db.collection('users').doc(userId)
        .collection('memories')
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    } else {
      const userStorageKey = `picsalive_memories_${userId}`;
      const raw = localStorage.getItem(userStorageKey);
      return raw ? JSON.parse(raw) : [];
    }
  },

  /**
   * Get a single memory by ID for the current user.
   */
  async getMemory(userId, memoryId) {
    if (!userId || !memoryId) return null;

    if (isFirebaseConfigured() && db) {
      const doc = await db.collection('users').doc(userId)
        .collection('memories').doc(memoryId).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } else {
      const memories = await this.getUserMemories(userId);
      return memories.find(m => m.id === memoryId) || null;
    }
  },

  /**
   * Delete a memory owned by the user.
   */
  async deleteMemory(userId, memoryId) {
    if (!userId || !memoryId) return;

    if (isFirebaseConfigured() && db && storage) {
      const basePath = `users/${userId}/memories/${memoryId}`;
      const filesToDelete = ['photo.jpg', 'video.mp4', 'video.mov', 'video.webm', 'target.mind'];
      for (const file of filesToDelete) {
        try {
          await storage.ref(`${basePath}/${file}`).delete();
        } catch (e) {
          // File may not exist
        }
      }
      await db.collection('users').doc(userId)
        .collection('memories').doc(memoryId).delete();
    } else {
      const userStorageKey = `picsalive_memories_${userId}`;
      let memories = await this.getUserMemories(userId);
      memories = memories.filter(m => m.id !== memoryId);
      localStorage.setItem(userStorageKey, JSON.stringify(memories));
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

        // Decode with msgpack if available
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
          // If msgpack not loaded, track single target directly
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

    // Fallback: use first target if combination unavailable
    return {
      blobUrl: memories[0] ? memories[0].targetUrl : null,
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
