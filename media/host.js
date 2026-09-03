// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

const vscode = acquireVsCodeApi();

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

const COLOR_KEYS = Object.keys(DEFAULT_COLORS);

const DEFAULT_FONT_STACK =
  '"Lucida Console", "Cascadia Mono", Consolas, "Courier New", monospace';

const measure = document.createElement("canvas").getContext("2d");
const SAMPLE = "mmmiiilll0O@#WM";

function fontStack(family) {
  const wanted = String(family || "").trim();
  return wanted ? `${wanted}, ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK;
}

/**
 * Rough check that the first named font exists, by seeing whether it renders
 * any differently from the generic fallbacks. A missing font is otherwise
 * silent: the screen just keeps the old look and nothing says why.
 */
function fontMissing(family) {
  const first = String(family || "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!first) {
    return "";
  }
  const widths = ["monospace", "serif", "sans-serif"].map((generic) => {
    measure.font = `72px ${generic}`;
    const base = measure.measureText(SAMPLE).width;
    measure.font = `72px "${first}", ${generic}`;
    return measure.measureText(SAMPLE).width === base;
  });
  return widths.every(Boolean) ? first : "";
}

const PREVIEW_ROWS = [
  [
    ["green", " Unprotected normal   "],
    ["red", "Unprotected intense   "],
  ],
  [
    ["turquoise", " Protected normal     "],
    ["white", "Protected intense     "],
  ],
  [
    ["blue", " Blue "],
    ["pink", "Pink "],
    ["yellow", "Yellow "],
    ["black", "Black "],
    ["white", "White"],
  ],
];

let hostId = null;
let statusTimer = null;
// tn3270.fontFamily, used by any profile that leaves the Font box empty.
let defaultFontFamily = "";
// The tn3270.transfer.* settings, shown as placeholders on the empty boxes.
let defaultTransfer = { syntax: "tso", options: "", idleTimeout: 60 };
// Monospaced fonts this machine can actually render, and the highlighted row.
let fontChoices = [];
let fontActive = -1;

const el = (id) => document.getElementById(id);

function currentColors() {
  const colors = {};
  for (const key of COLOR_KEYS) {
    colors[key] = el(`c-${key}`).value;
  }
  return colors;
}

function setStatus(text, isError) {
  const status = el("status");
  status.textContent = text;
  status.className = isError ? "error" : "";
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  if (text && !isError) {
    statusTimer = setTimeout(() => {
      status.textContent = "";
    }, 3000);
  }
}

// Built as nodes rather than markup: the webview CSP forbids inline style
// attributes, but setting style properties from script is allowed.
function renderPreview() {
  const colors = currentColors();
  const preview = el("preview");
  // An empty box means "inherit", so preview what will actually be used.
  const family = el("f-fontFamily").value.trim() || defaultFontFamily;
  preview.textContent = "";
  preview.style.background = colors.background;
  preview.style.fontFamily = fontStack(family);

  const missing = fontMissing(family);
  el("font-warning").textContent = missing
    ? `${missing} does not look installed on this machine, so the built-in stack is being used.`
    : "";
  for (const row of PREVIEW_ROWS) {
    const line = document.createElement("div");
    for (const [key, text] of row) {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.color = colors[key];
      line.appendChild(span);
    }
    preview.appendChild(line);
  }
}

function syncEnabled() {
  const tls = el("f-secure").value === "tls";
  el("f-verifyCert").disabled = !tls;
  el("f-secLevel").disabled = !tls;
}

function applyHost(host, isNew) {
  hostId = host.id;
  el("heading").textContent = isNew ? "New 3270 host" : host.label || "Host";
  el("f-label").value = host.label || "";
  el("f-group").value = host.group || "";
  el("f-host").value = host.host || "";
  el("f-port").value = String(host.port || (host.secure ? 992 : 23));
  el("f-psSize").value = host.psSize || "24x80";
  el("f-codePage").value = host.codePage || "037";
  el("f-secure").value = host.secure ? "tls" : "plain";
  el("f-secLevel").value =
    host.secLevel === undefined || host.secLevel === null
      ? ""
      : String(host.secLevel);
  el("f-verifyCert").checked = host.verifyCert !== false;
  el("f-luName").value = host.luName || "";
  el("f-tn3270e").checked = host.tn3270e !== false;
  el("f-extendedColor").checked = host.extendedColor !== false;
  el("f-blink").checked = host.blink === true;
  el("f-fontFamily").value = host.fontFamily || "";
  el("f-fontFamily").placeholder = defaultFontFamily
    ? `${defaultFontFamily} (from settings)`
    : "Default monospace";
  el("f-transferSyntax").value = host.transferSyntax || "";
  el("f-transferOptions").value = host.transferOptions || "";
  el("f-transferOptions").placeholder =
    defaultTransfer.options || "RECFM(V) LRECL(255)";
  el("f-transferIdleTimeout").value = host.transferIdleTimeout
    ? String(host.transferIdleTimeout)
    : "";
  el("f-transferIdleTimeout").placeholder = `${defaultTransfer.idleTimeout} (from settings)`;
  el("f-transferSyntax").options[0].textContent =
    `Default — ${defaultTransfer.syntax.toUpperCase()} from settings`;
  const colors = { ...DEFAULT_COLORS, ...(host.colors || {}) };
  for (const key of COLOR_KEYS) {
    el(`c-${key}`).value = colors[key];
  }
  syncEnabled();
  renderPreview();
}

function collect() {
  const secLevel = el("f-secLevel").value;
  return {
    id: hostId,
    label: el("f-label").value,
    group: el("f-group").value,
    host: el("f-host").value,
    port: Number(el("f-port").value),
    secure: el("f-secure").value === "tls",
    verifyCert: el("f-verifyCert").checked,
    secLevel: secLevel === "" ? undefined : Number(secLevel),
    luName: el("f-luName").value,
    tn3270e: el("f-tn3270e").checked,
    codePage: el("f-codePage").value,
    psSize: el("f-psSize").value,
    extendedColor: el("f-extendedColor").checked,
    blink: el("f-blink").checked,
    colors: currentColors(),
    fontFamily: el("f-fontFamily").value,
    transferSyntax: el("f-transferSyntax").value,
    transferOptions: el("f-transferOptions").value,
    transferIdleTimeout: Number(el("f-transferIdleTimeout").value) || 0,
  };
}

/**
 * Narrow the Font suggestions to the ones worth offering.
 *
 * The extension host sends every family it can find, including guesses on
 * macOS where the names come from file names. Here we can actually measure:
 * anything that does not resolve is dropped, and so is anything proportional,
 * since 3270 columns sit on a fixed pitch.
 */
function isFixedPitch(family) {
  measure.font = `72px "${family}", monospace`;
  const narrow = measure.measureText("iiiiiiii").width;
  const wide = measure.measureText("WWWWWWWW").width;
  return Math.abs(narrow - wide) < 0.5;
}

function applyFonts(names) {
  const seen = new Set();
  const usable = [];
  const unknown = [];
  const proportional = [];
  for (const name of names || []) {
    const family = String(name || "").trim();
    const key = family.toLowerCase();
    if (!family || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (fontMissing(family)) {
      unknown.push(family);
      continue;
    }
    if (!isFixedPitch(family)) {
      proportional.push(family);
      continue;
    }
    usable.push(family);
  }
  // Logged, because which fonts a webview can actually see varies by platform
  // and there is no other way to tell a filtered font from a missing one.
  vscode.postMessage({
    op: "fontReport",
    candidates: seen.size,
    kept: usable.length,
    unknown,
    proportional,
  });
  if (!usable.length) {
    // Nothing measured true, so keep whatever we were offering before.
    return;
  }
  usable.sort((a, b) => a.localeCompare(b));
  fontChoices = usable;
}

/**
 * Suggestion list for the Font box.
 *
 * Typing filters it, and the filter looks at the last item of a comma
 * separated list so a font stack can be built up one name at a time. Each row
 * is drawn in its own font, which is the only honest way to choose one.
 */
function closeFontList() {
  const list = el("font-list");
  list.hidden = true;
  list.textContent = "";
  fontActive = -1;
}

function openFontList() {
  const typed = el("f-fontFamily").value.split(",").pop().trim().toLowerCase();
  const matches = fontChoices.filter((family) =>
    family.toLowerCase().includes(typed)
  );
  const list = el("font-list");
  list.textContent = "";
  fontActive = -1;
  if (!matches.length) {
    list.hidden = true;
    return;
  }
  for (const family of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "font-option";
    option.textContent = family;
    option.style.fontFamily = `"${family}", monospace`;
    // mousedown, because a click would land after the box has lost focus.
    option.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickFont(family);
    });
    list.appendChild(option);
  }
  list.hidden = false;
}

function pickFont(family) {
  el("f-fontFamily").value = family;
  closeFontList();
  renderPreview();
  el("f-fontFamily").focus();
}

function moveFontActive(delta) {
  const options = [...el("font-list").children];
  if (!options.length) {
    return;
  }
  if (fontActive >= 0) {
    options[fontActive].classList.remove("active");
  }
  fontActive = (fontActive + delta + options.length) % options.length;
  const active = options[fontActive];
  active.classList.add("active");
  active.scrollIntoView({ block: "nearest" });
}

el("f-secure").addEventListener("change", () => {
  const tls = el("f-secure").value === "tls";
  const port = Number(el("f-port").value);
  // Only follow the transport while the port is still the other default.
  if (port === (tls ? 23 : 992) || !port) {
    el("f-port").value = tls ? "992" : "23";
  }
  syncEnabled();
});

for (const key of COLOR_KEYS) {
  el(`c-${key}`).addEventListener("input", renderPreview);
}

el("f-fontFamily").addEventListener("input", () => {
  renderPreview();
  openFontList();
});

el("f-fontFamily").addEventListener("focus", openFontList);

// Delayed, so a click on a row is not cut off by the box losing focus.
el("f-fontFamily").addEventListener("blur", () => {
  setTimeout(closeFontList, 120);
});

el("f-fontFamily").addEventListener("keydown", (e) => {
  const open = !el("font-list").hidden;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (open) {
      moveFontActive(1);
    } else {
      openFontList();
    }
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    moveFontActive(-1);
  } else if (e.key === "Enter" && open && fontActive >= 0) {
    e.preventDefault();
    pickFont(el("font-list").children[fontActive].textContent);
  } else if (e.key === "Escape" && open) {
    e.preventDefault();
    closeFontList();
  }
});

el("reset").addEventListener("click", () => {
  for (const key of COLOR_KEYS) {
    el(`c-${key}`).value = DEFAULT_COLORS[key];
  }
  renderPreview();
  setStatus("Palette reset. Save to apply.");
});

el("save").addEventListener("click", () => {
  vscode.postMessage({ op: "save", host: collect() });
});

el("close").addEventListener("click", () => {
  vscode.postMessage({ op: "close" });
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    vscode.postMessage({ op: "save", host: collect() });
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.op === "load") {
    defaultFontFamily = String(msg.defaultFontFamily || "").trim();
    defaultTransfer = { ...defaultTransfer, ...(msg.defaultTransfer || {}) };
    applyHost(msg.host, msg.isNew);
  } else if (msg.op === "fonts") {
    applyFonts(msg.names);
  } else if (msg.op === "saved") {
    el("heading").textContent = msg.host.label || "Host";
    setStatus("Saved.");
  } else if (msg.op === "invalid") {
    setStatus(msg.message, true);
  }
});

vscode.postMessage({ op: "ready" });
