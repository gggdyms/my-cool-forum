const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Persist db under .data (works on platforms that mount a persistent disk there)
const dataDir = path.join(__dirname, ".data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "forum.db"));

// --- schema
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  creator TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER,
  content TEXT NOT NULL,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  persona_id INTEGER,
  content TEXT NOT NULL,
  reply_to_comment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (persona_id) REFERENCES personas(id),
  FOREIGN KEY (reply_to_comment_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`);

function nowIso() {
  return new Date().toISOString();
}

function isProbablyHttpUrl(u) {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// --- personas
app.get("/api/personas", (req, res) => {
  const personas = db
    .prepare(
      `SELECT id, name, avatar_url, bio, creator, deleted_at
       FROM personas
       ORDER BY (deleted_at IS NOT NULL), name COLLATE NOCASE ASC`
    )
    .all();
  res.json({ personas });
});

app.post("/api/personas", (req, res) => {
  const name = (req.body?.name || "").trim();
  const avatar_url = (req.body?.avatar_url || "").trim();
  const bio = (req.body?.bio || "").trim();
  const creator = (req.body?.creator || "").trim();

  if (!name) return res.status(400).json({ error: "NAME_REQUIRED" });
  if (name === "未命名") return res.status(400).json({ error: "NAME_RESERVED" });
  if (avatar_url && !isProbablyHttpUrl(avatar_url)) return res.status(400).json({ error: "AVATAR_URL_INVALID" });

  try {
    const info = db
      .prepare(`INSERT INTO personas (name, avatar_url, bio, creator, deleted_at) VALUES (?, ?, ?, ?, NULL)`)
      .run(name, avatar_url || null, bio || null, creator || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "NAME_EXISTS" });
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// delete persona: soft-delete persona, but keep posts/comments and mark as deleted persona on read
app.delete("/api/personas/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "BAD_ID" });

  const persona = db.prepare(`SELECT id, deleted_at FROM personas WHERE id=?`).get(id);
  if (!persona) return res.status(404).json({ error: "NOT_FOUND" });
  if (persona.deleted_at) return res.json({ ok: true });

  db.prepare(`UPDATE personas SET deleted_at=? WHERE id=?`).run(nowIso(), id);
  res.json({ ok: true });
});

// --- posts
app.get("/api/posts", (req, res) => {
  const sort = (req.query.sort || "new").toString(); // "new" | "hot"
  const orderSql =
    sort === "hot"
      ? `ORDER BY reply_count DESC, p.created_at DESC`
      : `ORDER BY p.created_at DESC`;

  const posts = db
    .prepare(
      `
      SELECT
        p.id,
        p.content,
        p.image_url,
        p.created_at,
        p.deleted_at,
        p.persona_id,
        COALESCE(per.name, '已删除人设') AS persona_name,
        CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN NULL ELSE per.avatar_url END AS persona_avatar_url,
        CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN 1 ELSE 0 END AS persona_deleted,
        (
          SELECT COUNT(1)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS reply_count
      FROM posts p
      LEFT JOIN personas per ON per.id = p.persona_id
      WHERE p.deleted_at IS NULL
      ${orderSql}
      `
    )
    .all();

  res.json({ posts });
});

app.get("/api/posts/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "BAD_ID" });

  const post = db
    .prepare(
      `
    SELECT
      p.id,
      p.content,
      p.image_url,
      p.created_at,
      p.deleted_at,
      p.persona_id,
      COALESCE(per.name, '已删除人设') AS persona_name,
      CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN NULL ELSE per.avatar_url END AS persona_avatar_url,
      CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN 1 ELSE 0 END AS persona_deleted
    FROM posts p
    LEFT JOIN personas per ON per.id = p.persona_id
    WHERE p.id = ?
    `
    )
    .get(id);

  if (!post || post.deleted_at) return res.status(404).json({ error: "NOT_FOUND" });

  const comments = db
    .prepare(
      `
    SELECT
      c.id,
      c.post_id,
      c.content,
      c.created_at,
      c.reply_to_comment_id,
      c.persona_id,
      COALESCE(per.name, '已删除人设') AS persona_name,
      CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN NULL ELSE per.avatar_url END AS persona_avatar_url,
      CASE WHEN per.deleted_at IS NOT NULL OR per.id IS NULL THEN 1 ELSE 0 END AS persona_deleted
    FROM comments c
    LEFT JOIN personas per ON per.id = c.persona_id
    WHERE c.post_id = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC, c.id ASC
    `
    )
    .all(id);

  res.json({ post, comments });
});

app.post("/api/posts", (req, res) => {
  const personaName = (req.body?.persona_name || "").trim();
  const content = (req.body?.content || "").trim();
  const imageUrl = (req.body?.image_url || "").trim();

  if (!personaName) return res.status(400).json({ error: "PERSONA_REQUIRED" });
  if (!content) return res.status(400).json({ error: "CONTENT_REQUIRED" });
  if (imageUrl && !isProbablyHttpUrl(imageUrl)) return res.status(400).json({ error: "IMAGE_URL_INVALID" });

  const persona = db
    .prepare(`SELECT id, deleted_at FROM personas WHERE name = ? COLLATE NOCASE`)
    .get(personaName);

  if (!persona || persona.deleted_at) return res.status(400).json({ error: "PERSONA_NOT_FOUND" });

  const info = db
    .prepare(`INSERT INTO posts (persona_id, content, image_url, deleted_at) VALUES (?, ?, ?, NULL)`)
    .run(persona.id, content, imageUrl || null);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// delete post: soft delete post + soft delete its comments (requirement: delete with comments)
app.delete("/api/posts/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "BAD_ID" });

  const post = db.prepare(`SELECT id, deleted_at FROM posts WHERE id=?`).get(id);
  if (!post) return res.status(404).json({ error: "NOT_FOUND" });
  if (post.deleted_at) return res.json({ ok: true });

  const t = db.transaction(() => {
    const ts = nowIso();
    db.prepare(`UPDATE posts SET deleted_at=? WHERE id=?`).run(ts, id);
    db.prepare(`UPDATE comments SET deleted_at=? WHERE post_id=?`).run(ts, id);
  });
  t();

  res.json({ ok: true });
});

// --- comments
app.post("/api/comments", (req, res) => {
  const postId = Number(req.body?.post_id);
  const personaName = (req.body?.persona_name || "").trim();
  const content = (req.body?.content || "").trim();
  const replyToCommentId = req.body?.reply_to_comment_id != null ? Number(req.body.reply_to_comment_id) : null;

  if (!Number.isFinite(postId)) return res.status(400).json({ error: "POST_ID_REQUIRED" });
  if (!personaName) return res.status(400).json({ error: "PERSONA_REQUIRED" });
  if (!content) return res.status(400).json({ error: "CONTENT_REQUIRED" });
  if (replyToCommentId != null && !Number.isFinite(replyToCommentId)) return res.status(400).json({ error: "BAD_REPLY_TO" });

  const post = db.prepare(`SELECT id, deleted_at FROM posts WHERE id=?`).get(postId);
  if (!post || post.deleted_at) return res.status(404).json({ error: "POST_NOT_FOUND" });

  const persona = db.prepare(`SELECT id, deleted_at FROM personas WHERE name=? COLLATE NOCASE`).get(personaName);
  if (!persona || persona.deleted_at) return res.status(400).json({ error: "PERSONA_NOT_FOUND" });

  if (replyToCommentId != null) {
    const parent = db
      .prepare(`SELECT id, post_id, deleted_at FROM comments WHERE id=?`)
      .get(replyToCommentId);
    if (!parent || parent.deleted_at || parent.post_id !== postId) {
      return res.status(400).json({ error: "REPLY_TARGET_INVALID" });
    }
  }

  const info = db
    .prepare(
      `INSERT INTO comments (post_id, persona_id, content, reply_to_comment_id, deleted_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(postId, persona.id, content, replyToCommentId);

  res.json({ ok: true, id: info.lastInsertRowid });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));
