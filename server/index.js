import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { createDatabase, mergeTeamRecords, readState, replaceState, resetDatabase } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || process.env.API_PORT || 3001);
const db = await createDatabase();

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

async function getEffectiveState() {
  let current = await readState(db);
  if (current.status !== "running" || !current.startedAt) return current;
  const elapsed = Math.floor((Date.now() - current.startedAt) / 1000) + (current.elapsedBeforePause || 0);
  if (elapsed < current.settings.durationSeconds) return current;
  current = await replaceState(db, { ...current, status: "ended" });
  return current;
}

async function mergeTeamSubmission(currentState, incomingState, teamId) {
  if (currentState.status !== "running") return currentState;
  return mergeTeamRecords(db, teamId, incomingState.records || []);
}

async function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("state", sanitizeStateForRole(await getEffectiveState(), socket.data.session?.role));
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

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

app.post("/api/login", asyncRoute(async (request, response) => {
  const state = await readState(db);
  const accountName = String(request.body.account || "").trim();
  const account = accountName.toLowerCase();
  const password = String(request.body.password || "");
  if (!accountName) {
    response.status(400).json({ message: "Account name is required." });
    return;
  }

  const teacher = state.teachers.find((item) => item.enabled && item.username.toLowerCase() === account && item.password === password);
  if (teacher) {
    const session = createSession("teacher", teacher.id);
    response.json({ session, state: sanitizeStateForRole(await getEffectiveState(), "teacher") });
    return;
  }

  if (state.teachers.some((item) => item.username.toLowerCase() === account)) {
    response.status(401).json({ message: "Invalid teacher password." });
    return;
  }

  const team = state.teams.find((item) => item.name.toLowerCase() === account);
  if (team) {
    if (!team.enabled) {
      response.status(401).json({ message: "Team is disabled." });
      return;
    }
    const session = createSession("team", team.id);
    response.json({ session, state: sanitizeStateForRole(await getEffectiveState(), "team") });
    return;
  }

  const nextTeam = { id: randomUUID(), name: accountName, password: "", enabled: true };
  const nextState = await replaceState(db, { ...state, teams: [...state.teams, nextTeam] });
  const session = createSession("team", nextTeam.id);
  await broadcastState();
  response.json({ session, state: sanitizeStateForRole(nextState, "team") });
}));

app.get("/api/state", asyncRoute(async (request, response) => {
  const session = getSession(request);
  response.json(sanitizeStateForRole(await getEffectiveState(), session?.role));
}));

app.post("/api/state", asyncRoute(async (request, response) => {
  const session = getSession(request);
  if (!session) {
    response.status(401).json({ message: "Login required." });
    return;
  }

  const current = await getEffectiveState();
  const state = session.role === "teacher"
    ? await replaceState(db, mergeIncomingState(current, request.body))
    : await mergeTeamSubmission(current, request.body, session.id);
  await broadcastState();
  response.json(sanitizeStateForRole(state, session.role));
}));

app.post("/api/reset", asyncRoute(async (_request, response) => {
  const state = await resetDatabase(db);
  await broadcastState();
  response.json(state);
}));

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((_request, response) => {
    response.sendFile(path.join(distDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  socket.data.session = token ? sessions.get(token) : null;
  getEffectiveState()
    .then((state) => socket.emit("state", sanitizeStateForRole(state, socket.data.session?.role)))
    .catch((error) => socket.emit("state-error", { message: error.message }));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: "Server error." });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Medical match service listening on http://localhost:${port}`);
});
