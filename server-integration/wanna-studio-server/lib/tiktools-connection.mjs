import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { extraEvent } from './tiktools-events.mjs';

const ROOM = /^\d{5,30}$/;
const HANDLE = /^[a-zA-Z0-9._]{1,32}$/;
const MESSAGES = Object.freeze({
  TIKTOOLS_CONFIGURATION: 'The managed event connection is not configured correctly.',
  TIKTOOLS_CONNECTING: 'A managed event connection is already being established.',
  TIKTOOLS_ALREADY_CONNECTED: 'Disconnect the current managed event connection first.',
  TIKTOOLS_TIMEOUT: 'The managed event service did not confirm this LIVE room in time.',
  TIKTOOLS_CANCELLED: 'The managed event connection was cancelled.',
  TIKTOOLS_CONNECTION_FAILED: 'The managed event connection could not be established.',
  TIKTOOLS_PROVIDER_REJECTED: 'The managed event service did not accept the connection.',
  TIKTOOLS_PROTOCOL_INVALID: 'The managed event service returned an unsupported message.',
  TIKTOOLS_ROOM_MISMATCH: 'The managed event service did not confirm the requested creator and room.',
  TIKTOOLS_MESSAGE_TOO_LARGE: 'The managed event message exceeded the permitted size.',
  TIKTOOLS_CLOSED: 'The managed event connection closed.',
});
export class TikToolsConnectionError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.TIKTOOLS_CONNECTION_FAILED); this.name = 'TikToolsConnectionError'; this.code = code; }
}
const error = code => new TikToolsConnectionError(code);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max = 128) { return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : ''; }
function identifier(value, max = 128) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return text(value, max).trim();
}
function handle(value) { const result = text(value, 33).replace(/^@/, ''); return HANDLE.test(result) ? result : ''; }
function imageUrl(value) {
  if (!text(value, 4096)) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function projectUser(data) {
  const source = object(data.user) ? data.user : {};
  const id = identifier(source.id ?? source.userId ?? data.senderUserId, 256);
  const uniqueId = handle(source.uniqueId ?? data.user_unique_id);
  const secUid = text(source.secUid, 256).startsWith('MS4wLjAB') ? source.secUid : '';
  if (!id && !uniqueId && !secUid) return null;
  const avatar = imageUrl(source.profilePictureUrl);
  return { ...(id ? { id, userId: id } : {}), ...(uniqueId ? { uniqueId, displayId: uniqueId } : {}),
    ...(secUid ? { secUid } : {}), nickname: text(source.nickname, 160) || uniqueId || 'TikTok viewer',
    ...(avatar ? { profilePictureUrl: avatar, avatarThumb: { urlList: [avatar] } } : {}) };
}
function upstreamId(data) {
  for (const [kind, value] of [['msgId', data.common?.msgId], ['msgId', data.msgId], ['transactionId', data.transactionId]]) {
    const id = identifier(value);
    if (id) return { kind, id };
  }
  return null;
}

/** Reused from BOOSTERA's managed transport. Construction never opens a socket or reads credentials. */
class TikToolsConnection extends EventEmitter {
  #apiKey; #WebSocketImpl; #timeoutMs; #maxPayload; #socket = null; #pending = null;
  #generation = 0; #sessionId = null; #sequence = 0; #closing = Promise.resolve();
  #connectReservation = null;
  #diagnostics = { receivedMessages: 0, receivedBytes: 0, ignoredMessages: 0, invalidMessages: 0,
    upstreamIds: 0, transportReceipts: 0, lastErrorCode: null };
  constructor(username, { apiKey, WebSocketImpl = WebSocket, timeoutMs = 15000, maxPayload = 256 * 1024 } = {}) {
    super();
    this.uniqueId = handle(username);
    if (!this.uniqueId || typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096 ||
        /\s|[\x00-\x1f\x7f]/.test(apiKey) || typeof WebSocketImpl !== 'function' ||
        !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 25000 ||
        !Number.isInteger(maxPayload) || maxPayload < 256 || maxPayload > 1024 * 1024) throw error('TIKTOOLS_CONFIGURATION');
    this.#apiKey = apiKey; this.#WebSocketImpl = WebSocketImpl; this.#timeoutMs = timeoutMs; this.#maxPayload = maxPayload;
    this.isConnected = false; this.roomId = ''; this.roomInfo = null; this.availableGifts = [];
  }
  get providerMetadata() {
    return Object.freeze({ provider: 'tiktools', transport: 'managed-websocket', scope: 'live-events',
      receiptSessionId: this.#sessionId, ...this.#diagnostics });
  }
  get state() { return { isConnected: this.isConnected, roomId: this.roomId, roomInfo: this.roomInfo,
    availableGifts: [], providerMetadata: this.providerMetadata }; }

  #emitError(problem) { this.#diagnostics.lastErrorCode = problem.code; if (this.listenerCount(ControlEvent.ERROR)) this.emit(ControlEvent.ERROR, problem); }
  #settle(problem) {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer); this.#pending = null;
    problem ? pending.reject(problem) : pending.resolve(this.state);
  }
  #stopSocket(socket) {
    if (!socket) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { socket.terminate?.(); } catch {} finish(); }, 250);
      socket.once('close', finish);
      try { if (socket.readyState === 3) finish(); else socket.close(); } catch { try { socket.terminate?.(); } catch {} finish(); }
    });
  }
  #fail(code, socket, generation) {
    if (generation !== this.#generation || socket !== this.#socket) return;
    const problem = error(code), wasConnected = this.isConnected, roomId = this.roomId;
    ++this.#generation; this.#socket = null; this.isConnected = false; this.roomId = ''; this.roomInfo = null;
    this.#settle(problem); this.#emitError(problem);
    if (socket) this.#closing = this.#stopSocket(socket);
    if (wasConnected) this.emit(ControlEvent.DISCONNECTED, { roomId, code, providerMetadata: this.providerMetadata });
  }
  async connect(roomId) {
    if (roomId !== undefined && (typeof roomId !== 'string' || !ROOM.test(roomId))) throw error('TIKTOOLS_CONFIGURATION');
    if (this.isConnected) {
      if (!roomId || roomId === this.roomId) return this.state;
      throw error('TIKTOOLS_ALREADY_CONNECTED');
    }
    if (this.#pending || this.#connectReservation !== null) throw error('TIKTOOLS_CONNECTING');
    const generation = ++this.#generation;
    this.#connectReservation = generation;
    try {
      await this.#closing;
      if (generation !== this.#generation) throw error('TIKTOOLS_CANCELLED');
      this.#sessionId = randomUUID(); this.#sequence = 0;
      this.#diagnostics = { receivedMessages: 0, receivedBytes: 0, ignoredMessages: 0, invalidMessages: 0,
        upstreamIds: 0, transportReceipts: 0, lastErrorCode: null };
      return await new Promise((resolve, reject) => {
        this.#pending = { resolve, reject, timer: null };
        let socket;
        try {
          const url = new URL('wss://api.tik.tools');
          url.searchParams.set('uniqueId', this.uniqueId); url.searchParams.set('apiKey', this.#apiKey);
          socket = new this.#WebSocketImpl(url.href, { maxPayload: this.#maxPayload, perMessageDeflate: false,
            handshakeTimeout: this.#timeoutMs, followRedirects: false });
          this.#socket = socket;
        } catch {
          this.#settle(error('TIKTOOLS_CONNECTION_FAILED'));
          this.#diagnostics.lastErrorCode = 'TIKTOOLS_CONNECTION_FAILED';
          return;
        }
        this.#pending.timer = setTimeout(() => this.#fail('TIKTOOLS_TIMEOUT', socket, generation), this.#timeoutMs);
        socket.on('error', problem => this.#fail(problem?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'TIKTOOLS_MESSAGE_TOO_LARGE' : 'TIKTOOLS_CONNECTION_FAILED', socket, generation));
        socket.on('unexpected-response', () => this.#fail('TIKTOOLS_PROVIDER_REJECTED', socket, generation));
        socket.on('close', () => this.#fail('TIKTOOLS_CLOSED', socket, generation));
        socket.on('message', (raw, isBinary) => {
          if (generation !== this.#generation || socket !== this.#socket) return;
          const bytes = Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? Buffer.from(raw) : null;
          if (!bytes || isBinary) return this.#fail('TIKTOOLS_PROTOCOL_INVALID', socket, generation);
          this.#diagnostics.receivedMessages++; this.#diagnostics.receivedBytes += bytes.length;
          if (bytes.length > this.#maxPayload) return this.#fail('TIKTOOLS_MESSAGE_TOO_LARGE', socket, generation);
          let message;
          try { message = JSON.parse(bytes.toString('utf8')); } catch { return this.#fail('TIKTOOLS_PROTOCOL_INVALID', socket, generation); }
          if (!object(message) || typeof message.event !== 'string') return this.#fail('TIKTOOLS_PROTOCOL_INVALID', socket, generation);
          const data = object(message.data) ? message.data : {};
          if (message.event === 'error') return this.#fail('TIKTOOLS_PROVIDER_REJECTED', socket, generation);
          if (message.event === 'roomInfo') {
            const top = message.roomId !== undefined || message.uniqueId !== undefined;
            const info = top ? message : data;
            const receivedRoom = identifier(info.roomId, 30), creator = handle(info.uniqueId);
            if (!ROOM.test(receivedRoom) || !creator || creator.toLowerCase() !== this.uniqueId.toLowerCase() ||
                (roomId && roomId !== receivedRoom) || (this.roomId && this.roomId !== receivedRoom) ||
                (top && ((data.roomId !== undefined && identifier(data.roomId) !== receivedRoom) ||
                  (data.uniqueId !== undefined && handle(data.uniqueId).toLowerCase() !== creator.toLowerCase())))) {
              return this.#fail('TIKTOOLS_ROOM_MISMATCH', socket, generation);
            }
            if (this.isConnected) return;
            this.roomId = receivedRoom;
            // The handshake verifies a handle/room only. Never invent a numeric
            // owner ID that could qualify generic battle data as WIN evidence.
            this.roomInfo = { data: { id_str: receivedRoom, status: 2, owner: { uniqueId: creator } }, providerMetadata: this.providerMetadata };
            this.isConnected = true; this.#settle(); this.emit(ControlEvent.CONNECTED, this.state);
            return;
          }
          if (!this.isConnected) { this.#diagnostics.ignoredMessages++; return; }
          if (message.event === 'streamEnd') {
            if (data.uniqueId !== undefined && handle(data.uniqueId).toLowerCase() !== this.uniqueId.toLowerCase()) return this.#fail('TIKTOOLS_ROOM_MISMATCH', socket, generation);
            this.emit(WebcastEvent.STREAM_END, { roomId: this.roomId, providerMetadata: this.providerMetadata });
            void this.disconnect(); return;
          }
          if (!['gift', 'like', 'member'].includes(message.event)) {
            const upstream = upstreamId(data);
            const projected = extraEvent(message.event, data, projectUser(data), upstream ? { msgId: upstream.id } : {});
            if (projected) this.emit(projected.event, projected.data);
            else this.#diagnostics.ignoredMessages++;
            return;
          }
          const user = projectUser(data);
          if (!user) { this.#diagnostics.invalidMessages++; return; }
          const upstream = upstreamId(data);
          const receiptId = `tiktools:${this.#sessionId}:${++this.#sequence}`;
          upstream ? this.#diagnostics.upstreamIds++ : this.#diagnostics.transportReceipts++;
          const providerMetadata = Object.freeze({ provider: 'tiktools', transport: 'managed-websocket', scope: 'live-events',
            messageIdSource: upstream ? 'upstream' : 'transport-receipt', ...(upstream ? { upstreamIdKind: upstream.kind } : {}), receiptId });
          const common = upstream ? { msgId: upstream.id } : {};
          if (message.event === 'gift') {
            const giftId = identifier(data.giftId, 80), repeatCount = data.repeatCount ?? 1;
            if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(giftId) || !Number.isSafeInteger(repeatCount) || repeatCount < 1 || repeatCount > 100000) { this.#diagnostics.invalidMessages++; return; }
            const groupId = identifier(data.groupId);
            const giftType = Number.isSafeInteger(data.giftType) && data.giftType >= 0 && data.giftType <= 255 ? data.giftType
              : data.combo === true || data.repeatEnd === true || (groupId && groupId !== '0') ? 1 : 0;
            this.emit(WebcastEvent.GIFT, { user, common, giftId, giftType, giftName: text(data.giftName, 160), giftDetails: { giftType, giftName: text(data.giftName, 160) },
              repeatCount, repeatEnd: data.repeatEnd === true, ...(giftType === 1 && groupId && groupId !== '0' ? { groupId } : {}),
              ...(Number.isSafeInteger(data.diamondCount) && data.diamondCount >= 0 ? { diamondCount: data.diamondCount } : {}), providerMetadata });
          } else if (message.event === 'like') {
            if (!Number.isSafeInteger(data.likeCount) || data.likeCount < 1 || data.likeCount > 100000) { this.#diagnostics.invalidMessages++; return; }
            // Official examples omit a message ID. Keep that absence explicit;
            // strict TikTok normalizers must not mistake a receipt for upstream ID.
            this.emit(WebcastEvent.LIKE, { user, common, count: data.likeCount, likeCount: data.likeCount,
              ...(Number.isSafeInteger(data.totalLikes) && data.totalLikes >= 0 ? { total: data.totalLikes } : {}), providerMetadata });
          } else {
            this.emit(WebcastEvent.MEMBER, { user, common, action: text(data.action, 32),
              ...(Number.isSafeInteger(data.actionCode) ? { actionCode: data.actionCode } : {}), providerMetadata });
          }
        });
      });
      } finally { if (this.#connectReservation === generation) this.#connectReservation = null; }
  }
  async disconnect() {
    ++this.#generation;
    const socket = this.#socket, wasConnected = this.isConnected, roomId = this.roomId;
    this.#socket = null; this.isConnected = false; this.roomId = ''; this.roomInfo = null;
    this.#settle(error('TIKTOOLS_CANCELLED'));
    if (socket) this.#closing = this.#stopSocket(socket);
    if (wasConnected) this.emit(ControlEvent.DISCONNECTED, { roomId, code: 'TIKTOOLS_CANCELLED', providerMetadata: this.providerMetadata });
    await this.#closing;
  }
}

export function createTikToolsConnection(username, options) { return new TikToolsConnection(username, options); }
