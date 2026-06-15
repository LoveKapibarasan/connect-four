import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
let isPostgres = false;
let pool = null;
let sqliteDb = null;

if (databaseUrl) {
  isPostgres = true;
  pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });
} else {
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new DatabaseSync(path.join(dataDir, 'games.db'));
}

// Convert SQLite style ? placeholders to Postgres style $1, $2...
function convertPlaceholders(sql) {
  if (!isPostgres) return sql;
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

const db = {
  async init() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        player1_id TEXT NOT NULL,
        player1_name TEXT NOT NULL,
        player1_color TEXT NOT NULL,
        player2_id TEXT,
        player2_name TEXT,
        player2_color TEXT,
        winner_id TEXT,
        winner_color TEXT,
        status TEXT NOT NULL DEFAULT 'in_progress',
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        total_moves INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS game_moves (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        player_color TEXT NOT NULL,
        column_index INTEGER NOT NULL,
        row_index INTEGER NOT NULL,
        move_number INTEGER NOT NULL,
        placed_at BIGINT NOT NULL
      );
    `);
  },

  async exec(sql) {
    if (isPostgres) {
      await pool.query(sql);
    } else {
      sqliteDb.exec(sql);
    }
  },

  async run(sql, ...params) {
    if (isPostgres) {
      await pool.query(convertPlaceholders(sql), params);
    } else {
      sqliteDb.prepare(sql).run(...params);
    }
  },

  async all(sql, ...params) {
    if (isPostgres) {
      const res = await pool.query(convertPlaceholders(sql), params);
      return res.rows;
    } else {
      return sqliteDb.prepare(sql).all(...params);
    }
  },

  async get(sql, ...params) {
    if (isPostgres) {
      const res = await pool.query(convertPlaceholders(sql), params);
      return res.rows[0] || null;
    } else {
      return sqliteDb.prepare(sql).get(...params);
    }
  }
};

export default db;
