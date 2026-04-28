import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await loadDotEnv(path.join(__dirname, '.env'));

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.PROCUREMENT_DATA_DIR
  ? path.resolve(process.env.PROCUREMENT_DATA_DIR)
  : path.join(__dirname, 'data');
const UPLOAD_ROOT = path.join(DATA_DIR, 'documents');
const DB_PATH = path.join(DATA_DIR, 'procurement.db');
const EMAIL_OUTBOX_PATH = path.join(DATA_DIR, 'email-outbox.log');
const PORT = Number(process.env.PORT || 3000);
const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@procurement.local',
  appUrl: process.env.APP_URL || `http://localhost:${PORT}`
};

await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOAD_ROOT, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS level1s (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS level2s (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level1_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (level1_id) REFERENCES level1s(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS level3s (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level2_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    instructions TEXT DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (level2_id) REFERENCES level2s(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    requester TEXT NOT NULL,
    requester_user_id INTEGER,
    current_level1_id INTEGER,
    status TEXT NOT NULL DEFAULT 'in_progress',
    archived_at TEXT,
    archived_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (current_level1_id) REFERENCES level1s(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS entry_level_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    level1_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    submitted_at TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    notes TEXT DEFAULT '',
    UNIQUE (entry_id, level1_id),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (level1_id) REFERENCES level1s(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    level1_id INTEGER NOT NULL,
    level2_id INTEGER NOT NULL,
    level3_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT DEFAULT '',
    size INTEGER NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'pending',
    review_notes TEXT DEFAULT '',
    reviewed_at TEXT,
    reviewed_by TEXT,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (level1_id) REFERENCES level1s(id) ON DELETE CASCADE,
    FOREIGN KEY (level2_id) REFERENCES level2s(id) ON DELETE CASCADE,
    FOREIGN KEY (level3_id) REFERENCES level3s(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('requester', 'admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    notification_email TEXT DEFAULT '',
    email_notifications INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

migrateDatabase();
seedWorkflow();
seedUsers();
seedDocumentInstructions();

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    sendJson(res, status, {
      error: status === 500 ? 'Server error' : error.message,
      details: status === 500 ? error.message : undefined
    });
  }
});

server.listen(PORT, () => {
  console.log(`Procurement workflow running at http://localhost:${PORT}`);
});

server.on('close', () => {
  db.close();
});

function migrateDatabase() {
  const entryColumns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
  if (!entryColumns.includes('requester_user_id')) {
    db.prepare('ALTER TABLE entries ADD COLUMN requester_user_id INTEGER').run();
  }
  if (!entryColumns.includes('archived_at')) {
    db.prepare('ALTER TABLE entries ADD COLUMN archived_at TEXT').run();
  }
  if (!entryColumns.includes('archived_by')) {
    db.prepare('ALTER TABLE entries ADD COLUMN archived_by TEXT').run();
  }

  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!userColumns.includes('is_active')) {
    db.prepare('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!userColumns.includes('notification_email')) {
    db.prepare("ALTER TABLE users ADD COLUMN notification_email TEXT DEFAULT ''").run();
  }
  if (!userColumns.includes('email_notifications')) {
    db.prepare('ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!userColumns.includes('last_login_at')) {
    db.prepare('ALTER TABLE users ADD COLUMN last_login_at TEXT').run();
  }
  db.prepare("UPDATE users SET notification_email = email WHERE COALESCE(notification_email, '') = ''").run();

  const documentColumns = db.prepare('PRAGMA table_info(documents)').all().map((column) => column.name);
  if (!documentColumns.includes('review_status')) {
    db.prepare("ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'").run();
  }
  if (!documentColumns.includes('review_notes')) {
    db.prepare("ALTER TABLE documents ADD COLUMN review_notes TEXT DEFAULT ''").run();
  }
  if (!documentColumns.includes('reviewed_at')) {
    db.prepare('ALTER TABLE documents ADD COLUMN reviewed_at TEXT').run();
  }
  if (!documentColumns.includes('reviewed_by')) {
    db.prepare('ALTER TABLE documents ADD COLUMN reviewed_by TEXT').run();
  }

  db.prepare(`
    UPDATE documents
    SET review_status = COALESCE((
      SELECT CASE
        WHEN entry_level_statuses.status = 'approved' THEN 'approved'
        WHEN entry_level_statuses.status = 'rejected' THEN 'rejected'
        ELSE documents.review_status
      END
      FROM entry_level_statuses
      WHERE entry_level_statuses.entry_id = documents.entry_id
        AND entry_level_statuses.level1_id = documents.level1_id
    ), review_status)
    WHERE review_status = 'pending'
  `).run();

  db.prepare(`
    UPDATE documents
    SET review_notes = 'Rejected by admin.'
    WHERE review_status = 'rejected'
      AND COALESCE(review_notes, '') = ''
  `).run();

  db.prepare(`
    UPDATE entries
    SET status = 'in_progress'
    WHERE status = 'rejected'
      AND current_level1_id IS NOT NULL
  `).run();
}

function seedWorkflow() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM level1s').get().count;
  if (count > 0) return;

  const l1 = db.prepare('INSERT INTO level1s (name, description, position) VALUES (?, ?, ?)');
  const l2 = db.prepare('INSERT INTO level2s (level1_id, name, description, position) VALUES (?, ?, ?, ?)');
  const l3 = db.prepare('INSERT INTO level3s (level2_id, name, instructions, position) VALUES (?, ?, ?, ?)');

  const planning = Number(l1.run('Planning', 'Initial procurement requirement package.', 1).lastInsertRowid);
  const requirements = Number(l2.run(planning, 'Requirement Definition', '', 1).lastInsertRowid);
  l3.run(requirements, 'Terms of Reference', 'Upload the approved TOR document.', 1);
  l3.run(requirements, 'Budget Estimate', 'Upload the supporting cost estimate.', 2);

  const sourcing = Number(l1.run('Sourcing', 'Vendor search and procurement method package.', 2).lastInsertRowid);
  const vendor = Number(l2.run(sourcing, 'Vendor Shortlist', '', 1).lastInsertRowid);
  l3.run(vendor, 'Vendor Comparison', 'Upload the comparison matrix.', 1);
}

function seedUsers() {
  const users = [
    {
      name: 'Procurement Admin',
      email: 'admin@procurement.local',
      role: 'admin',
      password: 'admin123'
    },
    {
      name: 'Requester User',
      email: 'requester@procurement.local',
      role: 'requester',
      password: 'requester123'
    }
  ];

  const insert = db.prepare(`
    INSERT INTO users (name, email, role, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const user of users) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(user.email);
    if (existing) continue;
    const password = hashPassword(user.password);
    insert.run(user.name, user.email, user.role, password.hash, password.salt);
  }
}

function seedDocumentInstructions() {
  const descriptions = new Map([
    ['rencana', 'Upload the approved procurement plan or internal planning document for this package.'],
    ['feasibility study', 'Upload the feasibility study or business justification that supports the procurement need.'],
    ['rkap/rjpp', 'Upload the budget reference or planning allocation document.'],
    ['purchase request document', 'Upload the signed purchase request document.'],
    ['sk tim', 'Upload the official procurement team appointment letter.'],
    ['tor/kak', 'Upload the terms of reference or KAK that defines scope, deliverables, and requirements.'],
    ['nota metode pengadaan', 'Upload the procurement method memo or approval note.'],
    ['draft kontrak', 'Upload the contract draft prepared for this procurement package.'],
    ['dokumen oe/hps', 'Upload the owner estimate or HPS document and its supporting calculation.'],
    ['dokumen rfp', 'Upload the request for proposal document issued to vendors.'],
    ['undangan tender', 'Upload the tender invitation or sourcing notice sent to vendors.'],
    ['proposal vendor', 'Upload the vendor proposal received for this procurement.'],
    ['berita acara pembukaan penawaran', 'Upload the minutes of bid opening or proposal opening.'],
    ['berita acara evaluasi administrasi', 'Upload the administrative evaluation minutes or checklist.'],
    ['berita acara evaluasi teknis', 'Upload the technical evaluation minutes and scoring result.'],
    ['berita acara klarifikasi coq', 'Upload the clarification record for commercial or cost of quality items.'],
    ['berita acara evaluasi harga', 'Upload the price evaluation minutes and comparison result.'],
    ['dokumen nota persetujuan', 'Upload the approval note for the tender result.'],
    ['sppbj', 'Upload the supplier appointment letter.'],
    ['letter of award (loa)', 'Upload the letter of award issued to the selected vendor.'],
    ['letter of intent (loi)', 'Upload the letter of intent issued before contract signing.'],
    ['dokumen tertandatangan', 'Upload the fully signed contract document.'],
    ['dokumen purchase order (po)', 'Upload the issued purchase order document.'],
    ['laporan pre-delivery inspection', 'Upload the pre-delivery inspection report.'],
    ['laporan inspection', 'Upload the inspection report.'],
    ['berita acara final acceptance', 'Upload the final acceptance minutes.'],
    ['berita acara serah terima (bast)', 'Upload the handover minutes or BAST document.']
  ]);

  const update = db.prepare('UPDATE level3s SET instructions = ? WHERE id = ? AND COALESCE(instructions, ?) = ?');
  for (const document of db.prepare('SELECT id, name FROM level3s').all()) {
    const description = descriptions.get(String(document.name).toLowerCase().trim());
    if (description) update.run(description, document.id, '', '');
  }
}

function getUsers() {
  return db.prepare(`
    SELECT
      users.id,
      users.name,
      users.email,
      users.role,
      users.is_active,
      users.notification_email,
      users.email_notifications,
      users.last_login_at,
      users.created_at,
      COUNT(entries.id) AS entry_count
    FROM users
    LEFT JOIN entries ON entries.requester_user_id = users.id
    GROUP BY users.id
    ORDER BY users.created_at DESC, users.id DESC
  `).all().map(formatUserRow);
}

function createUser(body) {
  requireText(body.name, 'Name is required');
  requireText(body.email, 'Email is required');
  requireText(body.password, 'Password is required');
  const role = normalizeRole(body.role);
  const email = normalizeEmail(body.email);
  if (String(body.password).length < 6) throw httpError(400, 'Password must be at least 6 characters');

  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
  if (existing) throw httpError(400, 'Email is already registered');

  const password = hashPassword(body.password);
  const notificationEmail = body.notificationEmail ? normalizeEmail(body.notificationEmail) : email;
  const result = db.prepare(`
    INSERT INTO users (name, email, role, is_active, notification_email, email_notifications, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(body.name).trim(), email, role, body.isActive === false ? 0 : 1, notificationEmail, body.emailNotifications === false ? 0 : 1, password.hash, password.salt);

  return formatUserRow(db.prepare('SELECT id, name, email, role, is_active, notification_email, email_notifications, last_login_at, created_at, 0 AS entry_count FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
}

function updateUser(userId, body, currentUser) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) throw httpError(404, 'User not found');

  const name = body.name !== undefined ? String(body.name).trim() : target.name;
  const email = body.email !== undefined ? normalizeEmail(body.email) : target.email;
  const role = body.role !== undefined ? normalizeRole(body.role) : target.role;
  const isActive = body.isActive !== undefined ? (body.isActive ? 1 : 0) : target.is_active;
  const notificationEmail = body.notificationEmail !== undefined
    ? (String(body.notificationEmail || '').trim() ? normalizeEmail(body.notificationEmail) : email)
    : (target.notification_email || email);
  const emailNotifications = body.emailNotifications !== undefined ? (body.emailNotifications ? 1 : 0) : target.email_notifications;
  if (!name) throw httpError(400, 'Name is required');

  const emailOwner = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, userId);
  if (emailOwner) throw httpError(400, 'Email is already registered');

  const finalRole = userId === currentUser.id ? target.role : role;
  const finalActive = userId === currentUser.id ? target.is_active : isActive;

  if (body.password) {
    if (String(body.password).length < 6) throw httpError(400, 'Password must be at least 6 characters');
    const password = hashPassword(body.password);
    db.prepare(`
      UPDATE users
      SET name = ?, email = ?, role = ?, is_active = ?, notification_email = ?, email_notifications = ?, password_hash = ?, password_salt = ?
      WHERE id = ?
    `).run(name, email, finalRole, finalActive, notificationEmail, emailNotifications, password.hash, password.salt, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(userId, currentUser.id);
  } else {
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, is_active = ?, notification_email = ?, email_notifications = ? WHERE id = ?').run(name, email, finalRole, finalActive, notificationEmail, emailNotifications, userId);
  }

  if (!finalActive) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  return formatUserRow(db.prepare(`
    SELECT users.id, users.name, users.email, users.role, users.is_active, users.notification_email, users.email_notifications, users.last_login_at, users.created_at, COUNT(entries.id) AS entry_count
    FROM users
    LEFT JOIN entries ON entries.requester_user_id = users.id
    WHERE users.id = ?
    GROUP BY users.id
  `).get(userId));
}

function formatUserRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active),
    notificationEmail: row.notification_email || row.email,
    emailNotifications: Boolean(row.email_notifications),
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    entryCount: row.entry_count || 0
  };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Valid email is required');
  return email;
}

function normalizeRole(value) {
  const role = value === 'admin' ? 'admin' : 'requester';
  return role;
}

function login(body) {
  requireText(body.email, 'Email is required');
  requireText(body.password, 'Password is required');

  const email = String(body.email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!user || !verifyPassword(body.password, user)) {
    throw httpError(401, 'Invalid email or password');
  }
  if (!user.is_active) {
    throw httpError(403, 'This account is disabled');
  }
  if (body.role && user.role !== body.role) {
    throw httpError(403, `This account is not a ${body.role}`);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    user.id,
    expiresAt.toISOString()
  );
  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  return { user, token, expiresAt };
}

function logout(req) {
  const token = parseCookies(req.headers.cookie || '').procurement_session;
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function getAuthUser(req) {
  const token = parseCookies(req.headers.cookie || '').procurement_session;
  if (!token) return null;

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  const row = db.prepare(`
    SELECT users.id, users.name, users.email, users.role, users.is_active, users.notification_email, users.email_notifications, users.last_login_at, sessions.expires_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashToken(token));

  if (!row) return null;
  if (!row.is_active) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return row;
}

function requireUser(user, role = null) {
  if (!user) throw httpError(401, 'Please log in first');
  if (role && user.role !== role) throw httpError(403, 'You do not have permission for this action');
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    notificationEmail: user.notification_email || user.email,
    emailNotifications: Boolean(user.email_notifications),
    lastLoginAt: user.last_login_at || null
  };
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: scryptSync(String(password), salt, 64).toString('hex')
  };
}

function verifyPassword(password, user) {
  const expected = Buffer.from(user.password_hash, 'hex');
  const actual = Buffer.from(hashPassword(password, user.password_salt).hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(';').reduce((cookies, part) => {
    const [name, ...rest] = part.trim().split('=');
    if (!name) return cookies;
    cookies[name] = decodeURIComponent(rest.join('='));
    return cookies;
  }, {});
}

function sessionCookie(token, expiresAt) {
  return [
    `procurement_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`
  ].join('; ');
}

function clearSessionCookie() {
  return 'procurement_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const user = getAuthUser(req);

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseJson(req);
    const loggedIn = login(body);
    sendJson(res, 200, { user: publicUser(loggedIn.user) }, {
      'Set-Cookie': sessionCookie(loggedIn.token, loggedIn.expiresAt)
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    logout(req);
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': clearSessionCookie()
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    requireUser(user, 'admin');
    sendJson(res, 200, { users: getUsers() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/users') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    const created = createUser(body);
    sendJson(res, 201, { user: created });
    return;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (adminUserMatch && req.method === 'PUT') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    const updated = updateUser(Number(adminUserMatch[1]), body, user);
    sendJson(res, 200, { user: updated });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/workflow') {
    requireUser(user);
    sendJson(res, 200, { levels: getWorkflow() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/workflow/level1') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 1 name is required');
    const position = nextPosition('level1s');
    const result = db.prepare('INSERT INTO level1s (name, description, position) VALUES (?, ?, ?)').run(body.name.trim(), cleanText(body.description), position);
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    return;
  }

  const level1Match = pathname.match(/^\/api\/admin\/workflow\/level1\/(\d+)$/);
  if (level1Match && req.method === 'PUT') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 1 name is required');
    db.prepare('UPDATE level1s SET name = ?, description = ? WHERE id = ?').run(body.name.trim(), cleanText(body.description), Number(level1Match[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (level1Match && req.method === 'DELETE') {
    requireUser(user, 'admin');
    db.prepare('DELETE FROM level1s WHERE id = ?').run(Number(level1Match[1]));
    normalizePositions('level1s');
    sendJson(res, 200, { ok: true });
    return;
  }

  const level1MoveMatch = pathname.match(/^\/api\/admin\/workflow\/level1\/(\d+)\/move$/);
  if (level1MoveMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    moveItem('level1s', Number(level1MoveMatch[1]), body.direction);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/workflow/level2') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 2 name is required');
    const level1Id = Number(body.level1Id);
    assertExists('level1s', level1Id, 'Level 1 not found');
    const position = nextPosition('level2s', 'level1_id', level1Id);
    const result = db.prepare('INSERT INTO level2s (level1_id, name, description, position) VALUES (?, ?, ?, ?)').run(level1Id, body.name.trim(), cleanText(body.description), position);
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    return;
  }

  const level2Match = pathname.match(/^\/api\/admin\/workflow\/level2\/(\d+)$/);
  if (level2Match && req.method === 'PUT') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 2 name is required');
    db.prepare('UPDATE level2s SET name = ?, description = ? WHERE id = ?').run(body.name.trim(), cleanText(body.description), Number(level2Match[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (level2Match && req.method === 'DELETE') {
    requireUser(user, 'admin');
    const id = Number(level2Match[1]);
    const row = db.prepare('SELECT level1_id FROM level2s WHERE id = ?').get(id);
    db.prepare('DELETE FROM level2s WHERE id = ?').run(id);
    if (row) normalizePositions('level2s', 'level1_id', row.level1_id);
    sendJson(res, 200, { ok: true });
    return;
  }

  const level2MoveMatch = pathname.match(/^\/api\/admin\/workflow\/level2\/(\d+)\/move$/);
  if (level2MoveMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    moveItem('level2s', Number(level2MoveMatch[1]), body.direction, 'level1_id');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/workflow/level3') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 3 document name is required');
    const level2Id = Number(body.level2Id);
    assertExists('level2s', level2Id, 'Level 2 not found');
    const position = nextPosition('level3s', 'level2_id', level2Id);
    const result = db.prepare('INSERT INTO level3s (level2_id, name, instructions, position) VALUES (?, ?, ?, ?)').run(level2Id, body.name.trim(), cleanText(body.instructions), position);
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    return;
  }

  const level3Match = pathname.match(/^\/api\/admin\/workflow\/level3\/(\d+)$/);
  if (level3Match && req.method === 'PUT') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    requireText(body.name, 'Level 3 document name is required');
    db.prepare('UPDATE level3s SET name = ?, instructions = ? WHERE id = ?').run(body.name.trim(), cleanText(body.instructions), Number(level3Match[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (level3Match && req.method === 'DELETE') {
    requireUser(user, 'admin');
    const id = Number(level3Match[1]);
    const row = db.prepare('SELECT level2_id FROM level3s WHERE id = ?').get(id);
    db.prepare('DELETE FROM level3s WHERE id = ?').run(id);
    if (row) normalizePositions('level3s', 'level2_id', row.level2_id);
    sendJson(res, 200, { ok: true });
    return;
  }

  const level3MoveMatch = pathname.match(/^\/api\/admin\/workflow\/level3\/(\d+)\/move$/);
  if (level3MoveMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    moveItem('level3s', Number(level3MoveMatch[1]), body.direction, 'level2_id');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/entries') {
    requireUser(user);
    sendJson(res, 200, { entries: getEntries(user, { archived: url.searchParams.get('archived') }) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/entries') {
    requireUser(user, 'requester');
    const body = await parseJson(req);
    requireText(body.title, 'Procurement title is required');
    const firstLevel = db.prepare('SELECT id FROM level1s ORDER BY position, id LIMIT 1').get();
    if (!firstLevel) throw httpError(400, 'Admin must create at least one Level 1 before users can start');

    const result = db.prepare('INSERT INTO entries (title, requester, requester_user_id, current_level1_id, status) VALUES (?, ?, ?, ?, ?)').run(body.title.trim(), user.name, user.id, firstLevel.id, 'in_progress');
    sendJson(res, 201, { id: Number(result.lastInsertRowid) });
    return;
  }

  const entryMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch && req.method === 'GET') {
    requireUser(user);
    const entry = getEntry(Number(entryMatch[1]), user);
    sendJson(res, 200, { entry });
    return;
  }

  const entryZipMatch = pathname.match(/^\/api\/entries\/(\d+)\/documents\.zip$/);
  if (entryZipMatch && req.method === 'GET') {
    requireUser(user);
    await downloadEntryDocumentsZip(res, Number(entryZipMatch[1]), user);
    return;
  }

  const submitMatch = pathname.match(/^\/api\/entries\/(\d+)\/submit-level$/);
  if (submitMatch && req.method === 'POST') {
    requireUser(user, 'requester');
    const result = await submitCurrentLevel(req, Number(submitMatch[1]), user);
    notifyAdminsLevelSubmitted(result).catch((error) => console.error('Admin notification failed:', error.message));
    sendJson(res, 200, { ok: true });
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/admin\/entries\/(\d+)\/(approve|reject)$/);
  if (approvalMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    reviewEntry(Number(approvalMatch[1]), approvalMatch[2], user.name, cleanText(body.notes));
    sendJson(res, 200, { ok: true });
    return;
  }

  const documentReviewMatch = pathname.match(/^\/api\/admin\/entries\/(\d+)\/document-reviews$/);
  if (documentReviewMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    const result = reviewEntryDocuments(Number(documentReviewMatch[1]), body, user.name);
    notifyRequesterReviewResult(result).catch((error) => console.error('Requester notification failed:', error.message));
    sendJson(res, 200, { ok: true });
    return;
  }

  const archiveEntryMatch = pathname.match(/^\/api\/admin\/entries\/(\d+)\/archive$/);
  if (archiveEntryMatch && req.method === 'POST') {
    requireUser(user, 'admin');
    const entry = archiveEntry(Number(archiveEntryMatch[1]), user.name);
    sendJson(res, 200, { entry });
    return;
  }

  if (archiveEntryMatch && req.method === 'DELETE') {
    requireUser(user, 'admin');
    const entry = unarchiveEntry(Number(archiveEntryMatch[1]));
    sendJson(res, 200, { entry });
    return;
  }

  const adminEntryMatch = pathname.match(/^\/api\/admin\/entries\/(\d+)$/);
  if (adminEntryMatch && req.method === 'DELETE') {
    requireUser(user, 'admin');
    const body = await parseJson(req);
    await permanentlyDeleteEntry(Number(adminEntryMatch[1]), body.confirm);
    sendJson(res, 200, { ok: true });
    return;
  }

  const documentMatch = pathname.match(/^\/api\/documents\/(\d+)\/download$/);
  if (documentMatch && req.method === 'GET') {
    requireUser(user);
    await downloadDocument(res, Number(documentMatch[1]), user);
    return;
  }

  throw httpError(404, 'Route not found');
}

function getWorkflow() {
  const level1s = db.prepare('SELECT * FROM level1s ORDER BY position, id').all();
  const level2s = db.prepare('SELECT * FROM level2s ORDER BY position, id').all();
  const level3s = db.prepare('SELECT * FROM level3s ORDER BY position, id').all();

  return level1s.map((level1) => ({
    ...level1,
    level2s: level2s
      .filter((level2) => level2.level1_id === level1.id)
      .map((level2) => ({
        ...level2,
        level3s: level3s.filter((level3) => level3.level2_id === level2.id)
      }))
  }));
}

function getEntries(user, options = {}) {
  const filters = [];
  const params = [];
  if (user.role !== 'admin') {
    filters.push('e.requester_user_id = ?');
    params.push(user.id);
    filters.push('e.archived_at IS NULL');
  } else if (options.archived === 'archived') {
    filters.push('e.archived_at IS NOT NULL');
  } else if (options.archived !== 'all') {
    filters.push('e.archived_at IS NULL');
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      e.*,
      l1.name AS current_level1_name,
      els.status AS current_level_status,
      els.submitted_at,
      els.reviewed_at,
      els.reviewed_by,
      els.notes
    FROM entries e
    LEFT JOIN level1s l1 ON l1.id = e.current_level1_id
    LEFT JOIN entry_level_statuses els ON els.entry_id = e.id AND els.level1_id = e.current_level1_id
    ${where}
    ORDER BY e.updated_at DESC, e.id DESC
  `).all(...params);

  return rows.map((row) => ({
    ...row,
    isArchived: Boolean(row.archived_at),
    archivedAt: row.archived_at || null,
    archivedBy: row.archived_by || null,
    statusLabel: statusLabel(row.status)
  }));
}

function getEntry(entryId, user) {
  const entry = db.prepare(`
    SELECT e.*, l1.name AS current_level1_name
    FROM entries e
    LEFT JOIN level1s l1 ON l1.id = e.current_level1_id
    WHERE e.id = ?
  `).get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  assertCanAccessEntry(entry, user);

  const statuses = db.prepare('SELECT * FROM entry_level_statuses WHERE entry_id = ?').all(entryId);
  const documents = db.prepare(`
    SELECT
      d.*,
      l1.name AS level1_name,
      l1.position AS level1_position,
      l2.name AS level2_name,
      l2.position AS level2_position,
      l3.name AS level3_name,
      l3.position AS level3_position
    FROM documents d
    JOIN level1s l1 ON l1.id = d.level1_id
    JOIN level2s l2 ON l2.id = d.level2_id
    JOIN level3s l3 ON l3.id = d.level3_id
    WHERE d.entry_id = ?
    ORDER BY l1.position, l2.position, l3.position, d.uploaded_at DESC
  `).all(entryId);

  return {
    ...entry,
    isArchived: Boolean(entry.archived_at),
    archivedAt: entry.archived_at || null,
    archivedBy: entry.archived_by || null,
    statusLabel: statusLabel(entry.status),
    levels: getWorkflow().map((level1) => ({
      ...level1,
      entryStatus: statuses.find((status) => status.level1_id === level1.id) || null
    })),
    documents
  };
}

function archiveEntry(entryId, adminName) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  db.prepare(`
    UPDATE entries
    SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP),
        archived_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(adminName, entryId);
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
}

function unarchiveEntry(entryId) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  db.prepare(`
    UPDATE entries
    SET archived_at = NULL,
        archived_by = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(entryId);
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
}

async function permanentlyDeleteEntry(entryId, confirmation) {
  if (String(confirmation || '').trim().toLowerCase() !== 'yes') {
    throw httpError(400, 'Type yes to permanently delete this entry');
  }
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  const documents = db.prepare('SELECT file_path FROM documents WHERE entry_id = ?').all(entryId);

  withTransaction(() => {
    db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
  });

  for (const document of documents) {
    const absolutePath = path.resolve(DATA_DIR, document.file_path);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_ROOT))) continue;
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Failed to delete document file ${absolutePath}:`, error.message);
    }
  }
}

async function submitCurrentLevel(req, entryId, user) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  assertCanAccessEntry(entry, user);
  if (!entry.current_level1_id) throw httpError(400, 'This entry is already complete');
  if (entry.status === 'awaiting_approval') throw httpError(400, 'This level is already waiting for admin approval');

  const level = getWorkflow().find((item) => item.id === entry.current_level1_id);
  if (!level) throw httpError(400, 'Current Level 1 no longer exists');

  const requiredDocs = level.level2s.flatMap((level2) => level2.level3s.map((level3) => ({ level1: level, level2, level3 })));
  if (requiredDocs.length === 0) {
    throw httpError(400, 'Admin must add at least one Level 3 document to this Level 1 before it can be submitted');
  }

  const existingDocuments = new Map();
  for (const document of db.prepare(`
    SELECT *
    FROM documents
    WHERE entry_id = ? AND level1_id = ?
    ORDER BY id DESC
  `).all(entryId, level.id)) {
    if (!existingDocuments.has(document.level3_id)) existingDocuments.set(document.level3_id, document);
  }

  const formData = await parseFormData(req);
  const files = new Map();

  for (const required of requiredDocs) {
    const value = formData.get(`doc_${required.level3.id}`);
    const existing = existingDocuments.get(required.level3.id);
    if (!isUploadedFile(value) && existing?.review_status === 'approved') {
      continue;
    }
    if (!isUploadedFile(value)) {
      throw httpError(400, `Missing required document: ${required.level3.name}`);
    }
    files.set(required.level3.id, value);
  }

  const storedFiles = [];
  for (const required of requiredDocs) {
    const file = files.get(required.level3.id);
    if (!file) continue;
    const stored = await storeFile(file, entryId, required.level1, required.level2, required.level3);
    storedFiles.push({ required, file, stored });
  }

  withTransaction(() => {
    db.prepare(`
      INSERT INTO entry_level_statuses (entry_id, level1_id, status, submitted_at, reviewed_at, reviewed_by, notes)
      VALUES (?, ?, 'pending', CURRENT_TIMESTAMP, NULL, NULL, '')
      ON CONFLICT(entry_id, level1_id) DO UPDATE SET
        status = 'pending',
        submitted_at = CURRENT_TIMESTAMP,
        reviewed_at = NULL,
        reviewed_by = NULL,
        notes = ''
    `).run(entryId, level.id);

    db.prepare(`
      UPDATE entry_level_statuses
      SET status = 'pending',
        reviewed_at = NULL,
        reviewed_by = NULL,
        notes = ''
      WHERE entry_id = ?
        AND level1_id IN (
          SELECT id FROM level1s
          WHERE position > (SELECT position FROM level1s WHERE id = ?)
        )
        AND status = 'rejected'
    `).run(entryId, level.id);

    db.prepare('UPDATE entries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('awaiting_approval', entryId);

    for (const { required, file, stored } of storedFiles) {
      db.prepare('DELETE FROM documents WHERE entry_id = ? AND level1_id = ? AND level3_id = ?').run(entryId, level.id, required.level3.id);
      db.prepare(`
        INSERT INTO documents (entry_id, level1_id, level2_id, level3_id, original_name, stored_name, file_path, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entryId,
        required.level1.id,
        required.level2.id,
        required.level3.id,
        file.name,
        stored.fileName,
        stored.relativePath,
        file.type || '',
        file.size
      );
    }
  });

  return getNotificationContext(entryId, level.id);
}

function reviewEntryDocuments(entryId, body, reviewedBy) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');

  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  if (decisions.length === 0) throw httpError(400, 'No document review decisions provided');

  let result;
  withTransaction(() => {
    const update = db.prepare(`
      UPDATE documents
      SET review_status = ?, review_notes = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
      WHERE id = ? AND entry_id = ?
    `);

    for (const decision of decisions) {
      const documentId = Number(decision.documentId);
      const status = normalizeReviewStatus(decision.status);
      const notes = cleanText(decision.notes);
      const result = update.run(status, notes, reviewedBy, documentId, entryId);
      if (result.changes === 0) throw httpError(404, 'Document not found for this entry');
    }

    const rejectedDecisionIds = decisions
      .filter((decision) => decision.status === 'rejected')
      .map((decision) => Number(decision.documentId))
      .filter(Boolean);
    const rejectedDecisionDocuments = rejectedDecisionIds.length
      ? db.prepare(`
        SELECT d.*, l1.name AS level1_name, l2.name AS level2_name, l3.name AS level3_name
        FROM documents d
        JOIN level1s l1 ON l1.id = d.level1_id
        JOIN level2s l2 ON l2.id = d.level2_id
        JOIN level3s l3 ON l3.id = d.level3_id
        WHERE d.entry_id = ? AND d.id IN (${rejectedDecisionIds.map(() => '?').join(', ')})
        ORDER BY l1.position, l2.position, l3.position
      `).all(entryId, ...rejectedDecisionIds)
      : [];

    result = reconcileEntryReviewState(entryId, reviewedBy);
    if (result?.event === 'rejected' && result.rejectedDocuments.length === 0) {
      result.rejectedDocuments = rejectedDecisionDocuments;
    }
  });
  return result || getNotificationContext(entryId);
}

function reconcileEntryReviewState(entryId, reviewedBy) {
  const workflow = getWorkflow();
  const statuses = db.prepare('SELECT * FROM entry_level_statuses WHERE entry_id = ?').all(entryId);
  const documents = db.prepare('SELECT * FROM documents WHERE entry_id = ?').all(entryId);
  const levelStatus = new Map(statuses.map((status) => [status.level1_id, status]));

  const rejectedLevel = workflow.find((level) =>
    documents.some((document) => document.level1_id === level.id && document.review_status === 'rejected')
  );

  if (rejectedLevel) {
    const entry = db.prepare('SELECT current_level1_id FROM entries WHERE id = ?').get(entryId);
    const currentLevel = workflow.find((level) => level.id === entry?.current_level1_id) || null;
    if (currentLevel && currentLevel.position > rejectedLevel.position) {
      const rollbackLevelIds = workflow
        .filter((level) => level.position > rejectedLevel.position && level.position <= currentLevel.position)
        .map((level) => level.id);

      if (rollbackLevelIds.length > 0) {
        const placeholders = rollbackLevelIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM documents WHERE entry_id = ? AND level1_id IN (${placeholders})`).run(entryId, ...rollbackLevelIds);
        db.prepare(`DELETE FROM entry_level_statuses WHERE entry_id = ? AND level1_id IN (${placeholders})`).run(entryId, ...rollbackLevelIds);
      }
    }
    db.prepare('DELETE FROM entry_level_statuses WHERE entry_id = ? AND level1_id = ?').run(entryId, rejectedLevel.id);

    db.prepare('UPDATE entries SET current_level1_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(rejectedLevel.id, 'in_progress', entryId);
    return getNotificationContext(entryId, rejectedLevel.id, 'rejected');
  }

  const upsertStatus = db.prepare(`
    INSERT INTO entry_level_statuses (entry_id, level1_id, status, submitted_at, reviewed_at, reviewed_by, notes)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, '')
    ON CONFLICT(entry_id, level1_id) DO UPDATE SET
      status = excluded.status,
      reviewed_at = CASE WHEN excluded.status = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END,
      reviewed_by = CASE WHEN excluded.status = 'approved' THEN excluded.reviewed_by ELSE NULL END,
      notes = ''
  `);

  for (const level of workflow) {
    if (!levelStatus.has(level.id)) continue;
    const requiredCount = level.level2s.reduce((sum, level2) => sum + level2.level3s.length, 0);
    const levelDocuments = documents.filter((document) => document.level1_id === level.id);
    const approved = requiredCount > 0
      && levelDocuments.length >= requiredCount
      && levelDocuments.every((document) => document.review_status === 'approved');
    upsertStatus.run(entryId, level.id, approved ? 'approved' : 'pending', approved ? 'approved' : 'pending', approved ? reviewedBy : null);
  }

  const refreshedStatuses = db.prepare('SELECT * FROM entry_level_statuses WHERE entry_id = ?').all(entryId);
  const approvedLevelIds = new Set(refreshedStatuses.filter((status) => status.status === 'approved').map((status) => status.level1_id));
  const nextLevel = workflow.find((level) => !approvedLevelIds.has(level.id));
  if (!nextLevel) {
    db.prepare('UPDATE entries SET current_level1_id = NULL, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('complete', entryId);
    const lastApproved = workflow.at(-1);
    return getNotificationContext(entryId, lastApproved?.id || null, 'approved');
  }

  const nextStatus = refreshedStatuses.find((status) => status.level1_id === nextLevel.id);
  const entryStatus = nextStatus?.status === 'pending' ? 'awaiting_approval' : 'in_progress';
  db.prepare('UPDATE entries SET current_level1_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextLevel.id, entryStatus, entryId);
  const previousApproved = [...workflow].reverse().find((level) => approvedLevelIds.has(level.id));
  return getNotificationContext(entryId, previousApproved?.id || nextLevel.id, 'approved');
}

function reviewEntry(entryId, action, reviewedBy, notes) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  if (entry.status !== 'awaiting_approval' || !entry.current_level1_id) {
    throw httpError(400, 'Only entries waiting for approval can be reviewed');
  }

  const levelId = entry.current_level1_id;
  const pending = db.prepare('SELECT * FROM entry_level_statuses WHERE entry_id = ? AND level1_id = ? AND status = ?').get(entryId, levelId, 'pending');
  if (!pending) throw httpError(400, 'Current level has not been submitted');

  if (action === 'reject') {
    db.prepare(`
      UPDATE entry_level_statuses
      SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, notes = ?
      WHERE entry_id = ? AND level1_id = ?
    `).run(reviewedBy, notes, entryId, levelId);
    db.prepare('UPDATE entries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('in_progress', entryId);
    return;
  }

  const next = db.prepare(`
    SELECT id FROM level1s
    WHERE position > (SELECT position FROM level1s WHERE id = ?)
    ORDER BY position, id
    LIMIT 1
  `).get(levelId);

  db.prepare(`
    UPDATE entry_level_statuses
    SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, notes = ?
    WHERE entry_id = ? AND level1_id = ?
  `).run(reviewedBy, notes, entryId, levelId);

  if (next) {
    db.prepare('UPDATE entries SET current_level1_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next.id, 'in_progress', entryId);
  } else {
    db.prepare('UPDATE entries SET current_level1_id = NULL, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('complete', entryId);
  }
}

function getNotificationContext(entryId, level1Id = null, event = 'submitted') {
  const entry = db.prepare(`
    SELECT e.*, u.email, u.notification_email, u.email_notifications, u.name AS requester_name
    FROM entries e
    LEFT JOIN users u ON u.id = e.requester_user_id
    WHERE e.id = ?
  `).get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');

  const level = level1Id
    ? db.prepare('SELECT * FROM level1s WHERE id = ?').get(level1Id)
    : null;
  const rejectedDocuments = db.prepare(`
    SELECT d.*, l1.name AS level1_name, l2.name AS level2_name, l3.name AS level3_name
    FROM documents d
    JOIN level1s l1 ON l1.id = d.level1_id
    JOIN level2s l2 ON l2.id = d.level2_id
    JOIN level3s l3 ON l3.id = d.level3_id
    WHERE d.entry_id = ?
      AND d.review_status = 'rejected'
      ${level1Id ? 'AND d.level1_id = ?' : ''}
    ORDER BY l1.position, l2.position, l3.position
  `).all(...(level1Id ? [entryId, level1Id] : [entryId]));

  return { event, entry, level, rejectedDocuments };
}

async function notifyAdminsLevelSubmitted(context) {
  const admins = db.prepare(`
    SELECT id, name, email, notification_email, email_notifications
    FROM users
    WHERE role = 'admin' AND is_active = 1 AND email_notifications = 1
  `).all();
  const subject = `Procurement submitted: ${context.entry.title}`;
  const text = [
    `${context.entry.requester || context.entry.requester_name} submitted a procurement level for review.`,
    '',
    `Entry: #${context.entry.id} ${context.entry.title}`,
    `Stage: ${context.level ? `${context.level.position}. ${context.level.name}` : 'Unknown stage'}`,
    `Open: ${EMAIL_CONFIG.appUrl}`
  ].join('\n');
  await Promise.all(admins.map((admin) => sendNotificationEmail(admin, subject, text)));
}

async function notifyRequesterReviewResult(context) {
  const requester = {
    id: context.entry.requester_user_id,
    name: context.entry.requester_name || context.entry.requester,
    email: context.entry.email,
    notification_email: context.entry.notification_email,
    email_notifications: context.entry.email_notifications
  };
  if (!requester.id || !requester.email_notifications) return;

  if (context.event === 'rejected') {
    const lines = context.rejectedDocuments.map((document) =>
      `- ${document.level3_name} (${document.level1_name} / ${document.level2_name}): ${document.review_notes || 'Please upload a corrected document.'}`
    );
    await sendNotificationEmail(
      requester,
      `Documents rejected: ${context.entry.title}`,
      [
        `Some documents need correction for entry #${context.entry.id} ${context.entry.title}.`,
        '',
        `Stage: ${context.level ? `${context.level.position}. ${context.level.name}` : 'Current stage'}`,
        '',
        ...lines,
        '',
        `Please log in and upload the corrected documents: ${EMAIL_CONFIG.appUrl}`
      ].join('\n')
    );
    return;
  }

  if (context.event === 'approved') {
    await sendNotificationEmail(
      requester,
      `Level approved: ${context.entry.title}`,
      [
        `Your procurement level has been approved.`,
        '',
        `Entry: #${context.entry.id} ${context.entry.title}`,
        `Stage: ${context.level ? `${context.level.position}. ${context.level.name}` : 'Final stage'}`,
        `Next step: ${context.entry.status === 'complete' ? 'Workflow complete' : 'Please continue the next stage.'}`,
        '',
        `Open: ${EMAIL_CONFIG.appUrl}`
      ].join('\n')
    );
  }
}

async function sendNotificationEmail(user, subject, text) {
  const to = user.notification_email || user.email;
  if (!to) return;

  try {
    if (EMAIL_CONFIG.host) {
      await sendSmtpMail({ to, subject, text });
      db.prepare("INSERT INTO notification_logs (user_id, email, subject, status) VALUES (?, ?, ?, 'sent')").run(user.id || null, to, subject);
      return;
    }

    const record = [
      `--- ${new Date().toISOString()} ---`,
      `To: ${to}`,
      `Subject: ${subject}`,
      text,
      ''
    ].join('\n');
    await writeFile(EMAIL_OUTBOX_PATH, record, { flag: 'a' });
    db.prepare("INSERT INTO notification_logs (user_id, email, subject, status) VALUES (?, ?, ?, 'logged')").run(user.id || null, to, subject);
  } catch (error) {
    db.prepare("INSERT INTO notification_logs (user_id, email, subject, status, error) VALUES (?, ?, ?, 'failed', ?)").run(user.id || null, to, subject, error.message);
    throw error;
  }
}

async function sendSmtpMail({ to, subject, text }) {
  let socket = await connectSmtp();
  let activeSocket = socket;
  try {
    await expectSmtp(activeSocket, 220);
    await smtpCommand(activeSocket, `EHLO ${smtpHostname()}`, 250);
    if (!EMAIL_CONFIG.secure) {
      await smtpCommand(activeSocket, 'STARTTLS', 220);
      activeSocket = tls.connect({ socket: activeSocket, servername: EMAIL_CONFIG.host });
      await new Promise((resolve, reject) => {
        activeSocket.once('secureConnect', resolve);
        activeSocket.once('error', reject);
      });
    }
    await sendSmtpMailOverSocket(activeSocket, { to, subject, text }, false);
  } finally {
    if (!activeSocket.destroyed) activeSocket.end();
  }
}

async function sendSmtpMailOverSocket(socket, { to, subject, text }, greet = true) {
  if (greet) {
    await expectSmtp(socket, 220);
  }
  await smtpCommand(socket, `EHLO ${smtpHostname()}`, 250);
  if (EMAIL_CONFIG.user || EMAIL_CONFIG.pass) {
    await smtpCommand(socket, 'AUTH LOGIN', 334);
    await smtpCommand(socket, Buffer.from(EMAIL_CONFIG.user).toString('base64'), 334);
    await smtpCommand(socket, Buffer.from(EMAIL_CONFIG.pass).toString('base64'), 235);
  }

  await smtpCommand(socket, `MAIL FROM:<${EMAIL_CONFIG.from}>`, 250);
  await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
  await smtpCommand(socket, 'DATA', 354);
  await smtpCommand(socket, buildEmailMessage({ to, subject, text }), 250);
  await smtpCommand(socket, 'QUIT', 221);
}

function connectSmtp() {
  return new Promise((resolve, reject) => {
    const socket = EMAIL_CONFIG.secure
      ? tls.connect(EMAIL_CONFIG.port, EMAIL_CONFIG.host, () => resolve(socket))
      : net.connect(EMAIL_CONFIG.port, EMAIL_CONFIG.host, () => resolve(socket));
    socket.setTimeout(15000);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('SMTP connection timed out')));
  });
}

function smtpCommand(socket, command, expected) {
  socket.write(`${command}\r\n`);
  return expectSmtp(socket, expected);
}

function expectSmtp(socket, expected) {
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1);
      if (!last || /^\d{3}-/.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      if (expectedCodes.includes(code)) resolve(buffer);
      else reject(new Error(`SMTP expected ${expectedCodes.join('/')} but received: ${last}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function buildEmailMessage({ to, subject, text }) {
  const headers = [
    `From: ${EMAIL_CONFIG.from}`,
    `To: ${to}`,
    `Subject: ${sanitizeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8'
  ];
  const body = String(text).replaceAll('\r\n.', '\r\n..').replace(/^\./gm, '..');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.`;
}

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function smtpHostname() {
  return EMAIL_CONFIG.from.split('@')[1] || 'localhost';
}

async function storeFile(file, entryId, level1, level2, level3) {
  const folder = path.join(
    UPLOAD_ROOT,
    folderName(level1.position, level1.name),
    folderName(level2.position, level2.name),
    folderName(level3.position, level3.name)
  );
  await mkdir(folder, { recursive: true });

  const fileName = `${entryId}-${level3.id}-${Date.now()}-${safeFileName(file.name)}`;
  const absolutePath = path.join(folder, fileName);
  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT))) {
    throw httpError(400, 'Invalid upload path');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(resolved, buffer);

  return {
    fileName,
    relativePath: path.relative(DATA_DIR, resolved).replaceAll(path.sep, '/')
  };
}

async function downloadDocument(res, documentId, user) {
  const document = db.prepare(`
    SELECT documents.*, entries.requester_user_id
    FROM documents
    JOIN entries ON entries.id = documents.entry_id
    WHERE documents.id = ?
  `).get(documentId);
  if (!document) throw httpError(404, 'Document not found');
  assertCanAccessEntry(document, user);

  const absolutePath = path.resolve(DATA_DIR, document.file_path);
  if (!absolutePath.startsWith(path.resolve(UPLOAD_ROOT))) {
    throw httpError(400, 'Invalid document path');
  }
  await stat(absolutePath);

  res.writeHead(200, {
    'Content-Type': document.mime_type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(document.original_name)}"`
  });
  createReadStream(absolutePath).pipe(res);
}

async function downloadEntryDocumentsZip(res, entryId, user) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw httpError(404, 'Entry not found');
  assertCanAccessEntry(entry, user);
  if (entry.status !== 'complete') throw httpError(400, 'Documents ZIP is available after the entry is complete');

  const documents = db.prepare(`
    SELECT
      d.*,
      l1.name AS level1_name,
      l1.position AS level1_position,
      l2.name AS level2_name,
      l2.position AS level2_position,
      l3.name AS level3_name,
      l3.position AS level3_position
    FROM documents d
    JOIN level1s l1 ON l1.id = d.level1_id
    JOIN level2s l2 ON l2.id = d.level2_id
    JOIN level3s l3 ON l3.id = d.level3_id
    WHERE d.entry_id = ?
    ORDER BY l1.position, l2.position, l3.position, d.id
  `).all(entryId);
  if (documents.length === 0) throw httpError(404, 'No documents available for this entry');

  const files = [];
  for (const document of documents) {
    const absolutePath = path.resolve(DATA_DIR, document.file_path);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_ROOT))) {
      throw httpError(400, 'Invalid document path');
    }
    const data = await readFile(absolutePath);
    files.push({
      name: zipDocumentPath(document),
      data
    });
  }

  const zip = createZip(files);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename="${safeFileName(entry.title)}-documents.zip"`
  });
  res.end(zip);
}

function moveItem(table, id, direction, parentColumn = null) {
  const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!current) return;

  const operator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  const parentFilter = parentColumn ? `AND ${parentColumn} = ?` : '';
  const params = parentColumn ? [current.position, current[parentColumn]] : [current.position];
  const target = db.prepare(`
    SELECT * FROM ${table}
    WHERE position ${operator} ? ${parentFilter}
    ORDER BY position ${order}, id ${order}
    LIMIT 1
  `).get(...params);

  if (!target) return;

  withTransaction(() => {
    db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(target.position, current.id);
    db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(current.position, target.id);
  });
}

function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizePositions(table, parentColumn = null, parentId = null) {
  const where = parentColumn ? `WHERE ${parentColumn} = ?` : '';
  const rows = parentColumn
    ? db.prepare(`SELECT id FROM ${table} ${where} ORDER BY position, id`).all(parentId)
    : db.prepare(`SELECT id FROM ${table} ORDER BY position, id`).all();
  const update = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  rows.forEach((row, index) => update.run(index + 1, row.id));
}

function nextPosition(table, parentColumn = null, parentId = null) {
  const row = parentColumn
    ? db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS next FROM ${table} WHERE ${parentColumn} = ?`).get(parentId)
    : db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS next FROM ${table}`).get();
  return row.next;
}

async function serveStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const absolutePath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!absolutePath.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  const filePath = existsSync(absolutePath) ? absolutePath : path.join(PUBLIC_DIR, 'index.html');
  const file = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': mimeType(filePath) });
  res.end(file);
}

async function parseJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function parseFormData(req) {
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: 'half'
  });
  return request.formData();
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireText(value, message) {
  if (!value || !String(value).trim()) throw httpError(400, message);
}

function assertExists(table, id, message) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw httpError(404, message);
}

function assertCanAccessEntry(entry, user) {
  if (user.role === 'admin') return;
  if (entry.requester_user_id === user.id) return;
  throw httpError(403, 'You can only access your own procurement entries');
}

function cleanText(value) {
  return value ? String(value).trim() : '';
}

function folderName(position, name) {
  return `${String(position).padStart(2, '0')}_${slug(name)}`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'item';
}

function safeFileName(value) {
  const parsed = path.parse(value || 'upload');
  const base = slug(parsed.name || 'upload');
  const ext = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
  return `${base}${ext}`;
}

function zipDocumentPath(document) {
  return [
    folderName(document.level1_position, document.level1_name).replace(/_/g, ' - '),
    folderName(document.level2_position, document.level2_name).replace(/_/g, ' - '),
    folderName(document.level3_position, document.level3_name).replace(/_/g, ' - '),
    `${String(document.id).padStart(4, '0')}-${safeFileName(document.original_name)}`
  ].map(zipPathSegment).join('/');
}

function zipPathSegment(value) {
  return String(value || 'item')
    .replace(/[<>:"\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'item';
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(file.data.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, file.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(file.data.length, 20);
    centralHeader.writeUInt32LE(file.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function dosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function dosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function isUploadedFile(value) {
  return value && typeof value.arrayBuffer === 'function' && value.size > 0 && value.name;
}

function normalizeReviewStatus(value) {
  if (value === 'approved' || value === 'rejected' || value === 'pending') return value;
  throw httpError(400, 'Document review status must be approved, rejected, or pending');
}

async function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const raw = await readFile(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^"|"$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function statusLabel(status) {
  const labels = {
    in_progress: 'In progress',
    awaiting_approval: 'Waiting approval',
    rejected: 'Rejected',
    complete: 'Complete'
  };
  return labels[status] || status;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return types[ext] || 'application/octet-stream';
}
