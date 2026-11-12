// Tiny JSON-file store (templates, avatars, orders, cost ledger). Writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir; fs.mkdirSync(dir, { recursive: true });
    this.db = { templates: {}, avatars: {}, orders: {}, costs: [] };
    const f = path.join(dir, 'db.json');
    if (fs.existsSync(f)) this.db = { ...this.db, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
  }
  flush() { const f = path.join(this.dir, 'db.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(this.db, null, 2)); fs.renameSync(f + '.tmp', f); }
  templates() { return Object.values(this.db.templates).sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.created.localeCompare(b.created)); }
  template(id) { return this.db.templates[id]; }
  saveTemplate(t) { this.db.templates[t.id] = t; this.flush(); return t; }
  avatar(id) { return this.db.avatars[id]; }
  saveAvatar(a) { this.db.avatars[a.id] = a; this.flush(); return a; }
  orders() { return Object.values(this.db.orders).sort((a, b) => a.created.localeCompare(b.created)); }
  order(id) { return this.db.orders[id]; }
  saveOrder(o) { this.db.orders[o.id] = o; this.flush(); return o; }
  pending() { return this.orders().filter(o => o.status === 'queued'); }
  addCost(c) { this.db.costs.push({ time: new Date().toISOString(), ...c }); this.flush(); }
  costs() { return this.db.costs; }
}
