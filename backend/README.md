# SpatialCognition Backend

Receives the user's top-down `(x, y)` position from the **SpatialCognition** Snap
Spectacles lens and visualizes it live in a browser — current position, the full
path walked, and a browsable history of past sessions.

Zero dependencies. Pure Node.js (`http` + Server-Sent Events). No `npm install` needed.

---

## Run it

```bash
cd backend
node server.js        # or: npm start
```

Then open the frontend:

- **On this laptop:** http://localhost:3000
- **From another device on the same Wi-Fi:** `http://<your-lan-ip>:3000`
  (the server prints your LAN IP on startup)

Sessions are stored as JSON files in `backend/data/` and survive restarts.

---

## How the lens connects

The lens sends HTTP requests to the backend. Set the target in Lens Studio on the
**`SpatialTracker`** object → `SpatialTracker` script → **Backend Url** input:

| Where the lens runs                | Backend Url to use                     |
| ---------------------------------- | -------------------------------------- |
| Lens Studio **Preview** (laptop)   | `http://localhost:3000`                |
| **Spectacles device** (same Wi-Fi) | `http://<laptop-lan-ip>:3000`          |

> The server prints the exact LAN URL when it starts, e.g.
> `http://192.168.178.24:3000`.

### Important Lens Studio settings

- **Preview:** set **Device Type Override → Spectacles**, otherwise the Fetch API
  returns 404 and no data is sent.
- **HTTP (insecure):** talking to `http://…` (a local server) requires
  **Project Settings → Experimental APIs = enabled**. This is fine for testing;
  such lenses can't be published. For a published lens, put the backend behind
  `https://`.
- The lens needs **Internet access** permission (Extended Permissions), which the
  Spectacles Internet APIs use by default.

---

## What each session captures

A **new session is created every time the board is placed on the ground** — the
lens detects the placement visuals turning on (initial auto-placement, or a press
of the in-lens **Reset** button re-places the board and starts a fresh session).

While a session is active, the lens sends one position per second:
`(x, y)` = the head/camera position expressed in the board's local ground plane,
in meters, with the board center as origin.

---

## The "run to the numbers" game

Every time the board is placed, the lens scatters **`maxNumber`** flat numbered
boxes (default 5) at random, non-overlapping spots inside the board. The player
must reach them **in order**: run to `1`, then `2`, and so on.

- The **next target** box is **orange**, already-reached boxes turn **green**, the
  rest stay **grey**. Standing on a box (head within `reachRadiusMeters` of its
  center) counts as reached.
- The box layout is sent to the backend with the session, and each reach is
  reported with a timestamp, so the web view shows the course, live progress, and
  a stats table of when each number was reached (elapsed time + split).

Tunable on the **`SpatialTracker`** script: `maxNumber` (1–10, capped by the box
pool size), `tileSizeMeters`, `reachRadiusMeters`, `minSpacingMeters`.

### Run flow, timer, sounds & overlays

- After the board is placed, the boxes appear and a head-locked overlay reads
  *"The experience starts when you step inside the box."* Nothing is timed yet.
- The **timer** (a head-locked HUD text) and the **trajectory** both start the
  moment the user steps into the board; the timer stops when the **last** number is
  reached. Waypoint times in the web app are measured from board entry, not from
  when the lens started.
- On completion the overlay reads *"Complete! Step out of the box to play again."*
  Stepping out arms a fresh run and shows *"Step inside the box to start the test."*;
  stepping back in starts a new session with a new random course.

**Sound inputs** on `SpatialTracker` (assign your own audio; all optional): there is
**no** placement sound — `enterSound` (stepping in), `reachSound1/2/3` (one chosen at
**random** on each number reached), and a distinct `endSound` (final number). The HUD
texts are wired via `timerText` / `overlayText` (under the Camera).

> Note: `boardWidthMeters` / `boardHeightMeters` drive both the random box placement
> and the "inside the board" detection, so keep them matched to the **physical size of
> the border mesh** (the starter border is 2×2 m).

---

## Heart rate (Bluetooth)

The lens can read a **Bluetooth LE heart-rate monitor** (e.g. a **Garmin watch in
"Broadcast Heart Rate" mode**, or a chest strap) directly on the Spectacles and send
the current BPM alongside each position. Heart rate is stored per point (`point.hr`)
and shown in the app (current + average bpm, and a ♥ label on the live map).

On the **`SpatialTracker`** script:

| Input            | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `enableHeartRate`| Turn the feature on/off.                                                 |
| `hrDeviceName`   | Optional Bluetooth name filter (your Garmin's broadcast name). Empty = first HR device found. |
| `bluetoothModule`| Optional — only assign a *Bluetooth Central Module* asset if the built-in module fails on your device. |

It connects using the **standard BLE Heart Rate profile** (service `0x180D`,
characteristic `0x2A37`).

**On-device notes (Spectacles):**
- **Bluetooth does not work in Lens Studio Preview** — so in Preview the lens streams
  **mock BPM** (a value wandering ~58–105) to the backend, so the pipeline is testable
  without the watch. Real BPM is only read on the physical device.
- Put the **Garmin in Broadcast HR mode** and make sure it is **not already paired to
  your phone** (Spectacles needs an unclaimed BLE peripheral).
- Using Bluetooth + Internet together requires **Extended Permissions** enabled in the
  project; such a lens can't be published (fine for internal/clinical use). Requires
  **SpectaclesOS ≥ 5.062**.

---

## HTTP API

| Method | Path                          | Body / Result                                             |
| ------ | ----------------------------- | -------------------------------------------------------- |
| POST   | `/api/session`                | `{ boardWidth, boardHeight, maxNumber, waypoints:[{n,x,y}] }` → `{ sessionId }` |
| POST   | `/api/position`               | `{ sessionId, x, y, hr? }` → `{ ok, count }` (`hr` = optional bpm) |
| POST   | `/api/start`                  | `{ sessionId }` → marks run start (user entered board)   |
| POST   | `/api/waypoint`               | `{ sessionId, n }` → `{ ok }` (a number was reached)     |
| GET    | `/api/sessions`               | list of session summaries (newest first), incl. `patientId` |
| GET    | `/api/sessions/:id`           | full session incl. points, waypoints, reach events       |
| POST   | `/api/sessions/:id/patient`   | `{ patientId }` (or `null`) → assign/unassign a session   |
| DELETE | `/api/sessions/:id`           | remove a session                                         |
| GET    | `/api/patients`               | list of patients                                         |
| POST   | `/api/patients`               | `{ name, birthday, gender }` → the new patient           |
| PATCH  | `/api/patients/:id`           | update a patient                                         |
| DELETE | `/api/patients/:id`           | remove a patient (its sessions become unassigned)        |
| GET    | `/api/stream`                 | SSE: `patients`, `patient`, `patientDeleted`, `sessions`, `session`, `point`, `waypoint`, `start`, `end`, `assigned`, `deleted` |
| GET    | `/`                           | the web frontend                                         |

All responses are JSON and CORS-open so the lens can reach them.

### Patients

Patients (`name`, `birthday`, `gender`) are stored in `backend/data/patients.json`.
A session can be linked to a patient at any time — **while it is live or long after**
— via the patient dropdown in the app header, and you can filter the session list by
a specific patient or by *Unassigned*. Deleting a patient unassigns their sessions
rather than deleting the recordings.

---

## Frontend

`public/index.html` (single self-contained file):

- **Follow live session** toggle — auto-switches to and tracks the newest session
  as the user places the board and walks around.
- **Sessions list** — click any past session to replay its full path; delete with ✕.
- **Canvas** — draws the game board rectangle to scale, the numbered boxes
  (grey / orange target / green reached), and the current position (glowing dot).
  The **live dot shows even before the run starts**, but the **trajectory** (gradient
  polyline) is only drawn once the user has stepped into the board, and it continues
  until the last number is reached (even if the user steps out in between).
- **Timer** stat counts from board entry to the final number. **Hover the trajectory**
  to see the heart rate, elapsed time, and distance at that point next to the cursor.
- **Course panel** — progress bar, the next target, and a stats table of each
  number's reach time and split.
- Live updates arrive over SSE; position, points, distance, progress, and the
  stats table all update in real time.
