
https://github.com/user-attachments/assets/6f108de0-2e51-4190-ac9b-89b4a7720618

<br />

# LensMind

**Spatial cognition, measured on the move — an AR movement-and-memory assessment for Snap Spectacles.**

---

## The problem

Spatial working memory and navigation are among the earliest abilities to change with age, fatigue, or neurological conditions — yet they are hard to measure. Classic tools like the **Corsi Block-Tapping Task** capture memory *span* on a tabletop, but they can't see how a person actually plans a route, sequences targets, and moves their whole body through space.

Most assessments are still done seated, with a clipboard and subjective observation. The result is slow, coarse, and disconnected from real-world movement.

---

## What LensMind does

LensMind turns a room into the test. Wearing Snap Spectacles, the participant sees a game board projected on the floor with numbered targets, and simply **walks to them in order — 1, 2, 3 …** The glasses track their position in real time; a clinician watches the whole thing live in a browser.

- The participant puts on the glasses; a board is placed on the floor
- They step in — a timer starts — and move through the numbered course
- Every step, split time, and heartbeat streams live to the dashboard
- When they finish, one click produces an expert AI summary of the run

No clipboard. No manual scoring. The report is ready the moment they stop.

---

## Why AR instead of a tabletop

| Tabletop test | LensMind |
|---|---|
| Measures memory span only | Measures sequencing, route planning **and** whole-body navigation |
| Subjective, hand-timed | Objective position + timing, streamed live |
| Seated, abstract | Real movement through real space |
| One number at the end | Per-target splits, path efficiency, heart rate over time |
| Results interpreted later | Live view + AI summary the instant the run ends |

Inspired by the Corsi Block-Tapping Task, but extended from the tabletop into full room-scale locomotion.

---

## The test

A rectangular board is placed on the ground with **grey numbered plates** scattered at random, non-overlapping spots. The participant must reach them **in order**. The current target glows **orange**, reached targets turn **green**, and a head-up **timer** and **live heart rate** are shown in the glasses. Reaching the final number ends the run; stepping out and back in starts a fresh course.

### What it measures

| Signal | Meaning |
|---|---|
| **Sequence time & splits** | Processing speed and how pace changes across the course |
| **Path efficiency** | Walked distance vs. the optimal straight-line route — route planning quality |
| **Heart rate** | Physical effort during the task (live, from a Bluetooth monitor) |
| **Trajectory** | The exact path walked, from board-entry to the final target |

---

## The clinician dashboard

A bright, clinical web app (open it on any laptop on the same network):

- **Live top-down view** of the participant's position, path, numbered targets and heart rate — pan and zoom to explore
- **Patients** — add people (name, birthday, gender) and link sessions to them, live or after the fact
- **Session history** — browse, search and filter every past run
- **Analyze (AI)** — once a run is finished, a one-click expert summary (outcome, whether results look typical, and tips to improve), grounded in the Corsi literature and written cautiously — never a diagnosis
- **Per-point inspection** — hover the trajectory to read heart rate, time and distance at any moment

---

## How it works

```
Snap Spectacles (Lens)  ──HTTP──►  Node.js backend  ──►  Web dashboard (live via SSE)
   position + heart rate            sessions + patients        top-down view + AI analysis
```

- **Lens** (Lens Studio / TypeScript): places the board, spawns the numbered course, runs the game logic, reads a **Bluetooth heart-rate monitor** (e.g. a Garmin in broadcast mode; mock data in Preview), and streams the top-down position each second.
- **Backend** (`/backend`, zero-dependency Node.js): stores sessions and patients, times runs from board-entry, and calls **Google Gemini via OpenRouter** for the AI analysis.
- **Frontend** (`/backend/public`): a single self-contained clinical web app.

---

## Quick start

**Backend + dashboard**

```zsh
cd backend
node server.js
```

Open `http://localhost:3000` on your laptop (the server prints your LAN URL for other devices). Add your `OPENROUTER` key to `backend/.env` to enable AI analysis.

**Lens**

Open the project in Lens Studio, set the `SpatialTracker` script's **Backend Url** to your server (or an ngrok tunnel for the device), and push to Spectacles. See [`backend/README.md`](backend/README.md) for full setup, the HTTP API, and heart-rate notes.

---

## Medical disclaimer

LensMind is a research prototype and pre-screening / training aid. It is **not** a certified medical device and must not be used as a standalone diagnostic tool. All results require interpretation by a qualified clinician.

---

## Credits & resources

**Sound effects**

- Sound Effect by <a href="https://pixabay.com/users/freesound_community-46691455/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=80237">freesound_community</a> from <a href="https://pixabay.com//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=80237">Pixabay</a>
- Sound Effect by <a href="https://pixabay.com/users/freesound_community-46691455/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=82020">freesound_community</a> from <a href="https://pixabay.com//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=82020">Pixabay</a>
- Sound Effect by <a href="https://pixabay.com/users/freesound_community-46691455/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=82016">freesound_community</a> from <a href="https://pixabay.com/sound-effects//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=82016">Pixabay</a>
- Sound Effect by <a href="https://pixabay.com/users/freesound_community-46691455/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=102819">freesound_community</a> from <a href="https://pixabay.com//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=102819">Pixabay</a>
- Sound Effect by <a href="https://pixabay.com/users/u_op8btczor7-55070743/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=508249">u_op8btczor7</a> from <a href="https://pixabay.com//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=508249">Pixabay</a>

**Icons**

- <a href="https://www.flaticon.com/free-icons/heart" title="heart icons">Heart icons created by Good Ware - Flaticon</a>
- <a href="https://www.flaticon.com/free-icons/time" title="time icons">Time icons created by Ilham Fitrotul Hayat - Flaticon</a>

**Music**

- Music by <a href="https://pixabay.com/users/mangmaru-1300732/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=322715">MinGyu Jung</a> from <a href="https://pixabay.com/music//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=322715">Pixabay</a>
