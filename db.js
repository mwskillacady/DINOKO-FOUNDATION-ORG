// server/db.js
// SQLite database setup for the DINOKO Foundation site.
// Uses better-sqlite3 — a real, file-backed relational database.
// Data persists in dinoko.db on disk (survives restarts/deploys as long
// as the disk is persistent — see README for notes on Render/Railway disks).

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "dinoko.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

// ---------------------------------------------------------------
// Schema
// ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    emoji TEXT DEFAULT '🎤'
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id TEXT NOT NULL,
    voter_token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(artist_id, voter_token),
    FOREIGN KEY (artist_id) REFERENCES artists(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    type TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reaction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    voter_token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(type, voter_token)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    question TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------
// Seed default artists + reaction types (only if empty)
// ---------------------------------------------------------------
const artistCount = db.prepare("SELECT COUNT(*) AS c FROM artists").get().c;
if (artistCount === 0) {
  const insertArtist = db.prepare("INSERT INTO artists (id, name, category, emoji) VALUES (?, ?, ?, ?)");
  const seedArtists = [
    ["a1", "Kgosi M.", "Singer", "🎤"],
    ["a2", "Refilwe D.", "Dancer", "💃"],
    ["a3", "Sipho K.", "Painter", "🎨"],
    ["a4", "Amahle T.", "Poet", "✍️"],
    ["a5", "Tumelo B.", "Rapper", "🎧"],
    ["a6", "Lindiwe P.", "Model", "✨"],
  ];
  const insertMany = db.transaction((rows) => rows.forEach(r => insertArtist.run(...r)));
  insertMany(seedArtists);
}

const reactionCount = db.prepare("SELECT COUNT(*) AS c FROM reactions").get().c;
if (reactionCount === 0) {
  const insertReaction = db.prepare("INSERT INTO reactions (type, count) VALUES (?, 0)");
  const insertMany = db.transaction((types) => types.forEach(t => insertReaction.run(t)));
  insertMany(["like", "love", "clap", "fire"]);
}

module.exports = db;
