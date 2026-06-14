import { ChangeEvent, DragEvent, FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileDown, FileSpreadsheet, LogOut, Monitor, Pause, Pencil, Play, Plus, Settings, Trash2, Trophy, Users } from "lucide-react";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { io } from "socket.io-client";

type WordItem = { id: string; word: string; chinese: string; root: string; suffix: string };
type Team = { id: string; name: string; password?: string; enabled: boolean; avatar?: string; loginLocked?: boolean; activeSessionAt?: number | null; activeSessionMatchStartedAt?: number | null };
type Teacher = { id: string; name: string; username: string; password?: string; enabled: boolean };
type Session = { role: "team" | "teacher"; id: string; token: string };
type MatchStatus = "waiting" | "running" | "paused" | "ended";
type View = "student" | "admin" | "screen";

type AnswerRecord = {
  id: string;
  teamId: string;
  teamName: string;
  questionId: string;
  chinese: string;
  selectedRoot: string;
  selectedSuffix: string;
  combined: string;
  correct: boolean;
  answeredAt: string;
  secondsFromStart: number;
};

type SettingsState = {
  questionCount: number;
  durationSeconds: number;
  showChinese: boolean;
  leaderboardMode: "live" | "end";
};

type AppState = {
  words: WordItem[];
  teams: Team[];
  teachers: Teacher[];
  settings: SettingsState;
  status: MatchStatus;
  startedAt: number | null;
  pausedAt: number | null;
  elapsedBeforePause: number;
  records: AnswerRecord[];
};

const STORAGE_KEY = "medical-root-suffix-match-state";
const SESSION_KEY = "medical-root-suffix-match-session";

function getApiOrigin() {
  if (typeof window === "undefined") return "http://localhost:3001";
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname) && window.location.port === "5173";
  if (isLocalDev) return `${window.location.protocol}//${window.location.hostname}:3001`;
  return window.location.origin;
}
const API_ORIGIN = getApiOrigin();
const API_STATE_URL = `${API_ORIGIN}/api/state`;
const API_LOGIN_URL = `${API_ORIGIN}/api/login`;

const avatarOptions = [
  { id: "owl", icon: "🦉", label: "貓頭鷹", color: "#7c4dff" },
  { id: "rocket", icon: "🚀", label: "火箭", color: "#1967d2" },
  { id: "star", icon: "⭐", label: "星星", color: "#f9ab00" },
  { id: "heart", icon: "💖", label: "愛心", color: "#d93025" },
  { id: "brain", icon: "🧠", label: "大腦", color: "#9334e6" },
  { id: "microscope", icon: "🔬", label: "顯微鏡", color: "#00897b" },
  { id: "pill", icon: "💊", label: "膠囊", color: "#e8710a" },
  { id: "dna", icon: "🧬", label: "DNA", color: "#0097a7" },
  { id: "trophy", icon: "🏆", label: "獎盃", color: "#b06000" },
  { id: "lightning", icon: "⚡", label: "閃電", color: "#fbbc04" },
  { id: "leaf", icon: "🍀", label: "幸運草", color: "#188038" },
  { id: "fire", icon: "🔥", label: "火焰", color: "#c5221f" },
] as const;

function getDefaultAvatar(index: number) {
  return avatarOptions[index % avatarOptions.length].id;
}

function getAvatar(avatarId?: string) {
  return avatarOptions.find((avatar) => avatar.id === avatarId) ?? avatarOptions[0];
}

function isImageAvatar(avatar?: string) {
  return Boolean(avatar?.startsWith("data:image/"));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

async function resizeAvatarFile(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("請選擇圖片檔。");
  if (file.type === "image/svg+xml") return readFileAsDataUrl(file);
  const source = await readFileAsDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("圖片讀取失敗。"));
    nextImage.src = source;
  });
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("圖片處理失敗。");
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - sourceSize) / 2;
  const sy = (image.naturalHeight - sourceSize) / 2;
  context.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.82);
}

const defaultWords: WordItem[] = [
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
];

const defaultState: AppState = {
  words: defaultWords,
  teams: Array.from({ length: 12 }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team${index + 1}`,
    password: `team${index + 1}`,
    enabled: true,
    avatar: getDefaultAvatar(index),
  })),
  teachers: [{ id: "teacher-admin", name: "系統管理教師", username: "admin", password: "admin123", enabled: true }],
  settings: { questionCount: 10, durationSeconds: 300, showChinese: true, leaderboardMode: "live" },
  status: "waiting",
  startedAt: null,
  pausedAt: null,
  elapsedBeforePause: 0,
  records: [],
};

const durationOptions = [
  { label: "3 分鐘", value: 180 },
  { label: "5 分鐘", value: 300 },
  { label: "10 分鐘", value: 600 },
  { label: "15 分鐘", value: 900 },
  { label: "20 分鐘", value: 1200 },
];

function normalizeState(partial: Partial<AppState>): AppState {
  return {
    ...defaultState,
    ...partial,
    words: partial.words?.length ? partial.words : defaultState.words,
    teams: partial.teams?.length ? partial.teams.map((team, index) => ({ ...team, avatar: team.avatar || getDefaultAvatar(index) })) : defaultState.teams,
    teachers: partial.teachers ?? [],
    settings: { ...defaultState.settings, ...partial.settings },
    records: partial.records ?? [],
  };
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : defaultState;
  } catch {
    return defaultState;
  }
}

function persistLocalState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return session?.token && session?.role && session?.id ? session : null;
  } catch {
    return null;
  }
}

function persistSession(session: Session | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function cleanCell(value: unknown) {
  return String(value ?? "").trim();
}

function getImportedCell(row: Record<string, unknown>, names: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.trim(), value]));
  for (const name of names) {
    const value = normalized.get(name);
    if (value !== undefined) return cleanCell(value);
  }
  return "";
}

function seededScore(value: string, seed: string) {
  let hash = 2166136261;
  const source = `${seed}:${value}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicShuffle<T>(items: T[], seed: string, getValue: (item: T) => string) {
  return [...items].sort((a, b) => seededScore(getValue(a), seed) - seededScore(getValue(b), seed));
}

function buildOptions(correct: string, values: string[], seed: string, max = 8) {
  const unique = Array.from(new Set(values.filter(Boolean))).filter((value) => normalize(value) !== normalize(correct));
  const distractors = deterministicShuffle(unique, `${seed}:choices`, (value) => value).slice(0, max - 1);
  return deterministicShuffle([correct, ...distractors], `${seed}:final`, (value) => value);
}

function composeWord(root: string, suffix: string, words: WordItem[]) {
  return words.find((word) => normalize(word.root) === normalize(root) && normalize(word.suffix) === normalize(suffix))?.word ?? `${root}${suffix}`;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

function getElapsed(state: AppState, now: number) {
  if (!state.startedAt) return 0;
  if (state.status === "paused" || state.status === "ended") return state.elapsedBeforePause;
  return state.elapsedBeforePause + Math.floor((now - state.startedAt) / 1000);
}

function buildScoreboard(teams: Team[], records: AnswerRecord[]) {
  return teams
    .map((team) => {
      const teamRecords = records.filter((record) => record.teamId === team.id);
      const score = teamRecords.filter((record) => record.correct).length;
      const finishTime = teamRecords.length ? Math.max(...teamRecords.map((record) => record.secondsFromStart)) : Number.MAX_SAFE_INTEGER;
      return { ...team, score, answers: teamRecords.length, finishTime };
    })
    .sort((a, b) => b.score - a.score || a.finishTime - b.finishTime || a.name.localeCompare(b.name));
}

function canDeleteTeacher(teachers: Teacher[], teacherId: string) {
  const teacher = teachers.find((item) => item.id === teacherId);
  if (!teacher?.enabled) return true;
  return teachers.filter((item) => item.enabled && item.id !== teacherId).length > 0;
}

function getNextTeamNumber(teams: Team[]) {
  const usedNumbers = teams
    .map((team) => team.name.match(/^Team(\d+)$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  const maxNumber = usedNumbers.length ? Math.max(...usedNumbers) : teams.length;
  return maxNumber + 1;
}

function App() {
  const [state, setLocalState] = useState<AppState>(loadState);
  const [session, setSession] = useState<Session | null>(loadSession);
  const [view, setView] = useState<View>("student");
  const [now, setNow] = useState(Date.now());
  const [loginNotice, setLoginNotice] = useState("");

  useEffect(() => {
    const token = session?.token;
    let cancelled = false;
    const socket = io(API_ORIGIN, { auth: token ? { token } : undefined });

    fetch(API_STATE_URL, { headers: authHeaders(token) })
      .then(async (response) => {
        if (response.status === 409) {
          const result = await response.json().catch(() => ({ message: "此隊伍已在其他裝置登入，請重新登入。" }));
          setLoginNotice(result.message);
          persistSession(null);
          setSession(null);
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then((remoteState: Partial<AppState> | null) => {
        if (!remoteState || cancelled) return;
        const next = normalizeState(remoteState);
        persistLocalState(next);
        setLocalState(next);
      })
      .catch(() => undefined);

    socket.on("state", (remoteState: Partial<AppState>) => {
      const next = normalizeState(remoteState);
      persistLocalState(next);
      setLocalState(next);
    });
    socket.on("session-expired", (payload: { message?: string }) => {
      setLoginNotice(payload.message || "此隊伍已在其他裝置登入，請重新登入。");
      persistSession(null);
      setSession(null);
      setView("student");
    });

    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, [session?.token]);

  const setState: React.Dispatch<React.SetStateAction<AppState>> = useCallback((action) => {
    setLocalState((current) => {
      const next = normalizeState(typeof action === "function" ? (action as (current: AppState) => AppState)(current) : action);
      persistLocalState(next);
      fetch(API_STATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(session?.token) },
        body: JSON.stringify(next),
      }).then(async (response) => {
        if (response.status !== 409) return;
        const result = await response.json().catch(() => ({ message: "此隊伍已在其他裝置登入，請重新登入。" }));
        setLoginNotice(result.message);
        persistSession(null);
        setSession(null);
      }).catch(() => undefined);
      return next;
    });
  }, [session?.token]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = getElapsed(state, now);
  const remaining = Math.max(0, state.settings.durationSeconds - elapsed);

  useEffect(() => {
    if (state.status === "running" && remaining <= 0) setState((current) => ({ ...current, status: "ended", elapsedBeforePause: current.settings.durationSeconds }));
  }, [remaining, state.status, setState]);

  useEffect(() => {
    if (!session) return;
    if (session.role === "team" && view === "admin") setView("student");
    if (session.role === "teacher" && view === "student") setView("admin");
  }, [session, view]);

  const scoreboard = useMemo(() => buildScoreboard(state.teams, state.records), [state.teams, state.records]);
  const currentTeam = session?.role === "team" ? state.teams.find((team) => team.id === session.id) ?? null : null;
  const currentTeacher = session?.role === "teacher" ? state.teachers.find((teacher) => teacher.id === session.id) ?? null : null;

  function handleLogin(nextSession: Session, nextState: AppState) {
    const normalized = normalizeState(nextState);
    persistLocalState(normalized);
    setLocalState(normalized);
    setLoginNotice("");
    persistSession(nextSession);
    setSession(nextSession);
    setView(nextSession.role === "teacher" ? "admin" : "student");
  }

  function logout() {
    persistSession(null);
    setSession(null);
    setView("student");
  }

  if (!session || (session.role === "team" && !currentTeam) || (session.role === "teacher" && !currentTeacher)) {
    return (
      <div className="app-shell">
        <Header session={null} view={view} setView={setView} onLogout={logout} />
        <LoginPanel onLogin={handleLogin} notice={loginNotice} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Header session={session} view={view} setView={setView} onLogout={logout} />
      {session.role === "team" && view === "student" && currentTeam && (
        <StudentView state={state} setState={setState} team={currentTeam} remaining={remaining} elapsed={elapsed} scoreboard={scoreboard} />
      )}
      {session.role === "teacher" && view === "admin" && currentTeacher && (
        <AdminView state={state} setState={setState} remaining={remaining} scoreboard={scoreboard} currentTeacherId={currentTeacher.id} authToken={session.token} />
      )}
      {view === "screen" && <ScreenView state={state} remaining={remaining} scoreboard={scoreboard} />}
    </div>
  );
}

function Header({ session, view, setView, onLogout }: { session: Session | null; view: View; setView: (view: View) => void; onLogout: () => void }) {
  return (
    <nav className="top-nav">
      <div>
        <p className="eyebrow">Medical English Competition</p>
        <h1>醫學英文字根字尾配對競賽系統</h1>
      </div>
      {session && (
        <div className="nav-actions" aria-label="主要頁面">
          {session.role === "team" && <button className={view === "student" ? "active" : ""} onClick={() => setView("student")}><Users size={18} /> 競賽頁</button>}
          {session.role === "teacher" && <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Settings size={18} /> 教師後台</button>}
          <button className={view === "screen" ? "active" : ""} onClick={() => setView("screen")}><Monitor size={18} /> 大螢幕</button>
          <button onClick={onLogout}><LogOut size={18} /> 登出</button>
        </div>
      )}
    </nav>
  );
}

function LoginPanel({ onLogin, notice }: { onLogin: (session: Session, state: AppState) => void; notice?: string }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(API_LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, password }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({ message: "登入失敗：請確認密碼是否正確，或隊伍是否已被停用。" }));
        setError(result.message || "登入失敗：請確認密碼是否正確，或隊伍是否已被停用。");
        return;
      }
      const result = await response.json() as { session: Session; state: AppState };
      onLogin(result.session, result.state);
    } catch {
      setError("無法連線到後端服務，請確認 npm run dev 已啟動。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-scene" aria-label="字根拼拼樂登入">
        <div className="login-goals">
          <strong>遊戲目標：</strong>
          <span>1.認識英文單字結構（字根加字尾）</span>
          <span>2.練習單字組合與理解能力</span>
          <span>3.加強字彙記憶與猜解能力</span>
        </div>
        <div className="cat-doodle cat-top" aria-hidden="true"><span></span></div>
        <div className="cat-doodle cat-left" aria-hidden="true"><span></span></div>
        <div className="pup pup-small" aria-hidden="true"><span></span></div>
        <div className="pup pup-main" aria-hidden="true"><span></span></div>
        <div className="dog-bowl" aria-hidden="true"><span></span></div>
        <div className="doodle-arrow arrow-left" aria-hidden="true">↜</div>
        <div className="doodle-arrow arrow-right" aria-hidden="true">↷</div>
        <div className="doodle-star star-one" aria-hidden="true">★</div>
        <div className="doodle-star star-two" aria-hidden="true">★</div>
        <div className="title-cloud">
          <p>Medical English Competition</p>
          <h2>字根拼拼樂</h2>
        </div>
        <form className="login-panel" onSubmit={submit}>
          <h2>系統登入</h2>
          <label>教師帳號或隊伍名稱<input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="例如 admin 或 Team1" /></label>
          <label>密碼<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="請輸入教師或隊伍密碼" /></label>
          {notice && <p className="hint">{notice}</p>}
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="primary" disabled={busy}>{busy ? "登入中" : "登入"}</button>
          <p className="hint">隊伍由教師後台建立與管理。</p>
        </form>
      </section>
    </main>
  );
}

function StudentView({ state, setState, team, remaining, elapsed, scoreboard }: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  team: Team;
  remaining: number;
  elapsed: number;
  scoreboard: ReturnType<typeof buildScoreboard>;
}) {
  const score = scoreboard.find((item) => item.id === team.id)?.score ?? 0;
  const rankIndex = scoreboard.findIndex((item) => item.id === team.id);
  const rank = rankIndex >= 0 ? rankIndex + 1 : null;
  const result = rankIndex >= 0 ? scoreboard[rankIndex] : null;
  const [showResult, setShowResult] = useState(false);
  const previousStatus = useRef(state.status);
  const resultNoticeKey = `medical-result-notice:${team.id}:${state.startedAt ?? "manual"}`;
  useEffect(() => {
    const justEnded = previousStatus.current !== "ended" && state.status === "ended";
    previousStatus.current = state.status;
    if (state.status !== "ended") {
      setShowResult(false);
      return;
    }
    if (!justEnded || localStorage.getItem(resultNoticeKey)) return;
    localStorage.setItem(resultNoticeKey, "shown");
    setShowResult(true);
  }, [resultNoticeKey, state.status]);

  useEffect(() => {
    if (!showResult) return;
    const timer = window.setTimeout(() => setShowResult(false), 8000);
    return () => window.clearTimeout(timer);
  }, [showResult]);

  return (
    <main className="student-layout">
      <section className="game-panel">
        <div className="status-bar">
          <strong className="team-title"><TeamAvatar team={team} />{team.name}</strong>
          <span>剩餘時間 {formatTime(remaining)}</span>
          <span>目前得分 {score}</span>
        </div>
        <GameBoard state={state} setState={setState} team={team} elapsed={elapsed} disabled={state.status !== "running" || remaining <= 0} />
      </section>
      <LeaderboardPanel state={state} scoreboard={scoreboard} compact={false} />
      {showResult && rank && result && <TeamResultOverlay rank={rank} result={result} onClose={() => setShowResult(false)} />}
    </main>
  );
}

function TeamResultOverlay({ rank, result, onClose }: {
  rank: number;
  result: ReturnType<typeof buildScoreboard>[number];
  onClose: () => void;
}) {
  const medal = rank === 1 ? { label: "金牌", className: "gold" } : rank === 2 ? { label: "銀牌", className: "silver" } : rank === 3 ? { label: "銅牌", className: "bronze" } : { label: "完成", className: "standard" };
  const finishTime = result.finishTime === Number.MAX_SAFE_INTEGER ? "-" : formatTime(result.finishTime);
  async function shareResult(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const text = `${result.name} 第 ${rank} 名，得分 ${result.score} 分，完成時間 ${finishTime}`;
    if (navigator.share) {
      await navigator.share({ title: "醫學英文競賽結果", text });
      return;
    }
    await navigator.clipboard?.writeText(text);
  }

  return (
    <div className="result-overlay" role="status" aria-live="polite" onClick={onClose}>
      <div className={`result-card podium ${medal.className}`} onClick={(event) => event.stopPropagation()}>
        <div className="podium-confetti" aria-hidden="true"></div>
        <div className={`podium-medal ${medal.className}`}>
          <span className="podium-crown">♛</span>
          <strong>{medal.label}</strong>
          <small>比賽結果</small>
        </div>
        <div className="podium-avatar-ring">
          <TeamAvatar team={result} size="lg" />
        </div>
        <div className="podium-rank-line">
          <span>{result.name}</span>
          <b>第 {rank} 名</b>
        </div>
        <div className="podium-divider"></div>
        <p className="result-score">得分 <strong>{result.score}</strong> 分</p>
        <div className="podium-time"><span>◷</span> 完成時間 <strong>{finishTime}</strong></div>
        <div className="podium-actions">
          <button type="button" onClick={shareResult}>分享結果</button>
          <button className="primary" type="button" onClick={onClose}>回到首頁</button>
        </div>
      </div>
    </div>
  );
}

function TeamAvatar({ team, size = "md" }: { team: Pick<Team, "avatar" | "name">; size?: "sm" | "md" | "lg" }) {
  const avatar = getAvatar(team.avatar);
  if (isImageAvatar(team.avatar)) {
    return <span className={`team-avatar ${size} image`} title={`${team.name}：自訂頭像`} aria-label="自訂頭像"><img src={team.avatar} alt="" /></span>;
  }
  return <span className={`team-avatar ${size}`} style={{ backgroundColor: avatar.color }} title={`${team.name}：${avatar.label}`} aria-label={avatar.label}>{avatar.icon}</span>;
}

function AvatarUpload({ value, onChange, onError, compact = false }: { value: string; onChange: (avatar: string) => void; onError: (message: string) => void; compact?: boolean }) {
  const previewTeam = { name: "隊伍頭像", avatar: value };
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      onChange(await resizeAvatarFile(file));
    } catch (error) {
      onError(error instanceof Error ? error.message : "頭像上傳失敗。");
    } finally {
      event.target.value = "";
    }
  }
  return (
    <div className={compact ? "avatar-uploader compact" : "avatar-uploader"}>
      <TeamAvatar team={previewTeam} size={compact ? "sm" : "md"} />
      <label className="file-button avatar-file">上傳圖片<input type="file" accept="image/*" onChange={upload} /></label>
      {isImageAvatar(value) && <button type="button" onClick={() => onChange(getDefaultAvatar(0))}>恢復預設</button>}
    </div>
  );
}

function getRankStyle(index: number) {
  if (index === 0) return { className: "rank-gold", icon: "冠軍獎盃" };
  if (index === 1) return { className: "rank-silver", icon: "亞軍獎盃" };
  if (index === 2) return { className: "rank-bronze", icon: "銅牌獎盃" };
  return { className: "rank-wood", icon: "木牌" };
}

function GameBoard({ state, setState, team, elapsed, disabled }: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  team: Team;
  elapsed: number;
  disabled: boolean;
}) {
  const answeredIds = state.records.filter((record) => record.teamId === team.id).map((record) => record.questionId);
  const questions = state.words.slice(0, state.settings.questionCount);
  const question = questions.find((item) => !answeredIds.includes(item.id)) ?? null;
  const [selectedRoot, setSelectedRoot] = useState("");
  const [lastResult, setLastResult] = useState<AnswerRecord | null>(null);
  const rootOptions = useMemo(() => (question ? buildOptions(question.root, state.words.map((word) => word.root), `${question.id}:root`) : []), [state.words, question?.id]);
  const suffixOptions = useMemo(() => (question ? buildOptions(question.suffix, state.words.map((word) => word.suffix), `${question.id}:suffix`) : []), [state.words, question?.id]);

  useEffect(() => setSelectedRoot(""), [question?.id]);

  function answer(root: string, suffix: string) {
    if (!question || disabled) return;
    const combined = composeWord(root, suffix, state.words);
    const correct = normalize(question.root) === normalize(root) && normalize(question.suffix) === normalize(suffix) && normalize(question.word) === normalize(combined);
    const record: AnswerRecord = {
      id: crypto.randomUUID(),
      teamId: team.id,
      teamName: team.name,
      questionId: question.id,
      chinese: question.chinese,
      selectedRoot: root,
      selectedSuffix: suffix,
      combined,
      correct,
      answeredAt: new Date().toLocaleString("zh-TW"),
      secondsFromStart: elapsed,
    };
    setLastResult(record);
    setSelectedRoot("");
    setState((current) => ({ ...current, records: [...current.records, record] }));
  }

  function onDrop(event: DragEvent<HTMLButtonElement>, suffix: string) {
    answer(event.dataTransfer.getData("text/plain"), suffix);
  }

  if (disabled) {
    return <div className="empty-state"><h2>{state.status === "ended" ? "比賽已結束" : state.status === "paused" ? "比賽暫停中" : "等待教師開始比賽"}</h2><p>開始後即可進行字根與字尾配對。</p></div>;
  }
  if (!question) {
    return <div className="empty-state"><h2>本次題目已完成</h2><p>請等待比賽結束後查看排名。</p></div>;
  }

  return (
    <div className="game-board">
      <div className="question-band"><span>題目</span><strong>{state.settings.showChinese ? question.chinese : "請配對正確字根與字尾"}</strong></div>
      <div className="option-grid">
        <section>
          <h3>字根區 Root</h3>
          <div className="chips">
            {rootOptions.map((root, index) => (
              <button key={`${root}-${index}`} draggable className={`chip root ${selectedRoot === root ? "selected" : ""}`} onDragStart={(event) => event.dataTransfer.setData("text/plain", root)} onClick={() => setSelectedRoot(root)}>{root}</button>
            ))}
          </div>
        </section>
        <section>
          <h3>字尾區 Suffix</h3>
          <div className="chips">
            {suffixOptions.map((suffix, index) => (
              <button key={`${suffix}-${index}`} className="chip suffix" onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, suffix)} onClick={() => selectedRoot && answer(selectedRoot, suffix)}>{suffix}</button>
            ))}
          </div>
        </section>
      </div>
      {lastResult && <div className={`result-line ${lastResult.correct ? "correct" : "wrong"}`}>{lastResult.correct ? "答對" : "答錯"}：{lastResult.combined}</div>}
    </div>
  );
}

function LeaderboardPanel({ state, scoreboard, compact }: { state: AppState; scoreboard: ReturnType<typeof buildScoreboard>; compact: boolean }) {
  const visible = state.settings.leaderboardMode === "live" || state.status === "ended";
  return (
    <aside className={compact ? "leaderboard compact" : "leaderboard"}>
      <h2><Trophy size={20} /> 排行榜</h2>
      {!visible && <p className="hint">教師設定為比賽結束後公布。</p>}
      {visible && (
        <table className="leaderboard-table">
          <thead><tr><th>排名</th><th>隊伍</th><th>分數</th><th>完成時間</th></tr></thead>
          <tbody>{scoreboard.map((team, index) => {
            const rankStyle = getRankStyle(index);
            return <tr key={team.id} className={rankStyle.className}><td><span className="rank-icon">{rankStyle.icon}</span><strong>{index + 1}</strong></td><td><span className="leaderboard-team"><TeamAvatar team={team} size="sm" />{team.name}</span></td><td>{team.score}</td><td>{team.finishTime === Number.MAX_SAFE_INTEGER ? "-" : formatTime(team.finishTime)}</td></tr>;
          })}</tbody>
        </table>
      )}
    </aside>
  );
}

function AdminView({ state, setState, remaining, scoreboard, currentTeacherId, authToken }: {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  remaining: number;
  scoreboard: ReturnType<typeof buildScoreboard>;
  currentTeacherId: string;
  authToken: string;
}) {
  const nextTeamNumber = getNextTeamNumber(state.teams);
  const [wordDraft, setWordDraft] = useState<WordItem>({ id: "", chinese: "", word: "", root: "", suffix: "" });
  const [teamDraft, setTeamDraft] = useState<Team>({ id: "", name: `Team${nextTeamNumber}`, password: `team${nextTeamNumber}`, enabled: true, avatar: getDefaultAvatar(nextTeamNumber - 1) });
  const [teacherDraft, setTeacherDraft] = useState<Teacher>({ id: "", name: "", username: "", password: "", enabled: true });
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [teacherError, setTeacherError] = useState("");
  const [teamError, setTeamError] = useState("");
  const [teamMessage, setTeamMessage] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [customMinutes, setCustomMinutes] = useState(Math.round(state.settings.durationSeconds / 60).toString());

  function startMatch() {
    setState((current) => ({ ...current, status: "running", startedAt: Date.now(), pausedAt: null, elapsedBeforePause: current.status === "paused" ? current.elapsedBeforePause : 0, records: current.status === "paused" ? current.records : [] }));
  }
  function pauseMatch() {
    setState((current) => ({ ...current, status: "paused", pausedAt: Date.now(), elapsedBeforePause: getElapsed(current, Date.now()) }));
  }
  function endMatch() {
    setState((current) => ({ ...current, status: "ended", elapsedBeforePause: current.settings.durationSeconds }));
  }
  function getBlankTeamDraft(teams = state.teams) {
    const number = getNextTeamNumber(teams);
    return { id: "", name: `Team${number}`, password: `team${number}`, enabled: true, avatar: getDefaultAvatar(number - 1) };
  }
  function openNewTeamModal() {
    setTeamDraft(getBlankTeamDraft());
    setTeamError("");
    setTeamMessage("");
    setTeamModalOpen(true);
  }
  function openEditTeamModal(team: Team) {
    setTeamDraft({ ...team, password: team.password ?? "", avatar: team.avatar || getDefaultAvatar(0) });
    setTeamError("");
    setTeamMessage("");
    setTeamModalOpen(true);
  }
  function closeTeamModal() {
    setTeamModalOpen(false);
    setTeamDraft(getBlankTeamDraft());
    setTeamError("");
  }
  function saveTeam(event: FormEvent) {
    event.preventDefault();
    setTeamMessage("");
    const name = teamDraft.name.trim();
    const password = (teamDraft.password ?? "").trim();
    if (!name || !password) {
      setTeamError("請輸入隊伍名稱與密碼。");
      return;
    }
    const duplicate = state.teams.some((team) => team.id !== teamDraft.id && normalize(team.name) === normalize(name));
    if (duplicate) {
      setTeamError("隊伍名稱已存在。");
      return;
    }
    const next = { ...teamDraft, id: teamDraft.id || crypto.randomUUID(), name, password };
    setState((current) => ({ ...current, teams: teamDraft.id ? current.teams.map((team) => team.id === teamDraft.id ? next : team) : [...current.teams, next] }));
    const nextNumber = getNextTeamNumber([...state.teams, next]);
    setTeamDraft({ id: "", name: `Team${nextNumber}`, password: `team${nextNumber}`, enabled: true, avatar: getDefaultAvatar(nextNumber - 1) });
    setTeamError("");
    setTeamMessage(teamDraft.id ? "隊伍資料已儲存。" : "已新增隊伍。");
    setTeamModalOpen(false);
  }
  function deleteTeam(teamId: string) {
    setState((current) => ({
      ...current,
      teams: current.teams.filter((team) => team.id !== teamId),
      records: current.records.filter((record) => record.teamId !== teamId),
    }));
  }
  async function unlockTeam(teamId: string) {
    setTeamError("");
    setTeamMessage("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/teams/${teamId}/unlock`, {
        method: "POST",
        headers: authHeaders(authToken),
      });
      const result = await response.json();
      if (!response.ok) {
        setTeamError(result.message || "解除登入鎖失敗。");
        return;
      }
      setState(normalizeState(result));
      setTeamMessage("已解除登入鎖。");
    } catch {
      setTeamError("解除登入鎖失敗，請確認後端服務是否正常。");
    }
  }
  function saveWord(event: FormEvent) {
    event.preventDefault();
    const next = { ...wordDraft, id: wordDraft.id || crypto.randomUUID() };
    setState((current) => ({ ...current, words: wordDraft.id ? current.words.map((word) => word.id === wordDraft.id ? next : word) : [...current.words, next] }));
    setWordDraft({ id: "", chinese: "", word: "", root: "", suffix: "" });
  }
  function saveTeacher(event: FormEvent) {
    event.preventDefault();
    const duplicate = state.teachers.some((teacher) => normalize(teacher.username) === normalize(teacherDraft.username) && teacher.id !== teacherDraft.id);
    if (duplicate) {
      setTeacherError("此教師帳號已存在。");
      return;
    }
    const next = { ...teacherDraft, id: teacherDraft.id || crypto.randomUUID() };
    setState((current) => ({ ...current, teachers: teacherDraft.id ? current.teachers.map((teacher) => teacher.id === teacherDraft.id ? next : teacher) : [...current.teachers, next] }));
    setTeacherDraft({ id: "", name: "", username: "", password: "", enabled: true });
    setTeacherError("");
  }
  function setTeacherEnabled(teacher: Teacher, enabled: boolean) {
    if (!enabled && !canDeleteTeacher(state.teachers, teacher.id)) {
      setTeacherError("至少需要保留一個啟用中的教師帳號。");
      return;
    }
    setState((current) => ({ ...current, teachers: current.teachers.map((item) => item.id === teacher.id ? { ...item, enabled } : item) }));
  }
  function deleteTeacher(teacherId: string) {
    if (!canDeleteTeacher(state.teachers, teacherId)) {
      setTeacherError("不能刪除最後一個啟用中的教師帳號。");
      return;
    }
    setState((current) => ({ ...current, teachers: current.teachers.filter((teacher) => teacher.id !== teacherId) }));
  }
  function importExcel(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        const imported = rows.map((row) => ({
          id: crypto.randomUUID(),
          chinese: getImportedCell(row, ["中文", "中文名稱", "Chinese"]),
          word: getImportedCell(row, ["完整單字", "單字", "Example of Usage", "Example", "Word"]),
          root: getImportedCell(row, ["字根", "Root", "Stem", "Prefix"]),
          suffix: getImportedCell(row, ["字尾", "Suffix"]),
        })).filter((row) => row.chinese && row.word && row.root && row.suffix);
        if (imported.length === 0) {
          setImportMessage("匯入失敗：Excel 需要包含「中文名稱、完整單字、字根、字尾」欄位。");
          return;
        }
        setState((current) => ({ ...current, words: [...current.words, ...imported] }));
        setImportMessage(`已匯入 ${imported.length} 筆詞彙。`);
      } catch {
        setImportMessage("匯入失敗：請確認檔案是 .xlsx 或 .xls，且第一列是欄位名稱。");
      } finally {
        event.target.value = "";
      }
    };
    reader.onerror = () => {
      setImportMessage("匯入失敗：讀取檔案時發生錯誤。");
      event.target.value = "";
    };
    reader.readAsArrayBuffer(file);
  }
  function exportExcel() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(scoreboard.map((team, index) => ({ 排名: index + 1, 隊伍: team.name, 分數: team.score, 作答數: team.answers }))), "排名");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(state.records), "作答紀錄");
    XLSX.writeFile(workbook, "medical-match-results.xlsx");
  }
  function exportPdf() {
    const doc = new jsPDF();
    doc.text("Medical Root Suffix Match Results", 14, 18);
    scoreboard.forEach((team, index) => doc.text(`${index + 1}. ${team.name} - Score: ${team.score}, Answers: ${team.answers}`, 14, 32 + index * 8));
    const recordStartY = 40 + scoreboard.length * 8;
    doc.text("Answer Records", 14, recordStartY);
    state.records.slice(0, 26).forEach((record, index) => {
      const answer = `${record.teamName}: ${record.selectedRoot}+${record.selectedSuffix} -> ${record.combined} (${record.correct ? "Correct" : "Wrong"})`;
      doc.text(answer.slice(0, 95), 14, recordStartY + 10 + index * 7);
    });
    doc.save("medical-match-results.pdf");
  }

  return (
    <main className="admin-layout">
      <section className="control-strip">
        <div><p className="eyebrow">比賽狀態</p><strong>{state.status.toUpperCase()} / {formatTime(remaining)}</strong></div>
        <button className="primary" onClick={startMatch}><Play size={18} /> 開始比賽</button>
        <button onClick={pauseMatch} disabled={state.status !== "running"}><Pause size={18} /> 暫停</button>
        <button onClick={endMatch}><Trophy size={18} /> 結束比賽</button>
      </section>
      <section className="admin-grid">
        <div className="panel">
          <h2>題目與計時設定</h2>
          <label>本次出題數量<select value={state.settings.questionCount} onChange={(event) => setState({ ...state, settings: { ...state.settings, questionCount: Number(event.target.value) } })}>{[10, 20, 30, 50].map((count) => <option key={count} value={count}>{count} 題</option>)}</select></label>
          <label>測驗總時間<select value={durationOptions.some((item) => item.value === state.settings.durationSeconds) ? state.settings.durationSeconds : "custom"} onChange={(event) => event.target.value !== "custom" && setState({ ...state, settings: { ...state.settings, durationSeconds: Number(event.target.value) } })}>{durationOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}<option value="custom">自訂</option></select></label>
          <label>自訂分鐘<input value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value)} onBlur={() => setState({ ...state, settings: { ...state.settings, durationSeconds: Math.max(1, Number(customMinutes) || 5) * 60 } })} /></label>
          <label className="inline-check"><input type="checkbox" checked={state.settings.showChinese} onChange={(event) => setState({ ...state, settings: { ...state.settings, showChinese: event.target.checked } })} />前台顯示中文意思</label>
          <label>排行榜公布方式<select value={state.settings.leaderboardMode} onChange={(event) => setState({ ...state, settings: { ...state.settings, leaderboardMode: event.target.value as SettingsState["leaderboardMode"] } })}><option value="live">即時更新</option><option value="end">比賽結束後公布</option></select></label>
        </div>
        <div className="panel">
          <h2>單字題庫管理</h2>
          <form className="word-form" onSubmit={saveWord}>
            <input placeholder="中文名稱" value={wordDraft.chinese} onChange={(event) => setWordDraft({ ...wordDraft, chinese: event.target.value })} required />
            <input placeholder="完整單字" value={wordDraft.word} onChange={(event) => setWordDraft({ ...wordDraft, word: event.target.value })} required />
            <input placeholder="字根" value={wordDraft.root} onChange={(event) => setWordDraft({ ...wordDraft, root: event.target.value })} required />
            <input placeholder="字尾" value={wordDraft.suffix} onChange={(event) => setWordDraft({ ...wordDraft, suffix: event.target.value })} required />
            <button className="primary" type="submit">儲存</button>
          </form>
          <label className="file-button"><FileSpreadsheet size={18} /> 匯入 Excel<input type="file" accept=".xlsx,.xls" onChange={importExcel} /></label>
          {importMessage && <p className="hint">{importMessage}</p>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>中文名稱</th>
                  <th>完整單字</th>
                  <th>字根</th>
                  <th>字尾</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.words.map((word) => (
                  <tr key={word.id}>
                    <td>{word.chinese}</td>
                    <td>{word.word}</td>
                    <td className="root-text">{word.root}</td>
                    <td>{word.suffix}</td>
                    <td>
                      <button onClick={() => setWordDraft(word)}>修改</button>
                      <button onClick={() => setState({ ...state, words: state.words.filter((item) => item.id !== word.id) })}>刪除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel team-management-panel">
          <div className="panel-heading">
            <div>
              <h2>隊伍管理</h2>
              <p className="hint">管理參賽隊伍與頭像設定</p>
            </div>
            <button className="primary" type="button" onClick={openNewTeamModal}><Plus size={18} /> 新增隊伍</button>
          </div>
          {teamError && <p className="error-text">{teamError}</p>}
          {teamMessage && <p className="hint">{teamMessage}</p>}
          <div className="team-list-header">現有隊伍（{state.teams.length} 隊）</div>
          <div className="team-card-list">
            {state.teams.map((team) => (
              <div className="team-card-row" key={team.id}>
                <span className="team-drag-handle">⋮⋮</span>
                <div className="team-card-main">
                  <TeamAvatar team={team} />
                  <div>
                    <strong>{team.name}</strong>
                    <span>{team.password || "未設定密碼"}</span>
                  </div>
                </div>
                <div className="team-avatar-summary">
                  <TeamAvatar team={team} size="sm" />
                  <div>
                    <span>頭像</span>
                    <strong>{isImageAvatar(team.avatar) ? "自訂圖片" : getAvatar(team.avatar).label}</strong>
                  </div>
                </div>
                <span className={team.loginLocked ? "lock-status locked" : "lock-status"}>{team.loginLocked ? "已登入鎖定" : "未登入"}</span>
                <label className="inline-check"><input type="checkbox" checked={team.enabled} onChange={(event) => setState({ ...state, teams: state.teams.map((item) => item.id === team.id ? { ...item, enabled: event.target.checked } : item) })} />啟用</label>
                <div className="team-card-actions">
                  <button type="button" onClick={() => openEditTeamModal(team)}><Pencil size={16} /> 編輯</button>
                  <button type="button" onClick={() => unlockTeam(team.id)} disabled={!team.loginLocked}>解除登入鎖</button>
                  <button type="button" className="danger" onClick={() => deleteTeam(team.id)}><Trash2 size={16} /> 刪除</button>
                </div>
              </div>
            ))}
          </div>
          <div className="team-list-footnote">拖曳排序預留區：目前依建立順序顯示。</div>
          <div className="team-legend">
            <span><b className="dot green"></b>已登入鎖定：隊伍正在登入中</span>
            <span><b className="dot blue"></b>啟用：可在登入頁使用</span>
          </div>
        </div>
        <div className="panel">
          <h2>教師帳號管理</h2>
          <form className="teacher-form" onSubmit={saveTeacher}>
            <input placeholder="教師姓名" value={teacherDraft.name} onChange={(event) => setTeacherDraft({ ...teacherDraft, name: event.target.value })} required />
            <input placeholder="登入帳號" value={teacherDraft.username} onChange={(event) => setTeacherDraft({ ...teacherDraft, username: event.target.value })} required />
            <input placeholder="密碼" value={teacherDraft.password ?? ""} onChange={(event) => setTeacherDraft({ ...teacherDraft, password: event.target.value })} required />
            <label className="inline-check"><input type="checkbox" checked={teacherDraft.enabled} onChange={(event) => setTeacherDraft({ ...teacherDraft, enabled: event.target.checked })} />啟用</label>
            <button className="primary" type="submit">{teacherDraft.id ? "更新教師" : "新增教師"}</button>
          </form>
          {teacherError && <p className="error-text">{teacherError}</p>}
          <div className="table-scroll"><table><thead><tr><th>姓名</th><th>帳號</th><th>密碼</th><th>狀態</th><th>操作</th></tr></thead><tbody>{state.teachers.map((teacher) => <tr key={teacher.id}><td>{teacher.name}</td><td>{teacher.username}</td><td>{teacher.password}</td><td>{teacher.enabled ? "啟用" : "停用"}</td><td><button onClick={() => setTeacherDraft(teacher)}>修改</button><button onClick={() => setTeacherEnabled(teacher, !teacher.enabled)}>{teacher.enabled ? "停用" : "啟用"}</button><button disabled={teacher.id === currentTeacherId && !canDeleteTeacher(state.teachers, teacher.id)} onClick={() => deleteTeacher(teacher.id)}>刪除</button></td></tr>)}</tbody></table></div>
        </div>
        <div className="panel">
          <h2>成績管理</h2>
          <div className="export-actions"><button onClick={exportExcel}><Download size={18} /> 匯出 Excel</button><button onClick={exportPdf}><FileDown size={18} /> 匯出 PDF</button></div>
          <LeaderboardPanel state={state} scoreboard={scoreboard} compact />
          <h3>作答紀錄</h3>
          {state.records.length === 0 ? <p className="hint">目前尚無作答紀錄。</p> : <div className="table-scroll"><table><thead><tr><th>時間</th><th>隊伍</th><th>題目</th><th>選擇內容</th><th>組合結果</th><th>判定</th><th>作答秒數</th></tr></thead><tbody>{[...state.records].reverse().map((record) => <tr key={record.id}><td>{record.answeredAt}</td><td>{record.teamName}</td><td>{record.chinese}</td><td>{record.selectedRoot} + {record.selectedSuffix}</td><td>{record.combined}</td><td>{record.correct ? "答對" : "答錯"}</td><td>{formatTime(record.secondsFromStart)}</td></tr>)}</tbody></table></div>}
        </div>
      </section>
      {teamModalOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeTeamModal}>
          <form className="team-modal" onSubmit={saveTeam} onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">{teamDraft.id ? "Edit Team" : "New Team"}</p>
                <h2>{teamDraft.id ? "編輯隊伍" : "新增隊伍"}</h2>
              </div>
              <button type="button" onClick={closeTeamModal}>關閉</button>
            </div>
            <label>隊伍名稱<input placeholder="隊伍名稱" value={teamDraft.name} onChange={(event) => setTeamDraft({ ...teamDraft, name: event.target.value })} required /></label>
            <label>密碼<input placeholder="密碼" value={teamDraft.password ?? ""} onChange={(event) => setTeamDraft({ ...teamDraft, password: event.target.value })} required /></label>
            <div className="modal-avatar-field">
              <span>隊伍頭像</span>
              <AvatarUpload value={teamDraft.avatar || getDefaultAvatar(nextTeamNumber - 1)} onChange={(avatar) => setTeamDraft({ ...teamDraft, avatar })} onError={setTeamError} />
            </div>
            <label className="inline-check"><input type="checkbox" checked={teamDraft.enabled} onChange={(event) => setTeamDraft({ ...teamDraft, enabled: event.target.checked })} />啟用此隊伍</label>
            {teamError && <p className="error-text">{teamError}</p>}
            <div className="modal-actions">
              <button type="button" onClick={closeTeamModal}>取消</button>
              <button className="primary" type="submit">{teamDraft.id ? "儲存變更" : "新增隊伍"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function ScreenView({ state, remaining, scoreboard }: { state: AppState; remaining: number; scoreboard: ReturnType<typeof buildScoreboard> }) {
  return (
    <main className="screen-view">
      <div className="screen-time">{formatTime(remaining)}</div>
      <p>{state.status === "running" ? "競賽進行中" : state.status === "paused" ? "暫停中" : state.status === "ended" ? "競賽結束" : "等待開始"}</p>
      <LeaderboardPanel state={{ ...state, settings: { ...state.settings, leaderboardMode: "live" } }} scoreboard={scoreboard} compact={false} />
    </main>
  );
}

export default App;
