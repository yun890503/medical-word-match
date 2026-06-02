import express from "express";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const dataDir = path.join(__dirname, "data");
const stateFile = path.join(dataDir, "state.json");
const port = Number(process.env.PORT || process.env.API_PORT || 3001);

const defaultState = {
  words: [
    { id: randomUUID(), word: "Neurology", chinese: "神經學", root: "neur", suffix: "ology" },
    { id: randomUUID(), word: "Cardiology", chinese: "心臟學", root: "cardi", suffix: "ology" },
    { id: randomUUID(), word: "Gastritis", chinese: "胃炎", root: "gastr", suffix: "itis" },
    { id: randomUUID(), word: "Hepatitis", chinese: "肝炎", root: "hepat", suffix: "itis" },
    { id: randomUUID(), word: "Anemia", chinese: "貧血", root: "an", suffix: "emia" },
    { id: randomUUID(), word: "Gastrectomy", chinese: "胃切除術", root: "gastr", suffix: "ectomy" },
    { id: randomUUID(), word: "Dermatology", chinese: "皮膚學", root: "dermat", suffix: "ology" },
    { id: randomUUID(), word: "Nephrectomy", chinese: "腎切除術", root: "nephr", suffix: "ectomy" },
    { id: randomUUID(), word: "Leukemia", chinese: "白血病", root: "leuk", suffix: "emia" },
    { id: randomUUID(), word: "Arthritis", chinese: "關節炎", root: "arthr", suffix: "itis" },
  ],
  teams: Array.from({ length: 7 }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team${index + 1}`,
    password: `team${index + 1}`,
    enabled: true,
  })),
  teachers: [
    {
      id: "teacher-admin",
      name: "系統管理教師",
      username: "admin",
      password: "admin123",
      enabled: true,
    },
  ],
  settings: {
    questionCount: 10,
    durationSeconds: 5 * 60,
    showChinese: true,
    leaderboardMode: "live",
  },
  status: "waiting",
  startedAt: null,
  pausedAt: null,
  elapsedBeforePause: 0,
  records: [],
};

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

function mergeRecords(currentRecords = [], incomingRecords = []) {
  const merged = new Map();
  for (const record of currentRecords) merged.set(record.id, record);
  for (const record of incomingRecords) merged.set(record.id, record);
  return Array.from(merged.values()).sort((a, b) => (a.secondsFromStart ?? 0) - (b.secondsFromStart ?? 0));
}

function isNewMatchStart(currentState, incomingState) {
  return incomingState.status === "running" && incomingState.startedAt && incomingState.startedAt !== currentState.startedAt;
}

function mergeIncomingState(currentState, incomingState) {
  const normalizedIncoming = normalizeState(incomingState);
  if (isNewMatchStart(currentState, normalizedIncoming)) return normalizedIncoming;
  return {
    ...normalizedIncoming,
    records: mergeRecords(currentState.records, normalizedIncoming.records),
  };
}

function sanitizeStateForRole(nextState, role) {
  if (role === "teacher") return nextState;
  return {
    ...nextState,
    teams: nextState.teams.map(({ password, ...team }) => team),
    teachers: [],
  };
}

function getToken(request) {
  const authHeader = request.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length);
  return request.query.token;
}

function getSession(request) {
  const token = getToken(request);
  return token ? sessions.get(token) : null;
}

function createSession(role, id) {
  const token = randomUUID();
  const session = { role, id, token };
  sessions.set(token, session);
  return session;
}

function getEffectiveState() {
  if (state.status !== "running" || !state.startedAt) return state;
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000) + (state.elapsedBeforePause || 0);
  if (elapsed < state.settings.durationSeconds) return state;
  state = { ...state, status: "ended" };
  saveState(state).catch(() => undefined);
  return state;
}

function mergeTeamSubmission(currentState, incomingState, teamId) {
  if (currentState.status !== "running") return currentState;
  const answeredKeys = new Set(currentState.records.map((record) => `${record.teamId}:${record.questionId}`));
  const incomingRecords = (incomingState.records || []).filter((record) => record.teamId === teamId);
  const newRecords = incomingRecords.filter((record) => !answeredKeys.has(`${record.teamId}:${record.questionId}`));
  return {
    ...currentState,
    records: mergeRecords(currentState.records, newRecords),
  };
}

function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("state", sanitizeStateForRole(getEffectiveState(), socket.data.session?.role));
  }
}

async function loadState() {
  await mkdir(dataDir, { recursive: true });
  try {
    const raw = await readFile(stateFile, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    await saveState(defaultState);
    return defaultState;
  }
}

async function saveState(nextState) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
  },
});

app.use(express.json({ limit: "10mb" }));
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

let state = await loadState();
const sessions = new Map();

app.post("/api/login", (request, response) => {
  const account = String(request.body.account || "").trim().toLowerCase();
  const password = String(request.body.password || "");
  const teacher = state.teachers.find((item) => item.enabled && item.username.toLowerCase() === account && item.password === password);
  if (teacher) {
    const session = createSession("teacher", teacher.id);
    response.json({ session, state: sanitizeStateForRole(getEffectiveState(), "teacher") });
    return;
  }

  const team = state.teams.find((item) => item.enabled && item.name.toLowerCase() === account && item.password === password);
  if (team) {
    const session = createSession("team", team.id);
    response.json({ session, state: sanitizeStateForRole(getEffectiveState(), "team") });
    return;
  }

  response.status(401).json({ message: "Invalid account or password." });
});

app.get("/api/state", (request, response) => {
  const session = getSession(request);
  response.json(sanitizeStateForRole(getEffectiveState(), session?.role));
});

app.post("/api/state", async (request, response) => {
  const session = getSession(request);
  if (!session) {
    response.status(401).json({ message: "Login required." });
    return;
  }

  state = session.role === "teacher"
    ? mergeIncomingState(getEffectiveState(), request.body)
    : mergeTeamSubmission(getEffectiveState(), request.body, session.id);
  await saveState(state);
  broadcastState();
  response.json(sanitizeStateForRole(state, session.role));
});

app.post("/api/reset", async (_request, response) => {
  state = defaultState;
  await saveState(state);
  broadcastState();
  response.json(state);
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((_request, response) => {
    response.sendFile(path.join(distDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  socket.data.session = token ? sessions.get(token) : null;
  socket.emit("state", sanitizeStateForRole(getEffectiveState(), socket.data.session?.role));
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Medical match service listening on http://localhost:${port}`);
});
