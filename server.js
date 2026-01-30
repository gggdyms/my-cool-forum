// 这是为 Replit 平台特别修改的版本
const express = require("express");
const Database = require("@replit/database"); // 使用 Replit 的数据库

const app = express();
const db = new Database(); // 初始化数据库

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// --- helpers
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
app.get("/api/personas", async (req, res) => {
  const keys = await db.list({ prefix: "persona:" });
  const personas = (await Promise.all(keys.map(k => db.get(k)))).sort((a, b) => {
    if (a.deleted_at && !b.deleted_at) return 1;
    if (!a.deleted_at && b.deleted_at) return -1;
    return a.name.localeCompare(b.name);
  });
  res.json({ personas });
});

app.post("/api/personas", async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "NAME_REQUIRED" });
  if (name === "未命名") return res.status(400).json({ error: "NAME_RESERVED" });

  const existing = await db.get("persona_name:" + name.toLowerCase());
  if (existing) return res.status(409).json({ error: "NAME_EXISTS" });

  const id = Date.now();
  const persona = {
    id,
    name,
    avatar_url: (req.body?.avatar_url || "").trim() || null,
    bio: (req.body?.bio || "").trim() || null,
    creator: (req.body?.creator || "").trim() || null,
    deleted_at: null,
  };
  if (persona.avatar_url && !isProbablyHttpUrl(persona.avatar_url)) return res.status(400).json({ error: "AVATAR_URL_INVALID" });

  await db.set("persona:" + id, persona);
  await db.set("persona_name:" + name.toLowerCase(), id);
  res.json({ ok: true, id });
});

app.delete("/api/personas/:id", async (req, res) => {
  const id = Number(req.params.id);
  const key = "persona:" + id;
  const persona = await db.get(key);
  if (!persona) return res.status(404).json({ error: "NOT_FOUND" });

  persona.deleted_at = nowIso();
  await db.set(key, persona);
  await db.delete("persona_name:" + persona.name.toLowerCase());
  res.json({ ok: true });
});

// --- posts & comments
app.get("/api/posts", async (req, res) => {
  const sort = req.query.sort || "new";
  const postKeys = await db.list({ prefix: "post:" });
  let posts = (await Promise.all(postKeys.map(k => db.get(k)))).filter(p => !p.deleted_at);

  const personaCache = new Map();
  const getPersona = async (id) => {
    if (!id) return null;
    if (personaCache.has(id)) return personaCache.get(id);
    const p = await db.get("persona:" + id);
    personaCache.set(id, p);
    return p;
  };

  for (const p of posts) {
    const persona = await getPersona(p.persona_id);
    p.persona_name = persona?.name || "已删除人设";
    p.persona_avatar_url = persona?.deleted_at ? null : persona?.avatar_url;
    p.persona_deleted = !persona || !!persona.deleted_at;
    const commentKeys = await db.list({ prefix: `comment_post:${p.id}:` });
    p.reply_count = commentKeys.length;
  }

  if (sort === "hot") {
    posts.sort((a, b) => b.reply_count - a.reply_count || new Date(b.created_at) - new Date(a.created_at));
  } else {
    posts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  res.json({ posts });
});

app.get("/api/posts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const post = await db.get("post:" + id);
  if (!post || post.deleted_at) return res.status(404).json({ error: "NOT_FOUND" });

  const persona = await db.get("persona:" + post.persona_id);
  post.persona_name = persona?.name || "已删除人设";
  post.persona_avatar_url = persona?.deleted_at ? null : persona?.avatar_url;
  post.persona_deleted = !persona || !!persona.deleted_at;

  const commentKeys = await db.list({ prefix: `comment_post:${id}:` });
  let comments = (await Promise.all(commentKeys.map(k => db.get(k)))).filter(c => !c.deleted_at);
  
  const personaCache = new Map();
  const getPersona = async (pid) => {
    if (!pid) return null;
    if (personaCache.has(pid)) return personaCache.get(pid);
    const p = await db.get("persona:" + pid);
    personaCache.set(pid, p);
    return p;
  };

  for (const c of comments) {
    const p = await getPersona(c.persona_id);
    c.persona_name = p?.name || "已删除人设";
    c.persona_avatar_url = p?.deleted_at ? null : p?.avatar_url;
    c.persona_deleted = !p || !!p.deleted_at;
  }
  comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json({ post, comments });
});

app.post("/api/posts", async (req, res) => {
  const personaName = (req.body?.persona_name || "").trim();
  const content = (req.body?.content || "").trim();
  const imageUrl = (req.body?.image_url || "").trim();

  if (!personaName || !content) return res.status(400).json({ error: "MISSING_FIELDS" });
  if (imageUrl && !isProbablyHttpUrl(imageUrl)) return res.status(400).json({ error: "IMAGE_URL_INVALID" });

  const personaId = await db.get("persona_name:" + personaName.toLowerCase());
  if (!personaId) return res.status(400).json({ error: "PERSONA_NOT_FOUND" });

  const id = Date.now();
  const post = {
    id,
    persona_id: personaId,
    content,
    image_url: imageUrl || null,
    created_at: nowIso(),
    deleted_at: null,
  };
  await db.set("post:" + id, post);
  res.json({ ok: true, id });
});

app.delete("/api/posts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const key = "post:" + id;
  const post = await db.get(key);
  if (!post) return res.status(404).json({ error: "NOT_FOUND" });

  post.deleted_at = nowIso();
  await db.set(key, post);

  // delete comments
  const commentKeys = await db.list({ prefix: `comment_post:${id}:` });
  for (const k of commentKeys) {
    await db.delete(k);
  }
  res.json({ ok: true });
});

app.post("/api/comments", async (req, res) => {
  const postId = Number(req.body?.post_id);
  const personaName = (req.body?.persona_name || "").trim();
  const content = (req.body?.content || "").trim();
  const replyToCommentId = req.body?.reply_to_comment_id != null ? Number(req.body.reply_to_comment_id) : null;

  if (!postId || !personaName || !content) return res.status(400).json({ error: "MISSING_FIELDS" });

  const post = await db.get("post:" + postId);
  if (!post || post.deleted_at) return res.status(404).json({ error: "POST_NOT_FOUND" });

  const personaId = await db.get("persona_name:" + personaName.toLowerCase());
  if (!personaId) return res.status(400).json({ error: "PERSONA_NOT_FOUND" });

  const id = Date.now();
  const comment = {
    id,
    post_id: postId,
    persona_id: personaId,
    content,
    reply_to_comment_id: replyToCommentId,
    created_at: nowIso(),
    deleted_at: null,
  };
  await db.set(`comment_post:${postId}:${id}`, comment);
  res.json({ ok: true, id });
});

app.listen(3000, () => console.log("Server is running."));
