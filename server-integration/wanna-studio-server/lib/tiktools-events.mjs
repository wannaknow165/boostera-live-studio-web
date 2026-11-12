// Tik.Tools wire schema: https://tik.tools/docs (battle and battleArmies have different status enums).
// Only projected public event fields leave this transport; provider diagnostics never enter chat.
const text = (v, max = 160) => typeof v === 'string' ? v.slice(0, max) : '';
const id = v => typeof v === 'string' ? v.slice(0, 100) : Number.isSafeInteger(v) ? String(v) : '';
const points = v => /^\d+$/.test(String(v ?? '')) ? String(v) : '0';
const list = v => Array.isArray(v) ? v.slice(0, 20) : [];
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function managedBattle(data, event) {
  const battleId = id(data.battleId), matchId = id(data.matchId), sessionId = id(data.sessionId);
  const key = sessionId ? `${matchId || battleId}:${sessionId}` : battleId && battleId !== '0' ? battleId : matchId;
  if (!key) return null;
  const armies = event === 'battleArmies', remaining = finite(data.secsRemaining) ? data.secsRemaining : null;
  const ended = armies ? data.status === 2 || remaining === 0 : data.status === 3;
  const active = armies ? [1, 4].includes(data.status) : data.status === 1;
  const endTimeMs = finite(data.serverTsMs) && remaining !== null ? data.serverTsMs + remaining * 1000 : 0;
  const duration = finite(data.durationSec) ? data.durationSec : finite(data.battleDuration) ? data.battleDuration : 0;
  const hosts = list(data.hosts), teams = list(data.teams);
  const scores = (hosts.length ? hosts : teams).map(host => ({
    id: host.isTeam ? 'team:' + id(host.hostUserId) : id(host.hostUserId),
    score: points(host.teamTotalScore ?? host.score),
    members: list(host.members).map(member => id(member.userId)),
    contributors: list(host.contributors ?? host.users).map(entry => ({
      id: id(entry.userId ?? entry.user?.id), name: text(entry.nickname ?? entry.user?.nickname),
      handle: text(entry.user?.uniqueId), score: points(entry.score),
    })),
  })).filter(host => host.id);
  return { id: key, battleId, matchId, sessionId, status: ended ? 'ended' : active ? 'active' : 'pending',
    scores, duration, endTimeMs, startTimeMs: endTimeMs && duration ? endTimeMs - duration * 1000 : 0,
    serverTsMs: finite(data.serverTsMs) ? data.serverTsMs : 0 };
}

export function extraEvent(event, data, user, common) {
  if (['battle', 'battleArmies'].includes(event)) {
    const battle = managedBattle(data, event);
    return battle ? { event: 'managedBattle', data: { battle, common } } : null;
  }
  if (['roomUser', 'roomUserSeq'].includes(event)) return finite(data.viewerCount)
    ? { event: 'roomUser', data: { viewerCount: data.viewerCount, common } } : null;
  if (!user) return null;
  if (event === 'chat') {
    const content = text(data.comment ?? data.content, 1000);
    return content.trim() ? { event: 'chat', data: { user, common, content } } : null;
  }
  if (event === 'social') event = data.action;
  if (['follow', 'share', 'subscribe'].includes(event)) return { event, data: { user, common } };
  if (event === 'emoteChat') return { event: 'emote', data: { user, common, emoteId: id(data.emoteId) } };
  return null;
}
