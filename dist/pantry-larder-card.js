/*
 * pantry-larder-card: a Simple Inventory pantry as a printed larder list,
 * with storage diagrams drawn to scale.
 * https://github.com/mikecb/ha-pantry-larder-card
 *
 * type: custom:pantry-larder-card
 * inventory: sensor.pantry_inventory   # a Simple Inventory "<name> inventory" sensor
 * title: The Pantry                    # optional
 * view: items                          # items | location (initial tab)
 * appliances:                          # optional; without it every location is a plain block
 *   - name: Kitchen pantry
 *     area: Kitchen
 *     kind: run                        # run | frenchdoor | sidebyside | upright | room
 *     h: 78                            # inches
 *     parts:
 *       - { loc: Kitchen Pantry 1, label: "1", w: 24 }
 *
 * Quantity is per item, not per location: Simple Inventory keeps one total
 * even when an item is stored in several places.
 */
const VERSION = "0.2.0";

// Sizes are in inches. Each part is one Simple Inventory location name.
const KINDS = {
  run: { h: 78, partW: 24, parts: [1, 99] },
  frenchdoor: { w: 36, h: 70, parts: [2, 2] }, // [fridge doors, freezer drawer]
  sidebyside: { w: 36, h: 70, parts: [2, 2] }, // [freezer side, fridge side]
  upright: { w: 30, h: 70, parts: [1, 1] },
  room: { parts: [1, 1] },
};

// Fill in defaults and check the shape, so a typo shows HA's error card instead of a blank one.
function normalizeAppliances(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("pantry-larder-card: 'appliances' must be a list");
  return list.map((a, i) => {
    const where = `pantry-larder-card: appliances[${i}]`;
    if (!a || typeof a !== "object") throw new Error(`${where} must be an object`);
    const kind = a.kind || "room";
    const spec = KINDS[kind];
    if (!spec) throw new Error(`${where}: unknown kind '${kind}' (use ${Object.keys(KINDS).join(", ")})`);
    if (!Array.isArray(a.parts) || !a.parts.length) throw new Error(`${where} needs a 'parts' list`);
    const [min, max] = spec.parts;
    if (a.parts.length < min || a.parts.length > max)
      throw new Error(`${where}: kind '${kind}' takes ${min === max ? min : `${min} to ${max}`} part${max > 1 ? "s" : ""}`);
    const parts = a.parts.map((p, j) => {
      if (!p || !p.loc) throw new Error(`${where}.parts[${j}] needs 'loc', the Simple Inventory location name`);
      return { loc: String(p.loc), label: String(p.label ?? p.loc), w: Number(p.w) || spec.partW || 24 };
    });
    return {
      name: String(a.name || parts[0].loc),
      area: String(a.area || "Storage"),
      kind,
      w: Number(a.w) || spec.w,
      h: Number(a.h) || spec.h,
      parts,
    };
  });
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const locsOf = (it) => {
  const l = (Array.isArray(it.locations) && it.locations.length ? it.locations : [it.location]).filter((x) => x && String(x).trim());
  return l.length ? l : ["Unassigned"];
};
const catOf = (it) => (Array.isArray(it.categories) && it.categories[0]) || it.category || "Uncategorized";

function qtyText(it) {
  const q = Number(it.quantity);
  const n = Number.isFinite(q) ? (Number.isInteger(q) ? q : q.toFixed(1)) : it.quantity;
  return { n, unit: it.unit || "" };
}

// expired | soon | null
function expiryState(it) {
  if (!it.expiry_date) return null;
  const d = new Date(`${it.expiry_date}T00:00:00`);
  if (isNaN(d)) return null;
  const days = Math.floor((d - new Date(new Date().toDateString())) / 86400000);
  if (days < 0) return "expired";
  if (days <= Math.max(Number(it.expiry_alert_days) || 0, 7)) return "soon";
  return null;
}
const low = (it) => Number(it.desired_quantity) > 0 && Number(it.quantity) < Number(it.desired_quantity);
const fmtDate = (s) => {
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
// "Kitchen Pantry 1" reads as "Pantry 1" inside a Kitchen context, but lists show the full name.
const shortLoc = (l) => l;

class PantryLarderCard extends HTMLElement {
  static getStubConfig() {
    return { title: "The Pantry", inventory: "sensor.pantry_inventory" };
  }

  setConfig(config) {
    this._config = { title: "The Pantry", inventory: "sensor.pantry_inventory", view: "items", ...config };
    this._apps = normalizeAppliances(this._config.appliances);
    this._view = this._view || this._config.view;
    this._query = this._query || "";
    this._items = this._items || null;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
      this.shadowRoot.addEventListener("input", (e) => {
        if (e.target.id === "q") {
          this._query = e.target.value;
          this._renderBody();
        }
      });
    }
    this._sig = null;
  }

  set hass(hass) {
    this._hass = hass;
    const inv = hass.states[this._config.inventory];
    const sig = [hass.themes?.darkMode ? "d" : "l", inv?.last_updated, inv?.state, JSON.stringify(inv?.attributes || {})].join("|");
    if (sig !== this._sig) {
      this._sig = sig;
      this._load();
    }
    if (this._dialog) this._dialog.hass = hass;
  }

  connectedCallback() {
    // Edits to names or locations don't always change the sensor, so poll gently too.
    this._timer = setInterval(() => this._load(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  get inventoryId() {
    return this._hass?.states[this._config.inventory]?.attributes?.inventory_id;
  }

  async _load() {
    if (!this._hass) return;
    const id = this.inventoryId;
    if (!id) {
      this._error = `${this._config.inventory} has no inventory_id.`;
      return this._render();
    }
    try {
      const res = await this._hass.callWS({
        type: "call_service",
        domain: "simple_inventory",
        service: "get_items",
        service_data: { inventory_id: id },
        return_response: true,
      });
      this._items = res?.response?.items || [];
      this._error = null;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._render();
    if (this._dialog) this._dialog.refresh();
  }

  _filtered() {
    const items = this._items || [];
    const q = this._query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      [it.name, it.description, catOf(it), ...locsOf(it), ...(it.aliases || [])].join(" ").toLowerCase().includes(q)
    );
  }

  _knownLocs() {
    return this._apps.flatMap((a) => a.parts.map((p) => p.loc));
  }

  _render() {
    if (!this._hass || !this.shadowRoot) return;
    if (!this.shadowRoot.querySelector(".card")) {
      this.shadowRoot.innerHTML = `<style>${CARD_CSS}</style><ha-card class="card"><div class="head"></div><div class="body"></div></ha-card>`;
      ensureFont();
    }
    this.shadowRoot.querySelector(".card").classList.toggle("dark", !!this._hass.themes?.darkMode);
    this._renderHead();
    this._renderBody();
  }

  _renderHead() {
    const items = this._items || [];
    const used = new Set(items.flatMap(locsOf));
    const soon = items.filter((i) => expiryState(i)).length;
    const lows = items.filter(low).length;
    const flags = [
      soon ? `<span class="flag">${soon} expiring</span>` : "",
      lows ? `<span class="flag">${lows} running low</span>` : "",
    ].join("");
    this.shadowRoot.querySelector(".head").innerHTML = `
      <div class="masthead">
        <div class="eyebrow">Garde-manger</div>
        <h1>${esc(this._config.title)}</h1>
        <div class="meta">${items.length} items · ${used.size} ${used.size === 1 ? "place" : "places"}</div>
      </div>
      <div class="flags">${flags}</div>
      ${this._error ? `<div class="sync">Couldn't read the pantry: ${esc(this._error)}</div>` : ""}
      <div class="controls">
        <div class="tabs">
          <button data-view="items" class="${this._view === "items" ? "sel" : ""}">Larder list</button>
          <button data-view="location" class="${this._view === "location" ? "sel" : ""}">By location</button>
        </div>
        <div class="right">
          <input id="q" type="search" placeholder="Search" value="${esc(this._query)}" autocomplete="off">
          <button class="refresh" data-act="refresh" title="Reload the pantry" aria-label="Reload the pantry">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>
          </button>
        </div>
      </div>`;
  }

  _renderBody() {
    const body = this.shadowRoot.querySelector(".body");
    if (this._items === null) {
      body.innerHTML = `<div class="empty">Reading the pantry…</div>`;
      return;
    }
    const items = this._filtered();
    if (this._view === "location") {
      body.innerHTML = this._locationHTML(items);
      return;
    }
    if (!items.length) {
      body.innerHTML = `<div class="empty">${this._query ? "Nothing matches." : "The pantry is empty."}</div>`;
      return;
    }
    body.innerHTML = this._itemsHTML(items);
  }

  _lineHTML(it, { showLoc = true } = {}) {
    const { n, unit } = qtyText(it);
    const ex = expiryState(it);
    const tags = [
      ex === "expired" ? `<span class="tag bad">expired</span>` : ex === "soon" ? `<span class="tag">use by ${esc(fmtDate(it.expiry_date))}</span>` : "",
      low(it) ? `<span class="tag">low</span>` : "",
    ].join("");
    const locs = locsOf(it);
    return `
      <button class="line" data-open="${esc(it.id || it.name)}">
        <span class="qn">${esc(n)}</span>
        <span class="name">
          <span class="prod">${esc(it.name)}</span>${unit ? ` <span class="uom">${esc(unit)}</span>` : ""}${tags}
          ${it.description ? `<span class="detail">${esc(it.description)}</span>` : ""}
        </span>
        <span class="lead"></span>
        <span class="where">${showLoc ? locs.map((l) => esc(shortLoc(l))).join("<br>") : ""}</span>
      </button>`;
  }

  _itemsHTML(items) {
    const byCat = new Map();
    for (const it of items) {
      const c = catOf(it);
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(it);
    }
    let html = "";
    for (const c of [...byCat.keys()].sort((a, z) => (a === "Uncategorized") - (z === "Uncategorized") || a.localeCompare(z))) {
      const list = byCat.get(c).sort((a, z) => a.name.localeCompare(z.name));
      html += `<section><h2><span>${esc(c)}</span></h2>${list.map((it) => this._lineHTML(it)).join("")}</section>`;
    }
    return html;
  }

  _locationHTML(items) {
    const known = new Set(this._knownLocs());
    const extra = [...new Set(items.flatMap(locsOf))].filter((l) => !known.has(l));
    const extraArea = this._apps.length ? "Elsewhere" : "Storage";
    const apps = [...this._apps, ...extra.map((loc) => ({ area: extraArea, name: loc, kind: "room", parts: [{ loc, label: loc }] }))];
    let html = "";
    for (const area of [...new Set(apps.map((a) => a.area))]) {
      html += `<div class="area"><span>${esc(area)}</span></div>`;
      for (const app of apps.filter((a) => a.area === area)) {
        for (const part of app.parts) {
          const inLoc = items.filter((it) => locsOf(it).includes(part.loc));
          if (this._query && !inLoc.length) continue;
          const byCat = new Map();
          for (const it of inLoc) {
            const c = catOf(it);
            if (!byCat.has(c)) byCat.set(c, []);
            byCat.get(c).push(it);
          }
          const counts = this._counts(items);
          html += `<section class="unit"><h2><span>${esc(part.loc)} <span class="cap">· ${inLoc.length}</span></span></h2>
            <div class="unitwrap">
              <div class="mini">${appSVG(app, counts, [part.loc], { mini: true })}</div>
              <div class="unitlist">${
                inLoc.length
                  ? [...byCat.keys()]
                      .sort()
                      .map(
                        (c) =>
                          `<h3>${esc(c)}</h3>${byCat
                            .get(c)
                            .sort((a, z) => a.name.localeCompare(z.name))
                            .map((it) => this._lineHTML(it, { showLoc: locsOf(it).length > 1 }))
                            .join("")}`
                      )
                      .join("")
                  : `<div class="empty small">Empty</div>`
              }</div>
            </div></section>`;
        }
      }
    }
    return html || `<div class="empty">Nothing matches.</div>`;
  }

  _counts(items) {
    const c = {};
    for (const it of items || this._items || []) for (const l of locsOf(it)) c[l] = (c[l] || 0) + 1;
    return c;
  }

  _onClick(e) {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.view) {
      this._view = t.dataset.view;
      this._render();
    } else if (t.dataset.act === "refresh") {
      this._load();
    } else if (t.dataset.open) {
      this._openDialog(t.dataset.open);
    }
  }

  _item(key) {
    return (this._items || []).find((it) => (it.id || it.name) === key);
  }

  _openDialog(key) {
    if (this._dialog) this._dialog.close();
    const d = document.createElement("pantry-item-dialog");
    d.setup(this, key);
    document.body.appendChild(d);
    this._dialog = d;
    d.hass = this._hass;
  }
}

/* ---------- diagrams ---------- */

// counts: { location: item count }, highlight: [location names]
function appSVG(app, counts, highlight, { mini = false } = {}) {
  const hl = new Set(highlight);
  const s = mini ? 1 : 2.6; // px per inch
  const part = (p) => ({ on: hl.has(p.loc), n: counts[p.loc] || 0 });
  const cls = (on) => `zone ${on ? "hl" : ""}`;
  const label = (x, y, p, { big = false } = {}) => {
    const { on, n } = part(p);
    if (mini) return `<text x="${x}" y="${y + 4}" class="zc mini ${on ? "on" : ""}">${n || ""}</text>`;
    return `<text x="${x}" y="${y - 4}" class="zl ${on ? "on" : ""}">${esc(p.label)}</text>
      <text x="${x}" y="${y + (big ? 16 : 14)}" class="zc ${on ? "on" : ""}">${n} ${n === 1 ? "item" : "items"}</text>`;
  };
  const open = (w, h, name) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="rack" role="img" aria-label="${esc(name)}">`;

  if (app.kind === "run") {
    const gap = mini ? 1.5 : 3;
    const H = app.h * s;
    const total = app.parts.reduce((a, p) => a + p.w * s, 0) + gap * (app.parts.length + 1);
    let x = gap;
    let out = open(total, H + gap * 2 + (mini ? 0 : 0), app.name) + `<rect x="0" y="0" width="${total}" height="${H + gap * 2}" rx="${mini ? 2 : 4}" class="frame"/>`;
    for (const p of app.parts) {
      const w = p.w * s;
      const { on } = part(p);
      out += `<rect x="${x}" y="${gap}" width="${w}" height="${H}" rx="${mini ? 1.5 : 3}" class="${cls(on)}"/>`;
      if (!mini) out += `<line x1="${x + w - 6}" y1="${gap + H * 0.42}" x2="${x + w - 6}" y2="${gap + H * 0.58}" class="handle"/>`;
      out += mini
        ? `<text x="${x + w / 2}" y="${gap + H / 2 + 4}" class="zc mini ${on ? "on" : ""}">${(counts[p.loc] || 0) || ""}</text>`
        : `<text x="${x + w / 2}" y="${gap + 20}" class="zl ${on ? "on" : ""}">${esc(p.label)}</text>
           <text x="${x + w / 2}" y="${gap + H / 2 + 5}" class="zc ${on ? "on" : ""}">${counts[p.loc] || 0}</text>`;
      x += w + gap;
    }
    return out + `</svg>`;
  }

  if (app.kind === "frenchdoor" || app.kind === "sidebyside" || app.kind === "upright") {
    const W = app.w * s;
    const H = app.h * s;
    const g = mini ? 1.5 : 3;
    let out = open(W + g * 2, H + g * 2, app.name) + `<rect x="0" y="0" width="${W + g * 2}" height="${H + g * 2}" rx="${mini ? 3 : 6}" class="frame"/>`;
    if (app.kind === "frenchdoor") {
      const [fr, fz] = app.parts;
      const topH = H * 0.62;
      const doorW = (W - g) / 2;
      const on = part(fr).on;
      out += `<rect x="${g}" y="${g}" width="${doorW}" height="${topH}" rx="${mini ? 1.5 : 3}" class="${cls(on)}"/>`;
      out += `<rect x="${g * 2 + doorW}" y="${g}" width="${doorW}" height="${topH}" rx="${mini ? 1.5 : 3}" class="${cls(on)}"/>`;
      out += `<rect x="${g}" y="${g * 2 + topH}" width="${W}" height="${H - topH - g}" rx="${mini ? 1.5 : 3}" class="${cls(part(fz).on)}"/>`;
      if (!mini)
        out += `<line x1="${g + doorW - 6}" y1="${g + topH * 0.35}" x2="${g + doorW - 6}" y2="${g + topH * 0.7}" class="handle"/>
          <line x1="${g * 2 + doorW + 6}" y1="${g + topH * 0.35}" x2="${g * 2 + doorW + 6}" y2="${g + topH * 0.7}" class="handle"/>
          <line x1="${g + W * 0.3}" y1="${g * 2 + topH + 10}" x2="${g + W * 0.7}" y2="${g * 2 + topH + 10}" class="handle"/>`;
      out += label(g + W / 2, g + topH / 2, fr, { big: true });
      out += label(g + W / 2, g * 2 + topH + (H - topH) / 2, fz);
      return out + `</svg>`;
    }
    if (app.kind === "sidebyside") {
      const [fz, fr] = app.parts;
      const lw = (W - g) * 0.42;
      const rw = W - g - lw;
      out += `<rect x="${g}" y="${g}" width="${lw}" height="${H}" rx="${mini ? 1.5 : 3}" class="${cls(part(fz).on)}"/>`;
      out += `<rect x="${g * 2 + lw}" y="${g}" width="${rw}" height="${H}" rx="${mini ? 1.5 : 3}" class="${cls(part(fr).on)}"/>`;
      if (!mini)
        out += `<line x1="${g + lw - 6}" y1="${g + H * 0.3}" x2="${g + lw - 6}" y2="${g + H * 0.55}" class="handle"/>
          <line x1="${g * 2 + lw + 6}" y1="${g + H * 0.3}" x2="${g * 2 + lw + 6}" y2="${g + H * 0.55}" class="handle"/>`;
      out += label(g + lw / 2, g + H / 2, fz);
      out += label(g * 2 + lw + rw / 2, g + H / 2, fr);
      return out + `</svg>`;
    }
    const [p] = app.parts;
    out += `<rect x="${g}" y="${g}" width="${W}" height="${H}" rx="${mini ? 1.5 : 3}" class="${cls(part(p).on)}"/>`;
    if (!mini) out += `<line x1="${g + W - 7}" y1="${g + H * 0.3}" x2="${g + W - 7}" y2="${g + H * 0.55}" class="handle"/>`;
    out += label(g + W / 2, g + H / 2, p);
    return out + `</svg>`;
  }

  // room: a dashed outline for places without a fixed shape
  const [p] = app.parts;
  const w = mini ? 70 : 220;
  const h = mini ? 44 : 110;
  const { on, n } = part(p);
  return `${open(w, h, app.name)}<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" class="${cls(on)}" stroke-dasharray="${mini ? "3 3" : "6 4"}"/>
    <text x="${w / 2}" y="${h / 2 + 4}" class="zc ${mini ? "mini" : ""} ${on ? "on" : ""}">${mini ? n || "" : `${esc(p.loc)} · ${n} ${n === 1 ? "item" : "items"}`}</text></svg>`;
}

/* ---------- dialog ---------- */

class PantryItemDialog extends HTMLElement {
  setup(card, key) {
    this._card = card;
    this._key = key;
    this._busy = false;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this._onKey = (e) => e.key === "Escape" && this.close();
    window.addEventListener("keydown", this._onKey);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._drawn) this._render();
  }

  refresh() {
    this._render();
  }

  close() {
    window.removeEventListener("keydown", this._onKey);
    this.remove();
    if (this._card._dialog === this) this._card._dialog = null;
  }

  _render() {
    const it = this._card._item(this._key);
    if (!it) return this.close();
    this._drawn = true;
    const dark = !!this._hass?.themes?.darkMode;
    const { n, unit } = qtyText(it);
    const locs = locsOf(it);
    const ex = expiryState(it);
    const facts = [
      ["Category", (it.categories || []).join(", ") || it.category],
      ["Use by", it.expiry_date ? `${fmtDate(it.expiry_date)}${ex === "expired" ? " (expired)" : ""}` : ""],
      ["Keep at least", Number(it.desired_quantity) > 0 ? `${it.desired_quantity}${unit ? ` ${unit}` : ""}` : ""],
      ["Also called", (it.aliases || []).join(", ")],
      ["Barcode", (it.barcodes || []).join(", ")],
    ].filter(([, v]) => v);
    const counts = this._card._counts();
    const apps = this._card._apps.filter((a) => a.parts.some((p) => locs.includes(p.loc)));
    const loose = locs.filter((l) => !this._card._knownLocs().includes(l));
    const diagrams = [
      ...apps.map(
        (a) => `<figure><figcaption>${esc(a.name)}</figcaption>${appSVG(a, counts, locs)}</figure>`
      ),
      ...loose.map((l) => `<figure><figcaption>${esc(l)}</figcaption>${appSVG({ name: l, kind: "room", parts: [{ loc: l, label: l }] }, counts, [l])}</figure>`),
    ].join("");

    this.shadowRoot.innerHTML = `<style>${DIALOG_CSS}</style>
      <div class="scrim ${dark ? "dark" : ""}" data-act="scrim">
        <div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(it.name)}">
          <button class="x" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          <div class="cat">${esc(catOf(it))}</div>
          <div class="prod">${esc(it.name)}</div>
          ${it.description ? `<div class="cuvee">${esc(it.description)}</div>` : ""}
          <div class="qty">
            <button class="step" data-act="dec" aria-label="One less" ${this._busy || Number(it.quantity) <= 0 ? "disabled" : ""}>−</button>
            <div class="amount"><span class="big">${esc(n)}</span>${unit ? `<span class="u">${esc(unit)}</span>` : ""}</div>
            <button class="step" data-act="inc" aria-label="One more" ${this._busy ? "disabled" : ""}>+</button>
          </div>
          ${locs.length > 1 ? `<div class="hint">Total across ${locs.length} places. Simple Inventory keeps one amount per item.</div>` : ""}
          ${this._error ? `<div class="warn">${esc(this._error)}</div>` : ""}
          <div class="strip">${locs.map((l) => `<span class="u on">${esc(l)}</span>`).join("")}</div>
          <div class="diagram">${diagrams}</div>
          ${facts.length ? `<dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
        </div>
      </div>`;
  }

  async _onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.dataset.act === "scrim" && e.target !== t) return;
    if (t.dataset.act === "close" || t.dataset.act === "scrim") return this.close();
    if (t.dataset.act === "inc" || t.dataset.act === "dec") {
      const it = this._card._item(this._key);
      if (!it || this._busy) return;
      this._busy = true;
      this._error = null;
      this._render();
      try {
        await this._hass.callService("simple_inventory", t.dataset.act === "inc" ? "increment_item" : "decrement_item", {
          inventory_id: this._card.inventoryId,
          name: it.name,
          amount: 1,
        });
      } catch (err) {
        this._error = err.message || String(err);
      }
      this._busy = false;
      await this._card._load();
      this._render();
    }
  }
}

function ensureFont() {
  // Bundled Cormorant Garamond (SIL OFL), shipped next to this file. Skip it if another card already added the face.
  if (window.__pantryFontLoading) return;
  window.__pantryFontLoading = true;
  if ([...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Cormorant Garamond")) return;
  import(new URL("./pantry-fonts.js", import.meta.url).href)
    .then((m) => {
      const buf = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
      for (const [data, style] of [[m.NORMAL, "normal"], [m.ITALIC, "italic"]]) {
        const face = new FontFace("Cormorant Garamond", buf(data), { style, weight: "300 700", display: "swap" });
        document.fonts.add(face);
        face.load().catch(() => {});
      }
    })
    .catch(() => {});
}

const SHARED_CSS = `
  --serif: "Cormorant Garamond", "Iowan Old Style", Georgia, "Noto Serif", serif;
  --ink: var(--primary-text-color, #2b2416);
  --muted: var(--secondary-text-color, #766b58);
  --accent: #5f6b22;
  --accent-soft: rgba(95, 107, 34, 0.13);
  --warn: #9a4a12;
  --rule: color-mix(in srgb, var(--ink) 22%, transparent);
  --paper: var(--ha-card-background, var(--card-background-color, #fbf8f2));
`;
const SHARED_DARK = `--accent: #c2cf7d; --accent-soft: rgba(194, 207, 125, 0.16); --warn: #f0a46b;`;

const SVG_CSS = `
  .rack .frame { fill: color-mix(in srgb, var(--ink) 5%, transparent); stroke: var(--rule); }
  .rack .zone { fill: color-mix(in srgb, var(--ink) 4%, transparent); stroke: var(--rule); stroke-width: 1.5; }
  .rack .zone.hl { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 2.5; }
  .rack .handle { stroke: color-mix(in srgb, var(--ink) 35%, transparent); stroke-width: 2.5; stroke-linecap: round; }
  .rack .zl { font: 600 15px var(--serif); fill: var(--muted); text-anchor: middle; }
  .rack .zc { font: 500 13px var(--serif); fill: var(--muted); text-anchor: middle; }
  .rack .zc.mini { font-size: 10px; font-weight: 700; }
  .rack .on { fill: var(--accent); }
`;

const CARD_CSS = `
  :host { display: block; }
  ha-card.card { ${SHARED_CSS} background: var(--paper); padding: 28px 28px 32px; color: var(--ink); font-family: var(--serif); }
  ha-card.card.dark { ${SHARED_DARK} }
  .head { display: grid; grid-template-columns: 1fr auto; gap: 12px 16px; align-items: end; }
  .eyebrow { font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: var(--muted); }
  h1 { font-size: 40px; font-weight: 600; margin: 2px 0 0; line-height: 1.05; letter-spacing: .01em; }
  .meta { color: var(--muted); font-size: 16px; font-style: italic; margin-top: 4px; }
  .flags { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .flag { font-size: 15px; font-weight: 600; color: var(--warn); border: 1.5px solid var(--warn); border-radius: 999px; padding: 3px 12px; }
  .sync { grid-column: 1 / -1; font-size: 15px; padding: 10px 12px; border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); border-radius: 4px; }
  .controls { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; justify-content: space-between;
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); padding: 8px 0; margin-top: 8px; flex-wrap: wrap; }
  .tabs { display: flex; gap: 4px; }
  .right { display: flex; gap: 8px; align-items: center; }
  .refresh { all: unset; cursor: pointer; display: flex; padding: 8px; border-radius: 50%; color: var(--muted); }
  .refresh:hover { background: var(--accent-soft); color: var(--accent); }
  .tabs button { all: unset; cursor: pointer; font-size: 15px; letter-spacing: .14em; text-transform: uppercase; padding: 6px 10px; border-radius: 6px; color: var(--muted); }
  .tabs button.sel { color: var(--accent); font-weight: 700; }
  .tabs button:focus-visible, .line:focus-visible, .refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type=search] { font: inherit; font-size: 16px; color: var(--ink); background: transparent; border: 1px solid var(--rule);
    border-radius: 999px; padding: 6px 14px; min-width: 0; width: 200px; }
  .body { columns: 2 380px; column-gap: 48px; }
  section { break-inside: avoid-column; padding-top: 22px; }
  section.unit { break-inside: avoid; }
  .area { column-span: all; margin: 26px 0 0; font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: var(--muted); }
  .area:first-child { margin-top: 10px; }
  h2 { font-size: 15px; letter-spacing: .32em; text-transform: uppercase; font-weight: 700; color: var(--accent);
    text-align: center; margin: 0 0 6px; display: flex; align-items: center; gap: 14px; }
  h2::before, h2::after { content: ""; flex: 1; border-top: 1px solid var(--rule); }
  h2 .cap { letter-spacing: .05em; color: var(--muted); font-weight: 500; }
  h3 { font-size: 15px; font-style: italic; font-weight: 500; color: var(--muted); margin: 12px 0 2px; break-after: avoid; }
  .line { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: grid; grid-template-columns: 44px auto 1fr auto;
    align-items: baseline; gap: 0 8px; padding: 5px 6px; border-radius: 6px; break-inside: avoid; }
  .line:hover { background: var(--accent-soft); }
  .qn { font-size: 17px; font-weight: 600; font-variant-numeric: oldstyle-nums; color: var(--muted); text-align: right; }
  .name { font-size: 18px; line-height: 1.25; }
  .prod { font-variant: small-caps; font-weight: 700; letter-spacing: .03em; }
  .uom { font-size: 15px; font-style: italic; color: var(--muted); }
  .tag { font-size: 13px; font-weight: 700; color: var(--warn); margin-left: 8px; letter-spacing: .04em; white-space: nowrap; }
  .tag.bad { text-transform: uppercase; }
  .detail { display: block; font-size: 14px; font-style: italic; color: var(--muted); }
  .lead { border-bottom: 1.5px dotted var(--rule); transform: translateY(-5px); min-width: 12px; align-self: start; margin-top: 1.05em; }
  .where { font-size: 15px; font-style: italic; color: var(--muted); text-align: right; align-self: start; line-height: 1.3; padding-top: 2px; white-space: nowrap; }
  .unitwrap { display: flex; gap: 18px; align-items: flex-start; }
  .mini { flex: none; padding-top: 10px; }
  .unitlist { flex: 1; min-width: 0; }
  .empty { text-align: center; color: var(--muted); font-style: italic; padding: 32px 0; column-span: all; }
  .empty.small { padding: 12px 0; text-align: left; }
  ${SVG_CSS}
  @media (max-width: 600px) {
    ha-card.card { padding: 20px 16px 24px; }
    h1 { font-size: 32px; }
    .head { grid-template-columns: 1fr; }
    .flags { justify-content: flex-start; }
    .right { width: 100%; }
    input[type=search] { width: 100%; flex: 1; }
    .line { grid-template-columns: 34px 1fr auto; }
    .lead { display: none; }
    .where { font-size: 13px; }
  }
`;

const DIALOG_CSS = `
  :host { position: fixed; inset: 0; z-index: 1000; }
  .scrim { ${SHARED_CSS} --paper: var(--card-background-color, #fbf8f2);
    position: fixed; inset: 0; background: rgba(20, 16, 8, .55); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .scrim.dark { ${SHARED_DARK} }
  .dlg { position: relative; background: var(--paper); color: var(--ink); font-family: var(--serif); border-radius: 14px;
    width: min(620px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 26px 26px 22px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
  .x { all: unset; cursor: pointer; position: absolute; right: 12px; top: 12px; color: var(--muted); padding: 6px; display: flex; border-radius: 50%; }
  .x:hover { background: var(--accent-soft); }
  .cat { font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: var(--muted); }
  .prod { font-size: 30px; font-variant: small-caps; font-weight: 700; line-height: 1.1; letter-spacing: .02em; margin-top: 2px; }
  .cuvee { font-size: 19px; font-style: italic; color: var(--muted); line-height: 1.25; margin-top: 2px; }
  .qty { display: flex; align-items: center; justify-content: center; gap: 22px; margin: 18px 0 6px; }
  .amount { display: flex; align-items: baseline; gap: 8px; min-width: 90px; justify-content: center; }
  .amount .big { font-size: 48px; font-weight: 700; color: var(--accent); line-height: 1; font-variant-numeric: lining-nums; }
  .amount .u { font-size: 19px; font-style: italic; color: var(--muted); }
  .step { all: unset; cursor: pointer; width: 44px; height: 44px; border-radius: 50%; border: 1.5px solid var(--accent); color: var(--accent);
    display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 600; line-height: 1; }
  .step:hover { background: var(--accent-soft); }
  .step:disabled { opacity: .35; cursor: default; }
  .step:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hint { font-size: 14px; color: var(--muted); font-style: italic; text-align: center; }
  .warn { margin-top: 10px; padding: 10px 14px; border-radius: 10px; font-size: 15px; border: 1.5px solid var(--warn); color: var(--warn); }
  .strip { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 4px; justify-content: center; }
  .strip .u { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--rule); color: var(--muted); }
  .strip .u.on { background: var(--accent); border-color: var(--accent); color: var(--paper); font-weight: 700; }
  .diagram { display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; align-items: flex-end; padding: 10px 0 4px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 100%; }
  figure svg { max-width: 100%; height: auto; }
  figcaption { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; margin: 16px 0 0; font-size: 16px; }
  dt { color: var(--muted); font-style: italic; }
  dd { margin: 0; }
  ${SVG_CSS}
  @media (max-width: 480px) { .dlg { padding: 22px 16px 18px; } .prod { font-size: 26px; } }
`;

customElements.get("pantry-larder-card") || customElements.define("pantry-larder-card", PantryLarderCard);
customElements.get("pantry-item-dialog") || customElements.define("pantry-item-dialog", PantryItemDialog);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "pantry-larder-card",
  name: "Pantry larder list",
  description: "Simple Inventory pantry as a printed larder list, with storage diagrams and quantity controls.",
  documentationURL: "https://github.com/mikecb/ha-pantry-larder-card",
});
console.info(`%c PANTRY-LARDER-CARD %c ${VERSION} `, "background:#5f6b22;color:#fff", "");
