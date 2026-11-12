// Battle automations: a TikTok LIVE event (battle start, ×2/×3/×5, snipe, win, lose, a gift…) fires an effect by itself.
// Rules live in data/automations.json. Events come in on POST /api/event { type, user, gift, count, supporter, avatar, mult }
// (supporter = who gave, avatar = the address of the profile picture, mult = the multiplier to write in a supporter effect).
import fs from 'node:fs';
import path from 'node:path';

export const EVENTS = {
  battle_start: { he: '⚔ תחילת קרב', hint: 'user = היריב' },
  gift_x2: { he: '✌ כפפה ×2', hint: 'user = על מי' },
  gift_x3: { he: '🤟 כפפה ×3', hint: 'user = על מי' },
  gift_x5: { he: '🖐 כפפה ×5', hint: 'user = על מי' },
  snipe: { he: '🎯 סנייפ (גניבה ברגע האחרון)', hint: 'user = היריב' },
  lead: { he: '📈 עקיפה בניקוד', hint: '' },
  win: { he: '🏆 ניצחון', hint: 'user = היריב שהפסיד' },
  lose: { he: '💀 הפסד', hint: 'user = היריב שניצח' },
  coins_goal: { he: '💰 הגענו ליעד כסף', hint: 'הקורא שולח כשמגיעים ליעד שקבעת' },
  quiet: { he: '😴 הקהל נרדם (שקט ארוך)', hint: 'אין מתנות/תגובות כמה זמן' },
  gift: { he: '🎁 מתנה מסוימת', hint: 'gift = שם המתנה (Rose, Lion, Universe…)' },
  supporter_gift: { he: '💛 מתנה מתומך', hint: 'supporter = שם התומך · avatar = תמונת הפרופיל שלו · mult = הכפל שייכתב' },
};

// action.type: overlay (id) · special (battle clip id on the player) · player_random (random personal clip of that player)
//              clip (background video id) · live (live effect id on the streamer) · supporter_video (that supporter's front video)
export const DEFAULT_RULES = [
  { id: 'r1', on: 'battle_start', action: { type: 'player_random' }, delayMs: 1500, enabled: true, note: 'כשהקרב מתחיל: קליפ אישי של היריב (הטורקי מרביץ ל-…)' },
  { id: 'r2', on: 'gift_x2', action: { type: 'special', id: 'multiplier_x2' }, delayMs: 0, enabled: true, note: 'סטירה כפולה על היריב' },
  { id: 'r3', on: 'gift_x3', action: { type: 'special', id: 'multiplier_x3' }, delayMs: 0, enabled: true, note: '"אחת שתיים שלוש" על היריב' },
  { id: 'r4', on: 'gift_x5', action: { type: 'special', id: 'glove_x5' }, delayMs: 0, enabled: true, note: 'טירוף הגמד על היריב' },
  { id: 'r5', on: 'snipe', action: { type: 'special', id: 'snipe' }, delayMs: 0, enabled: true, note: 'כוונת סנייפר על היריב' },
  { id: 'r6', on: 'lead', action: { type: 'overlay', id: 'boxer3' }, delayMs: 0, enabled: false, note: 'אגרוף למצלמה כשעוקפים' },
  { id: 'r7', on: 'win', action: { type: 'live', id: 'werelion-beast' }, delayMs: 800, enabled: true, note: 'ניצחון: המשדרת הופכת לאריה' },
  { id: 'r8', on: 'lose', action: { type: 'special', id: 'diaper' }, delayMs: 800, enabled: true, note: 'הפסד: חיתול על היריב (צחוק)' },
  { id: 'r9', on: 'gift', match: 'Lion', action: { type: 'live', id: 'werelion-beast' }, delayMs: 0, enabled: true, note: 'מתנת אריה → אריה פראי' },
  { id: 'r10', on: 'gift', match: 'Universe', action: { type: 'live', id: 'anubis' }, delayMs: 0, enabled: true, note: 'יקום → אנוביס' },
  { id: 'r11', on: 'supporter_gift', action: { type: 'supporter_video' }, delayMs: 0, enabled: true, note: 'תומך ששלח מתנה: הסרטון שלו (פרונט) אם קיים' },
  // screen punches: the camera picture gets hit (shake + glove + cracked glass) — wakes the audience
  { id: 'r12', on: 'gift_x2', action: { type: 'double', mult: 2, seconds: 30 }, delayMs: 0, enabled: true, note: 'דאבל ×2: דופק על המסך כל הזמן שהדאבל רץ' },
  { id: 'r13', on: 'gift_x3', action: { type: 'double', mult: 3, seconds: 30 }, delayMs: 0, enabled: false, note: 'ממתין לאפקט המיוחד של ×3' },
  { id: 'r14', on: 'gift_x5', action: { type: 'double', mult: 5, seconds: 30 }, delayMs: 0, enabled: false, note: 'ממתין לאפקט המיוחד של ×5' },
  { id: 'r15', on: 'battle_start', action: { type: 'screen_hits', count: 2 }, delayMs: 0, enabled: true, note: 'פתיחת קרב: שתי דפיקות על המסך' },
  { id: 'r16', on: 'lead', action: { type: 'screen_hits', count: 3 }, delayMs: 0, enabled: true, note: 'עקיפה: שלוש דפיקות' },
  { id: 'r17', on: 'quiet', action: { type: 'wake_up' }, delayMs: 0, enabled: true, note: 'כולם נרדמו: הגמד בא, WAKE UP, ובסוף בום' },
  // tomatoes on the chosen head (pick it in the live panel: "בחר ראש")
  { id: 'r18', on: 'gift', match: 'Rose', action: { type: 'tomato', count: 1, perGift: true }, delayMs: 0, cooldownMs: 0, enabled: true, note: 'כל ורד = עגבנייה מתפוצצת על המסך' },
  { id: 'r19', on: 'coins_goal', action: { type: 'tomato', count: 3 }, delayMs: 0, enabled: true, note: 'יעד כסף = 3 עגבניות על המסך' },
  // supporter effects: whoever gave is IN the effect (profile picture cut to a head, name, what is written). They need the
  // event to say who: supporter (+ avatar = the profile picture). "needs" = the rule is skipped when the event has no such field.
  { id: 'r20', on: 'supporter_gift', needs: 'supporter', action: { type: 'special', id: 'fan_burst' }, delayMs: 0, enabled: true, note: 'מתנה מתומך: הוא עצמו בתוך פיצוץ זהב (mult באירוע = הכפל שייכתב, למשל 50)' },
  { id: 'r21', on: 'win', needs: 'supporter', action: { type: 'special', id: 'fan_mvp' }, delayMs: 2500, enabled: true, note: 'ניצחון: MVP עם כתר לתומך המוביל (supporter + avatar באירוע)' },
  { id: 'r22', on: 'gift_x2', needs: 'supporter', action: { type: 'special', id: 'fan_burst', mult: 2 }, delayMs: 700, enabled: true, note: '×2: מי שנתן, בתוך פיצוץ ×2' },
  { id: 'r23', on: 'gift_x3', needs: 'supporter', action: { type: 'special', id: 'fan_burst', mult: 3 }, delayMs: 700, enabled: true, note: '×3: מי שנתן, בתוך פיצוץ ×3' },
  { id: 'r24', on: 'gift_x5', needs: 'supporter', action: { type: 'special', id: 'fan_burst', mult: 5 }, delayMs: 700, enabled: true, note: '×5: מי שנתן, בתוך פיצוץ ×5' },
];
export const NEW_DEFAULT_IDS = ['r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20', 'r21', 'r22', 'r23', 'r24'];

export class Automations {
  constructor({ dataDir, resolve, play, log }) {
    this.file = path.join(dataDir, 'automations.json'); this.resolve = resolve; this.play = play; this.log = log || console.log;
    this.rules = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : DEFAULT_RULES;
    // saved rules from before the screen punches existed get the new defaults appended once
    for (const id of NEW_DEFAULT_IDS) if (!this.rules.some(r => r.id === id)) this.rules.push(DEFAULT_RULES.find(r => r.id === id));
    this.history = []; this.lastFire = {};
  }
  save(rules) { this.rules = rules; fs.writeFileSync(this.file, JSON.stringify(rules, null, 2)); return rules; }
  reset() { return this.save(DEFAULT_RULES); }

  // run all enabled rules that match this event; returns what was played
  async fire(ev) {
    const out = [];
    const rules = this.rules.filter(r => r.enabled && r.on === ev.type && (!r.match || String(ev.gift || '').toLowerCase() === String(r.match).toLowerCase()) && (!r.needs || ev[r.needs]));
    for (const r of rules) {
      const key = r.id + '|' + (ev.user || '') + '|' + (ev.supporter || ''); if (Date.now() - (this.lastFire[key] || 0) < (r.cooldownMs ?? 2500)) continue; // no double fire (two supporters in a row are two events)
      this.lastFire[key] = Date.now();
      const act = await this.resolve(r.action, ev);
      const entry = { at: Date.now(), event: ev, rule: r.id, note: r.note, result: act || { error: 'אין מה לנגן לכלל הזה' } };
      if (act) setTimeout(() => this.play(act, ev), r.delayMs || 0);
      out.push(entry); this.history.unshift(entry);
    }
    if (!rules.length) this.history.unshift({ at: Date.now(), event: ev, rule: null, result: { error: 'אין כלל לאירוע הזה' } });
    this.history = this.history.slice(0, 60);
    return out;
  }
}
