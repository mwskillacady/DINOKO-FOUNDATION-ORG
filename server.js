// server/server.js
// REST API + static file server for the DINOKO Foundation website.
// Backed by a real SQLite database (db.js) so votes, reactions, comments
// and questions persist for every visitor, not just one browser.

require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve the frontend (public/) from this same server so the API and
// site share one origin in production — no CORS issues.
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------------------------------------------------------------
// Basic rate limiting to stop spam/abuse on write endpoints
// ---------------------------------------------------------------
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
});

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function getVoterToken(req) {
  // Prefer a client-supplied anonymous token (stored in localStorage on
  // the frontend) so the SAME browser is recognised across sessions.
  const supplied = req.body?.voterToken || req.query?.voterToken;
  if (supplied && typeof supplied === "string" && supplied.length <= 100) return supplied;
  // Fallback: hash of IP (less reliable, but stops the simplest abuse)
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  return crypto.createHash("sha256").update(String(ip)).digest("hex");
}

function escapeBasic(str) {
  return String(str).slice(0, 2000);
}

// ===================================================================
// GET /api/data  — everything the frontend needs in one call
// ===================================================================
app.get("/api/data", (req, res) => {
  try {
    const artists = db.prepare(`
      SELECT a.id, a.name, a.category, a.emoji,
             COUNT(v.id) AS votes
      FROM artists a
      LEFT JOIN votes v ON v.artist_id = a.id
      GROUP BY a.id
      ORDER BY a.id
    `).all();

    const reactions = db.prepare("SELECT type, count FROM reactions").all();
    const reactionMap = {};
    reactions.forEach(r => { reactionMap[r.type] = r.count; });

    const comments = db.prepare(`
      SELECT id, name, text, created_at AS time
      FROM comments
      ORDER BY id DESC
      LIMIT 200
    `).all();

    const totalVotes = db.prepare("SELECT COUNT(*) AS c FROM votes").get().c;

    res.json({
      artists,
      reactions: reactionMap,
      comments,
      stats: { totalVotes, totalComments: comments.length },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load data" });
  }
});

// ===================================================================
// POST /api/vote  { artistId, voterToken }
// ===================================================================
app.post("/api/vote", writeLimiter, (req, res) => {
  try {
    const { artistId } = req.body;
    if (!artistId) return res.status(400).json({ error: "artistId is required" });

    const artist = db.prepare("SELECT id FROM artists WHERE id = ?").get(artistId);
    if (!artist) return res.status(404).json({ error: "Artist not found" });

    const voterToken = getVoterToken(req);

    db.prepare("INSERT INTO votes (artist_id, voter_token) VALUES (?, ?)").run(artistId, voterToken);

    const votes = db.prepare("SELECT COUNT(*) AS c FROM votes WHERE artist_id = ?").get(artistId).c;
    res.json({ success: true, artistId, votes });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "You have already voted for this artist." });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to register vote" });
  }
});

// ===================================================================
// POST /api/reaction  { type, voterToken }
// Toggles a reaction on/off for this anonymous voter token.
// ===================================================================
app.post("/api/reaction", writeLimiter, (req, res) => {
  try {
    const { type } = req.body;
    const validTypes = ["like", "love", "clap", "fire"];
    if (!validTypes.includes(type)) return res.status(400).json({ error: "Invalid reaction type" });

    const voterToken = getVoterToken(req);
    const existing = db.prepare("SELECT id FROM reaction_log WHERE type = ? AND voter_token = ?").get(type, voterToken);

    let active;
    if (existing) {
      db.prepare("DELETE FROM reaction_log WHERE id = ?").run(existing.id);
      db.prepare("UPDATE reactions SET count = MAX(count - 1, 0) WHERE type = ?").run(type);
      active = false;
    } else {
      db.prepare("INSERT INTO reaction_log (type, voter_token) VALUES (?, ?)").run(type, voterToken);
      db.prepare("UPDATE reactions SET count = count + 1 WHERE type = ?").run(type);
      active = true;
    }

    const count = db.prepare("SELECT count FROM reactions WHERE type = ?").get(type).count;
    res.json({ success: true, type, count, active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register reaction" });
  }
});

// ===================================================================
// GET /api/my-state?voterToken=...  — which artists/reactions this
// browser has already voted/reacted on (so the UI can disable buttons)
// ===================================================================
app.get("/api/my-state", (req, res) => {
  try {
    const voterToken = getVoterToken(req);
    const votedArtists = db.prepare("SELECT artist_id FROM votes WHERE voter_token = ?").all(voterToken).map(r => r.artist_id);
    const myReactions = db.prepare("SELECT type FROM reaction_log WHERE voter_token = ?").all(voterToken).map(r => r.type);
    res.json({ votedArtists, myReactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load state" });
  }
});

// ===================================================================
// POST /api/comment  { name, text }
// ===================================================================
app.post("/api/comment", writeLimiter, (req, res) => {
  try {
    const name = escapeBasic(req.body.name || "").trim();
    const text = escapeBasic(req.body.text || "").trim();
    if (!name || !text) return res.status(400).json({ error: "name and text are required" });
    if (name.length > 40) return res.status(400).json({ error: "Name too long" });
    if (text.length > 500) return res.status(400).json({ error: "Comment too long" });

    const result = db.prepare("INSERT INTO comments (name, text) VALUES (?, ?)").run(name, text);
    const comment = db.prepare("SELECT id, name, text, created_at AS time FROM comments WHERE id = ?").get(result.lastInsertRowid);
    res.json({ success: true, comment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to post comment" });
  }
});

// ===================================================================
// POST /api/ask  { name, email, question }
// Saves the question in the DB AND (if SMTP env vars are set) emails
// it to mphefuwinston@gmail.com automatically.
// ===================================================================
app.post("/api/ask", writeLimiter, async (req, res) => {
  try {
    const name = escapeBasic(req.body.name || "").trim();
    const email = escapeBasic(req.body.email || "").trim();
    const question = escapeBasic(req.body.question || "").trim();
    if (!name || !question) return res.status(400).json({ error: "name and question are required" });

    const result = db.prepare("INSERT INTO questions (name, email, question) VALUES (?, ?, ?)").run(name, email, question);

    let emailed = false;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === "true",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: process.env.NOTIFY_EMAIL || "mphefuwinston@gmail.com",
          subject: `New question from ${name} — DINOKO Foundation`,
          text: `Name: ${name}\nEmail: ${email || "(not provided)"}\n\nQuestion:\n${question}`,
        });
        emailed = true;
      } catch (mailErr) {
        console.error("Email send failed:", mailErr.message);
      }
    }

    res.json({ success: true, id: result.lastInsertRowid, emailed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit question" });
  }
});

// ===================================================================
// Fallback: serve index.html for any unknown non-API route (SPA-style)
// ===================================================================
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ DINOKO Foundation server running on http://localhost:${PORT}`);
});
