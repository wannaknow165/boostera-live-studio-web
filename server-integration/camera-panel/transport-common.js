"use strict";

(() => {
  const SDK_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.23.0/dist/livekit-client.umd.min.js";
  let sdkPromise;

  class TransportError extends Error {
    constructor(code) { super(code); this.name = "TransportError"; this.code = code; }
  }

  function abortError() { return new DOMException("Connection cancelled", "AbortError"); }

  function createAccess(role, input) {
    if (role !== "publisher" && role !== "viewer") throw new TransportError("ROLE");
    const storageKey = `boostera.transport.${role}.code`;
    let remembered = "";
    try { remembered = sessionStorage.getItem(storageKey) || ""; } catch { /* Storage may be disabled. */ }
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has("connect")) {
      remembered = (fragment.get("connect") || "").trim();
      try { sessionStorage.setItem(storageKey, remembered); } catch { /* Keep it in the current page only. */ }
      fragment.delete("connect");
      const remaining = fragment.toString();
      history.replaceState(history.state, "", `${location.pathname}${location.search}${remaining ? `#${remaining}` : ""}`);
    }
    input.value = remembered;
    return {
      role,
      getCode() { return input.value.trim(); },
      remember(code) {
        try { sessionStorage.setItem(storageKey, code); } catch { /* No persistence is required. */ }
      },
      clear() {
        input.value = "";
        try { sessionStorage.removeItem(storageKey); } catch { /* Already absent. */ }
      }
    };
  }

  async function requestToken(access, signal) {
    const code = access.getCode();
    if (!code) throw new TransportError("CODE_REQUIRED");
    const controller = new AbortController();
    let timedOut = false;
    const aborted = () => controller.abort();
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      if (signal.aborted) throw abortError();
      const response = await fetch("/api/transport/token", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ code, role: access.role }), signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) throw new TransportError("CODE_REJECTED");
      if (response.status === 429) throw new TransportError("RATE_LIMITED");
      if (!response.ok) throw new TransportError("SERVER_UNAVAILABLE");
      const config = await response.json();
      if (typeof config?.url !== "string" || !config.url.startsWith("wss://") || typeof config.token !== "string" || !config.token || typeof config.room !== "string") throw new TransportError("SERVER_CONFIG");
      if (signal.aborted) throw abortError();
      access.remember(code);
      return config;
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (timedOut) throw new TransportError("TOKEN_TIMEOUT");
      if (error instanceof TransportError) throw error;
      throw new TransportError("NETWORK");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }

  function loadSDK() {
    if (window.LivekitClient?.Room) return Promise.resolve(window.LivekitClient);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(window.LivekitClient);
      };
      const timer = setTimeout(() => finish(new TransportError("SDK_NETWORK")), 25000);
      script.src = SDK_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => finish(window.LivekitClient?.Room ? null : new TransportError("SDK_NETWORK"));
      script.onerror = () => finish(new TransportError("SDK_NETWORK"));
      document.head.append(script);
    }).catch(error => { sdkPromise = null; throw error; });
    return sdkPromise;
  }

  function createRoom(sdk, shouldReconnect) {
    return new sdk.Room({
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: true,
      reconnectPolicy: {
        nextRetryDelayInMs(context) {
          if (!shouldReconnect() || context.elapsedMs > 25000) return null;
          return [0, 1000, 3000, 5000][context.retryCount] ?? null;
        }
      }
    });
  }

  function disconnect(room) {
    if (!room) return;
    try { Promise.resolve(room.disconnect(true)).catch(() => {}); } catch { /* Local tracks are separately owned and stopped. */ }
  }

  function describeError(error) {
    const messages = {
      CODE_REQUIRED: "הזינו את קוד החיבור הפרטי שקיבלתם.",
      CODE_REJECTED: "קוד החיבור שגוי, פג תוקף או אינו מתאים למסך הזה. השתמשו בקישור או בקוד המתאים.",
      RATE_LIMITED: "בוצעו יותר מדי ניסיונות. המתינו מעט לפני ניסיון נוסף.",
      SERVER_UNAVAILABLE: "שירות החיבור אינו זמין כרגע. אפשר לנסות שוב בעוד רגע.",
      SERVER_CONFIG: "הגדרת שירות החיבור אינה תקינה. יש לבדוק את ההגדרה בשרת.",
      TOKEN_TIMEOUT: "השרת לא השיב בזמן. בדקו את חיבור האינטרנט ונסו שוב.",
      NETWORK: "לא ניתן להגיע לשירות החיבור. בדקו את חיבור האינטרנט ונסו שוב.",
      SDK_NETWORK: "רכיב השידור לא נטען. בדקו את חיבור האינטרנט או חסימת התוכן בדפדפן.",
      CAPTURE_UNAVAILABLE: "הדפדפן אינו תומך בשליחת תצוגת ה־AR. נסו Chrome מעודכן באנדרואיד או Safari מעודכן באייפון.",
      MICROPHONE: "המיקרופון לא אושר או אינו זמין. אפשר לבטל את צירוף המיקרופון ולשלוח וידאו בלבד.",
      CONNECT_TIMEOUT: "החיבור לא הושלם בזמן. התצוגה המקומית נשארת פעילה; אפשר לנסות שוב.",
      MEDIA_ENDED: "מקור הווידאו נעצר. הפעילו את המצלמה מחדש לפני השליחה."
    };
    return messages[error?.code] || "החיבור לא הושלם. בדקו את הרשת ואת תוקף קוד החיבור ונסו שוב.";
  }

  window.BoosteraTransport = Object.freeze({
    TransportError, abortError, createAccess, requestToken, loadSDK, createRoom, disconnect, describeError,
    connectOptions: Object.freeze({ autoSubscribe: true, maxRetries: 1, websocketTimeout: 12000, peerConnectionTimeout: 15000 })
  });
})();
