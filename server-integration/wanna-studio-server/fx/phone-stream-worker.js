// Reads the phone's video stream (multipart JPEG) OFF the page's main thread — used by opponent.js.
// The page is busy with tracking and effects; reading and decoding the stream there keeps about one picture in three,
// so the target's "live" head would move in jumps. Here every JPEG is decoded as it arrives and handed to the page as a
// ready ImageBitmap, stamped with the moment its bytes came in (clock: performance.timeOrigin + performance.now()).
// Only what the page needs is handed over (every picture it draws costs it a texture upload):
//   crop: [y0, y1] = the rows of the battle area (fractions of the height); a little more above and below is kept
//   fps : at most this many pictures a second
//   page -> worker : { url, id, crop, fps }  start reading (a stream that was running is closed first)  ·  { stop: true }
//   worker -> page : { id, bmp, t, n, w, h, oy }  one picture: w x h = the size of the WHOLE phone picture, oy = the row
//                    of it where this bitmap starts  ·  { id, end: true, status, error }  the stream is over / never opened
let ac = null;
onmessage = async e => {
  const m = e.data;
  if (ac) { ac.abort(); ac = null; }
  if (!m.url) return;
  const my = ac = new AbortController(), id = m.id, crop = m.crop || null, gap = m.fps ? 1000 / m.fps - 4 : 0;
  try {
    const r = await fetch(m.url, { signal: my.signal, cache: 'no-store' });
    if (!r.ok || !r.body) { if (ac === my) { ac = null; postMessage({ id, end: true, status: r.status }); } return; }
    const rd = r.body.getReader(), td = new TextDecoder('latin1');
    let buf = new Uint8Array(0), decoding = 0, n = 0, lastT = 0;
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
      for (;;) {
        let h = -1; for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) { h = i; break; }
        if (h < 0) break;
        const cl = /content-length:\s*(\d+)/i.exec(td.decode(buf.subarray(0, h)));
        if (!cl) { buf = buf.subarray(h + 4); continue; }
        const len = +cl[1]; if (buf.length < h + 4 + len) break;
        const jpg = buf.slice(h + 4, h + 4 + len); buf = buf.subarray(h + 4 + len);
        const t = performance.timeOrigin + performance.now(), k = ++n;
        if (t - lastT < gap || decoding >= 3) continue;      // the page asked for fewer pictures, or decoding cannot keep up
        lastT = t; decoding++;
        (async () => {
          let b = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' })); const w = b.width, hh = b.height; let oy = 0;
          if (crop) { // keep only the battle area (+ room for hair above it and a chin below)
            const y0 = Math.max(0, Math.floor((crop[0] - 0.08) * hh)), y1 = Math.min(hh, Math.ceil((crop[1] + 0.04) * hh));
            if (y1 - y0 > 8 && y1 - y0 < hh) { const c = await createImageBitmap(b, 0, y0, w, y1 - y0); b.close(); b = c; oy = y0; }
          }
          if (ac === my) postMessage({ id, bmp: b, t, n: k, w, h: hh, oy }, [b]); else b.close();
        })().catch(() => {}).finally(() => { decoding--; });
      }
      if (buf.length > 2e7) buf = new Uint8Array(0);
    }
    if (ac === my) { ac = null; postMessage({ id, end: true, status: 200 }); }   // the server closed it
  } catch (err) {
    if (ac === my) { ac = null; if (err.name !== 'AbortError') postMessage({ id, end: true, error: String(err && err.message || err) }); }
  }
};
