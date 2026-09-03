# Development history

This is a record of the Cursor chats that produced this extension (20 August –
3 September 2026), not a transcript dump. Tool calls, screenshots and log
attachments are omitted; the decisions and the bugs that drove them are not.

It uses [IBM tnz](https://github.com/IBM/tnz) at runtime. Until 0.10.0 that was
a `pip install` the user had to do; since then tnz and ebcdic are bundled.

The extension was called TNZ 3270 throughout the period this records, and its
settings `tnzView.*`. Both were renamed in 0.9.0 when it moved to BMC: the names
below are left as they were said at the time rather than rewritten.

## Contents

| Day | What it produced | Releases |
| --- | --- | --- |
| [20–21 Aug][d1] | Scaffold: hosts, screen, PF keys | — |
| [24 Aug][d2] | Selectable text, colour, host editor | 0.1.0–0.1.5 |
| [25 Aug][d3] | Geometry, keymap, IND$FILE, macros | 0.1.6–0.3.2 |
| [26 Aug][d4] | Attribute byte, connect diagnostics | 0.3.3–0.3.5 |
| [27–28 Aug][d5] | Script macros, per-host fonts, tracing | 0.4.0–0.6.2 |
| [1 Sep][d6] | Block selection, resilience, the rename | 0.7.1–0.9.0 |
| [2 Sep][d7] | tnz and ebcdic bundled | 0.10.0 |
| [3 Sep][d8] | Keyboard marking, menu, fonts, Mac insert | 0.11.0 |

[Why this exists](#why-this-exists) ·
[What was left on purpose](#what-was-left-on-purpose) ·
[Where it stands](#where-it-stands)

[d1]: #2021-august--scaffold
[d2]: #24-august--first-real-session
[d3]: #25-august--reconnect-keys-files-macros
[d4]: #26-august--polish-and-tls
[d5]: #2728-august--macros-that-think
[d6]: #1-september--selection-resilience-a-name
[d7]: #2-september--no-prerequisites
[d8]: #3-september--marking-without-a-mouse-and-a-mac-keyboard

## Why this exists

The starting point was a clone of IBM/tnz and the question whether it could
become a VS Code or Cursor extension. tnz already speaks TN3270, including
extended colour, file transfer and a character-cell API. What it does not
provide is an editor UI.

Two fronts were considered: zti's curses terminal (easy, wrong for an editor)
and a native 3270 webview driven by tnz's `Tnz` object (harder, what was
wanted). The native view won. Hosts were to live in the activity bar; sessions
as editor tabs with a fixed 3270 grid, not a VT terminal.

A separate repository was recommended so the extension would not sit inside
the IBM/tnz checkout. It was built in this workspace, then moved to
`spufidoo/tnz-view`.

Architecture that stuck from the first build:

- TypeScript extension for the tree, settings, commands and webview.
- A Python sidecar wrapping `tnz.Tnz`, talking JSON-lines over stdin/stdout.
  One process, one worker thread per session.
- Secrets stay out of settings; passwords are typed on the 3270 screen.

## 20–21 August — scaffold

Untagged; the first tag came on 24 August.

First working extension: host list, connect, webview screen, PF keys, ATTN,
basic colour from field attributes. Packaged and installed in Cursor and VS
Code.

## 24 August — first real session

Tags: `v0.1.0` `v0.1.1` `v0.1.2` `v0.1.4` `v0.1.5`

### Sidecar would not start

tnz tried to write `tnz.log` into the editor install directory
(`C:\Program Files\cursor`), which is not writable. The sidecar now logs under
`TNZ_VIEW_LOG_DIR` (the extension's global storage) or disables tnz file
logging. The process is spawned with a writable cwd. A log channel was added
so errors are copyable.

### Canvas vs text

The first screen was a `<canvas>`. Text could not be selected. It was rewritten
as a DOM grid (`div` rows, `span` runs) so copy and paste work. The webview CSP
forbids inline `style` attributes; colours are set from script via CSSOM.

`Ctrl+C` copies when there is a selection and sends ATTN when there is not.

### Hidden fields and colour

The logon password was visible. tnz does read the non-display bit; the sidecar
was not applying field attributes across the buffer. `_effective_planes`
propagates field attributes and extended colour/highlight, and `_mask_hidden`
blanks non-display fields before they reach the webview.

The first paint was green on black. Field-attribute colour (protected /
intensified) was implemented with a PCOMM-like palette, then compared against
screenshots of a real emulator. Extended colour mode followed: advertise
colour in the 3270 query reply (`capable_color`) so the host sends extended
colour orders; the status line shows `BASE COLOR` or `EXT COLOR`. APL /
box-drawing glyphs needed `cp310` loaded in the sidecar.

Windows pipes defaulted to cp1252, so those glyphs crashed the sidecar with
`UnicodeEncodeError`. stdin/stdout/stderr are reconfigured to UTF-8, and
`PYTHONIOENCODING=utf-8` is set on spawn. Screen-update errors are caught so
one bad paint cannot kill the session thread.

### Host editor

Sequential input boxes for host fields were replaced by a settings tab: all
fields, extended colour, blink, and a live palette. Saving a profile repaints
open sessions for colour and blink; geometry and TLS still need a reconnect.

That day's colour and editor work was committed and pushed on request.

## 25 August — reconnect, keys, files, macros

Tags: `v0.1.6` `v0.1.8` `v0.1.9` `v0.2.0` `v0.3.0` `v0.3.1` `v0.3.2`

### Session lost on TSO reconnect

Reconnecting to an existing TSO session failed with
`TnzTerminalError: Invalid address`. The host was writing past the end of the
client buffer because the session geometry had been set by another emulator
(PCOMM at `30x133`) and TN3270E does not renegotiate it. Columns must match
exactly; rows may be higher.

The host editor's screen size became free text with a datalist of standard
models. A Unicode multiplication sign (`30×133`) failed
`_util.session_ps_size`; both the sidecar and the editor now accept `×`.
Lost-session messages started explaining the address error instead of
discarding the exception.

### Keymap

Keys were an `if/else` chain in the webview. They became a chord → action
table (`src/keymap.ts`), overridable with `tnzView.keymap`. Missing keys were
added as table entries: PA1–3, Clear, End, word left/right, Erase Input, New
Line, Reset. Reset is local (leave insert, clear the status); it cannot
unlock a host-held keyboard.

**TNZ 3270: Show Keyboard Map** lists the bindings in effect. Chord syntax,
AID vs nav vs local, and reserved keys are in [docs/KEYMAP.md](docs/KEYMAP.md).
DUP and Field Mark were left out: they insert EBCDIC controls rather than
calling a tnz key function.

### IND$FILE

Download and upload commands wrap `tnz.get_file` / `put_file` on the session
thread, because tnz drives its own wait loop. The session must be at a ready
prompt; the command is typed at the cursor. An idle timeout stops the loop
spinning forever when IND$FILE never starts. Host-initiated transfers stay
disabled.

Text mode needs `ASCII` and `CRLF` as whole words so tnz does the translation
itself (the host's tables mangle `|`). The first parameter builder wrapped
options in `(`, which is CMS convention. TSO answered
`IKJ56712I INVALID KEYWORD, (`. TSO now gets bare keywords;
`tnzView.transfer.syntax` selects `tso` (default) or `cms`. Walkthrough:
[docs/TRANSFER.md](docs/TRANSFER.md).

Title-bar transfer buttons were declared but easy to miss; the commands stay
in the palette even with no session focused, and they say so rather than
vanishing. `tnzView.sessionActive` was only set from `onDidChangeViewState`,
which does not fire when a panel is created, so a new session counted as
inactive until the user clicked away and back.

### Macros

Named sequences in `tnzView.macros`, played from a key (`macro:<name>`) or
**Run Macro**. Syntax is text with `[action]` markers, e.g.
`=3.4[enter][wait]MY.JCL[enter]`. `[wait]` blocks on the keyboard lock rather
than a guessed delay. Macros run on the session thread so typing cannot
interleave. Passwords should not go in settings (plain text, often synced).
A separate `MACROS.md` was declined; KEYMAP.md covers them.

After Run Macro from the palette, the 3270 ignored keys until a click. The
palette returns focus to the webview document, not to `#screen`. The webview
now focuses that element whenever the window regains focus.

## 26 August — polish and TLS

Tags: `v0.3.3` `v0.3.4` `v0.3.5`

### Field attribute column

An underscored input field looked one column too wide on the left. Every
buffer position inherited the nearest field's extended highlighting,
including the attribute byte itself. That byte occupies a screen position but
belongs to no field; a 3270 shows it as a plain blank. It now keeps default
planes while still setting what following positions inherit.

### TLS mismatch

Connecting to `www.moshix.tech:2023` dropped immediately with SESSION LOST.
The port speaks TLS (`DO TERMINAL-TYPE` after a TLS handshake; the
certificate validates). Connect had been reporting
`connection lost during connect` and dropping the exception.

Failures now keep the original exception (and wrapped SSL causes) and add a
sentence for TLS vs plain, certificate verification, refused, reset, timeout,
DNS, and oversized screens. A handshake that never completes times out with
that explanation instead of claiming success.

## 27–28 August — macros that think

Tags: `v0.4.0` `v0.5.3` `v0.6.2`

### Prompts in a tape macro

A logon macro needs a userid and a password it does not store. `[prompt:Label]`
and `[password:Label]` ask before the tape plays, so nothing sensitive reaches
`settings.json`. The first attempt rejected them with "does not take a value":
the marker parser split on `:` and then complained that the action had an
argument, because prompts were being checked against the AID and nav tables.

New host profiles also changed to what a mainframe shop actually meets first:
plain telnet on port 23, code page 037. Right Ctrl became Reset, which is where
a real 3270 keyboard has it.

### Vista-style script macros

A tape cannot make a decision. `startlpar.mac` from Vista TN3270 was the
benchmark: read the screen, branch on what is there, ask mid-flight. Tapes were
kept and joined by **script** macros — Python files in a macros folder,
referenced as `{ "script": "startlpar" }`, run in the sidecar with a small API
(`type`, `enter`, `on_screen`, `word_at`, `ask`, `ask_password`, `warn`).

Two failures came from how the script was compiled. A pre-flight `compile()` of
the raw source rejected the top-level `return` the API encourages, and wrapping
the source by indenting it broke multi-line strings and threw line numbers out.
Both went away by wrapping through the `ast` module instead, which preserves
positions. Ctrl+click was wired to `tn3270.clickMacro`, passing the cell under
the pointer so a macro can start from what was clicked.

### Fonts per host

The font had to be set in `settings.json`, which is the wrong place for
something that belongs to one host. It moved into the host settings tab, with
the workspace `fontFamily` kept as the default when a profile leaves the box
empty, and a preview that warns when the named font is not installed.

### Waiting for a screen, not an unlock

The logon script warned "Can't find the password prompt anywhere" the instant
the userid was sent. `wait_unlock` returns when the keyboard unlocks, which
happens several times during a logon, so the script was reading an intermediate
screen. `wait_for` waits for content rather than a state, and
`tn3270.macroTrace` with `trace` and `trace_screen` makes it possible to see
which screen a script actually saw. Passwords are redacted from the trace.

## 1 September — selection, resilience, a name

Tags: `v0.7.1` `v0.7.2` `v0.8.0` `v0.8.1` `v0.9.0`

### Block selection

Selecting text behaved like Notepad: a run of characters that wraps. A 3270 user
wants a rectangle. `tn3270.selection` chooses `block` (default) or `stream`,
with block drawing its own marked rectangle over the grid because native
selection cannot do columns.

### Keys VS Code was stealing

PF5 sent PF5 to TSO *and* started debugging. A webview cannot stop the workbench
acting on a key it has also bound. The fix is a no-op command,
`tn3270.session.keyGuard`, bound to the conflicting chords with a `when` clause
of `activeWebviewPanelId == tn3270.session`: the workbench binding resolves to
nothing and the webview's own handler still runs.

### Surviving a reload, and a sidecar that dies

A code review found several ways to be left with a live-looking dead session: an
exception escaping a command handler killed the session's worker thread for
good; reconnecting through an existing panel never restarted a dead sidecar; a
transfer whose sidecar exited hung forever; and `SESSION_SECLEVEL` was set
globally at connect and never cleared, so one profile's TLS level leaked into
the next.

Each was contained rather than papered over — the worker loop catches per
command, sends go through a wrapper that reports a dead sidecar in the OIA,
pending transfers are failed on exit, and the environment variable is scoped to
the call with a lock. A `WebviewPanelSerializer` was added at the same time, so
3270 tabs survive a window reload and reconnect themselves.

### A name that is not a library's

Tab titles read `DB2B.REP.plain`; a tester wanted `DB2B`. Status moved to the
OIA where it belongs. Then the product name itself: `mdavage.tnz-view` became
`mdavage.vscode-3270` and every `tnzView.*` setting became `tn3270.*`, with a
one-time migration that copies settings and the macros folder and offers to
remove the old keys.

Because the same source ships to two audiences, display names live in a branding
overlay applied at package time: `3270 Terminal` by default, `BMC AMI DevX 3270`
for the BMC build, from one identifier and one codebase. BMC GHE became `origin`
with the public GitHub repo as a mirror.

## 2 September — no prerequisites

Tags: `v0.10.0`

Testers had to `pip install tnz ebcdic` before anything worked, which is a poor
first five minutes and impossible to explain to a customer. Both packages are
now fetched at package time into `sidecar/vendor` and put on `sys.path` ahead of
anything else, so the extension installs and runs. They are not committed; the
NOTICE records what is bundled and under which licence.

## 3 September — marking without a mouse, and a Mac keyboard

0.11.0, packaged and installed for testing; not yet tagged.

### Shift+arrows

Copying still needed the mouse: `Ctrl+C` could copy a mark but nothing could
make one from the keyboard. Five `local:mark*` actions were added to the keymap
table, bound by default to Shift+arrows and Escape, so they are rebindable and
appear in Show Keyboard Map. The first press anchors on the 3270 cursor and only
the far corner moves afterwards. The cursor itself stays put and nothing is sent
to the host, so copying never costs the typing position.

### The anchor cell that would not mark

The first byte always looked unselected. Cursor and mark both paint white
through a `difference` blend, so a cell carrying both is differenced twice and
comes back looking untouched — necessarily the anchor cell, and any cell a
drag crossed. The cursor is now hidden while it sits inside the mark.

### A right-click menu that works

Cut, Copy and Paste in the webview's context menu did nothing. That menu is
built from Electron editing roles, which act on a DOM selection and an editable
target; block mode suppresses the first and a grid of `div`s is never the
second. Overriding the `copy` event would not have helped either, since with
no selection it is never dispatched. The view now draws its own menu — Copy,
Paste, Mark all — copying the mark and pasting via the extension host, the
only side that can read the clipboard. No Cut: a terminal cannot cut host data.

### Transfer settings that belong to the host

Whether IND$FILE wants a parenthesis is a fact about the host, not a preference,
so one workspace setting cannot serve a shop with both TSO and VM. Syntax,
default options and idle timeout became host profile fields, with the
`tn3270.transfer.*` settings as the fallback.

### The font list, three times over

Asking users to type a font name exactly is unkind, so the box was made to
suggest what is installed. A webview cannot enumerate fonts — it knows only
what it has loaded, and the browser API for system fonts needs a permission VS
Code will not grant — so names are gathered in the extension host and measured
in the webview, which drops anything that does not resolve or is not fixed
pitch. Deliberately over-guessing is safe because measuring is the arbiter.

It then failed three times, each for a different reason. The Windows font
registry holds face names, not families:
`Sauce Code Pro Light Nerd Font Complete Mono` is a face of a family called
`SauceCodePro Nerd Font Mono`, and only the family resolves, so every Nerd Font
was discarded. Switching to the installed font families fixed that, but
`System.Drawing` inherits GDI's `LOGFONT` limit and cuts names at 31
characters — `FantasqueSansMono Nerd Font Mon` — so WPF's list is now
queried as well and both spellings offered. Finally the suggestions themselves
were unusable: a `datalist` popup with a couple of hundred entries is taller
than the screen and will not scroll inside a webview. The view draws its own
list, filtered as you type, each row in its own font.

Diagnosing that middle failure needed evidence rather than theory, so the
webview reports what it kept, what would not resolve and what was proportional
to the log. That stays in: which fonts a webview can see varies by platform, and
there is otherwise no way to tell a filtered font from a missing one.

### A dropdown that came up white

In a dark theme the IND$FILE syntax dropdown opened white with unreadable grey
text. The `<select>` was themed but its popup is drawn by the browser, which
follows `color-scheme`, and nothing was passing on the theme. VS Code puts the
theme kind on the webview `<body>`, so that is now handed straight to the
browser — which also fixes the other dropdowns and the type-ahead popups.

### Insert on a Mac

From a parallel chat, and folded in here. Apple keyboards have no Insert key,
so the `insert` default was unreachable for the Mac tester — who also had no
obvious way to reach `settings.json` to rebind it. Three things followed: a
**Toggle Insert Mode** command, an **Open Settings** command (linked from the
keyboard map view, which now allows command URIs), and a macOS-only default of
`ctrl+i`.

That default has a limitation worth recording. `platformDefaults()` reads
`process.platform` in the extension host, which is where the keymap is built.
Over Remote-SSH the extension host runs on the remote machine, so a Mac user
connected to a Linux host reports `linux` and silently loses the `ctrl+i`
binding, while a Windows user on a Mac remote would gain it. Not worth fixing
while nobody is running that way — the workaround is a `tn3270.keymap` entry,
which is per-user anyway — but it is the first thing to check if a Mac tester
says insert mode stopped working after moving to a remote workspace.

## What was left on purpose

- DUP / Field Mark keys.
- Host-initiated IND$FILE.
- Per-host macros.
- A chord-capture or editable keymap UI (the setting and Show Keyboard Map
  were enough).
- Title-bar transfer icons, if they still fail to appear; the palette commands
  are the supported path.
- Cut in the right-click menu; a terminal cannot cut host data.
- A font weight in the host profile. Light faces of families that Windows does
  not split into their own family are therefore unreachable by name.
- Fonts the webview's Chromium will not resolve, such as the CaskaydiaCove NF
  families here. They are named differently to what it will match, and guessing
  the other spelling was judged worse than leaving them out.
- Deriving the keymap platform from the UI rather than the extension host; see
  the Remote-SSH note above.

## Where it stands

Current packaged version at the end of this record: **0.11.0**.

`origin` is the BMC GHE repository and the source of truth; the public GitHub
repository is a mirror. The same source builds both flavours, the display name
coming from a branding overlay at package time.

Reference documentation lives beside this file: [README](README.md),
[keymap](docs/KEYMAP.md), [macros](docs/MACROS.md),
[file transfer](docs/TRANSFER.md) and [settings](docs/SETTINGS.md).
