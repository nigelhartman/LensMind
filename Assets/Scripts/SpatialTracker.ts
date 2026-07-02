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
const MSG_FIRST = "The experience starts\nwhen you step inside the box";
const MSG_COMPLETE = "Complete!\nStep out of the box to play again";
const MSG_REPEAT = "Step inside the box\nto start the test";

interface Waypoint {
  object: SceneObject;
  tileMaterial: Material;
  label: Text;
  n: number; // 1-based number shown on the box
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
  @hint("How many numbered boxes to spawn (1..pool size).")
  maxNumber: number = 5;

  @input
  @hint("Tile size in meters (edge length of each numbered box).")
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

  private boardTransform: Transform;
  private cameraTransform: Transform;

  private prevEnabled: boolean = false;
  private sessionId: string = null;
  private creatingSession: boolean = false;
  private timeAccum: number = 0;

  // Game state
  private pool: Waypoint[] = [];
  private active: Waypoint[] = []; // the ones spawned this round, ordered 1..N
  private targetNumber: number = 0; // next number to reach; 0 = none/inactive
  private gameActive: boolean = false;

  // Run flow: "armed" (waiting to enter), "running", "finished"
  private state: string = "idle";
  private prevInside: boolean = false;
  private enterTimeSec: number = 0;
  private endElapsedSec: number = 0;
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
    if (this.enableHeartRate) {
      this.startHeartRate();
    }
    print("[SpatialTracker] Ready. Backend: " + this.backendUrl + " | pool: " + this.pool.length);
  }

  /** Place the head-locked HUD texts in front of the camera and clear them. */
  private initHud() {
    if (this.timerText) {
      this.timerText.getSceneObject().getTransform().setLocalPosition(new vec3(0, 22, -100));
      this.timerText.size = 72;
      this.timerText.text = "";
    }
    if (this.overlayText) {
      this.overlayText.getSceneObject().getTransform().setLocalPosition(new vec3(0, -8, -100));
      this.overlayText.size = 44;
      this.setOverlay("");
    }
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

      // Number label lying flat on top of the box, readable from above.
      const labelTf = labelObj.getTransform();
      labelTf.setLocalPosition(new vec3(0, GROUND_Y + 3.5, 0));
      labelTf.setLocalRotation(quat.fromEulerAngles(-Math.PI / 2, 0, 0));

      const rmv = tileObj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      const text = labelObj.getComponent("Component.Text") as Text;

      // Big, bold numbers.
      if (text) {
        text.size = 480; // 10x the default (48)
        try {
          // Fake "bold" with a thick outline in the same fill color.
          text.outlineSettings.enabled = true;
          text.outlineSettings.size = 0.5;
        } catch (e) {
          // Older API without outlineSettings - size increase alone still applies.
        }
      }

      // Unique UNLIT material per box so colors are solid and set independently.
      // The default box material is lit + textured, so its color can't be tinted.
      let mat: Material = null;
      const sourceMat: Material = this.baseTileMaterial || (rmv ? rmv.mainMaterial : null);
      if (rmv && sourceMat) {
        mat = sourceMat.clone();
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

    if (this.state === "armed") {
      // Timer + trajectory begin the moment the user is inside the board.
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
   * Prepare a fresh run: spawn a new course, create a backend session, and wait
   * for the user to step into the board. No sound plays on placement.
   */
  private armRun() {
    this.sessionId = null;
    this.timeAccum = this.sendIntervalSeconds; // send the first point promptly
    this.state = "armed";
    this.enterTimeSec = 0;
    this.endElapsedSec = 0;
    this.spawnCourse();
    this.setTimer(0);
    this.setOverlay(this.firstRun ? MSG_FIRST : MSG_REPEAT);
    this.createSession();
  }

  /** User stepped into the board: start the timer + trajectory. */
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
    // Hide every box first.
    for (const w of this.pool) {
      w.object.enabled = false;
    }
    this.active = [];
    this.gameActive = false;

    if (!this.pool.length) {
      return;
    }
    let count = Math.floor(this.maxNumber);
    if (count < 1) count = 1;
    if (count > this.pool.length) count = this.pool.length;

    const positions = this.randomPositions(count);
    for (let i = 0; i < count; i++) {
      const w = this.pool[i];
      w.n = i + 1;
      w.x = positions[i].x;
      w.y = positions[i].y;
      w.object.enabled = true;
      w.object
        .getTransform()
        .setLocalPosition(new vec3(w.x * UNITS_PER_METER, GROUND_Y, w.y * UNITS_PER_METER));
      if (w.label) {
        w.label.text = w.n.toString();
      }
      this.setTileColor(w, i === 0 ? COLOR_TARGET : COLOR_GREY);
      this.active.push(w);
    }
    this.targetNumber = 1;
    this.gameActive = true;
    print("[SpatialTracker] Spawned course with " + count + " boxes.");
  }

  /** Rejection-sample non-overlapping (x, y) positions in meters within the board. */
  private randomPositions(count: number): vec2[] {
    const marginM = this.tileSizeMeters / 2 + 0.15;
    const halfX = Math.max(0.1, this.boardWidthMeters / 2 - marginM);
    const halfY = Math.max(0.1, this.boardHeightMeters / 2 - marginM);
    const minDist = this.minSpacingMeters;
    const out: vec2[] = [];
    for (let i = 0; i < count; i++) {
      let placed: vec2 = null;
      for (let attempt = 0; attempt < 200; attempt++) {
        const p = new vec2((Math.random() * 2 - 1) * halfX, (Math.random() * 2 - 1) * halfY);
        let ok = true;
        for (const q of out) {
          if (Math.hypot(p.x - q.x, p.y - q.y) < minDist) {
            ok = false;
            break;
          }
        }
        if (ok) {
          placed = p;
          break;
        }
      }
      // Fallback: accept a possibly-close spot rather than fail.
      out.push(placed || new vec2((Math.random() * 2 - 1) * halfX, (Math.random() * 2 - 1) * halfY));
    }
    return out;
  }

  private checkReached() {
    if (this.targetNumber < 1 || this.targetNumber > this.active.length) {
      return; // course finished or not active
    }
    const target = this.active[this.targetNumber - 1];
    const user = this.getUserBoardXY();
    const dist = Math.hypot(user.x - target.x, user.y - target.y);
    if (dist <= this.reachRadiusMeters) {
      this.onReached(target);
    }
  }

  private onReached(w: Waypoint) {
    this.setTileColor(w, COLOR_REACHED);
    this.reportWaypoint(w.n);
    this.targetNumber = w.n + 1;
    if (this.targetNumber <= this.active.length) {
      this.setTileColor(this.active[this.targetNumber - 1], COLOR_TARGET);
      this.playReachSound();
      print("[SpatialTracker] Reached #" + w.n + " -> next: #" + this.targetNumber);
    } else {
      // Final number reached: stop the timer and prompt to repeat.
      this.state = "finished";
      this.gameActive = false;
      this.endElapsedSec = getTime() - this.enterTimeSec;
      this.playSound(this.endSound);
      this.setOverlay(MSG_COMPLETE);
      print("[SpatialTracker] Course complete! All " + this.active.length + " reached.");
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

  private formatTime(sec: number): string {
    if (sec < 0) sec = 0;
    if (sec < 60) {
      return sec.toFixed(1) + "s";
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
      const wpPayload = this.active.map((w) => ({ n: w.n, x: w.x, y: w.y }));
      const request = new Request(this.backendUrl + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardWidth: this.boardWidthMeters,
          boardHeight: this.boardHeightMeters,
          maxNumber: this.active.length,
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
