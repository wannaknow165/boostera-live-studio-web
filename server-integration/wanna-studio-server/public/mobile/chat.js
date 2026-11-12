// Shared by the camera and manager. Messages are always text, never HTML or executable commands.
export function mountChat(root) {
  const section = document.createElement('section');
  section.className = 'live-chat';
  section.innerHTML = `<div class="title-row"><h3>הצ׳אט והאירועים שלך</h3><span data-source class="muted"></span></div>
    <p data-chat-status role="status">ממתין לחיבור ללייב.</p><p data-live-counts class="muted"></p>
    <label class="check"><input type="checkbox" data-read-chat>הקראת הודעות חדשות בקול</label>
    <div class="live-chat-messages" data-chat role="log" aria-label="הודעות מהלייב" aria-live="polite"></div>
    <details><summary>מתנות ופעילות אחרונה</summary><div data-activity class="live-chat-messages"></div></details>
    <details data-provider-setup hidden><summary>הגדרת חיבור האירועים</summary>
      <form class="form-stack" data-provider-form><label>שירות קליטה<select name="provider"><option value="direct">חיבור ישיר</option><option value="tiktools">Tik.Tools</option></select></label>
      <label>מפתח Tik.Tools<input name="apiKey" type="password" autocomplete="off" dir="ltr" placeholder="השאר ריק לשמירת המפתח הקיים"></label>
      <button class="button subtle">שמור חיבור</button><p data-provider-note class="muted" role="status">המפתח נשמר בשרת ואינו נשלח לטלפון. שמירה אינה מפעילה חיבור.</p></form></details>`;
  root.append(section);
  const get = selector => section.querySelector(selector), speech = window.speechSynthesis;
  let lastId = null, room = null, signature = '', speechGeneration = 0;
  if (!speech) get('[data-read-chat]').disabled = true;
  get('[data-read-chat]').onchange = () => { ++speechGeneration; speech?.cancel(); };
  const names = {gift:'מתנה',like:'לייק',member:'הצטרפות',follow:'מעקב',share:'שיתוף',subscribe:'מנוי',battle:'באטל',linkMicBattle:'באטל',linkMicArmies:'ניקוד באטל'};
  function row(event, activity = false) {
    const line = document.createElement('div'), author = document.createElement('strong'), body = document.createElement('span'), time = document.createElement('time');
    line.className = 'live-chat-message';
    author.textContent = event.user?.name || event.user?.handle || (activity ? names[event.type] || event.type : 'צופה');
    body.dir = 'auto';
    body.textContent = activity ? [names[event.type] || event.type, event.name, event.count ? '× ' + event.count : '', event.battleId].filter(Boolean).join(' · ') : event.text;
    time.textContent = new Date(event.at).toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'});
    line.append(author, time, body); return line;
  }
  async function providerInfo() {
    try {
      const response = await fetch('/api/workspace/tiktok/provider', {cache:'no-store'});
      if (!response.ok) return;
      const info = await response.json();
      get('[data-source]').textContent = info.provider === 'tiktools' ? 'Tik.Tools' : 'חיבור ישיר';
      get('[data-provider-setup]').hidden = !info.canConfigure;
      get('[data-provider-form]').elements.provider.value = info.provider;
      if (info.provider === 'tiktools') get('[data-provider-note]').textContent = info.tiktoolsConfigured ? 'מפתח מוגדר בשרת. לחץ חבר צ׳אט ובאטל כדי להתחיל.' : 'נדרש מפתח Tik.Tools אישי. הזן אותו כאן בלבד.';
    } catch { get('[data-source]').textContent = 'אין חיבור לשרת'; }
  }
  get('[data-provider-form]').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
    const body = {provider:form.elements.provider.value};
    if (form.elements.apiKey.value.trim()) body.apiKey = form.elements.apiKey.value.trim();
    form.elements.apiKey.value = '';
    try {
      const response = await fetch('/api/workspace/tiktok/provider', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) { get('[data-provider-note]').textContent = response.status === 409 ? 'נתק את קליטת האירועים לפני שינוי החיבור.' : 'ההגדרה לא נשמרה. נסה מהמסך המקומי.'; return; }
      await providerInfo(); get('[data-provider-note]').textContent = 'ההגדרה נשמרה. לחץ חבר צ׳אט ובאטל.';
    } catch { get('[data-provider-note]').textContent = 'לא התקבל אישור שמירה מהשרת.'; }
    finally { button.disabled = false; }
  };
  void providerInfo();
  return {
    render(state) {
      const connected = state.status === 'connected', roomKey = state.handle + ':' + state.roomId;
      const messages = connected ? (state.chat || []).slice(0, 100) : [];
      const newest = messages[0]?.id ?? null;
      if (connected && roomKey === room && lastId !== null && get('[data-read-chat]').checked) {
        const fresh = messages.filter(event => event.id > lastId).slice(0, 3).reverse(), generation = speechGeneration;
        for (const message of fresh) {
          if (speech.pending) break;
          const utterance = new SpeechSynthesisUtterance((message.user?.name || message.user?.handle || 'צופה') + ': ' + message.text);
          utterance.lang = /[א-ת]/.test(message.text) ? 'he-IL' : 'en-US';
          if (generation === speechGeneration) speech.speak(utterance);
        }
      }
      if (!connected || room !== roomKey) { ++speechGeneration; speech?.cancel(); }
      room = roomKey; lastId = connected ? newest ?? 0 : null;
      get('[data-chat-status]').textContent = !connected ? 'אין קליטת צ׳אט פעילה. השידור והאפקטים זמינים בנפרד.' : messages.length ? 'הודעות מהחיבור הנוכחי · אחרונה ב־' + new Date(messages[0].at).toLocaleTimeString('he-IL') : 'מחובר לחדר הלייב; ממתין להודעה הראשונה.';
      get('[data-live-counts]').textContent = connected ? `${state.viewers || 0} צופים · ${state.likes || 0} לייקים · ${state.gifts || 0} מתנות · ${state.follows || 0} עוקבים חדשים · ${state.shares || 0} שיתופים` : '';
      const activity = connected ? (state.events || []).filter(event => !['chat','emote','roomUser'].includes(event.type)).slice(0, 15) : [];
      const next = JSON.stringify([messages, activity]);
      if (next !== signature) {
        signature = next; get('[data-chat]').replaceChildren(...messages.slice().reverse().map(event => row(event)));
        get('[data-activity]').replaceChildren(...activity.map(event => row(event, true)));
        get('[data-chat]').scrollTop = get('[data-chat]').scrollHeight;
      }
    },
    close() { ++speechGeneration; speech?.cancel(); section.remove(); },
  };
}
