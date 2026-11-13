"use strict";

(() => {
  const T = window.BoosteraTransport;
  const el = Object.fromEntries(["canvas", "code", "start", "stop", "status", "log"].map(id => [id, document.getElementById(`diag-${id}`)]));
  const access = T.createAccess("publisher", el.code);
  const ctx = el.canvas.getContext("2d");
  let session = null;
  const active = s => session === s && !s.stopped;
  const status = (text, failure = false) => { el.status.textContent = text; el.status.dataset.error = String(failure); };
  function log(text) {
    const line = `${new Date().toLocaleTimeString("he-IL")} · ${text}`;
    el.log.textContent = [...el.log.textContent.split("\n").slice(-19), line].join("\n");
  }
  function draw(s) {
    if (s && !active(s)) return;
    if (s && Date.now() >= s.deadline) { stop("הבדיקה הסתיימה אוטומטית אחרי 120 שניות."); return; }
    const n = s ? ++s.frame : 0;
    ctx.fillStyle = "#0c1424"; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = `hsl(${n * 7 % 360} 80% 60%)`;
    ctx.fillRect(24 + (n * 9 % 496), 250, 96, 60);
    ctx.fillStyle = "#eef4ff"; ctx.textAlign = "left";
    ctx.font = "bold 24px monospace"; ctx.fillText("BOOSTERA · SYNTHETIC TEST", 24, 48);
    ctx.font = "bold 64px monospace"; ctx.fillText(String(n).padStart(6, "0"), 24, 143);
    ctx.font = "18px monospace"; ctx.fillText(new Date().toISOString(), 24, 190);
    ctx.fillText("NO PHYSICAL CAMERA / MICROPHONE", 24, 222);
    ctx.fillText(s ? `${Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000))}s remaining` : "STOPPED · 640x360 · 10fps target", 24, 340);
    s?.video?.requestFrame?.();
  }
  function stop(text = "הבדיקה נעצרה. כל מקורות המדיה המלאכותיים נסגרו.", failure = false) {
    const s = session; session = null;
    if (s) {
      s.stopped = true; s.controller.abort();
      clearInterval(s.interval); clearTimeout(s.limit); clearTimeout(s.connectTimer);
      try { s.oscillator?.stop(); } catch { /* It may have stopped automatically. */ }
      for (const track of s.tracks) track.stop();
      if (s.audio) s.audio.close().catch(() => {});
      T.disconnect(s.room);
    }
    el.start.disabled = false; el.stop.disabled = true; el.code.disabled = false;
    draw(null); status(text, failure); log(text);
  }
  async function start() {
    if (session) return;
    if (!access.getCode()) { status(T.describeError({ code: "CODE_REQUIRED" }), true); return; }
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!window.isSecureContext || !Audio || !el.canvas.captureStream || !ctx) {
      status("נדרש דפדפן תומך Web Audio ו־canvas.captureStream דרך HTTPS.", true); return;
    }
    const s = { controller: new AbortController(), tracks: [], stopped: false, frame: 0, deadline: Date.now() + 120000 };
    session = s; el.start.disabled = true; el.stop.disabled = false; el.code.disabled = true;
    el.log.textContent = ""; status("מכינים מדיה מלאכותית ובודקים את קוד החיבור…");
    s.limit = setTimeout(() => { if (active(s)) stop("הבדיקה הסתיימה אוטומטית אחרי 120 שניות."); }, 120000);
    try {
      s.audio = new Audio();
      const resumed = s.audio.resume();
      const destination = s.audio.createMediaStreamDestination();
      const gain = s.audio.createGain(); gain.gain.value = 0.02;
      s.oscillator = s.audio.createOscillator(); s.oscillator.type = "sine"; s.oscillator.frequency.value = 440;
      s.oscillator.connect(gain); gain.connect(destination);
      s.tracks.push(...destination.stream.getAudioTracks());
      s.oscillator.start(); s.oscillator.stop(s.audio.currentTime + 120);
      draw(s);
      const stream = el.canvas.captureStream(10);
      s.video = stream.getVideoTracks()[0]; s.tracks.push(...stream.getTracks());
      if (!s.video) throw new Error("Synthetic capture failed");
      s.interval = setInterval(() => draw(s), 100);
      await resumed;
      if (!active(s)) return;
      if (s.audio.state !== "running") throw new Error("Synthetic audio did not start");
      log("מקורות מלאכותיים פעילים; המצלמה והמיקרופון לא הופעלו.");
      const [sdk, config] = await Promise.all([T.loadSDK(), T.requestToken(access, s.controller.signal)]);
      if (!active(s)) return;
      s.room = T.createRoom(sdk, () => active(s));
      const E = sdk.RoomEvent;
      s.room.on(E.ConnectionStateChanged, state => { if (active(s)) log(`מצב החיבור: ${state}`); });
      s.room.on(E.LocalTrackPublished, publication => { if (active(s)) log(`פורסם ערוץ ${publication.kind}: ${publication.trackName}`); });
      s.room.on(E.Reconnecting, () => { if (active(s)) status("החיבור נקטע; מנסים להתחבר מחדש בתוך חלון הבדיקה."); });
      s.room.on(E.Reconnected, () => { if (active(s)) { status("החיבור חודש. בדקו שהמונה ממשיך להתעדכן במקלט."); log("החיבור חודש."); } });
      s.room.on(E.Disconnected, () => { if (active(s)) stop("החיבור לשרת הסתיים; הבדיקה נעצרה.", true); });
      s.connectTimer = setTimeout(() => { if (active(s)) stop("החיבור או פרסום המדיה לא הושלמו בזמן.", true); }, 30000);
      await s.room.connect(config.url, config.token, { ...T.connectOptions, autoSubscribe: false });
      if (!active(s)) { T.disconnect(s.room); return; }
      log("מחוברים לחדר; מתחילים לפרסם את ערוצי הבדיקה.");
      await Promise.all([
        s.room.localParticipant.publishTrack(s.video, { name: "synthetic-video", source: sdk.Track.Source.Camera, simulcast: false, videoEncoding: { maxBitrate: 350000, maxFramerate: 10 } }),
        s.room.localParticipant.publishTrack(s.tracks[0], { name: "synthetic-audio", source: sdk.Track.Source.Microphone, dtx: false })
      ]);
      if (!active(s)) { T.disconnect(s.room); return; }
      clearTimeout(s.connectTimer);
      status("שני הערוצים המלאכותיים פורסמו לשרת. בדקו תמונה ושמע במקלט כדי לאמת קבלה בפועל.");
    } catch (error) {
      if (active(s)) stop(error?.code ? T.describeError(error) : "הבדיקה נכשלה בהפעלת המדיה או בחיבור. בדקו את הרשת ואת המקלט ונסו שוב.", true);
      else T.disconnect(s.room);
    }
  }
  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", () => stop());
  window.addEventListener("pagehide", () => { if (session) stop(); });
  document.addEventListener("visibilitychange", () => { if (session && Date.now() >= session.deadline) stop("חלון הבדיקה הסתיים; המדיה נעצרה."); });
  if (ctx) draw(null);
})();
