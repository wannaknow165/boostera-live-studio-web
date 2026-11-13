"use strict";

(() => {
  const SDK_VERSION = "5.6.22";
  const SDK_ROOT = `https://cdn.jsdelivr.net/npm/deepar@${SDK_VERSION}/`;
  const MAX_CANVAS_EDGE = 1280;
  const TARGET_FPS = 30;
  const elements = Object.fromEntries([
    "camera-canvas", "preview-placeholder", "placeholder-title", "placeholder-copy",
    "preview-loading", "preview-state", "camera-name", "effect-name", "status-pill",
    "status-label", "controls-title", "start-button", "start-label", "switch-button",
    "stop-button", "status-message", "error-message", "effect-none", "effect-aviators",
    "effect-hint", "source-resolution", "output-resolution", "source-framerate", "site-hostname",
    "publish-code", "publish-mic", "publish-button", "publish-button-label", "publish-stop",
    "publish-pill", "publish-status-label", "publish-message", "publish-error", "microphone-status", "microphone-mute"
  ].map(id => [id, document.getElementById(id)]));

  let session = null;
  let sdkPromise = null;
  let startingOperations = 0;
  let phase = "idle";
  const transport = window.BoosteraTransport;
  const publisherAccess = transport.createAccess("publisher", elements["publish-code"]);
  let publication = null;
  let publishingOperations = 0;
  let publishPhase = "idle";

  class CameraError extends Error {
    constructor(code) {
      super(code);
      this.name = "CameraError";
      this.code = code;
    }
  }

  const isCurrent = current => session === current && !current.stopped;
  const stoppedError = () => new DOMException("Camera session stopped", "AbortError");

  function setMessage(message) {
    elements["status-message"].textContent = message;
  }

  function clearError() {
    elements["error-message"].hidden = true;
    elements["error-message"].textContent = "";
  }

  function showError(message) {
    elements["error-message"].textContent = message;
    elements["error-message"].hidden = false;
  }

  function renderControls() {
    const ready = phase === "ready" && !!session?.engine;
    const busy = phase === "starting" || phase === "switching";
    elements["start-button"].disabled = !!session || startingOperations > 0;
    elements["start-label"].textContent = !session && startingOperations > 0 ? "מסיימים את הפעולה הקודמת…" : phase === "starting" ? "פותחים את המצלמה…" : ready ? "המצלמה פעילה" : "הפעלת מצלמה";
    elements["switch-button"].disabled = !ready || !session?.canSwitch || !!session?.effectBusy || publishPhase === "connecting" || publishPhase === "reconnecting";
    elements["stop-button"].disabled = !session;
    elements["effect-none"].disabled = !ready || !!session?.effectBusy;
    elements["effect-aviators"].disabled = !ready || !!session?.effectBusy;
    elements["preview-loading"].hidden = !busy;
    elements["status-pill"].dataset.state = phase;
    elements["status-label"].textContent = ({
      idle: "מוכנה לבדיקה", starting: "מתחילה…", ready: "מצלמה פעילה",
      switching: "מחליפה מצלמה…", stopped: "מצלמה כבויה", error: "נדרשת בדיקה"
    })[phase];
    elements["preview-state"].textContent = ready ? "פעילה במכשיר הזה" : busy ? "בטעינה…" : "מצלמה כבויה";
    elements["controls-title"].textContent = ready ? "המצלמה שלך פעילה" : "נפתח את המצלמה?";
    elements["effect-hint"].textContent = session?.effectBusy ? "טוענים את האפקט…" : ready ? "אפשר להחליף אפקט בזמן שהמצלמה פועלת." : "בחירת האפקט זמינה אחרי הפעלת המצלמה.";
    document.body.dataset.cameraActive = String(!!session);
    renderPublishing();
  }

  function setPhase(next) {
    phase = next;
    renderControls();
  }

  function updateEffectSelection(effect) {
    for (const name of ["none", "aviators"]) {
      const selected = name === effect;
      elements[`effect-${name}`].classList.toggle("is-selected", selected);
      elements[`effect-${name}`].setAttribute("aria-pressed", String(selected));
    }
    elements["effect-name"].textContent = effect === "aviators" ? "משקפי AR" : "ללא אפקט";
  }

  function resetPreview(message = "לחצו על הפעלת מצלמה ואשרו את הגישה בדפדפן.") {
    elements["camera-canvas"].hidden = true;
    elements["preview-placeholder"].hidden = false;
    elements["placeholder-title"].textContent = "מתחילים מהמצלמה שלך";
    elements["placeholder-copy"].textContent = message;
    elements["camera-name"].textContent = "ממתינה להפעלה";
    for (const id of ["source-resolution", "output-resolution", "source-framerate"]) elements[id].textContent = "—";
    updateEffectSelection("none");
  }

  function stopTracks(stream) {
    stream?.getTracks().forEach(track => track.stop());
  }

  function destroySession(current) {
    if (!current || current.stopped) return;
    if (publication?.camera === current) stopPublishing("השליחה נעצרה יחד עם המצלמה.");
    current.stopped = true;
    current.controller.abort();
    // External getUserMedia tracks belong to this page, not to the SDK.
    stopTracks(current.stream);
    current.stream = null;
    if (current.video) {
      current.video.pause();
      current.video.srcObject = null;
      current.video.remove();
      current.video = null;
    }
    if (current.engine) {
      try { current.engine.stopVideo(); } catch { /* Continue releasing all resources. */ }
      try { current.engine.shutdown(); } catch { /* Tracks are already stopped. */ }
      current.engine = null;
    }
  }

  function stopCamera(message = "המצלמה נעצרה. אפשר להפעיל אותה שוב כשתרצו.") {
    const oldSession = session;
    session = null;
    destroySession(oldSession);
    clearError();
    resetPreview("המצלמה כבויה. לחצו על הפעלת מצלמה כדי להתחיל שוב.");
    setMessage(startingOperations > 0 ? `${message} אם בקשת הרשאה עדיין פתוחה, סגרו אותה. כפתור ההפעלה יחזור להיות זמין בסיום הפעולה הקודמת.` : message);
    setPhase("stopped");
  }

  async function loadRuntimeConfig(signal) {
    let response;
    try {
      response = await fetch("/runtime-config.json", { cache: "no-store", credentials: "same-origin", signal });
    } catch (error) {
      if (signal.aborted) throw stoppedError();
      throw new CameraError("CONFIG_NETWORK");
    }
    if (!response.ok) throw new CameraError("CONFIG_MISSING");
    let config;
    try { config = await response.json(); } catch { throw new CameraError("CONFIG_MISSING"); }
    if (typeof config?.licenseKey !== "string" || !config.licenseKey.trim()) throw new CameraError("CONFIG_MISSING");
    return { licenseKey: config.licenseKey.trim() };
  }

  function loadSDK() {
    if (window.deepar?.initialize) return Promise.resolve(window.deepar);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else {
          resolve(window.deepar);
        }
      };
      const timer = setTimeout(() => finish(new CameraError("SDK_NETWORK")), 30000);
      script.src = `${SDK_ROOT}js/deepar.js`;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => finish(window.deepar?.initialize ? null : new CameraError("SDK_NETWORK"));
      script.onerror = () => finish(new CameraError("SDK_NETWORK"));
      document.head.append(script);
    }).catch(error => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
  }

  function cameraConstraints(facing, exact) {
    return {
      audio: false,
      video: {
        facingMode: exact ? { exact: facing } : { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: TARGET_FPS, max: TARGET_FPS }
      }
    };
  }

  async function acquireCamera(current, facing, exact = false) {
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, exact));
    if (!isCurrent(current)) {
      stopTracks(stream);
      throw stoppedError();
    }
    current.stream = stream;
    current.requestedFacing = facing;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new CameraError("CAMERA_EMPTY");
    videoTrack.addEventListener("ended", () => {
      if (isCurrent(current) && !current.switching) {
        stopCamera("המצלמה נותקה או שהרשאת הגישה השתנתה. אפשר לבדוק הרשאות ולהפעיל שוב.");
      }
    }, { once: true });
    return stream;
  }

  function waitForVideo(current) {
    const video = current.video;
    if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const signal = current.controller.signal;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("resize", loaded);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = () => {
        if (video.videoWidth > 0 && video.readyState >= 2) { cleanup(); resolve(); }
      };
      const aborted = () => { cleanup(); reject(stoppedError()); };
      const timer = setTimeout(() => { cleanup(); reject(new CameraError("CAMERA_TIMEOUT")); }, 15000);
      video.addEventListener("loadeddata", loaded);
      video.addEventListener("resize", loaded);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else loaded();
    });
  }

  function configureCanvas(current) {
    const width = current.video.videoWidth;
    const height = current.video.videoHeight;
    if (!width || !height) throw new CameraError("CAMERA_EMPTY");
    const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(width, height));
    const canvas = elements["camera-canvas"];
    const outputWidth = current.publishCanvasSize?.width || Math.max(2, Math.round(width * scale / 2) * 2);
    const outputHeight = current.publishCanvasSize?.height || Math.max(2, Math.round(height * scale / 2) * 2);
    if (canvas.width !== outputWidth) canvas.width = outputWidth;
    if (canvas.height !== outputHeight) canvas.height = outputHeight;
    const settings = current.stream.getVideoTracks()[0].getSettings();
    current.actualFacing = settings.facingMode || null;
    elements["source-resolution"].textContent = `${width} × ${height}`;
    elements["output-resolution"].textContent = `${canvas.width} × ${canvas.height}`;
    elements["source-framerate"].textContent = Number.isFinite(settings.frameRate) ? `${Math.round(settings.frameRate * 10) / 10} fps` : "לא זמין";
    elements["camera-name"].textContent = ({ user: "מצלמה קדמית", environment: "מצלמה אחורית" })[settings.facingMode] || "מצלמת המכשיר";
  }

  async function updateCameraOptions(current) {
    const supportsFacing = !!navigator.mediaDevices.getSupportedConstraints?.().facingMode;
    let videoInputs = 0;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devices.filter(device => device.kind === "videoinput").length;
    } catch { /* Capture can still work when device enumeration is unavailable. */ }
    if (isCurrent(current)) current.canSwitch = supportsFacing && (videoInputs > 1 || !!current.actualFacing);
  }

  function attachProcessedVideo(current) {
    return new Promise((resolve, reject) => {
      const engine = current.engine;
      const signal = current.controller.signal;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        try { engine.removePostRenderListener(rendered); } catch { /* Shutdown may already be in progress. */ }
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const rendered = () => finish();
      const aborted = () => finish(stoppedError());
      const timer = setTimeout(() => finish(new CameraError("AR_TIMEOUT")), 15000);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try {
        engine.addPostRenderListener(rendered);
        const mirror = (current.actualFacing || current.requestedFacing) === "user";
        engine.setVideoElement(current.video, mirror);
      } catch (error) { finish(error); }
    });
  }

  async function prepareVideo(current, stream) {
    if (!current.video) {
      const video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-hidden", "true");
      video.className = "camera-source-video";
      document.body.append(video);
      current.video = video;
    }
    current.video.srcObject = stream;
    await current.video.play();
    if (!isCurrent(current)) throw stoppedError();
    await waitForVideo(current);
    if (!isCurrent(current)) throw stoppedError();
    configureCanvas(current);
    await updateCameraOptions(current);
    if (!isCurrent(current)) throw stoppedError();
  }

  function explainError(error) {
    if (error?.code === "HTTPS_REQUIRED") return "כדי לגשת למצלמה, פתחו את הכתובת המאובטחת שמתחילה ב־https:// בדפדפן רגיל.";
    if (error?.code === "MEDIA_UNAVAILABLE") return "הדפדפן הזה לא מאפשר גישה למצלמה בעמוד. פתחו את הקישור ישירות ב־Chrome מעודכן באנדרואיד או ב־Safari באייפון.";
    if (error?.code === "CONFIG_MISSING") return "הגדרת הרישיון עדיין אינה זמינה באתר. יש להשלים את הגדרת DeepAR בשרת ולנסות שוב.";
    if (error?.code === "CONFIG_NETWORK") return "לא הצלחנו לקבל את הגדרות האתר. בדקו את חיבור האינטרנט ונסו שוב.";
    if (error?.code === "SDK_NETWORK") return "מנוע ה־AR לא נטען. בדקו את חיבור האינטרנט ונסו שוב; חסימת תוכן בדפדפן עשויה למנוע את הטעינה.";
    if (error?.code === "CAMERA_EMPTY" || error?.code === "CAMERA_TIMEOUT") return "לא התקבלה תמונה מהמצלמה. סגרו אפליקציה אחרת שמשתמשת בה ונסו להפעיל שוב.";
    if (error?.code === "AR_TIMEOUT") return "המצלמה נפתחה, אבל תצוגת ה־AR לא התחילה. נסו שוב בדפדפן מעודכן.";
    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError" || error?.name === "SecurityError") return "הגישה למצלמה לא אושרה. פתחו את הרשאות האתר בדפדפן, אפשרו מצלמה ולחצו שוב על הפעלה.";
    if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") return "לא נמצאה מצלמה זמינה במכשיר הזה. בדקו שהיא מחוברת וזמינה לדפדפן.";
    if (error?.name === "NotReadableError" || error?.name === "TrackStartError") return "לא ניתן לפתוח את המצלמה כרגע. סגרו אפליקציות אחרות שמשתמשות בה ונסו שוב.";
    if (error?.name === "OverconstrainedError") return "המצלמה המבוקשת או הגדרות הצילום אינן זמינות במכשיר הזה.";
    const message = String(error?.message || "").toLowerCase();
    if (/licen[sc]e|domain|subscription|invalid key/.test(message)) return `רישיון DeepAR לא אושר. יש לבדוק שהוא פעיל ומוגדר לכתובת ${location.hostname}.`;
    if (/webgl|webassembly|wasm/.test(message)) return "מנוע ה־AR לא הצליח לפעול בדפדפן הזה. נסו דפדפן מעודכן עם תמיכה בגרפיקה מואצת.";
    return "לא הצלחנו להשלים את פתיחת המצלמה וה־AR. בדקו הרשאות וחיבור אינטרנט, ואז נסו שוב.";
  }

  async function startCamera() {
    if (session || startingOperations > 0) return;
    clearError();
    resetPreview();
    const current = {
      controller: new AbortController(), stopped: false, stream: null, video: null,
      engine: null, requestedFacing: "user", actualFacing: null, canSwitch: false,
      effect: "none", effectBusy: false, switching: false
    };
    session = current;
    startingOperations += 1;
    setPhase("starting");
    setMessage("טוענים את הגדרות האתר ואת מנוע ה־AR…");
    try {
      if (!window.isSecureContext) throw new CameraError("HTTPS_REQUIRED");
      if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("MEDIA_UNAVAILABLE");
      const config = await loadRuntimeConfig(current.controller.signal);
      if (!isCurrent(current)) return;
      const sdk = await loadSDK();
      if (!isCurrent(current)) return;
      setMessage("אשרו את הגישה למצלמה בחלון של הדפדפן.");
      const stream = await acquireCamera(current, "user");
      await prepareVideo(current, stream);
      if (!isCurrent(current)) return;
      setMessage("מכינים את תצוגת ה־AR. הטעינה הראשונה עשויה להימשך מעט יותר.");
      const engine = await sdk.initialize({
        licenseKey: config.licenseKey,
        rootPath: SDK_ROOT,
        canvas: elements["camera-canvas"],
        additionalOptions: { cameraConfig: { disableDefaultCamera: true } }
      });
      if (!isCurrent(current)) {
        try { engine.shutdown(); } catch { /* A stopped session must never retain an SDK instance. */ }
        return;
      }
      current.engine = engine;
      engine.setFps(TARGET_FPS);
      await attachProcessedVideo(current);
      if (!isCurrent(current)) return;
      elements["camera-canvas"].hidden = false;
      elements["preview-placeholder"].hidden = true;
      setMessage("התצוגה המקומית פעילה. אפשר לנסות את משקפי ה־AR או להחליף מצלמה.");
      setPhase("ready");
    } catch (error) {
      if (!isCurrent(current)) return;
      session = null;
      destroySession(current);
      resetPreview("המצלמה כבויה. בדקו את ההודעה ונסו שוב.");
      setMessage("המצלמה לא פעילה כרגע.");
      showError(explainError(error));
      setPhase("error");
    } finally {
      startingOperations -= 1;
      renderControls();
    }
  }

  async function switchCamera() {
    const current = session;
    if (!current || phase !== "ready" || !current.canSwitch || current.effectBusy) return;
    clearError();
    const previous = current.actualFacing || current.requestedFacing;
    const next = previous === "environment" ? "user" : "environment";
    current.switching = true;
    setPhase("switching");
    setMessage("משחררים את המצלמה הנוכחית ופותחים את המצלמה השנייה…");
    try {
      current.engine.stopVideo();
      current.video.pause();
      current.video.srcObject = null;
      stopTracks(current.stream);
      current.stream = null;
      let stream;
      let restored = false;
      try {
        stream = await acquireCamera(current, next, true);
      } catch (error) {
        if (!isCurrent(current)) return;
        stream = await acquireCamera(current, previous, false);
        restored = true;
      }
      await prepareVideo(current, stream);
      if (!isCurrent(current)) return;
      await attachProcessedVideo(current);
      if (!isCurrent(current)) return;
      setMessage(restored ? "לא ניתן היה להחליף מצלמה. המצלמה הקודמת פעילה." : "המצלמה הוחלפה. האפקט שבחרתם נשאר פעיל.");
      setPhase("ready");
    } catch (error) {
      if (!isCurrent(current)) return;
      stopCamera("החלפת המצלמה לא הושלמה.");
      showError(explainError(error));
      setPhase("error");
    } finally {
      current.switching = false;
      renderControls();
    }
  }

  async function chooseEffect(effect) {
    const current = session;
    if (!current || phase !== "ready" || current.effectBusy || current.effect === effect) return;
    clearError();
    current.effectBusy = true;
    renderControls();
    try {
      if (effect === "none") current.engine.clearEffect();
      else await current.engine.switchEffect(`${SDK_ROOT}effects/aviators`);
      if (!isCurrent(current)) return;
      current.effect = effect;
      updateEffectSelection(effect);
      setMessage(effect === "none" ? "המצלמה פעילה ללא אפקט." : "משקפי ה־AR פעילים. הביטו אל המצלמה כדי לראות את האפקט.");
    } catch {
      if (!isCurrent(current)) return;
      try { current.engine.clearEffect(); } catch { /* Keep the active camera available. */ }
      current.effect = "none";
      updateEffectSelection("none");
      showError("האפקט לא נטען. המצלמה עדיין פעילה; בדקו את חיבור האינטרנט ונסו לבחור באפקט שוב.");
    } finally {
      current.effectBusy = false;
      renderControls();
    }
  }

  function isPublishingCurrent(current) {
    return publication === current && !current.stopped && isCurrent(current.camera);
  }

  function publishMessage(text) { elements["publish-message"].textContent = text; }
  function publishError(text) {
    elements["publish-error"].textContent = text;
    elements["publish-error"].hidden = !text;
  }

  function renderPublishing() {
    const labels = { idle: "לא שולח", connecting: "מתחבר…", publishing: "וידאו פורסם לשרת", reconnecting: "מתחבר מחדש…", stopped: "השליחה נעצרה", error: "לא מחובר" };
    elements["publish-status-label"].textContent = labels[publishPhase];
    elements["publish-pill"].dataset.state = publishPhase === "publishing" ? "ready" : publishPhase;
    elements["publish-button"].hidden = !!publication;
    elements["publish-button"].disabled = phase !== "ready" || !session?.engine || !!session?.effectBusy || publishingOperations > 0;
    elements["publish-button-label"].textContent = publishingOperations > 0 && !publication ? "מסיימים את החיבור הקודם…" : elements["publish-mic"].checked ? "שליחת מצלמה וקול לשרת" : "שליחת וידאו בלבד לשרת";
    elements["publish-stop"].hidden = !publication;
    elements["publish-stop"].disabled = !publication;
    elements["publish-code"].disabled = !!publication || publishingOperations > 0;
    elements["publish-mic"].disabled = !!publication || publishingOperations > 0;
    const micTrack = publication?.microphoneStream?.getAudioTracks()[0];
    const hasMicrophone = micTrack?.readyState === "live";
    const muted = hasMicrophone && (!micTrack.enabled || publication?.microphonePublication?.track?.isMuted);
    elements["microphone-status"].textContent = hasMicrophone ? muted ? "מיקרופון מושתק" : "מיקרופון פעיל" : "מיקרופון כבוי";
    elements["microphone-status"].dataset.active = String(hasMicrophone && !muted);
    elements["microphone-mute"].hidden = !hasMicrophone;
    elements["microphone-mute"].disabled = !publication?.microphonePublication?.track || !!publication?.muteBusy || publishPhase !== "publishing";
    elements["microphone-mute"].textContent = muted ? "ביטול השתקת מיקרופון" : "השתקת מיקרופון";
    elements["microphone-mute"].setAttribute("aria-pressed", String(!!muted));
  }

  function setPublishPhase(next) { publishPhase = next; renderControls(); }

  function destroyPublication(current) {
    if (!current || current.stopped) return;
    current.stopped = true;
    current.controller.abort();
    clearTimeout(current.connectionTimer);
    stopTracks(current.canvasStream);
    stopTracks(current.microphoneStream);
    current.camera.publishCanvasSize = null;
    transport.disconnect(current.room);
  }

  function stopPublishing(text = "השליחה נעצרה. התצוגה המקומית של המצלמה נשארת פעילה.", failure = false) {
    const old = publication;
    publication = null;
    destroyPublication(old);
    publishMessage(publishingOperations > 0 ? `${text} אם בקשת מיקרופון עדיין פתוחה, סגרו אותה.` : text);
    setPublishPhase(failure ? "error" : "stopped");
  }

  async function startPublishing() {
    const camera = session;
    if (!camera || phase !== "ready" || camera.effectBusy || publication || publishingOperations > 0) return;
    publishError("");
    const current = {
      camera, stopped: false, controller: new AbortController(), room: null,
      canvasStream: null, microphoneStream: null, microphonePublication: null,
      videoPublished: false, ready: false, muteBusy: false, connectionTimer: null
    };
    publication = current;
    publishingOperations += 1;
    setPublishPhase("connecting");
    publishMessage("בודקים את קוד השליחה ומכינים חיבור פרטי לשרת…");
    try {
      const canvas = camera.engine.getCanvas();
      if (typeof canvas.captureStream !== "function") throw new transport.TransportError("CAPTURE_UNAVAILABLE");
      const config = await transport.requestToken(publisherAccess, current.controller.signal);
      if (!isPublishingCurrent(current)) return;
      const sdk = await transport.loadSDK();
      if (!isPublishingCurrent(current)) return;
      if (elements["publish-mic"].checked) {
        publishMessage("אשרו גישה למיקרופון כדי לצרף קול לשליחה.");
        let microphone;
        try {
          microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch {
          if (!isPublishingCurrent(current)) return;
          throw new transport.TransportError("MICROPHONE");
        }
        if (!isPublishingCurrent(current)) { stopTracks(microphone); return; }
        current.microphoneStream = microphone;
        const microphoneTrack = microphone.getAudioTracks()[0];
        if (!microphoneTrack) throw new transport.TransportError("MICROPHONE");
        microphoneTrack.addEventListener("ended", () => {
          if (!isPublishingCurrent(current)) return;
          publishError("המיקרופון נותק. הווידאו יכול להמשיך; כדי לצרף שוב קול, עצרו את השליחה והפעילו אותה מחדש.");
          renderPublishing();
        }, { once: true });
        renderPublishing();
      }
      camera.publishCanvasSize = { width: canvas.width, height: canvas.height };
      current.canvasStream = canvas.captureStream(TARGET_FPS);
      const videoTrack = current.canvasStream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState !== "live") throw new transport.TransportError("MEDIA_ENDED");
      videoTrack.addEventListener("ended", () => {
        if (isPublishingCurrent(current)) stopPublishing("מקור הווידאו נעצר. הפעילו את המצלמה שוב לפני השליחה.", true);
      }, { once: true });
      const room = transport.createRoom(sdk, () => isPublishingCurrent(current) && !document.hidden);
      current.room = room;
      room.on(sdk.RoomEvent.Reconnecting, () => {
        if (!isPublishingCurrent(current)) return;
        publishMessage("החיבור לשרת נקטע. מתבצע ניסיון התחברות מחדש; המצלמה המקומית ממשיכה לפעול.");
        setPublishPhase("reconnecting");
      });
      room.on(sdk.RoomEvent.Reconnected, () => {
        if (!isPublishingCurrent(current)) return;
        publishMessage("החיבור לשרת חזר. את התמונה המתקבלת אפשר לבדוק במסך המקלט.");
        setPublishPhase(current.ready ? "publishing" : "connecting");
      });
      room.on(sdk.RoomEvent.Disconnected, () => {
        if (!isPublishingCurrent(current)) return;
        stopPublishing("החיבור לשרת הסתיים. התצוגה המקומית נשארת פעילה; אפשר לנסות לשלוח שוב.", true);
      });
      publishMessage("מתחברים לשרת ומפרסמים את תצוגת ה־AR…");
      current.connectionTimer = setTimeout(() => {
        if (isPublishingCurrent(current) && !current.ready) stopPublishing("החיבור לא הושלם בזמן. אפשר לנסות שוב.", true);
      }, 35000);
      await room.connect(config.url, config.token, { ...transport.connectOptions, autoSubscribe: false });
      if (!isPublishingCurrent(current)) { transport.disconnect(room); return; }
      await room.localParticipant.publishTrack(videoTrack, {
        name: "boostera-ar", source: sdk.Track.Source.Camera, simulcast: false,
        videoEncoding: { maxBitrate: 3500000, maxFramerate: TARGET_FPS },
        degradationPreference: "maintain-framerate"
      });
      if (!isPublishingCurrent(current)) { transport.disconnect(room); return; }
      current.videoPublished = true;
      if (current.microphoneStream) {
        const microphoneTrack = current.microphoneStream.getAudioTracks()[0];
        const microphonePublication = await room.localParticipant.publishTrack(microphoneTrack, {
          name: "boostera-microphone", source: sdk.Track.Source.Microphone, stopMicTrackOnMute: false
        });
        if (!isPublishingCurrent(current)) { transport.disconnect(room); return; }
        current.microphonePublication = microphonePublication;
      }
      clearTimeout(current.connectionTimer);
      current.ready = true;
      publishMessage(current.microphonePublication ? "הווידאו והקול פורסמו לשרת. פתחו את המקלט במחשב כדי לבדוק את הקליטה." : "הווידאו פורסם לשרת ללא מיקרופון. פתחו את המקלט במחשב כדי לבדוק את הקליטה.");
      setPublishPhase(room.state === "connected" ? "publishing" : "reconnecting");
    } catch (cause) {
      if (!isPublishingCurrent(current)) return;
      stopPublishing("השליחה לא הושלמה. התצוגה המקומית נשארת פעילה.", true);
      publishError(transport.describeError(cause));
      elements["publish-error"].scrollIntoView?.({ block: "nearest", behavior: "auto" });
    } finally {
      publishingOperations -= 1;
      renderControls();
    }
  }

  async function toggleMicrophoneMute() {
    const current = publication;
    const track = current?.microphonePublication?.track;
    if (!current || !track || current.muteBusy || publishPhase !== "publishing") return;
    current.muteBusy = true;
    renderPublishing();
    try {
      if (track.isMuted) await track.unmute(); else await track.mute();
      if (isPublishingCurrent(current)) publishError("");
    } catch {
      if (isPublishingCurrent(current)) publishError("לא ניתן לשנות את מצב המיקרופון כרגע. אפשר לעצור את השליחה ולהתחבר מחדש.");
    } finally {
      current.muteBusy = false;
      renderPublishing();
    }
  }

  elements["site-hostname"].textContent = location.hostname;
  elements["start-button"].addEventListener("click", startCamera);
  elements["stop-button"].addEventListener("click", () => stopCamera());
  elements["switch-button"].addEventListener("click", switchCamera);
  elements["effect-none"].addEventListener("click", () => chooseEffect("none"));
  elements["effect-aviators"].addEventListener("click", () => chooseEffect("aviators"));
  elements["publish-button"].addEventListener("click", startPublishing);
  elements["publish-stop"].addEventListener("click", () => { publishError(""); stopPublishing(); });
  elements["publish-mic"].addEventListener("change", renderPublishing);
  elements["microphone-mute"].addEventListener("click", toggleMicrophoneMute);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && session) {
      setMessage("העמוד ברקע. המצלמה נשארת פעילה כל עוד הדפדפן מאפשר זאת.");
    } else if (!document.hidden && session && phase === "ready") {
      setMessage("המצלמה פעילה. אם מערכת ההפעלה השהתה את השידור, הפעילו מחדש את השליחה.");
    }
  });
  window.addEventListener("pagehide", () => { if (session) stopCamera(); });
  renderControls();
  if (!window.isSecureContext) showError(explainError(new CameraError("HTTPS_REQUIRED")));
})();
