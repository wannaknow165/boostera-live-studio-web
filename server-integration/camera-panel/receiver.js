"use strict";

(() => {
  const T = window.BoosteraTransport;
  const ids = ["receiver-code", "receiver-connect", "receiver-disconnect", "receiver-sound", "receiver-message", "receiver-error", "receiver-pill", "receiver-status-label", "receiver-media-state", "receiver-video", "receiver-placeholder", "receiver-placeholder-title", "receiver-placeholder-copy", "receiver-resolution", "receiver-audio-state", "receiver-audio-elements", "receiver-play-button"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const access = T.createAccess("viewer", el["receiver-code"]);
  let session = null;
  let phase = "idle";
  const active = current => session === current && !current.stopped;

  function message(text) { el["receiver-message"].textContent = text; }
  function error(text) { el["receiver-error"].textContent = text; el["receiver-error"].hidden = !text; }
  function placeholder(title, copy) {
    el["receiver-placeholder-title"].textContent = title;
    el["receiver-placeholder-copy"].textContent = copy;
    el["receiver-placeholder"].hidden = false;
  }

  function render() {
    const labels = { idle: "לא מחובר", connecting: "מתחבר…", waiting: "מחובר · ממתין", receiving: "תמונה מתקבלת", reconnecting: "מתחבר מחדש…", stopped: "מנותק", error: "החיבור לא פעיל" };
    el["receiver-status-label"].textContent = labels[phase];
    el["receiver-pill"].dataset.state = phase === "receiving" ? "ready" : phase;
    el["receiver-media-state"].textContent = phase === "receiving" ? "וידאו מתקבל" : labels[phase];
    el["receiver-connect"].disabled = !!session;
    el["receiver-connect"].textContent = phase === "connecting" ? "מתחבר…" : "התחברות לצפייה";
    el["receiver-disconnect"].disabled = !session;
    el["receiver-code"].disabled = !!session;
    const hasAudio = !!session?.audio.size;
    el["receiver-sound"].disabled = !hasAudio || !session?.connected;
    el["receiver-sound"].textContent = session?.soundEnabled ? "השתקת שמע" : "הפעלת שמע";
    el["receiver-sound"].setAttribute("aria-pressed", String(!!session?.soundEnabled));
    const allMuted = hasAudio && [...session.audio.values()].every(item => item.track.isMuted);
    el["receiver-audio-state"].textContent = !hasAudio ? "לא מתקבל ערוץ שמע" : allMuted ? "המיקרופון אצל השולח מושתק" : session.soundEnabled ? "שמע פעיל" : "שמע כבוי במקלט";
  }

  function setPhase(next) { phase = next; render(); }

  function detachVideo(current) {
    current.videoGeneration += 1;
    if (current.frameRequest != null && el["receiver-video"].cancelVideoFrameCallback) el["receiver-video"].cancelVideoFrameCallback(current.frameRequest);
    current.frameRequest = null;
    if (current.videoTrack) {
      try { current.videoTrack.detach(el["receiver-video"]); } catch { /* The room may already have detached it. */ }
    }
    current.videoTrack = null;
    current.lastFrameAt = 0;
    const video = el["receiver-video"];
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    el["receiver-resolution"].textContent = "—";
    el["receiver-play-button"].hidden = true;
  }

  function detachAudio(current, track) {
    const item = current.audio.get(track);
    if (!item) return;
    item.element.muted = true;
    item.element.pause();
    try { track.detach(item.element); } catch { /* Continue local cleanup. */ }
    item.element.srcObject = null;
    item.element.remove();
    current.audio.delete(track);
  }

  function closeSession(current) {
    if (!current || current.stopped) return;
    current.stopped = true;
    current.controller.abort();
    clearTimeout(current.connectionTimer);
    clearInterval(current.frameTimer);
    detachVideo(current);
    for (const track of [...current.audio.keys()]) detachAudio(current, track);
    T.disconnect(current.room);
  }

  function disconnect(text = "הצפייה נותקה. אפשר להתחבר שוב כשתרצו.", failure = false) {
    const old = session;
    session = null;
    closeSession(old);
    placeholder("המקלט מנותק", "לחצו על התחברות לצפייה כדי להתחיל שוב.");
    message(text);
    setPhase(failure ? "error" : "stopped");
  }

  function gotFrame(current, generation) {
    if (!active(current) || current.videoGeneration !== generation || !current.connected || current.videoTrack?.isMuted) return;
    const video = el["receiver-video"];
    if (!video.videoWidth || !video.videoHeight) return;
    current.lastFrameAt = performance.now();
    el["receiver-resolution"].textContent = `${video.videoWidth} × ${video.videoHeight}`;
    el["receiver-placeholder"].hidden = true;
    el["receiver-play-button"].hidden = true;
    if (phase !== "receiving") {
      setPhase("receiving");
      message("תמונה מהשולח מוצגת כאן. אפשר להפעיל שמע בנפרד אם נשלח גם מיקרופון.");
    }
  }

  function watchVideo(current) {
    const video = el["receiver-video"];
    const generation = current.videoGeneration;
    current.lastVideoTime = video.currentTime;
    current.lastFrameCount = video.getVideoPlaybackQuality?.().totalVideoFrames || 0;
    if (video.requestVideoFrameCallback) {
      const callback = () => {
        if (!active(current) || current.videoGeneration !== generation) return;
        gotFrame(current, generation);
        current.frameRequest = video.requestVideoFrameCallback(callback);
      };
      current.frameRequest = video.requestVideoFrameCallback(callback);
    }
  }

  function attachVideo(current, track) {
    if (!active(current) || current.videoTrack === track) return;
    detachVideo(current);
    current.videoTrack = track;
    const video = el["receiver-video"];
    video.muted = true;
    video.playsInline = true;
    video.hidden = false;
    placeholder("ממתינים לתמונה", "ערוץ הווידאו מחובר. התמונה תופיע כשהיא תתקבל.");
    track.attach(video);
    watchVideo(current);
    video.play().catch(() => {
      if (!active(current) || current.videoTrack !== track) return;
      el["receiver-play-button"].hidden = false;
      placeholder("נדרשת לחיצה להפעלה", "הדפדפן עצר הפעלה אוטומטית של התמונה.");
    });
  }

  function attachAudio(current, track) {
    if (!active(current) || current.audio.has(track)) return;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.muted = !current.soundEnabled;
    el["receiver-audio-elements"].append(audio);
    track.attach(audio);
    audio.muted = !current.soundEnabled;
    current.audio.set(track, { track, element: audio });
    if (current.soundEnabled) audio.play().catch(() => {
      if (!active(current)) return;
      current.soundEnabled = false;
      for (const item of current.audio.values()) item.element.muted = true;
      message("השמע נחסם על ידי הדפדפן. לחצו שוב על הפעלת שמע.");
      render();
    });
    render();
  }

  function registerRoom(current, sdk) {
    const room = current.room;
    const events = sdk.RoomEvent;
    room.on(events.TrackSubscribed, track => {
      if (!active(current)) return;
      if (track.kind === "video") attachVideo(current, track);
      if (track.kind === "audio") attachAudio(current, track);
    });
    room.on(events.TrackUnsubscribed, track => {
      if (!active(current)) return;
      if (track === current.videoTrack) {
        detachVideo(current);
        placeholder("ממתינים לשולח", "התמונה נעצרה. היא תופיע שוב כשהשולח יפרסם וידאו.");
        if (current.connected) setPhase("waiting");
      }
      detachAudio(current, track);
      render();
    });
    room.on(events.TrackMuted, publication => {
      if (!active(current)) return;
      if (publication.track === current.videoTrack) {
        current.lastFrameAt = 0;
        placeholder("התמונה מושהית", "ממתינים שהשולח יחזיר את הווידאו.");
        if (current.connected) setPhase("waiting");
      }
      render();
    });
    room.on(events.TrackUnmuted, () => { if (active(current)) render(); });
    room.on(events.TrackSubscriptionFailed, () => {
      if (active(current)) error("לא ניתן לקבל את אחד מערוצי המדיה. בדקו את הרשת או נתקו והתחברו שוב.");
    });
    room.on(events.Reconnecting, () => {
      if (!active(current)) return;
      current.connected = false;
      current.lastFrameAt = 0;
      placeholder("החיבור מתחדש", "ממתינים לחזרה של תמונה עדכנית.");
      message("החיבור לשרת נקטע. מתבצע ניסיון התחברות מחדש.");
      setPhase("reconnecting");
    });
    room.on(events.Reconnected, () => {
      if (!active(current)) return;
      current.connected = true;
      current.lastFrameAt = 0;
      setPhase("waiting");
      placeholder("ממתינים לתמונה", "החיבור חזר. ממתינים לפריים עדכני מהשולח.");
    });
    room.on(events.Disconnected, () => {
      if (!active(current)) return;
      disconnect("החיבור הסתיים. לחצו על התחברות לצפייה כדי לנסות שוב.", true);
    });
  }

  async function connect() {
    if (session) return;
    error("");
    if (!window.isSecureContext) { error("פתחו את המקלט דרך כתובת HTTPS מאובטחת."); return; }
    const current = {
      controller: new AbortController(), stopped: false, room: null, connected: false,
      videoTrack: null, videoGeneration: 0, frameRequest: null, lastFrameAt: 0,
      audio: new Map(), soundEnabled: false, connectionTimer: null, frameTimer: null
    };
    session = current;
    setPhase("connecting");
    placeholder("מתחברים למקלט", "בודקים את קוד הצפייה ואת החיבור לשרת.");
    message("מתחברים באופן פרטי. המצלמה והמיקרופון במכשיר הזה נשארים סגורים.");
    try {
      const config = await T.requestToken(access, current.controller.signal);
      if (!active(current)) return;
      const sdk = await T.loadSDK();
      if (!active(current)) return;
      const room = T.createRoom(sdk, () => active(current));
      current.room = room;
      registerRoom(current, sdk);
      current.connectionTimer = setTimeout(() => {
        if (active(current) && !current.connected) disconnect("החיבור לא הושלם בזמן. אפשר לנסות שוב.", true);
      }, 35000);
      await room.connect(config.url, config.token, T.connectOptions);
      clearTimeout(current.connectionTimer);
      if (!active(current)) { T.disconnect(room); return; }
      current.connected = true;
      setPhase("waiting");
      placeholder("ממתינים לשולח", "המקלט מחובר. הפעילו שליחה מהטלפון כדי לראות תמונה.");
      message("מחוברים לשרת. ממתינים לווידאו מהשולח.");
      // Also handle already-subscribed publications when connection resolution races an event.
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track?.kind === "video") attachVideo(current, publication.track);
          if (publication.track?.kind === "audio") attachAudio(current, publication.track);
        }
      }
      current.frameTimer = setInterval(() => {
        if (!active(current) || !current.connected || !current.videoTrack) return;
        const video = el["receiver-video"];
        if (!video.requestVideoFrameCallback && video.readyState >= 2 && video.videoWidth) {
          const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
          const changed = Number.isFinite(count) ? count > current.lastFrameCount : video.currentTime > current.lastVideoTime;
          current.lastFrameCount = count || 0;
          current.lastVideoTime = video.currentTime;
          if (changed) gotFrame(current, current.videoGeneration);
        }
        if (phase === "receiving" && performance.now() - current.lastFrameAt > 4500) {
          placeholder("ממתינים לתמונה עדכנית", "לא התקבל פריים חדש כרגע. בודקים את החיבור לשולח.");
          setPhase("waiting");
        }
      }, 1000);
    } catch (cause) {
      if (!active(current)) return;
      disconnect("הצפייה לא התחילה.", true);
      error(T.describeError(cause));
    }
  }

  async function toggleSound() {
    const current = session;
    if (!current || !current.connected || !current.audio.size) return;
    error("");
    if (current.soundEnabled) {
      current.soundEnabled = false;
      for (const item of current.audio.values()) item.element.muted = true;
      render();
      return;
    }
    current.soundEnabled = true;
    try {
      const plays = [];
      for (const item of current.audio.values()) { item.element.muted = false; plays.push(item.element.play()); }
      plays.push(current.room.startAudio());
      await Promise.all(plays);
      if (!active(current)) return;
      render();
    } catch {
      if (!active(current)) return;
      current.soundEnabled = false;
      for (const item of current.audio.values()) item.element.muted = true;
      error("הדפדפן לא אפשר הפעלת שמע. לחצו שוב על הפעלת שמע ובדקו שעוצמת הקול במכשיר פתוחה.");
      render();
    }
  }

  el["receiver-connect"].addEventListener("click", connect);
  el["receiver-disconnect"].addEventListener("click", () => { error(""); disconnect(); });
  el["receiver-sound"].addEventListener("click", toggleSound);
  el["receiver-play-button"].addEventListener("click", () => {
    el["receiver-video"].play().catch(() => error("הפעלת התמונה נחסמה. נסו לנתק ולהתחבר מחדש בדפדפן רגיל."));
  });
  window.addEventListener("pagehide", () => { if (session) disconnect(); });
  render();
})();
