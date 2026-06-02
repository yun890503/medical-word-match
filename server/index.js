import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { createDatabase, defaultState, mergeTeamRecords, readState, replaceState, resetDatabase } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const dataDir = path.join(__dirname, "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "medical-match.sqlite");
const port = Number(process.env.PORT || process.env.API_PORT || 3001);
const db = createDatabase(dbPath);

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
  if (isNewMatchStart(currentState, incomingState)) return incomingState;
  return {
    ...incomingState,
    records: mergeRecords(currentState.records, incomingState.records),
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
  let current = readState(db);
  if (current.status !== "running" || !current.startedAt) return current;
  const elapsed = Math.floor((Date.now() - current.startedAt) / 1000) + (current.elapsedBeforePause || 0);
  if (elapsed < current.settings.durationSeconds) return current;
  current = replaceState(db, { ...current, status: "ended" });
  return current;
}

function mergeTeamSubmission(currentState, incomingState, teamId) {
  if (currentState.status !== "running") return currentState;
  return mergeTeamRecords(db, teamId, incomingState.records || []);
}

function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("state", sanitizeStateForRole(getEffectiveState(), socket.data.session?.role));
  }
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
  },
});
const sessions = new Map();

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

app.post("/api/login", (request, response) => {
  const state = readState(db);
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

app.post("/api/state", (request, response) => {
  const session = getSession(request);
  if (!session) {
    response.status(401).json({ message: "Login required." });
    return;
  }

  const current = getEffectiveState();
  const state = session.role === "teacher"
    ? replaceState(db, mergeIncomingState(current, request.body))
    : mergeTeamSubmission(current, request.body, session.id);
  broadcastState();
  response.json(sanitizeStateForRole(state, session.role));
});

app.post("/api/reset", (_request, response) => {
  const state = resetDatabase(db);
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
