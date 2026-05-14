const express = require('express');
const crypto = require('node:crypto');

const {
  createAuthUser,
  findAuthUserByEmail,
  touchAuthLastLogin,
  createPasswordResetToken,
  consumePasswordResetToken,
  updateAuthPassword
} = require('../utils/db');

const router = express.Router();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const sessions = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function readCookie(req, key) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((x) => x.trim()).find((p) => p.startsWith(`${key}=`));
  return match ? decodeURIComponent(match.slice(key.length + 1)) : '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `auth_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'auth_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

router.post('/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim();
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ success: false, error: 'Email and a password with minimum 8 characters are required.' });
    }
    const existing = await findAuthUserByEmail(email);
    if (existing) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });

    const { salt, hash } = hashPassword(password);
    const user = await createAuthUser({ email, fullName, passwordSalt: salt, passwordHash: hash });
    return res.json({ success: true, user: { id: user.id, email: user.email, fullName: user.fullName } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await findAuthUserByEmail(email);
    if (!user || !user.isActive) return res.status(401).json({ success: false, error: 'Invalid credentials.' });

    const { hash } = hashPassword(password, user.passwordSalt);
    if (hash !== user.passwordHash) return res.status(401).json({ success: false, error: 'Invalid credentials.' });

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionToken, { userId: user.id, email: user.email, fullName: user.fullName, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, sessionToken);
    await touchAuthLastLogin(user.id);

    return res.json({ success: true, user: { id: user.id, email: user.email, fullName: user.fullName } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/logout', (req, res) => {
  const token = readCookie(req, 'auth_session');
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  return res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = readCookie(req, 'auth_session');
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  return res.json({ success: true, user: { userId: session.userId, email: session.email, fullName: session.fullName } });
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });
    const user = await findAuthUserByEmail(email);
    if (!user) return res.json({ success: true, message: 'If your account exists, a reset token has been generated.' });
    const token = crypto.randomBytes(24).toString('hex');
    await createPasswordResetToken(user.id, token);
    return res.json({ success: true, message: 'Reset token generated.', resetToken: token, expiresInMinutes: 30 });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!token || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Valid reset token and password (8+ chars) are required.' });
    }
    const tokenRecord = await consumePasswordResetToken(token);
    if (!tokenRecord) return res.status(400).json({ success: false, error: 'Invalid or expired reset token.' });

    const { salt, hash } = hashPassword(newPassword);
    await updateAuthPassword(tokenRecord.userId, salt, hash);
    return res.json({ success: true, message: 'Password reset complete.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
