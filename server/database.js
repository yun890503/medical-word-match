import mysql from "mysql2/promise";
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
  teams: Array.from({ length: 12 }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team${index + 1}`,
    password: `team${index + 1}`,
    enabled: true,
    avatar: ["owl", "rocket", "star", "heart", "brain", "microscope", "pill", "dna", "trophy", "lightning", "leaf", "fire"][index],
  })),
  teachers: [{ id: "teacher-admin", name: "系統管理教師", username: "admin", password: "admin123", enabled: true }],
  settings: { questionCount: 10, durationSeconds: 300, showChinese: true, leaderboardMode: "live" },
  status: "waiting",
  startedAt: null,
  pausedAt: null,
  elapsedBeforePause: 0,
  records: [],
};

let questionBank = defaultState.words;

function boolToInt(value) {
  return value ? 1 : 0;
}

function intToBool(value) {
  return Boolean(value);
}

function normalizeState(nextState = {}) {
  const words = nextState.words?.length ? nextState.words : questionBank;
  return {
    ...defaultState,
    ...nextState,
    words,
    teams: nextState.teams?.length ? nextState.teams.map((team, index) => ({ ...team, avatar: team.avatar || defaultState.teams[index % defaultState.teams.length]?.avatar || "owl" })) : defaultState.teams,
    teachers: nextState.teachers?.length ? nextState.teachers : defaultState.teachers,
    settings: { ...defaultState.settings, ...nextState.settings },
    records: nextState.records ?? [],
  };
}

function getMysqlConfig() {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    };
  }

  return {
    host: process.env.MYSQL_HOST || process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER || "root",
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME || "zeabur",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4",
  };
}

async function initializeSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      avatar MEDIUMTEXT NULL,
      active_session_token VARCHAR(120) NULL,
      active_session_at BIGINT NULL,
      active_session_match_started_at BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  for (const statement of [
    "ALTER TABLE teams ADD COLUMN active_session_token VARCHAR(120) NULL",
    "ALTER TABLE teams ADD COLUMN active_session_at BIGINT NULL",
    "ALTER TABLE teams ADD COLUMN active_session_match_started_at BIGINT NULL",
    "ALTER TABLE teams ADD COLUMN avatar MEDIUMTEXT NULL",
    "ALTER TABLE teams MODIFY COLUMN avatar MEDIUMTEXT NULL",
  ]) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      username VARCHAR(120) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id TINYINT PRIMARY KEY,
      question_count INT NOT NULL,
      duration_seconds INT NOT NULL,
      show_chinese TINYINT(1) NOT NULL,
      leaderboard_mode VARCHAR(20) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_state (
      id TINYINT PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      started_at BIGINT NULL,
      paused_at BIGINT NULL,
      elapsed_before_pause INT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS answer_records (
      id VARCHAR(80) PRIMARY KEY,
      team_id VARCHAR(80) NOT NULL,
      team_name VARCHAR(120) NOT NULL,
      question_id VARCHAR(80) NOT NULL,
      chinese VARCHAR(255) NOT NULL,
      selected_root VARCHAR(120) NOT NULL,
      selected_suffix VARCHAR(120) NOT NULL,
      combined VARCHAR(255) NOT NULL,
      correct TINYINT(1) NOT NULL,
      answered_at VARCHAR(80) NOT NULL,
      seconds_from_start INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_team_question (team_id, question_id),
      INDEX idx_records_team (team_id),
      INDEX idx_records_score_order (seconds_from_start)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function seedDefaultsIfNeeded(pool) {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM teams");
  if (Number(rows[0]?.count || 0) === 0) {
    await replaceState(pool, defaultState);
  }
}

export async function createDatabase() {
  const pool = mysql.createPool(getMysqlConfig());
  await initializeSchema(pool);
  await seedDefaultsIfNeeded(pool);
  return pool;
}

export async function readState(pool) {
  const [[settings], [match], [teams], [teachers], [records]] = await Promise.all([
    pool.query("SELECT * FROM settings WHERE id = 1"),
    pool.query("SELECT * FROM match_state WHERE id = 1"),
    pool.query(`
      SELECT id, name, password, enabled, avatar,
        active_session_token AS activeSessionToken,
        active_session_at AS activeSessionAt,
        active_session_match_started_at AS activeSessionMatchStartedAt,
        active_session_token IS NOT NULL AS loginLocked
      FROM teams
      ORDER BY created_at, id
    `),
    pool.query("SELECT id, name, username, password, enabled FROM teachers ORDER BY created_at, id"),
    pool.query(`
      SELECT id, team_id AS teamId, team_name AS teamName, question_id AS questionId,
        chinese, selected_root AS selectedRoot, selected_suffix AS selectedSuffix,
        combined, correct, answered_at AS answeredAt, seconds_from_start AS secondsFromStart
      FROM answer_records
      ORDER BY seconds_from_start, created_at, id
    `),
  ]);

  return normalizeState({
    words: questionBank,
    teams: teams.map((team) => ({ ...team, enabled: intToBool(team.enabled), loginLocked: intToBool(team.loginLocked) })),
    teachers: teachers.map((teacher) => ({ ...teacher, enabled: intToBool(teacher.enabled) })),
    settings: settings[0] ? {
      questionCount: settings[0].question_count,
      durationSeconds: settings[0].duration_seconds,
      showChinese: intToBool(settings[0].show_chinese),
      leaderboardMode: settings[0].leaderboard_mode,
    } : defaultState.settings,
    status: match[0]?.status ?? defaultState.status,
    startedAt: match[0]?.started_at === null || match[0]?.started_at === undefined ? null : Number(match[0].started_at),
    pausedAt: match[0]?.paused_at === null || match[0]?.paused_at === undefined ? null : Number(match[0].paused_at),
    elapsedBeforePause: match[0]?.elapsed_before_pause ?? 0,
    records: records.map((record) => ({ ...record, correct: intToBool(record.correct) })),
  });
}

export async function replaceState(pool, incomingState) {
  const state = normalizeState(incomingState);
  questionBank = state.words;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [existingTeams] = await connection.query(`
      SELECT id,
        active_session_token AS activeSessionToken,
        active_session_at AS activeSessionAt,
        active_session_match_started_at AS activeSessionMatchStartedAt
      FROM teams
    `);
    const activeSessions = new Map(existingTeams.map((team) => [team.id, team]));
    await connection.query("DELETE FROM answer_records");
    await connection.query("DELETE FROM teams");
    await connection.query("DELETE FROM teachers");
    await connection.query("DELETE FROM settings");
    await connection.query("DELETE FROM match_state");

    for (const team of state.teams) {
      const activeSession = activeSessions.get(team.id) || {};
      await connection.query(
        `INSERT INTO teams
          (id, name, password, enabled, avatar, active_session_token, active_session_at, active_session_match_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          team.id || randomUUID(),
          team.name,
          team.password || "",
          boolToInt(team.enabled),
          team.avatar || "owl",
          team.activeSessionToken ?? activeSession.activeSessionToken ?? null,
          team.activeSessionAt ?? activeSession.activeSessionAt ?? null,
          team.activeSessionMatchStartedAt ?? activeSession.activeSessionMatchStartedAt ?? null,
        ],
      );
    }

    for (const teacher of state.teachers) {
      await connection.query(
        "INSERT INTO teachers (id, name, username, password, enabled) VALUES (?, ?, ?, ?, ?)",
        [teacher.id || randomUUID(), teacher.name, teacher.username, teacher.password || "", boolToInt(teacher.enabled)],
      );
    }

    await connection.query(
      "INSERT INTO settings (id, question_count, duration_seconds, show_chinese, leaderboard_mode) VALUES (1, ?, ?, ?, ?)",
      [state.settings.questionCount, state.settings.durationSeconds, boolToInt(state.settings.showChinese), state.settings.leaderboardMode],
    );

    await connection.query(
      "INSERT INTO match_state (id, status, started_at, paused_at, elapsed_before_pause) VALUES (1, ?, ?, ?, ?)",
      [state.status, state.startedAt, state.pausedAt, state.elapsedBeforePause],
    );

    for (const record of state.records) {
      await connection.query(
        `INSERT INTO answer_records
          (id, team_id, team_name, question_id, chinese, selected_root, selected_suffix, combined, correct, answered_at, seconds_from_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id || randomUUID(),
          record.teamId,
          record.teamName,
          record.questionId,
          record.chinese,
          record.selectedRoot,
          record.selectedSuffix,
          record.combined,
          boolToInt(record.correct),
          record.answeredAt,
          record.secondsFromStart,
        ],
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return readState(pool);
}

export async function mergeTeamRecords(pool, teamId, records) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const record of records.filter((item) => item.teamId === teamId)) {
      await connection.query(
        `INSERT IGNORE INTO answer_records
          (id, team_id, team_name, question_id, chinese, selected_root, selected_suffix, combined, correct, answered_at, seconds_from_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id || randomUUID(),
          record.teamId,
          record.teamName,
          record.questionId,
          record.chinese,
          record.selectedRoot,
          record.selectedSuffix,
          record.combined,
          boolToInt(record.correct),
          record.answeredAt,
          record.secondsFromStart,
        ],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return readState(pool);
}

export async function readTeamSession(pool, teamId) {
  const [rows] = await pool.query(
    "SELECT active_session_token AS activeSessionToken FROM teams WHERE id = ?",
    [teamId],
  );
  return rows[0] || null;
}

export async function setTeamSession(pool, teamId, token, matchStartedAt) {
  await pool.query(
    "UPDATE teams SET active_session_token = ?, active_session_at = ?, active_session_match_started_at = ? WHERE id = ?",
    [token, Date.now(), matchStartedAt ?? null, teamId],
  );
}

export async function clearTeamSession(pool, teamId) {
  await pool.query(
    "UPDATE teams SET active_session_token = NULL, active_session_at = NULL, active_session_match_started_at = NULL WHERE id = ?",
    [teamId],
  );
}

export async function resetDatabase(pool) {
  questionBank = defaultState.words;
  await replaceState(pool, defaultState);
  await pool.query("UPDATE teams SET active_session_token = NULL, active_session_at = NULL, active_session_match_started_at = NULL");
  return readState(pool);
}
