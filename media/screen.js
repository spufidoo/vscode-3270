// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

const vscode = acquireVsCodeApi();

// IBM PCOMM defaults, overridden per host from the settings tab.
const DEFAULT_COLORS = {
  background: "#000000",
  black: "#000000",
  blue: "#7890f0",
  red: "#f01818",
  pink: "#ff00ff",
  green: "#24d830",
  turquoise: "#58f0f0",
  yellow: "#ffff00",
  white: "#ffffff",
};

const EH_BLINK = 0xf1;
const EH_REVERSE = 0xf2;
const EH_UNDERSCORE = 0xf4;

const config = window.__VSCODE_3270_CONFIG__ || {};
let colors = { ...DEFAULT_COLORS, ...(config.colors || {}) };
let blinkEnabled = config.blink === true;
let keymap = config.keymap || {};

// Colour value 0 means "use the field default".
let PALETTE = {};

function applyColors() {
  PALETTE = {
    0x00: null,
    0xf0: colors.black,
    0xf1: colors.blue,
    0xf2: colors.red,
    0xf3: colors.pink,
    0xf4: colors.green,
    0xf5: colors.turquoise,
    0xf6: colors.yellow,
    0xf7: colors.white,
  };
  document.body.style.background = colors.background;
}

const DEFAULT_FONT_STACK =
  '"Lucida Console", "Cascadia Mono", Consolas, "Courier New", monospace';
const LINE_RATIO = 1.2;

// Always fall back to the stack, so a font the machine lacks degrades to a
// monospace rather than to whatever the webview's default proportional is.
function fontStack(family) {
  const wanted = String(family || "").trim();
  return wanted ? `${wanted}, ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK;
}

let FONT_STACK = fontStack(config.fontFamily);

const screenEl = document.getElementById("screen");
const gridEl = document.createElement("div");
gridEl.id = "grid";
const cursorEl = document.createElement("div");
cursorEl.id = "cursor";
const markEl = document.createElement("div");
markEl.id = "mark";
const menuEl = document.createElement("div");
menuEl.id = "menu";
menuEl.hidden = true;
gridEl.appendChild(cursorEl);
gridEl.appendChild(markEl);
screenEl.appendChild(gridEl);
document.body.appendChild(menuEl);

// "block" marks a row/column rectangle like Vista; "stream" is the browser's
// linear text selection. Set from config, updated live on a config message.
let selectionMode = config.selection === "stream" ? "stream" : "block";
// The marked rectangle, 1-based inclusive. Corners are stored as dragged; read
// them through the min/max helpers, since a drag can go up or left.
let mark = null;
let dragAnchor = null;
let dragging = false;

function applySelectionMode() {
  gridEl.classList.toggle("block-select", selectionMode === "block");
  clearMark();
}

function clearMark() {
  if (mark) {
    mark = null;
    drawMark();
  }
}

function drawMark() {
  // Drawn whenever a mark exists. The selection setting governs the mouse;
  // Shift+arrow marks a rectangle in either mode.
  if (!mark) {
    markEl.style.display = "none";
    positionCursor();
    return;
  }
  const top = Math.min(mark.r1, mark.r2) - 1;
  const left = Math.min(mark.c1, mark.c2) - 1;
  const rows = Math.abs(mark.r1 - mark.r2) + 1;
  const cols = Math.abs(mark.c1 - mark.c2) + 1;
  markEl.style.display = "block";
  markEl.style.left = `${left * cellW}px`;
  markEl.style.top = `${top * cellH}px`;
  markEl.style.width = `${cols * cellW}px`;
  markEl.style.height = `${rows * cellH}px`;
  positionCursor();
}

// The marked cells as text, one line per row. Non-display fields read as
// spaces so a copied block can never carry a password out of a hidden field.
function markedText() {
  if (!mark) {
    return "";
  }
  const top = Math.min(mark.r1, mark.r2);
  const bottom = Math.max(mark.r1, mark.r2);
  const left = Math.min(mark.c1, mark.c2);
  const right = Math.max(mark.c1, mark.c2);
  const lines = [];
  for (let r = top; r <= bottom; r++) {
    let line = "";
    for (let c = left; c <= right; c++) {
      const i = (r - 1) * state.cols + (c - 1);
      const { hidden } = cellColor(i);
      line += hidden ? " " : state.text[i] || " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

const MARK_STEPS = {
  left: [0, -1],
  right: [0, 1],
  up: [-1, 0],
  down: [1, 0],
};

/**
 * Grow or shrink the marked rectangle from the keyboard.
 *
 * The first press anchors on the 3270 cursor and only the far corner moves
 * after that, so the block can be dragged out in any direction and pulled
 * back through itself. The 3270 cursor stays put: marking is local to the
 * view and sends nothing to the host, so a copy never costs you your place.
 */
function moveMark(direction) {
  const step = MARK_STEPS[direction];
  if (!step) {
    return;
  }
  if (!mark) {
    const { cursorRow: row, cursorCol: col } = state;
    mark = { r1: row, c1: col, r2: row, c2: col };
    // So a following Shift+click extends this block rather than an old one.
    dragAnchor = { row, col };
    if (selectionMode === "stream") {
      window.getSelection()?.removeAllRanges();
    }
  }
  mark.r2 = clamp(mark.r2 + step[0], 1, state.rows);
  mark.c2 = clamp(mark.c2 + step[1], 1, state.cols);
  drawMark();
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function copyMark() {
  const text = markedText();
  if (text) {
    vscode.postMessage({ op: "copy", text });
  }
  clearMark();
  screenEl.focus();
}

// Copy whichever kind of selection is in play: a marked rectangle if there is
// one, otherwise whatever the browser has selected in stream mode.
function copySelection() {
  if (mark) {
    copyMark();
    return;
  }
  const text = window.getSelection()?.toString() ?? "";
  if (text) {
    vscode.postMessage({ op: "copy", text });
  }
  screenEl.focus();
}

function markAll() {
  mark = { r1: 1, c1: 1, r2: state.rows, c2: state.cols };
  drawMark();
}

/**
 * Right-click menu.
 *
 * VS Code's own webview menu is built from Electron editing roles, which act on
 * a DOM selection and an editable target. Block mode has neither — it suppresses
 * native selection, and the grid is a wall of divs — so Copy, Cut and Paste all
 * come up dead. This menu works on the mark instead, and gets clipboard text
 * from the extension host, which is the only side allowed to read it.
 */
function hideMenu() {
  menuEl.hidden = true;
  menuEl.textContent = "";
}

function showMenu(x, y) {
  const items = [
    { label: "Copy", enabled: Boolean(mark) || hasSelection(), run: copySelection },
    { label: "Paste", enabled: true, run: () => vscode.postMessage({ op: "pasteRequest" }) },
    { label: "Mark all", enabled: selectionMode === "block", run: markAll },
  ];

  menuEl.textContent = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    button.textContent = item.label;
    button.disabled = !item.enabled;
    button.addEventListener("click", () => {
      hideMenu();
      item.run();
      // The button took focus on the way in; the 3270 needs it back.
      screenEl.focus();
    });
    menuEl.appendChild(button);
  }

  // Placed, then nudged back inside the panel if it would hang off the edge.
  menuEl.hidden = false;
  menuEl.style.left = "0px";
  menuEl.style.top = "0px";
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${clamp(x, 0, Math.max(0, window.innerWidth - width))}px`;
  menuEl.style.top = `${clamp(y, 0, Math.max(0, window.innerHeight - height))}px`;
}

const measure = document.createElement("canvas").getContext("2d");

let state = {
  rows: 24,
  cols: 80,
  cursorRow: 1,
  cursorCol: 1,
  lock: false,
  text: " ".repeat(24 * 80),
  attr: new Uint8Array(24 * 80),
  fg: new Uint8Array(24 * 80),
  bg: new Uint8Array(24 * 80),
  eh: new Uint8Array(24 * 80),
  extendedColor: false,
};
let insertMode = false;
let cellW = 8;
let cellH = 16;
let rowEls = [];
let rowSig = [];

function decodeB64(s) {
  if (!s) {
    return new Uint8Array(0);
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function cellColor(i) {
  // 3270 field attribute bits 4-5: 00 normal, 01 detectable,
  // 10 intensified, 11 non-display.
  const fa = state.attr[i] || 0;
  const disp = fa & 0x0c;
  if (disp === 0x0c) {
    return { fg: colors.background, bg: colors.background, hidden: true };
  }
  const intense = disp === 0x08;
  const normal = disp === 0x00;
  const protectedField = (fa & 0x20) !== 0;
  let fg = PALETTE[state.fg[i]] || null;
  let bg = PALETTE[state.bg[i]] || null;
  if (!fg) {
    if (intense && !protectedField) {
      fg = state.extendedColor ? colors.white : colors.red;
    } else if (intense && protectedField) {
      fg = colors.white;
    } else if (normal && protectedField) {
      fg = state.extendedColor ? colors.green : colors.turquoise;
    } else {
      fg = colors.green;
    }
  }
  if (!bg) {
    bg = colors.background;
  }
  if (state.eh[i] === EH_REVERSE) {
    return { fg: bg, bg: fg, hidden: false };
  }
  return { fg, bg, hidden: false };
}

// Built as DOM nodes rather than markup: the webview CSP forbids inline
// style attributes, but setting style properties from script is allowed.
function makeSpan(style, text) {
  const [fg, bg, underline, blink] = style.split("|");
  const el = document.createElement("span");
  el.textContent = text;
  el.style.color = fg;
  if (bg !== colors.background) {
    el.style.background = bg;
  }
  if (underline === "1") {
    el.style.textDecoration = "underline";
  }
  if (blink === "1") {
    el.className = "blink";
  }
  return el;
}

function buildGrid() {
  for (const el of rowEls) {
    el.remove();
  }
  rowEls = [];
  rowSig = new Array(state.rows).fill(null);
  for (let r = 0; r < state.rows; r++) {
    const row = document.createElement("div");
    row.className = "row";
    gridEl.appendChild(row);
    rowEls.push(row);
  }
}

function paint() {
  if (rowEls.length !== state.rows) {
    buildGrid();
  }
  for (let r = 0; r < state.rows; r++) {
    const runs = [];
    let style = null;
    let run = "";
    for (let c = 0; c < state.cols; c++) {
      const i = r * state.cols + c;
      const { fg, bg, hidden } = cellColor(i);
      const underline = state.eh[i] === EH_UNDERSCORE ? "1" : "0";
      const blink = blinkEnabled && state.eh[i] === EH_BLINK ? "1" : "0";
      const key = `${fg}|${bg}|${underline}|${blink}`;
      const ch = hidden ? " " : state.text[i] || " ";
      if (key === style) {
        run += ch;
      } else {
        if (style !== null) {
          runs.push([style, run]);
        }
        style = key;
        run = ch;
      }
    }
    if (style !== null) {
      runs.push([style, run]);
    }

    // Only touch rows that changed, so an active selection survives updates.
    const signature = runs.map(([s, t]) => `${s}\u0000${t}`).join("\u0001");
    if (rowSig[r] === signature) {
      continue;
    }
    rowSig[r] = signature;
    const row = rowEls[r];
    row.textContent = "";
    for (const [runStyle, runText] of runs) {
      row.appendChild(makeSpan(runStyle, runText));
    }
  }
  positionCursor();
}

function cursorInMark() {
  if (!mark) {
    return false;
  }
  const { cursorRow: row, cursorCol: col } = state;
  return (
    row >= Math.min(mark.r1, mark.r2) &&
    row <= Math.max(mark.r1, mark.r2) &&
    col >= Math.min(mark.c1, mark.c2) &&
    col <= Math.max(mark.c1, mark.c2)
  );
}

function positionCursor() {
  // Cursor and mark both paint white through a difference blend, so a cell
  // carrying both is differenced twice and comes back unmarked. Hide the
  // cursor there: inside a reverse-video block it would be invisible anyway.
  cursorEl.style.display = cursorInMark() ? "none" : "block";
  cursorEl.style.width = `${cellW}px`;
  cursorEl.style.height = insertMode ? "2px" : `${cellH}px`;
  cursorEl.style.left = `${(state.cursorCol - 1) * cellW}px`;
  cursorEl.style.top = `${
    (state.cursorRow - 1) * cellH + (insertMode ? cellH - 2 : 0)
  }px`;
}

function fit() {
  const w = screenEl.clientWidth || 1;
  const h = screenEl.clientHeight || 1;
  measure.font = `100px ${FONT_STACK}`;
  const ratio = measure.measureText("M").width / 100 || 0.6;

  let fontSize = Math.floor(
    Math.min(w / state.cols / ratio, h / state.rows / LINE_RATIO)
  );
  fontSize = Math.max(fontSize, 8);
  cellW = fontSize * ratio;
  cellH = Math.round(fontSize * LINE_RATIO);

  gridEl.style.font = `${fontSize}px/${cellH}px ${FONT_STACK}`;
  gridEl.style.width = `${state.cols * cellW}px`;
  gridEl.style.height = `${state.rows * cellH}px`;
  for (const row of rowEls) {
    row.style.height = `${cellH}px`;
  }
  positionCursor();
  drawMark();
}

function setOia() {
  const lock = document.getElementById("oia-lock");
  lock.textContent = state.lock ? "X" : "A";
  lock.className = state.lock ? "locked" : "unlocked";
  document.getElementById("oia-ins").textContent = insertMode ? "INS" : "REP";
  document.getElementById("oia-pos").textContent =
    `${state.cursorRow},${state.cursorCol}`;
  document.getElementById("oia-size").textContent =
    `${state.rows}x${state.cols}`;
  document.getElementById("oia-color").textContent = state.extendedColor
    ? "EXT COLOR"
    : "BASE COLOR";
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.op === "screen") {
    const resized = msg.rows !== state.rows || msg.cols !== state.cols;
    state = {
      rows: msg.rows,
      cols: msg.cols,
      cursorRow: msg.cursorRow,
      cursorCol: msg.cursorCol,
      lock: msg.lock,
      text: msg.text,
      attr: decodeB64(msg.attr),
      fg: decodeB64(msg.fg),
      bg: decodeB64(msg.bg),
      eh: decodeB64(msg.eh),
      extendedColor: msg.extendedColor,
    };
    document.getElementById("oia-msg").textContent = msg.lock ? "X SYSTEM" : "";
    if (resized) {
      buildGrid();
    }
    fit();
    paint();
    setOia();
  } else if (msg.op === "status") {
    if (msg.seslost) {
      document.getElementById("oia-msg").textContent = msg.reason
        ? `SESSION LOST — ${msg.reason}`
        : "SESSION LOST";
    } else if (msg.connected) {
      document.getElementById("oia-msg").textContent = msg.tls
        ? "TLS"
        : "CONNECTED";
    } else {
      document.getElementById("oia-msg").textContent = "DISCONNECTED";
    }
    state.lock = msg.lock;
    setOia();
  } else if (msg.op === "config") {
    colors = { ...DEFAULT_COLORS, ...(msg.colors || {}) };
    blinkEnabled = msg.blink === true;
    if (msg.keymap) {
      keymap = msg.keymap;
    }
    if (msg.selection) {
      selectionMode = msg.selection === "stream" ? "stream" : "block";
      applySelectionMode();
    }
    applyColors();
    FONT_STACK = fontStack(msg.fontFamily);
    fit();
    rowSig.fill(null);
    paint();
  } else if (msg.op === "focus") {
    screenEl.focus();
  } else if (msg.op === "toggleInsert") {
    setInsert(!insertMode);
  } else if (msg.op === "oia") {
    const text = String(msg.message || "");
    document.getElementById("oia-msg").textContent =
      text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } else if (msg.op === "transfer") {
    // The screen does not update while IND$FILE runs, so say why.
    document.getElementById("oia-msg").textContent =
      msg.state === "start" ? "FILE TRANSFER IN PROGRESS" : "";
  } else if (msg.op === "error") {
    const first =
      String(msg.message || "error")
        .split("\n")
        .find((l) => l.trim()) || "error";
    document.getElementById("oia-msg").textContent =
      first.length > 240 ? `${first.slice(0, 240)}…` : first;
  }
});

function hasSelection() {
  const sel = window.getSelection();
  return Boolean(sel && !sel.isCollapsed && sel.toString().length);
}

const KEY_ALIASES = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  PageUp: "pageup",
  PageDown: "pagedown",
  Escape: "escape",
  " ": "space",
};

const MODIFIER_KEYS = {
  Control: "ctrl",
  Alt: "alt",
  Shift: "shift",
  Meta: "meta",
};

/**
 * Name a modifier pressed on its own, left and right apart.
 *
 * A 3270 keyboard puts ENTER and RESET on the keys a PC uses for Ctrl, so
 * which one was pressed has to be part of the chord.
 */
function modifierChord(e) {
  const name = MODIFIER_KEYS[e.key];
  if (!name) {
    return "";
  }
  return (e.location === 2 ? "right" : "left") + name;
}

function chordFor(e) {
  const key = KEY_ALIASES[e.key] || e.key.toLowerCase();
  let chord = "";
  if (e.ctrlKey) {
    chord += "ctrl+";
  }
  if (e.altKey) {
    chord += "alt+";
  }
  if (e.shiftKey) {
    chord += "shift+";
  }
  if (e.metaKey) {
    chord += "meta+";
  }
  return chord + key;
}

function setInsert(on) {
  insertMode = on;
  setOia();
  positionCursor();
}

function runAction(action) {
  const sep = action.indexOf(":");
  const kind = sep === -1 ? action : action.slice(0, sep);
  const value = sep === -1 ? "" : action.slice(sep + 1);
  if (kind === "aid" || kind === "nav") {
    vscode.postMessage({ op: "key", type: kind, value });
  } else if (kind === "macro") {
    vscode.postMessage({ op: "macro", name: value });
  } else if (kind === "local" && value === "insert") {
    setInsert(!insertMode);
  } else if (kind === "local" && value === "reset") {
    // Reset is an operator function: it unlocks the keyboard and leaves
    // insert mode without sending anything to the host.
    setInsert(false);
    document.getElementById("oia-msg").textContent = "";
  } else if (kind === "local" && value === "markclear") {
    clearMark();
  } else if (kind === "local" && value.startsWith("mark")) {
    moveMark(value.slice("mark".length));
  }
}

// Set while a modifier is held with nothing else pressed since. Acting on
// keyup is what separates a solo Ctrl from the Ctrl that starts Ctrl+C.
let soloModifier = "";

screenEl.addEventListener("keydown", (e) => {
  const modifier = modifierChord(e);
  if (modifier) {
    soloModifier = modifier;
    return;
  }
  soloModifier = "";

  // Any key dismisses the menu. Escape does only that, keeping the mark that
  // was about to be copied; every other key goes on to do its usual job.
  if (!menuEl.hidden) {
    hideMenu();
    if (e.key === "Escape") {
      e.preventDefault();
      return;
    }
  }

  // Clipboard and select-all. Ctrl+C only means ATTN when there is nothing to
  // copy, so a real 3270 attention key is still reachable.
  const clip = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && ["c", "a", "v", "x"].includes(clip)) {
    if (clip === "c") {
      // A mark wins in either mode, since Shift+arrow can make one in both.
      if (mark) {
        e.preventDefault();
        copyMark();
      } else if (selectionMode === "block" || !hasSelection()) {
        e.preventDefault();
        runAction("aid:attn");
      }
    } else if (clip === "a" && selectionMode === "block") {
      // Mark the whole screen; stream mode keeps the browser's select-all.
      e.preventDefault();
      markAll();
    }
    return;
  }

  const action = keymap[chordFor(e)];

  // The marking keys are the one thing that must not drop the mark first.
  if (action && action.startsWith("local:mark")) {
    e.preventDefault();
    runAction(action);
    return;
  }

  // Any other key is host input, so the mark has served its purpose.
  clearMark();

  if (action) {
    e.preventDefault();
    runAction(action);
    return;
  }

  if (e.ctrlKey || e.altKey || e.metaKey) {
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    vscode.postMessage({
      op: "key",
      type: "chars",
      value: e.key,
      insert: insertMode,
    });
  }
});

screenEl.addEventListener("keyup", (e) => {
  const modifier = modifierChord(e);
  const solo = soloModifier;
  soloModifier = "";
  if (!modifier || modifier !== solo) {
    return;
  }
  const action = keymap[modifier];
  if (action) {
    e.preventDefault();
    runAction(action);
  }
});

function cellFromEvent(e) {
  const rect = gridEl.getBoundingClientRect();
  const col = Math.min(
    state.cols,
    Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1)
  );
  const row = Math.min(
    state.rows,
    Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1)
  );
  return { row, col };
}

// Stream mode: dragging selects text; a plain click still positions the 3270
// cursor. Only bound when block mode is off, so the two never both fire.
gridEl.addEventListener("mouseup", (e) => {
  if (selectionMode !== "stream") {
    return;
  }
  screenEl.focus();
  if (e.detail === 2) {
    const { row, col } = cellFromEvent(e);
    vscode.postMessage({ op: "click", row, col, double: true });
    return;
  }
  if (hasSelection()) {
    return;
  }
  const { row, col } = cellFromEvent(e);
  vscode.postMessage({
    op: "click",
    row,
    col,
    double: false,
    ctrl: Boolean(e.ctrlKey || e.metaKey),
  });
});

// Block mode: press to anchor, drag to mark a rectangle, Shift+press to extend.
// preventDefault stops the browser starting a native text selection underneath.
gridEl.addEventListener("mousedown", (e) => {
  if (selectionMode !== "block" || e.button !== 0) {
    return;
  }
  const { row, col } = cellFromEvent(e);
  if (e.shiftKey && dragAnchor) {
    mark = { r1: dragAnchor.row, c1: dragAnchor.col, r2: row, c2: col };
    dragging = true;
    drawMark();
    e.preventDefault();
    return;
  }
  dragAnchor = { row, col };
  dragging = true;
  mark = null;
  drawMark();
  e.preventDefault();
});

// On window, so a drag that leaves the grid keeps tracking (clamped by
// cellFromEvent) instead of freezing at the edge.
window.addEventListener("mousemove", (e) => {
  if (!dragging || selectionMode !== "block") {
    return;
  }
  const { row, col } = cellFromEvent(e);
  mark = { r1: dragAnchor.row, c1: dragAnchor.col, r2: row, c2: col };
  drawMark();
});

window.addEventListener("mouseup", (e) => {
  if (!dragging || selectionMode !== "block") {
    return;
  }
  dragging = false;
  const { row, col } = cellFromEvent(e);
  screenEl.focus();
  if (e.detail === 2) {
    clearMark();
    vscode.postMessage({ op: "click", row, col, double: true });
    return;
  }
  // A press and release on the same cell is a click, not a drag: drop any mark
  // and position the cursor, keeping Ctrl+click for the click macro.
  if (row === dragAnchor.row && col === dragAnchor.col) {
    clearMark();
    vscode.postMessage({
      op: "click",
      row,
      col,
      double: false,
      ctrl: Boolean(e.ctrlKey || e.metaKey),
    });
  }
});

screenEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY);
});

// Anything that is not a click on the menu itself dismisses it. Capture, so a
// press on the grid closes the menu before it starts marking a new block.
window.addEventListener(
  "mousedown",
  (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) {
      hideMenu();
    }
  },
  true
);

window.addEventListener("blur", hideMenu);
window.addEventListener("resize", hideMenu);

// A 3270 drops the marked block once it has been copied. Clearing after the
// event lets the browser read the selection first, and taking focus back means
// the next keystroke types instead of landing on the selection.
document.addEventListener("copy", () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
    }
    screenEl.focus();
  }, 0);
});

document.addEventListener("paste", (e) => {
  const text = e.clipboardData ? e.clipboardData.getData("text") : "";
  if (text) {
    e.preventDefault();
    vscode.postMessage({ op: "paste", text });
  }
});

window.addEventListener("resize", () => {
  fit();
});

// The command palette, notifications and dialogs all take focus away. VS Code
// hands it back to the webview document but not to the element listening for
// keys, so without this the 3270 stays deaf until the user clicks it.
window.addEventListener("focus", () => {
  screenEl.focus();
});

applySelectionMode();
applyColors();
buildGrid();
fit();
paint();
setOia();
screenEl.focus();

// Kept so VS Code can hand this panel back to the right host after a window
// reload; the extension reads it from the serialized state.
vscode.setState({ hostId: config.hostId || "" });

// The grid starts empty, and the host only sends a screen when it changes, so
// ask for the current one. Also covers a webview reloaded after being hidden.
vscode.postMessage({ op: "ready" });
