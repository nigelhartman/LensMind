/**
 * SpatialCognition backend
 * -------------------------
 * Zero-dependency Node.js server (no `npm install` required).
 *
 * Responsibilities:
 *   - Receive the user's top-down (x, y) position from the Snap Spectacles lens.
 *   - Create a new session every time the game board is (re)placed on the ground.
 *   - Persist every session to disk so history survives restarts.
 *   - Serve a live web frontend and push updates in real time via SSE.
 *
 * HTTP API (all JSON, CORS-open so the lens can reach it):
 *   POST /api/session            -> { boardWidth, boardHeight, label? }        => { sessionId }
 *   POST /api/position           -> { sessionId, x, y }                         => { ok: true }
 *   GET  /api/sessions           -> list of session summaries (newest first)
 *   GET  /api/sessions/:id       -> full session incl. all points
 *   DELETE /api/sessions/:id     -> remove a session
 *   GET  /api/stream             -> Server-Sent Events (live points + session events)
 *   GET  /                       -> web frontend (public/index.html)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Minimal .env loader (no dependency) + OpenRouter (Gemini) client
// ---------------------------------------------------------------------------
const ENV = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env */
}
const OPENROUTER_KEY = process.env.OPENROUTER || ENV.OPENROUTER || "";
const AI_MODEL = "google/gemini-3.5-flash";

function callOpenRouter(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: AI_MODEL, messages });
    const req = https.request(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + OPENROUTER_KEY,
          "Content-Length": Buffer.byteLength(payload),
          "HTTP-Referer": "http://localhost:" + PORT,
          "X-Title": "LensMind",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (res.statusCode !== 200) {
              return reject(new Error((j.error && j.error.message) || "HTTP " + res.statusCode));
            }
            resolve((j.choices && j.choices[0] && j.choices[0].message.content) || "");
          } catch (e) {
            reject(new Error("Bad AI response: " + data.slice(0, 200)));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, object>} sessionId -> session object (kept in memory) */
const sessions = new Map();

function sessionFile(id) {
  return path.join(DATA_DIR, id + ".json");
}

function saveSession(session) {
  try {
    fs.writeFileSync(sessionFile(session.id), JSON.stringify(session));
  } catch (err) {
    console.error("Failed to save session", session.id, err);
  }
}

function loadSessions() {
  let files;
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      if (s && s.id) sessions.set(s.id, s);
    } catch (err) {
      console.error("Skipping unreadable session file", f, err.message);
    }
  }
  console.log(`Loaded ${sessions.size} session(s) from disk.`);
}

function summary(s) {
  const pts = s.points;
  return {
    id: s.id,
    label: s.label,
    createdAt: s.createdAt,
    boardWidth: s.boardWidth,
    boardHeight: s.boardHeight,
    pointCount: pts.length,
    maxNumber: s.maxNumber || (s.waypoints ? s.waypoints.length : 0),
    waypointCount: s.waypoints ? s.waypoints.length : 0,
    reachedCount: s.events ? s.events.length : 0,
    patientId: s.patientId || null,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
    hasAnalysis: !!s.analysis,
    lastAt: pts.length ? pts[pts.length - 1].t : s.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Patients (persisted as a single JSON file)
// ---------------------------------------------------------------------------

const PATIENTS_FILE = path.join(DATA_DIR, "patients.json");

/** @type {Map<string, object>} patientId -> patient */
const patients = new Map();

function savePatients() {
  try {
    fs.writeFileSync(PATIENTS_FILE, JSON.stringify([...patients.values()]));
  } catch (err) {
    console.error("Failed to save patients", err);
  }
}

function loadPatients() {
  try {
    const arr = JSON.parse(fs.readFileSync(PATIENTS_FILE, "utf8"));
    if (Array.isArray(arr)) for (const p of arr) if (p && p.id) patients.set(p.id, p);
  } catch {
    /* no file yet */
  }
  console.log(`Loaded ${patients.size} patient(s) from disk.`);
}

function ageYears(bd) {
  if (!bd) return null;
  const d = new Date(bd);
  if (isNaN(d)) return null;
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}

/** Compact raw-data object describing a finished run, for the AI prompt. */
function buildAnalysisData(s) {
  const start = s.startedAt || s.createdAt;
  const end = s.endedAt || (s.points.length ? s.points[s.points.length - 1].t : start);
  const traj = s.points.filter((p) => p.t >= start && (!s.endedAt || p.t <= s.endedAt));
  let dist = 0;
  for (let i = 1; i < traj.length; i++) {
    dist += Math.hypot(traj[i].x - traj[i - 1].x, traj[i].y - traj[i - 1].y);
  }
  const hrs = s.points.filter((p) => p.hr > 0).map((p) => p.hr);
  const hr = hrs.length
    ? { minBpm: Math.min(...hrs), maxBpm: Math.max(...hrs), avgBpm: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) }
    : null;
  // Optimal route = straight lines through the targets in order; efficiency ratio
  // compares the actual walked distance to that ideal (1.0 = perfectly direct).
  const wps = (s.waypoints || []).slice().sort((a, b) => a.n - b.n);
  let optimal = 0;
  for (let i = 1; i < wps.length; i++) {
    optimal += Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y);
  }
  const patient = s.patientId ? patients.get(s.patientId) : null;
  return {
    boardSizeMeters: { width: s.boardWidth, height: s.boardHeight },
    numberOfTargets: s.waypoints ? s.waypoints.length : 0,
    totalTimeSeconds: +((end - start) / 1000).toFixed(1),
    totalDistanceMeters: +dist.toFixed(2),
    optimalPathMeters: +optimal.toFixed(2),
    pathEfficiencyRatio: optimal > 0 ? +(dist / optimal).toFixed(2) : null,
    reaches: (s.events || []).map((e) => ({
      target: e.n,
      elapsedSeconds: +(e.elapsedMs / 1000).toFixed(1),
      splitSeconds: +(e.splitMs / 1000).toFixed(1),
    })),
    heartRate: hr,
    patient: patient ? { gender: patient.gender, ageYears: ageYears(patient.birthday) } : null,
  };
}

// ---------------------------------------------------------------------------
// Server-Sent Events (live push to browser frontends)
// ---------------------------------------------------------------------------

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  setCors(res);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    return res.end();
  }

  // ---- Live stream (SSE) ----
  if (pathname === "/api/stream" && req.method === "GET") {
    setCors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    // Send current patients + session list so the client can populate immediately.
    res.write(`event: patients\ndata: ${JSON.stringify([...patients.values()])}\n\n`);
    res.write(`event: sessions\ndata: ${JSON.stringify([...sessions.values()].map(summary))}\n\n`);
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // ---- Create a session (board placed) ----
  if (pathname === "/api/session" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    // waypoints: [{ n, x, y }] in board-frame meters, sent by the lens on placement.
    const waypoints = Array.isArray(body.waypoints)
      ? body.waypoints
          .map((w) => ({ n: Number(w.n), x: Number(w.x), y: Number(w.y) }))
          .filter((w) => Number.isFinite(w.n) && Number.isFinite(w.x) && Number.isFinite(w.y))
          .sort((a, b) => a.n - b.n)
      : [];
    const session = {
      id,
      label: body.label || null,
      createdAt: now,
      boardWidth: Number(body.boardWidth) || 2,
      boardHeight: Number(body.boardHeight) || 2,
      maxNumber: Number(body.maxNumber) || waypoints.length,
      waypoints,
      events: [], // [{ n, t, elapsedMs, splitMs }] each time a number is reached
      points: [],
      patientId: patients.has(body.patientId) ? body.patientId : null,
      startedAt: null, // set when the user first steps into the board
      endedAt: null, // set when the last number is reached
    };
    sessions.set(id, session);
    saveSession(session);
    broadcast("session", summary(session));
    console.log(`New session ${id} (board ${session.boardWidth}x${session.boardHeight}, ${waypoints.length} waypoints)`);
    return sendJson(res, 200, { sessionId: id });
  }

  // ---- Ingest a position ----
  if (pathname === "/api/position" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "Unknown session" });
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return sendJson(res, 400, { error: "x and y must be numbers" });
    }
    const point = { x, y, t: Date.now() };
    const hr = Number(body.hr);
    if (Number.isFinite(hr) && hr > 0) point.hr = hr; // optional heart rate (bpm)
    session.points.push(point);
    saveSession(session);
    broadcast("point", { sessionId: session.id, ...point });
    return sendJson(res, 200, { ok: true, count: session.points.length });
  }

  // ---- Run started (user stepped into the board) ----
  if (pathname === "/api/start" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "Unknown session" });
    if (!session.startedAt) {
      session.startedAt = Date.now();
      saveSession(session);
      broadcast("start", { sessionId: session.id, startedAt: session.startedAt });
      console.log(`Session ${session.id}: started (entered board)`);
    }
    return sendJson(res, 200, { ok: true, startedAt: session.startedAt });
  }

  // ---- Waypoint reached (user stood on a number) ----
  if (pathname === "/api/waypoint" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const session = sessions.get(body.sessionId);
    if (!session) return sendJson(res, 404, { error: "Unknown session" });
    const n = Number(body.n);
    if (!Number.isFinite(n)) return sendJson(res, 400, { error: "n must be a number" });
    if (!session.events) session.events = [];
    // Ignore duplicates for the same number.
    if (session.events.some((e) => e.n === n)) {
      return sendJson(res, 200, { ok: true, duplicate: true });
    }
    const now = Date.now();
    // Timing is relative to when the user stepped into the board (fallback: creation).
    if (!session.startedAt) {
      session.startedAt = now;
      broadcast("start", { sessionId: session.id, startedAt: session.startedAt });
    }
    const elapsedMs = now - session.startedAt;
    const prev = session.events[session.events.length - 1];
    const splitMs = prev ? now - prev.t : elapsedMs;
    const event = { n, t: now, elapsedMs, splitMs };
    session.events.push(event);
    // Reaching the final number ends the run.
    const total = session.waypoints ? session.waypoints.length : 0;
    if (total > 0 && session.events.length >= total && !session.endedAt) {
      session.endedAt = now;
      broadcast("end", { sessionId: session.id, endedAt: session.endedAt });
      console.log(`Session ${session.id}: finished in ${((now - session.startedAt) / 1000).toFixed(1)}s`);
    }
    saveSession(session);
    broadcast("waypoint", { sessionId: session.id, ...event });
    console.log(`Session ${session.id}: reached #${n} at ${(elapsedMs / 1000).toFixed(1)}s`);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Patients: list ----
  if (pathname === "/api/patients" && req.method === "GET") {
    const list = [...patients.values()].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );
    return sendJson(res, 200, list);
  }

  // ---- Patients: create ----
  if (pathname === "/api/patients" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const name = (body.name || "").toString().trim();
    if (!name) return sendJson(res, 400, { error: "name is required" });
    const patient = {
      id: crypto.randomUUID(),
      name,
      birthday: body.birthday ? String(body.birthday) : null, // "YYYY-MM-DD"
      gender: body.gender ? String(body.gender) : "Unspecified",
      createdAt: Date.now(),
    };
    patients.set(patient.id, patient);
    savePatients();
    broadcast("patient", patient);
    console.log(`New patient ${patient.id} (${patient.name})`);
    return sendJson(res, 200, patient);
  }

  // ---- Patients: update / delete ----
  const patientMatch = pathname.match(/^\/api\/patients\/([^/]+)$/);
  if (patientMatch) {
    const pid = patientMatch[1];
    const patient = patients.get(pid);
    if (!patient) return sendJson(res, 404, { error: "Not found" });
    if (req.method === "PATCH") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
      if (body.name !== undefined) patient.name = String(body.name).trim() || patient.name;
      if (body.birthday !== undefined) patient.birthday = body.birthday ? String(body.birthday) : null;
      if (body.gender !== undefined) patient.gender = String(body.gender);
      savePatients();
      broadcast("patient", patient);
      return sendJson(res, 200, patient);
    }
    if (req.method === "DELETE") {
      patients.delete(pid);
      savePatients();
      // Unassign this patient's sessions.
      for (const s of sessions.values()) {
        if (s.patientId === pid) {
          s.patientId = null;
          saveSession(s);
          broadcast("assigned", { sessionId: s.id, patientId: null });
        }
      }
      broadcast("patientDeleted", { patientId: pid });
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- Assign / unassign a session to a patient (works on live or past sessions) ----
  const assignMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/patient$/);
  if (assignMatch && (req.method === "POST" || req.method === "PATCH")) {
    const session = sessions.get(assignMatch[1]);
    if (!session) return sendJson(res, 404, { error: "Unknown session" });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    const pid = body.patientId || null;
    if (pid && !patients.has(pid)) return sendJson(res, 404, { error: "Unknown patient" });
    session.patientId = pid;
    saveSession(session);
    broadcast("assigned", { sessionId: session.id, patientId: pid });
    return sendJson(res, 200, { ok: true, patientId: pid });
  }

  // ---- AI analysis (OpenRouter / Gemini) ----
  const analyzeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/analyze$/);
  if (analyzeMatch && req.method === "POST") {
    const session = sessions.get(analyzeMatch[1]);
    if (!session) return sendJson(res, 404, { error: "Unknown session" });
    const total = session.waypoints ? session.waypoints.length : 0;
    const finished = total > 0 && session.events && session.events.length >= total;
    if (!finished) return sendJson(res, 400, { error: "Session not finished yet" });
    if (session.analysis) return sendJson(res, 200, { analysis: session.analysis, cached: true });
    if (!OPENROUTER_KEY) return sendJson(res, 400, { error: "OPENROUTER key missing in backend/.env" });

    const data = buildAnalysisData(session);
    try {
      const text = await callOpenRouter([
        {
          role: "system",
          content: [
            "You are an expert in visuospatial cognitive assessment. You know the Corsi Block-Tapping Task (a standard measure of visuospatial short-term / working memory) and its metrics — Block Span (longest correct sequence), Total Correct, and Total Score (Kessels et al., 2000) — and its normative literature.",
            "",
            "This app runs a related but DIFFERENT, room-scale test: a participant wearing AR glasses walks/runs to numbered floor targets in a fixed ascending order (1, 2, 3 ... N). Unlike the classic Corsi task, the sequence is visible and numbered and is executed by whole-body locomotion. It therefore probes spatial sequencing, route planning, navigation efficiency and processing speed under light physical load — NOT pure memory span. Interpret the data with that distinction; do not treat it as a literal Corsi span.",
            "",
            "Reference context (classic Corsi span, for loose qualitative framing only — never a direct comparison):",
            "- Healthy adults: forward span ~5.7 blocks (young adults ~6.1; adults 50+ ~4.8).",
            "- Alzheimer's disease: ~3.9 (moderate stage ~3.6); mild stages usually overlap with healthy.",
            "",
            "Data notes: pathEfficiencyRatio is actual distance / optimal straight-line route (1.0 = perfectly direct; higher = more wandering). Splits are seconds between consecutive targets. Heart rate reflects physical effort.",
            "",
            "TONE — very important: write as a measured, supportive expert. This is a screening/training tool, NOT a clinical diagnosis. Be cautious and PASSIVE: never state or imply the person is ill, cognitively impaired, or has dementia. Use hedged phrasing ('appears within a typical range', 'an area that may benefit from practice'). Where performance looks lower, mention benign explanations (unfamiliarity with the setup, fatigue, room size) and keep it encouraging.",
            "",
            "Write ~180 words max: (1) a brief expert summary of the outcome referencing the relevant measures (targets completed, sequencing speed via total time and splits, navigation efficiency, physical effort); (2) a cautious note on whether results appear good / within typical expectations; (3) two or three concrete, encouraging tips to improve. Plain language: a short paragraph plus a few bullets.",
          ].join("\n"),
        },
        { role: "user", content: "Session data (JSON):\n" + JSON.stringify(data, null, 2) },
      ]);
      session.analysis = text;
      saveSession(session);
      console.log(`Session ${session.id}: AI analysis generated (${text.length} chars).`);
      return sendJson(res, 200, { analysis: text });
    } catch (e) {
      console.error("AI analysis error:", e.message);
      return sendJson(res, 502, { error: "AI request failed: " + e.message });
    }
  }

  // ---- List sessions ----
  if (pathname === "/api/sessions" && req.method === "GET") {
    const list = [...sessions.values()].map(summary).sort((a, b) => b.createdAt - a.createdAt);
    return sendJson(res, 200, list);
  }

  // ---- Single session / delete ----
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    if (req.method === "GET") {
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      return sendJson(res, 200, s);
    }
    if (req.method === "DELETE") {
      if (sessions.delete(id)) {
        try {
          fs.unlinkSync(sessionFile(id));
        } catch {
          /* ignore */
        }
        broadcast("deleted", { sessionId: id });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: "Not found" });
    }
  }

  // ---- Static frontend ----
  if (req.method === "GET") {
    return serveStatic(req, res, pathname);
  }

  sendJson(res, 404, { error: "Not found" });
});

loadPatients();
loadSessions();
server.listen(PORT, () => {
  console.log(`\nSpatialCognition backend running:`);
  console.log(`  Frontend:  http://localhost:${PORT}/`);
  console.log(`  API base:  http://localhost:${PORT}/api`);
  printLanHint();
});

function printLanHint() {
  try {
    const nets = require("os").networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) ips.push(net.address);
      }
    }
    if (ips.length) {
      console.log(`\n  For the Spectacles device, point the lens at one of:`);
      ips.forEach((ip) => console.log(`    http://${ip}:${PORT}`));
    }
  } catch {
    /* ignore */
  }
}
