import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const defaultState = {
  words: [
    { id: "word-neurology", word: "Neurology", chinese: "神經學", root: "neur", suffix: "ology" },
    { id: "word-cardiology", word: "Cardiology", chinese: "心臟學", root: "cardi", suffix: "ology" },
    { id: "word-gastritis", word: "Gastritis", chinese: "胃炎", root: "gastr", suffix: "itis" },
    { id: "word-hepatitis", word: "Hepatitis", chinese: "肝炎", root: "hepat", suffix: "itis" },
    { id: "word-anemia", word: "Anemia", chinese: "貧血", root: "an", suffix: "emia" },
    { id: "word-gastrectomy", word: "Gastrectomy", chinese: "胃切除術", root: "gastr", suffix: "ectomy" },
    { id: "word-dermatology", word: "Dermatology", chinese: "皮膚學", root: "dermat", suffix: "ology" },
    { id: "word-nephrectomy", word: "Nephrectomy", chinese: "腎切除術", root: "nephr", suffix: "ectomy" },
    { id: "word-leukemia", word: "Leukemia", chinese: "白血病", root: "leuk", suffix: "emia" },
    { id: "word-arthritis", word: "Arthritis", chinese: "關節炎", root: "arthr", suffix: "itis" },
  ],
  teams: Array.from({ length: 7 }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team${index + 1}`,
    password: `team${index + 1}`,
    enabled: true,
  })),
  teachers: [{ id: "teacher-admin", name: "系統管理教師", username: "admin", password: "admin123", enabled: true }],
  settings: { questionCount: 10, durationSeconds: 300, showChinese: true, leaderboardMode: "live" },
  status: "waiting",
  startedAt: null,
  pausedAt: null,
  elapsedBeforePause: 0,
  records: [],
};

function boolToInt(value) {
  return value ? 1 : 0;
}

function intToBool(value) {
  return Boolean(value);
}

function normalizeState(nextState) {
  return {
    ...defaultState,
    ...nextState,
    words: nextState.words?.length ? nextState.words : defaultState.words,
    teams: nextState.teams?.length ? nextState.teams : defaultState.teams,
    teachers: nextState.teachers?.length ? nextState.teachers : defaultState.teachers,
    settings: { ...defaultState.settings, ...nextState.settings },
    records: nextState.records ?? [],
  };
}

export function createDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      chinese TEXT NOT NULL,
      root TEXT NOT NULL,
      suffix TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      question_count INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      show_chinese INTEGER NOT NULL,
      leaderboard_mode TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      started_at INTEGER,
      paused_at INTEGER,
      elapsed_before_pause INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_records (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      question_id TEXT NOT NULL,
      chinese TEXT NOT NULL,
      selected_root TEXT NOT NULL,
      selected_suffix TEXT NOT NULL,
      combined TEXT NOT NULL,
      correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL,
      seconds_from_start INTEGER NOT NULL,
      UNIQUE(team_id, question_id)
    );
  `);

  const wordCount = db.prepare("SELECT COUNT(*) AS count FROM words").get().count;
  if (wordCount === 0) replaceState(db, defaultState);
  return db;
}

export function readState(db) {
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
  return normalizeState({
    words: db.prepare("SELECT id, word, chinese, root, suffix FROM words ORDER BY rowid").all(),
    teams: db.prepare("SELECT id, name, password, enabled FROM teams ORDER BY rowid").all().map((team) => ({ ...team, enabled: intToBool(team.enabled) })),
    teachers: db.prepare("SELECT id, name, username, password, enabled FROM teachers ORDER BY rowid").all().map((teacher) => ({ ...teacher, enabled: intToBool(teacher.enabled) })),
    settings: settings ? {
      questionCount: settings.question_count,
      durationSeconds: settings.duration_seconds,
      showChinese: intToBool(settings.show_chinese),
      leaderboardMode: settings.leaderboard_mode,
    } : defaultState.settings,
    status: match?.status ?? defaultState.status,
    startedAt: match?.started_at ?? null,
    pausedAt: match?.paused_at ?? null,
    elapsedBeforePause: match?.elapsed_before_pause ?? 0,
    records: db.prepare(`
      SELECT id, team_id AS teamId, team_name AS teamName, question_id AS questionId,
        chinese, selected_root AS selectedRoot, selected_suffix AS selectedSuffix,
        combined, correct, answered_at AS answeredAt, seconds_from_start AS secondsFromStart
      FROM answer_records
      ORDER BY seconds_from_start, rowid
    `).all().map((record) => ({ ...record, correct: intToBool(record.correct) })),
  });
}

export const replaceState = (db, incomingState) => {
  const state = normalizeState(incomingState);
  const transaction = db.transaction(() => {
    db.exec("DELETE FROM answer_records; DELETE FROM words; DELETE FROM teams; DELETE FROM teachers; DELETE FROM settings; DELETE FROM match_state;");
    const insertWord = db.prepare("INSERT INTO words (id, word, chinese, root, suffix) VALUES (?, ?, ?, ?, ?)");
    const insertTeam = db.prepare("INSERT INTO teams (id, name, password, enabled) VALUES (?, ?, ?, ?)");
    const insertTeacher = db.prepare("INSERT INTO teachers (id, name, username, password, enabled) VALUES (?, ?, ?, ?, ?)");
    const insertRecord = db.prepare(`
      INSERT INTO answer_records (id, team_id, team_name, question_id, chinese, selected_root, selected_suffix, combined, correct, answered_at, seconds_from_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const word of state.words) insertWord.run(word.id || randomUUID(), word.word, word.chinese, word.root, word.suffix);
    for (const team of state.teams) insertTeam.run(team.id || randomUUID(), team.name, team.password || "", boolToInt(team.enabled));
    for (const teacher of state.teachers) insertTeacher.run(teacher.id || randomUUID(), teacher.name, teacher.username, teacher.password || "", boolToInt(teacher.enabled));
    db.prepare("INSERT INTO settings (id, question_count, duration_seconds, show_chinese, leaderboard_mode) VALUES (1, ?, ?, ?, ?)")
      .run(state.settings.questionCount, state.settings.durationSeconds, boolToInt(state.settings.showChinese), state.settings.leaderboardMode);
    db.prepare("INSERT INTO match_state (id, status, started_at, paused_at, elapsed_before_pause) VALUES (1, ?, ?, ?, ?)")
      .run(state.status, state.startedAt, state.pausedAt, state.elapsedBeforePause);
    for (const record of state.records) {
      insertRecord.run(record.id || randomUUID(), record.teamId, record.teamName, record.questionId, record.chinese, record.selectedRoot, record.selectedSuffix, record.combined, boolToInt(record.correct), record.answeredAt, record.secondsFromStart);
    }
  });
  transaction();
  return readState(db);
};

export function mergeTeamRecords(db, teamId, records) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO answer_records (id, team_id, team_name, question_id, chinese, selected_root, selected_suffix, combined, correct, answered_at, seconds_from_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    for (const record of records.filter((item) => item.teamId === teamId)) {
      insert.run(record.id || randomUUID(), record.teamId, record.teamName, record.questionId, record.chinese, record.selectedRoot, record.selectedSuffix, record.combined, boolToInt(record.correct), record.answeredAt, record.secondsFromStart);
    }
  });
  transaction();
  return readState(db);
}

export function resetDatabase(db) {
  return replaceState(db, defaultState);
}
