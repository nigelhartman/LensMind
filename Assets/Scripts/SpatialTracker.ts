/**
 * SpatialCognition - SpatialTracker
 * ---------------------------------
 * 1. Sends the user's top-down (x, y) position relative to the game board to the
 *    backend once per second, starting a NEW backend session every time the board
 *    is (re)placed on the ground.
 * 2. Runs a "run to the numbers" game: on every placement it scatters `maxNumber`
 *    flat numbered boxes at random, non-overlapping spots inside the board. The
 *    player must reach them in order (1, 2, 3 ...). The current target box is
 *    orange, already-reached boxes turn green, the rest stay grey. Reaching a box
 *    (standing on it) is reported to the backend with a timestamp for stats.
 *
 * Coordinates: the head/camera world position is expressed in the board's local
 * frame and projected to the ground plane -> (local X, local Z). Lens world units
 * are centimeters; everything sent to the backend is in meters.
 */

// Built-in module; no asset needs to be added to the project.
const internetModule: InternetModule = require("LensStudio:InternetModule");

const UNITS_PER_METER = 100.0; // Lens world units (cm) per meter
const GROUND_Y = 0.0; // board-local ground height in units

// Box tile colors (RGB 0..1)
const COLOR_GREY = new vec4(0.55, 0.58, 0.65, 1.0); // not yet reached
const COLOR_TARGET = new vec4(1.0, 0.55, 0.1, 1.0); // next one to run to (orange)
const COLOR_REACHED = new vec4(0.15, 0.85, 0.45, 1.0); // already reached (green)

// Overlay instruction messages
const MSG_OBSERVE = "Test starts soon\nStep back to observe the whole board";
const MSG_WATCH = "Memorize the order";
const MSG_GO = "Step inside and walk\nthe sequence in order";
const MSG_COMPLETE = "Complete!\nStep out of the box to play again";

interface Waypoint {
  object: SceneObject;
  tileMaterial: Material;
  label: Text;
  n: number; // sequence order (1-based) if part of the sequence; 0 otherwise
  x: number; // board-local position in meters
  y: number;
}

@component
export class SpatialTracker extends BaseScriptComponent {
  @input
  @hint("Object whose enabled-state flips true once the board is placed (VisualParent).")
  boardVisuals: SceneObject;

  @input
  @hint("Root object positioned/rotated on the ground when placed (Example Surface).")
  boardRoot: SceneObject;

  @input
  @hint("The camera / head object used as the user's position (Camera Object).")
  camera: SceneObject;

  @input
  @hint("Backend base URL, e.g. http://192.168.1.20:3000 (device) or http://localhost:3000 (preview).")
  backendUrl: string = "http://localhost:3000";

  @input
  @hint("How often (seconds) to send the position.")
  sendIntervalSeconds: number = 1.0;

  @input
  @hint("Game board width in meters (local X). Must match the physical border.")
  boardWidthMeters: number = 2.0;

  @input
  @hint("Game board depth in meters (local Z). Must match the physical border.")
  boardHeightMeters: number = 2.0;

  @input
  @hint("Parent object holding the numbered box objects (the 'Waypoints' container). The game uses the first Max Number of its children.")
  waypointsParent: SceneObject;

  @input
  @hint("Unlit material used to color the boxes (WaypointUnlit). Its baseColor is tinted per box.")
  baseTileMaterial: Material;

  @input
  @hint("Connect to a Bluetooth heart-rate monitor (e.g. Garmin in Broadcast HR mode) and send BPM with each position. In Lens Studio Preview, mock BPM is sent instead.")
  enableHeartRate: boolean = true;

  @input
  @hint("Optional Bluetooth device-name filter (your Garmin's broadcast name). Leave empty to accept the first heart-rate device found.")
  hrDeviceName: string = "";

  @input
  @allowUndefined
  @hint("(Optional) Bluetooth Central Module asset. If assigned it is used instead of the built-in module - add one via the Asset Browser only if the built-in require fails on your device.")
  bluetoothModule: Bluetooth.BluetoothCentralModule;

  @input
  @hint("Total plates to place on the board (1..pool size).")
  plateCount: number = 9;

  @input
  @hint("How many plates form the sequence the user must recall (<= Plate Count).")
  sequenceLength: number = 5;

  @input
  @hint("Seconds to wait after placement (observe the board) before the sequence is shown.")
  observeDelaySeconds: number = 4.0;

  @input
  @hint("Seconds each plate stays highlighted (orange) while the sequence is demonstrated.")
  highlightSeconds: number = 2.0;

  @input
  @hint("Tile size in meters (edge length of each plate).")
  tileSizeMeters: number = 0.3;

  @input
  @hint("How close (meters) the player must get to a box to count as reached.")
  reachRadiusMeters: number = 0.4;

  @input
  @hint("Minimum spacing between box centers in meters (so they don't overlap).")
  minSpacingMeters: number = 0.6;

  @input
  @allowUndefined
  @hint("Sound played when the user steps into the board (enter).")
  enterSound: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("Reach sound option 1 - one of the three plays at random each time a number is reached.")
  reachSound1: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("Reach sound option 2 - one of the three plays at random each time a number is reached.")
  reachSound2: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("Reach sound option 3 - one of the three plays at random each time a number is reached.")
  reachSound3: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("Sound played when the final number is reached (end) - different from the reach sounds.")
  endSound: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("HUD Text that shows the run timer (TimerText under the Camera).")
  timerText: Text;

  @input
  @allowUndefined
  @hint("HUD Text used for instructions/overlays (OverlayText under the Camera).")
  overlayText: Text;

  @input
  @allowUndefined
  @hint("HUD Text showing the live heart rate, above the timer (HeartText under the Camera).")
  heartText: Text;

  @input
  @allowUndefined
  @hint("Icon image shown to the left of the timer.")
  timerIcon: Texture;

  @input
  @allowUndefined
  @hint("Icon image shown to the left of the heart rate.")
  heartIcon: Texture;

  @input
  @allowUndefined
  @hint("Plane object that displays the timer icon (TimerIcon under the Camera).")
  timerIconObject: SceneObject;

  @input
  @allowUndefined
  @hint("Plane object that displays the heart-rate icon (HeartIcon under the Camera).")
  heartIconObject: SceneObject;

  @input
  @allowUndefined
  @hint("Unlit material used to render the HUD icons (IconUnlit).")
  iconMaterial: Material;

  @input
  @allowUndefined
  @hint("Board border material (BorderLit) - tinted blue at runtime to match the web app.")
  borderMaterial: Material;

  private boardTransform: Transform;
  private cameraTransform: Transform;

  private prevEnabled: boolean = false;
  private sessionId: string = null;
  private creatingSession: boolean = false;
  private timeAccum: number = 0;

  // Game state
  private pool: Waypoint[] = [];
  private plates: Waypoint[] = []; // all plates placed this round
  private sequence: Waypoint[] = []; // the ordered subset the user must recall
  private targetIndex: number = 0; // index into sequence of the next plate to reach

  // Run flow: "observe" -> "highlight" -> "armed" -> "running" -> "finished"
  private state: string = "idle";
  private prevInside: boolean = false;
  private enterTimeSec: number = 0;
  private endElapsedSec: number = 0;
  private phaseTimer: number = 0; // getTime() deadline for the current observe/highlight step
  private highlightIndex: number = 0; // which sequence plate is currently highlighted
  private firstRun: boolean = true;
  private audio: AudioComponent = null;

  // Heart rate
  private currentHr: number = 0; // latest BPM (0 = none yet)
  private mockHr: number = 72; // wandering value used in Preview
  private isEditor: boolean = false;
  private bluetooth: any = null;
  private hrGatt: any = null;

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart() {
    if (!this.boardVisuals || !this.boardRoot || !this.camera) {
      print("[SpatialTracker] Missing input references - check the component inputs.");
      return;
    }
    this.boardTransform = this.boardRoot.getTransform();
    this.cameraTransform = this.camera.getTransform();
    this.prevEnabled = this.boardVisuals.enabled;
    this.initWaypointPool();
    this.initHud();
    this.audio = this.getSceneObject().createComponent("Component.AudioComponent") as AudioComponent;
    this.isEditor = global.deviceInfoSystem.isEditor();
    if (this.borderMaterial) {
      // Web app board color (#2563eb). Set at runtime because editing the
      // material's baseColor at author time did not stick.
      this.borderMaterial.mainPass.baseColor = new vec4(0.145, 0.388, 0.922, 1.0);
    }
    if (this.enableHeartRate) {
      this.startHeartRate();
    }
    print("[SpatialTracker] Ready. Backend: " + this.backendUrl + " | pool: " + this.pool.length);
  }

  /** Place the head-locked HUD texts in front of the camera and clear them. */
  private initHud() {
    if (this.timerText) {
      // Left-aligned so the number starts right of its icon (with a margin).
      this.timerText.horizontalAlignment = HorizontalAlignment.Left;
      this.timerText.getSceneObject().getTransform().setLocalPosition(new vec3(24, 19, -100));
      this.timerText.size = 144;
      this.timerText.text = "0.0";
    }
    if (this.heartText) {
      // Heart rate sits right on top of the timer.
      this.heartText.horizontalAlignment = HorizontalAlignment.Left;
      this.heartText.getSceneObject().getTransform().setLocalPosition(new vec3(24, 28, -100));
      this.heartText.size = 144;
      this.heartText.text = "...";
    }
    this.setupIcon(this.timerIconObject, this.timerIcon, 13, 19);
    this.setupIcon(this.heartIconObject, this.heartIcon, 13, 28);
    if (this.overlayText) {
      // Instruction/"todos" overlay: 3x the previous size.
      this.overlayText.getSceneObject().getTransform().setLocalPosition(new vec3(0, -8, -100));
      this.overlayText.size = 132;
      this.setOverlay("");
    }
  }

  /** Assign an icon texture to a HUD plane, position it left of its text. */
  private setupIcon(obj: SceneObject, tex: Texture, x: number, y: number) {
    if (!obj) {
      return;
    }
    if (!tex || !this.iconMaterial) {
      obj.enabled = false; // no icon assigned
      return;
    }
    const rmv = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (rmv) {
      const mat = this.iconMaterial.clone();
      mat.mainPass.baseTex = tex;
      mat.mainPass.twoSided = true; // render regardless of which way the plane faces
      rmv.mainMaterial = mat;
    }
    const t = obj.getTransform();
    // The Plane primitive lies flat (horizontal); rotate it upright to face the camera.
    t.setLocalRotation(quat.fromEulerAngles(Math.PI / 2, 0, 0));
    t.setLocalPosition(new vec3(x, y, -100));
    t.setLocalScale(new vec3(4.5, 4.5, 4.5));
    obj.enabled = true;
  }

  // -------------------------------------------------------------------------
  // Waypoint pool setup (runs once): configure geometry, clone materials, hide.
  // -------------------------------------------------------------------------
  private initWaypointPool() {
    this.pool = [];
    if (!this.waypointsParent) {
      return;
    }
    const tileUnits = this.tileSizeMeters * UNITS_PER_METER;
    const childCount = this.waypointsParent.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      const obj = this.waypointsParent.getChild(i);
      if (!obj) {
        continue;
      }
      const tileObj = this.findChild(obj, "Tile");
      const labelObj = this.findChild(obj, "Label");
      if (!tileObj || !labelObj) {
        print("[SpatialTracker] Waypoint " + i + " missing Tile/Label child.");
        continue;
      }

      // Flat box resting on the ground.
      const tileTf = tileObj.getTransform();
      tileTf.setLocalScale(new vec3(tileUnits, 3, tileUnits));
      tileTf.setLocalPosition(new vec3(0, GROUND_Y + 1.5, 0));

      // No number labels on the plates anymore - this is a spatial-memory test.
      labelObj.enabled = false;

      const rmv = tileObj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      const text = labelObj.getComponent("Component.Text") as Text;

      // Unique UNLIT material per box so colors are solid and set independently.
      // The default box material is lit + textured, so its color can't be tinted.
      let mat: Material = null;
      const sourceMat: Material = this.baseTileMaterial || (rmv ? rmv.mainMaterial : null);
      if (rmv && sourceMat) {
        mat = sourceMat.clone();
        // Matte, non-metallic finish so the lit tiles read cleanly (ignored by unlit).
        try {
          mat.mainPass.roughness = 0.6;
          mat.mainPass.metallic = 0.0;
        } catch (e) {
          // Unlit material has no roughness/metallic - fine.
        }
        rmv.mainMaterial = mat;
      }

      this.pool.push({ object: obj, tileMaterial: mat, label: text, n: 0, x: 0, y: 0 });
      obj.enabled = false;
    }
  }

  private findChild(obj: SceneObject, name: string): SceneObject {
    const count = obj.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const c = obj.getChild(i);
      if (c.name === name) {
        return c;
      }
    }
    return null;
  }

  private setTileColor(w: Waypoint, color: vec4) {
    if (w.tileMaterial) {
      w.tileMaterial.mainPass.baseColor = color;
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------
  private onUpdate() {
    if (!this.boardTransform) {
      return;
    }

    // Heart rate updates continuously, independent of the game state.
    this.updateHeartText();

    // Detect the board being (re)placed: visuals turning on.
    const enabled = this.boardVisuals.enabled;
    if (enabled && !this.prevEnabled) {
      this.onBoardPlaced();
    }
    this.prevEnabled = enabled;

    if (!enabled) {
      return;
    }

    const inside = this.isInsideBoard();
    const now = getTime();

    if (this.state === "observe") {
      // Wait (observe the whole board), then demonstrate the sequence.
      if (now >= this.phaseTimer) {
        this.beginHighlight();
      }
    } else if (this.state === "highlight") {
      // Flash each sequence plate for highlightSeconds, then prompt to enter.
      if (now >= this.phaseTimer) {
        this.advanceHighlight();
      }
    } else if (this.state === "armed") {
      // Recall phase begins the moment the user steps into the board.
      if (inside) {
        this.onEnter();
      }
    } else if (this.state === "running") {
      this.checkReached();
    } else if (this.state === "finished") {
      // Stepping out after finishing arms a fresh run to repeat.
      if (!inside && this.prevInside) {
        this.onSteppedOutAfterFinish();
      }
    }
    this.prevInside = inside;

    this.updateTimerText();

    // Position streaming needs a live backend session. We stream even before the
    // run starts so the web app can show a live dot (the trajectory only begins
    // once the backend has a startedAt).
    if (!this.sessionId) {
      return;
    }
    this.timeAccum += getDeltaTime();
    if (this.timeAccum >= this.sendIntervalSeconds) {
      this.timeAccum = 0;
      this.sendPosition();
    }
  }

  /** Is the user's head (top-down) currently within the board rectangle? */
  private isInsideBoard(): boolean {
    const u = this.getUserBoardXY();
    return (
      Math.abs(u.x) <= this.boardWidthMeters / 2 && Math.abs(u.y) <= this.boardHeightMeters / 2
    );
  }

  /** Current head position in board-local space, projected to the ground -> meters. */
  private getUserBoardXY(): vec2 {
    const camWorld = this.cameraTransform.getWorldPosition();
    const invBoard = this.boardTransform.getInvertedWorldTransform();
    const local = invBoard.multiplyPoint(camWorld);
    return new vec2(local.x / UNITS_PER_METER, local.z / UNITS_PER_METER);
  }

  // -------------------------------------------------------------------------
  // Placement -> new session + new random course
  // -------------------------------------------------------------------------
  private onBoardPlaced() {
    this.firstRun = true;
    this.armRun();
  }

  /**
   * Prepare a fresh run: place the plates and pick a random sequence, create a
   * backend session, then hold in the OBSERVE phase. The test does NOT start when
   * the user walks in during observe/highlight - only after the sequence is shown.
   */
  private armRun() {
    this.sessionId = null;
    this.timeAccum = this.sendIntervalSeconds; // send the first point promptly
    this.enterTimeSec = 0;
    this.endElapsedSec = 0;
    this.targetIndex = 0;
    this.spawnCourse();
    this.setTimer(0);
    this.state = "observe";
    this.phaseTimer = getTime() + this.observeDelaySeconds;
    this.setOverlay(MSG_OBSERVE);
    this.createSession();
  }

  /** Observe delay elapsed: start demonstrating the sequence, one plate at a time. */
  private beginHighlight() {
    this.state = "highlight";
    this.highlightIndex = -1;
    this.setOverlay(MSG_WATCH);
    this.advanceHighlight();
  }

  /** Turn the current highlight off and light up the next sequence plate (or finish). */
  private advanceHighlight() {
    if (this.highlightIndex >= 0 && this.highlightIndex < this.sequence.length) {
      this.setTileColor(this.sequence[this.highlightIndex], COLOR_GREY);
    }
    this.highlightIndex++;
    if (this.highlightIndex < this.sequence.length) {
      this.setTileColor(this.sequence[this.highlightIndex], COLOR_TARGET);
      this.playReachSound(); // one of the 3 random sounds while highlighting
      this.phaseTimer = getTime() + this.highlightSeconds;
    } else {
      // Sequence fully shown: prompt the user to enter and recall it.
      this.state = "armed";
      this.setOverlay(MSG_GO);
    }
  }

  /** User stepped into the board: start the timer + trajectory (recall phase). */
  private onEnter() {
    this.state = "running";
    this.enterTimeSec = getTime();
    this.setOverlay("");
    this.playSound(this.enterSound);
    this.reportStart();
  }

  /** After finishing, stepping out arms a repeat run. */
  private onSteppedOutAfterFinish() {
    this.firstRun = false;
    this.armRun();
  }

  private spawnCourse() {
    // Hide every plate first.
    for (const w of this.pool) {
      w.object.enabled = false;
    }
    this.plates = [];
    this.sequence = [];
    if (!this.pool.length) {
      return;
    }

    let plateN = Math.floor(this.plateCount);
    if (plateN < 1) plateN = 1;
    if (plateN > this.pool.length) plateN = this.pool.length;

    let seqN = Math.floor(this.sequenceLength);
    if (seqN < 1) seqN = 1;
    if (seqN > plateN) seqN = plateN;

    // Place all plates (grey, no numbers).
    const positions = this.randomPositions(plateN);
    for (let i = 0; i < plateN; i++) {
      const w = this.pool[i];
      w.n = 0;
      w.x = positions[i].x;
      w.y = positions[i].y;
      w.object.enabled = true;
      w.object
        .getTransform()
        .setLocalPosition(new vec3(w.x * UNITS_PER_METER, GROUND_Y, w.y * UNITS_PER_METER));
      this.setTileColor(w, COLOR_GREY);
      this.plates.push(w);
    }

    // Pick a random ordered sequence of seqN distinct plates (Fisher-Yates).
    const idx: number[] = [];
    for (let i = 0; i < plateN; i++) idx.push(i);
    for (let i = plateN - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    for (let k = 0; k < seqN; k++) {
      const w = this.plates[idx[k]];
      w.n = k + 1; // sequence order
      this.sequence.push(w);
    }
    this.targetIndex = 0;
    print("[SpatialTracker] Placed " + plateN + " plates; sequence length " + seqN + ".");
  }

  /**
   * Sample non-overlapping (x, y) positions in meters within the board.
   * For each plate we take many candidates and keep the one that is FARTHEST
   * from all already-placed plates (maximin). This never returns a blindly
   * overlapping spot: if a fully-clear spot exists it is used, otherwise the
   * least-overlapping one is chosen.
   */
  private randomPositions(count: number): vec2[] {
    const marginM = this.tileSizeMeters / 2 + 0.15;
    const halfX = Math.max(0.1, this.boardWidthMeters / 2 - marginM);
    const halfY = Math.max(0.1, this.boardHeightMeters / 2 - marginM);
    // Plates must never touch: center spacing >= tile size, honoring Min Spacing.
    const minDist = Math.max(this.minSpacingMeters, this.tileSizeMeters + 0.1);
    const out: vec2[] = [];
    for (let i = 0; i < count; i++) {
      let best: vec2 = null;
      let bestNearest = -1;
      for (let attempt = 0; attempt < 400; attempt++) {
        const p = new vec2((Math.random() * 2 - 1) * halfX, (Math.random() * 2 - 1) * halfY);
        if (out.length === 0) {
          best = p;
          break;
        }
        let nearest = Infinity;
        for (const q of out) {
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < nearest) {
            nearest = d;
          }
        }
        if (nearest >= minDist) {
          best = p; // clear spot found - use it
          break;
        }
        if (nearest > bestNearest) {
          bestNearest = nearest; // remember the least-overlapping candidate
          best = p;
        }
      }
      out.push(best);
    }
    return out;
  }

  private checkReached() {
    if (this.targetIndex < 0 || this.targetIndex >= this.sequence.length) {
      return; // finished or not active
    }
    const target = this.sequence[this.targetIndex];
    const user = this.getUserBoardXY();
    const dist = Math.hypot(user.x - target.x, user.y - target.y);
    if (dist <= this.reachRadiusMeters) {
      this.onReached(target);
    }
  }

  private onReached(w: Waypoint) {
    // Turn the reached plate green. Do NOT hint the next one (spatial recall).
    this.setTileColor(w, COLOR_REACHED);
    this.reportWaypoint(w.n);
    this.targetIndex++;
    if (this.targetIndex < this.sequence.length) {
      this.playReachSound();
      print("[SpatialTracker] Reached #" + w.n + " -> next hidden");
    } else {
      // Final plate reached: stop the timer, play the finish sound, prompt to repeat.
      this.state = "finished";
      this.endElapsedSec = getTime() - this.enterTimeSec;
      this.playSound(this.endSound);
      this.setOverlay(MSG_COMPLETE);
      print("[SpatialTracker] Sequence complete! " + this.sequence.length + " reached.");
    }
  }

  // -------------------------------------------------------------------------
  // HUD + audio helpers
  // -------------------------------------------------------------------------
  private updateTimerText() {
    let sec = 0;
    if (this.state === "running") {
      sec = getTime() - this.enterTimeSec;
    } else if (this.state === "finished") {
      sec = this.endElapsedSec;
    }
    this.setTimer(sec);
  }

  private setTimer(sec: number) {
    if (this.timerText) {
      this.timerText.text = this.formatTime(sec);
    }
  }

  /** Live heart rate: mock in Preview; "..." while connecting on device; BPM once read. */
  private updateHeartText() {
    if (!this.heartText) {
      return;
    }
    this.heartText.text = this.currentHr > 0 ? "" + this.currentHr : "...";
  }

  private formatTime(sec: number): string {
    if (sec < 0) sec = 0;
    if (sec < 60) {
      return sec.toFixed(1);
    }
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" + s : "" + s);
  }

  private setOverlay(msg: string) {
    if (!this.overlayText) {
      return;
    }
    this.overlayText.text = msg;
    this.overlayText.getSceneObject().enabled = msg !== "";
  }

  private playSound(track: AudioTrackAsset) {
    if (!track || !this.audio) {
      return;
    }
    this.audio.audioTrack = track;
    this.audio.play(1);
  }

  /** Play one of the (up to three) reach sounds at random. */
  private playReachSound() {
    const options: AudioTrackAsset[] = [];
    if (this.reachSound1) options.push(this.reachSound1);
    if (this.reachSound2) options.push(this.reachSound2);
    if (this.reachSound3) options.push(this.reachSound3);
    if (!options.length) {
      return;
    }
    this.playSound(options[Math.floor(Math.random() * options.length)]);
  }

  // -------------------------------------------------------------------------
  // Backend communication
  // -------------------------------------------------------------------------
  private async reportStart() {
    const sid = this.sessionId;
    if (!sid) {
      return;
    }
    try {
      const request = new Request(this.backendUrl + "/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      const response = await internetModule.fetch(request);
      if (response.status !== 200) {
        print("[SpatialTracker] Start report failed: HTTP " + response.status);
      }
    } catch (e) {
      print("[SpatialTracker] Start report error: " + e);
    }
  }

  private async createSession() {
    if (this.creatingSession) {
      return;
    }
    this.creatingSession = true;
    try {
      const platesPayload = this.plates.map((p) => ({ x: p.x, y: p.y }));
      const wpPayload = this.sequence.map((w) => ({ n: w.n, x: w.x, y: w.y }));
      const request = new Request(this.backendUrl + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardWidth: this.boardWidthMeters,
          boardHeight: this.boardHeightMeters,
          maxNumber: this.sequence.length,
          plates: platesPayload,
          waypoints: wpPayload,
        }),
      });
      const response = await internetModule.fetch(request);
      if (response.status !== 200) {
        print("[SpatialTracker] Session create failed: HTTP " + response.status);
        return;
      }
      const data = await response.json();
      this.sessionId = data.sessionId;
      print("[SpatialTracker] New session: " + this.sessionId);
    } catch (e) {
      print("[SpatialTracker] Session create error: " + e);
    } finally {
      this.creatingSession = false;
    }
  }

  private async sendPosition() {
    const sid = this.sessionId;
    if (!sid) {
      return;
    }
    const user = this.getUserBoardXY();

    // In Preview there is no Bluetooth, so advance a mock BPM once per send.
    if (this.enableHeartRate && this.isEditor) {
      this.updateMockHr();
    }

    const payload: any = { sessionId: sid, x: user.x, y: user.y };
    if (this.currentHr > 0) {
      payload.hr = this.currentHr;
    }

    try {
      const request = new Request(this.backendUrl + "/api/position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const response = await internetModule.fetch(request);
      if (response.status !== 200) {
        print("[SpatialTracker] Position send failed: HTTP " + response.status);
      }
    } catch (e) {
      print("[SpatialTracker] Position send error: " + e);
    }
  }

  private async reportWaypoint(n: number) {
    const sid = this.sessionId;
    if (!sid) {
      return; // backend not connected; visuals still advanced
    }
    try {
      const request = new Request(this.backendUrl + "/api/waypoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, n: n }),
      });
      const response = await internetModule.fetch(request);
      if (response.status !== 200) {
        print("[SpatialTracker] Waypoint send failed: HTTP " + response.status);
      }
    } catch (e) {
      print("[SpatialTracker] Waypoint send error: " + e);
    }
  }

  // -------------------------------------------------------------------------
  // Heart rate (Bluetooth LE on device; mock in Lens Studio Preview)
  // -------------------------------------------------------------------------
  private startHeartRate() {
    if (this.isEditor) {
      // Bluetooth does not work in Preview - stream mock BPM instead.
      print("[SpatialTracker] Preview: using mock heart rate.");
      this.currentHr = Math.round(this.mockHr);
      return;
    }
    try {
      this.bluetooth = this.bluetoothModule || require("LensStudio:BluetoothCentralModule");
      this.scanForHeartRateMonitor();
    } catch (e) {
      print("[SpatialTracker] Bluetooth unavailable: " + e);
    }
  }

  private updateMockHr() {
    this.mockHr += (Math.random() - 0.5) * 4;
    if (this.mockHr < 58) this.mockHr = 58;
    if (this.mockHr > 105) this.mockHr = 105;
    this.currentHr = Math.round(this.mockHr);
  }

  private scanForHeartRateMonitor() {
    const scanFilter = new Bluetooth.ScanFilter();
    // Filter by device name when provided; otherwise take the first HR device.
    if (this.hrDeviceName) {
      scanFilter.deviceName = this.hrDeviceName;
    }
    const scanSettings = new Bluetooth.ScanSettings();
    scanSettings.uniqueDevices = true;
    scanSettings.timeoutSeconds = 30;
    scanSettings.scanMode = Bluetooth.ScanMode.Balanced;

    print("[SpatialTracker] Scanning for heart-rate monitor…");
    this.bluetooth
      .startScan([scanFilter], scanSettings, (result: any) => this.hrScanPredicate(result))
      .then((result: any) => this.onFoundHeartRateDevice(result))
      .catch((error: any) => print("[SpatialTracker] HR scan error: " + error));
  }

  /** Return true to stop scanning once a suitable device is seen. */
  private hrScanPredicate(result: any): boolean {
    if (!result) return false;
    if (this.hrDeviceName) {
      return (result.deviceName || "").indexOf(this.hrDeviceName) >= 0;
    }
    return true; // accept the first device found
  }

  private onFoundHeartRateDevice(scanResult: any) {
    if (!scanResult) return;
    print("[SpatialTracker] Connecting to " + (scanResult.deviceName || scanResult.deviceAddress));
    this.bluetooth
      .connectGatt(scanResult.deviceAddress)
      .then((gatt: any) => {
        this.hrGatt = gatt;
        this.discoverHeartRateService();
      })
      .catch((error: any) => print("[SpatialTracker] HR connect error: " + error));
  }

  private discoverHeartRateService() {
    try {
      const service = this.hrGatt.getService("180D"); // Heart Rate Service
      if (!service) {
        print("[SpatialTracker] No heart-rate service on device.");
        return;
      }
      const characteristic = service.getCharacteristic("2A37"); // Heart Rate Measurement
      if (!characteristic) {
        print("[SpatialTracker] No heart-rate characteristic on device.");
        return;
      }
      characteristic
        .registerNotifications((value: Uint8Array) => this.onHeartRateNotification(value))
        .then(() => print("[SpatialTracker] Heart-rate notifications active."))
        .catch((error: any) => print("[SpatialTracker] HR notify error: " + error));
    } catch (e) {
      print("[SpatialTracker] HR discovery error: " + e);
    }
  }

  /** Parse the standard Heart Rate Measurement (0x2A37) value. */
  private onHeartRateNotification(value: Uint8Array) {
    if (!value || value.length < 2) return;
    const flags = value[0];
    const bpm = (flags & 0x01) === 0 ? value[1] : (value[2] << 8) | value[1];
    if (bpm > 0) {
      this.currentHr = bpm;
    }
  }
}
