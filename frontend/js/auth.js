/**
 * PicsAlive – Authentication Utilities
 *
 * Supports production Firebase Auth (email/password & Google OAuth)
 * and seamless local fallback when Firebase project keys are pending.
 */

const LOCAL_USER_KEY = 'picsalive_user_session';
const LOCAL_USERS_KEY = 'picsalive_registered_users';

const Auth = {
  /**
   * Sign up with email and password.
   */
  async signUp(email, password) {
    email = email.trim().toLowerCase();
    if (!email || !password) throw new Error('Please enter both email and password.');
    if (password.length < 6) throw new Error('Password should be at least 6 characters.');

    if (isFirebaseConfigured() && auth) {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await db.collection('users').doc(cred.user.uid).set({
        email: cred.user.email,
        displayName: cred.user.displayName || email.split('@')[0],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return cred.user;
    } else {
      // Local demo mode storage
      const users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '{}');
      if (users[email]) {
        throw new Error('An account with this email already exists.');
      }
      const uid = 'usr_' + Math.random().toString(36).substring(2, 10);
      const user = {
        uid,
        email,
        displayName: email.split('@')[0],
        createdAt: new Date().toISOString()
      };
      users[email] = { ...user, password }; // In production Firebase handles hashing
      localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
      localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
      window.dispatchEvent(new Event('picsalive:authchange'));
      return user;
    }
  },

  /**
   * Sign in with email and password.
   */
  async signIn(email, password) {
    email = email.trim().toLowerCase();
    if (!email || !password) throw new Error('Please enter both email and password.');

    if (isFirebaseConfigured() && auth) {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      return cred.user;
    } else {
      const users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '{}');
      const userRecord = users[email];
      if (!userRecord || userRecord.password !== password) {
        throw new Error('Invalid email or password. Please try again.');
      }
      const user = {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email.split('@')[0]
      };
      localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
      window.dispatchEvent(new Event('picsalive:authchange'));
      return user;
    }
  },

  /**
   * Sign in with Google popup.
   */
  async signInWithGoogle() {
    if (isFirebaseConfigured() && auth) {
      const provider = new firebase.auth.GoogleAuthProvider();
      const cred = await auth.signInWithPopup(provider);
      await db.collection('users').doc(cred.user.uid).set({
        email: cred.user.email,
        displayName: cred.user.displayName || cred.user.email.split('@')[0],
        photoURL: cred.user.photoURL || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return cred.user;
    } else {
      // Demo Google account sign-in
      const demoEmail = 'user@gmail.com';
      const uid = 'usr_google_demo';
      const user = {
        uid,
        email: demoEmail,
        displayName: 'Google Demo User',
        photoURL: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80'
      };
      localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
      window.dispatchEvent(new Event('picsalive:authchange'));
      return user;
    }
  },

  /**
   * Sign out the current user.
   */
  async signOut() {
    if (isFirebaseConfigured() && auth) {
      await auth.signOut();
    }
    localStorage.removeItem(LOCAL_USER_KEY);
    window.dispatchEvent(new Event('picsalive:authchange'));
  },

  /**
   * Get the currently signed-in user (or null).
   */
  getCurrentUser() {
    if (isFirebaseConfigured() && auth) {
      return auth.currentUser;
    }
    const raw = localStorage.getItem(LOCAL_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },

  /**
   * Returns a promise that resolves with the current user.
   */
  waitForUser() {
    return new Promise((resolve) => {
      if (isFirebaseConfigured() && auth) {
        const unsub = auth.onAuthStateChanged((user) => {
          unsub();
          resolve(user);
        });
      } else {
        resolve(this.getCurrentUser());
      }
    });
  },

  /**
   * Listen for auth state changes.
   */
  onAuthChanged(callback) {
    if (isFirebaseConfigured() && auth) {
      return auth.onAuthStateChanged(callback);
    }
    const handler = () => callback(this.getCurrentUser());
    window.addEventListener('picsalive:authchange', handler);
    return () => window.removeEventListener('picsalive:authchange', handler);
  },

  /**
   * Auth guard for protected pages.
   */
  async requireAuth() {
    const user = await this.waitForUser();
    if (!user) {
      window.location.href = '/signin.html';
      return new Promise(() => {});
    }
    return user;
  },

  /**
   * Redirect guard for auth pages.
   */
  async redirectIfAuthed() {
    const user = await this.waitForUser();
    if (user) {
      window.location.href = '/dashboard.html';
      return new Promise(() => {});
    }
    return null;
  },

  /**
   * User-friendly error message resolution.
   */
  getErrorMessage(error) {
    if (!error) return 'An unknown error occurred.';
    const messages = {
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/user-not-found': 'No account found with this email.',
      'auth/wrong-password': 'Incorrect password. Please try again.',
      'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
      'auth/popup-closed-by-user': 'Sign-in window was closed.',
      'auth/network-request-failed': 'Network error. Please check your connection.',
      'auth/invalid-credential': 'Invalid email or password. Please try again.',
    };
    return messages[error.code] || error.message || 'An unexpected error occurred.';
  }
};
