# 3270 Terminal

Native 3270 terminal view for VS Code and Cursor. Hosts live in the left activity bar; sessions open as editor tabs with a fixed 3270 grid (not a VT terminal).

The TN3270 protocol is handled by [IBM tnz](https://github.com/IBM/tnz) in a Python sidecar.
tnz and ebcdic are packaged inside the extension, so there is nothing to pip install.

## Prerequisites

- Python 3.10 or later
- VS Code or Cursor 1.85+

Both are pure Python, so one `.vsix` works on every platform. The packaged copy is
used ahead of anything in site-packages, so a stale tnz on the machine cannot
interfere. Point `tn3270.libraryPath` at a local IBM/tnz checkout to override it
while developing.

## Setup

```console
cd vscode-3270
npm install
npm run compile
```

Press **F5** (Run Extension) from this folder, or install the folder as an unpacked extension.

Open the **3270 Terminal** icon in the activity bar → **Add Host** → Connect.

## Host profiles

**Add Host**, or **Edit Host** from a host's context menu, opens a settings tab with
every field on one page. Ctrl+S saves. Profiles are stored in `tn3270.hosts` (user
settings), so they can also be edited as JSON.

| Field | Meaning |
| --- | --- |
| host / port | A new profile starts on 23; switching the transport to TLS moves it to 992 |
| secure / verifyCert | TLS and certificate checking. New profiles are plain telnet. A TLS host on a non-standard port still needs Secure on; a mismatch drops the session immediately |
| psSize | Any `rowsxcols`, not just the standard models |
| codePage | EBCDIC code page. Defaults to `037` |
| luName / tn3270e | LU name requires TN3270E |
| secLevel | Set to `1` for older TLS stacks (`ZTI_SECLEVEL`) |
| extendedColor | Advertise colour capability to the host |
| blink | Render the blink highlight instead of ignoring it |
| colors | Per-host palette |
| IND$FILE syntax | TSO or CMS. Empty follows `tn3270.transfer.syntax` |
| Default options / Idle timeout | Per-host transfer defaults; empty follows the `tn3270.transfer.*` settings |

Passwords are not stored. Log on in the 3270 screen.

### Screen size

`psSize` must match the emulator that started the session, because the host formats
for the screen size in its LU definition and does not renegotiate it when resuming
one. The columns have to match exactly, since a buffer address is mapped to a row
and column using the column count; the rows may be higher, which just leaves blank
lines at the bottom. Any size is accepted, not only the standard models — a PCOMM
session showing `30x133` needs exactly `30x133` here.

If the size is too small, the host writes past the end of the buffer and tnz drops
the session. The reported address is the *first* one past the end, so it is only a
lower bound and raising the size one model at a time will keep failing.

## Sessions

Each connected host gets a tab. Closing it disconnects; connecting again from the
sidebar reopens it. A session tab left open across a window reload comes back and
reconnects itself, so a 3270 tab survives **Developer: Reload Window** the way an
editor does — it does not resume the host session, it logs on again.

All sessions share one Python sidecar process. If it stops, the open tabs say
`SIDECAR STOPPED` on the status line and connecting any host starts it again.

## Keys (3270 tab focused)

| Key | Action |
| --- | --- |
| F1–F12, Shift+F1–F12 | PF1–PF24 |
| Enter | ENTER |
| Alt+1 / Alt+2 / Alt+3 | PA1 / PA2 / PA3 |
| Alt+C or Pause | CLEAR |
| Alt+A or Ctrl+C (no selection) | ATTN |
| Tab / Shift+Tab | Next / previous field |
| Arrows, Home, End | Cursor movement |
| Alt+Left / Alt+Right | Word left / word right |
| Backspace, Delete | Edit |
| Ctrl+Home or Shift+End | Erase to end of field |
| Alt+Delete | Erase input |
| Ctrl+Enter | New line |
| Insert (Ctrl+I on macOS) | Toggle insert |
| Ctrl+R, Right Ctrl | Reset |
| Click / double-click | Cursor / cursor + ENTER |
| Right-click | Copy, Paste and Mark all menu |
| Drag | Mark a rectangle (block) or a run of text (stream) |
| Shift+arrows | Mark a rectangle from the keyboard |
| Escape | Drop the marked block |
| Ctrl+C | Copy the marked block, else ATTN |
| Ctrl+A | Mark the whole screen (block mode) |
| Ctrl+V | Paste into fields |

Every binding can be changed with the `tn3270.keymap` setting, and open sessions
pick up edits immediately. **3270 Terminal: Show Keyboard Map** lists what is in
effect; **3270 Terminal: Open Settings** opens the settings UI filtered to this
extension; **3270 Terminal: Toggle Insert Mode** switches insert/replace without
needing a key binding.

See [docs/KEYMAP.md](docs/KEYMAP.md) for the chord syntax, every action name,
and the keys that are reserved.

The webview scales the font so the whole 3270 screen fits. Resizing the editor does not change rows×cols.

## Selection and copy

`tn3270.selection` chooses how selecting works:

- **block** (default) marks a rectangle of rows and columns, like Vista TN3270
  and PCOMM. Drag to mark, Shift+click to extend, Ctrl+A to mark the screen, and
  Ctrl+C to copy the rectangle. A plain click still positions the cursor.
- **stream** selects a linear run of characters like a text editor, which also
  allows dragging text out to another app and the webview's own right-click Copy.

Either way Ctrl+C copies and Ctrl+V pastes, and copying clears the mark. Ctrl+C
with nothing marked is still ATTN. Non-display fields (passwords) read as blanks
in both modes, so they can never be copied.

Shift+arrows mark a rectangle without touching the mouse, anchored where the 3270
cursor is, and Escape drops it. The cursor itself stays put and nothing goes to
the host, so copying never loses your place in a field. This works in both modes:
`tn3270.selection` governs the mouse, while the keyboard always marks a rectangle.

Right-click offers Copy, Paste and Mark all. This is the view's own menu rather
than VS Code's, whose Cut/Copy/Paste entries are wired to a text selection and an
editable target and so do nothing on a 3270 screen. There is no Cut: cutting host
data is not a thing a terminal can do.

## Macros

**3270 Terminal: Run Macro**, or a keymap chord `macro:<name>`, plays a named
entry from `tn3270.macros`. A **tape** is text with `[action]` markers, for
example `=3.4[enter][wait]MY.JCL[enter]`. A **script** is
`{ "script": "startlpar" }`, a Python file in the macros folder that can read
the screen and ask as it runs. **Open Macros Folder** creates that folder.
Ctrl+click runs `tn3270.clickMacro` if set.

See [docs/MACROS.md](docs/MACROS.md) for tape markers, the script API, and
examples.

## File transfer

**3270 Terminal: Download File from Host** and **Upload File to Host**, or the
buttons on the session tab, transfer files with IND$FILE. The session must be
at a ready prompt (TSO READY, ISPF option 6, CMS) because the command is typed
at the cursor.

Text transfers use `ASCII CRLF`, which tnz translates itself rather than
trusting the host's tables; binary copies bytes unchanged. The screen freezes
for the duration and shows `FILE TRANSFER IN PROGRESS`, since tnz owns the
session while a transfer runs.

Whether options need a parenthesis depends on the host, so the **File transfer**
section of the host settings tab can pin the syntax, the default options and the
idle timeout per profile. That matters as soon as you reach both TSO and VM
systems, since one workspace setting cannot be right for both. Leave the fields
empty to follow the `tn3270.transfer.*` settings.

See [docs/TRANSFER.md](docs/TRANSFER.md) for host file name formats, RECFM and
LRECL options, timeouts, and what the failure messages mean.

## Colour

Basic colours come from the field attribute (protected/intensified). When the host
sends extended colour orders, tnz switches the screen into extended colour mode and
the full seven-colour palette plus reverse video and underscore are used. The status
line shows `BASE COLOR` or `EXT COLOR` so you can tell which set is in play.

The **Appearance** section of the host settings tab controls this:

- **Extended colour** advertises colour capability in the 3270 query reply, which is
  what invites the host to send extended colour orders. Turning it off keeps the
  screen on basic field colours, which is useful when a host renders badly in colour.
- **Render the blink attribute** draws blinking fields instead of showing them as
  normal text.
- The palette sets all eight 3270 colour values plus the background, with a live
  preview. Saving repaints any open session for that host immediately; the extended
  colour toggle takes effect on the next connect.

## Font

`tn3270.fontFamily` sets the font for every session:

```json
"tn3270.fontFamily": "Cascadia Mono"
```

The **Font** box in the **Appearance** section of the host settings tab overrides
that for one profile, so a single host can look different. Leave the box empty to
follow the setting; the placeholder shows which font that currently is. Type a font
name, or a comma-separated list, and the preview below the palette shows it.
Saving repaints any open session for that host immediately, and changing the
setting repaints every session that has not overridden it.

With neither set you get the built-in stack of Lucida Console, Cascadia Mono,
Consolas and Courier New.

The Font box suggests the monospaced fonts installed on your machine. The names
come from the installed font families on Windows, `fc-list` on Linux and the
font folders on macOS, and each one is then measured in the view itself:
anything that does not resolve, or that is not fixed pitch, is left out.

Click the box to see the list, or type to filter it; arrow keys and Enter pick a
row, and each row is drawn in its own font. It is a suggestion list, not a
restriction, so a name that is not offered can still be typed.

They are family names, not face names, which matters for fonts with many
weights. Windows lists the Light face of SauceCodePro Nerd Font Mono as
`Sauce Code Pro Light Nerd Font Complete Mono`, but the family a browser can
match is `SauceCodePro Nerd Font Mono`, and that is what you will be offered. It is a suggestion list,
not a restriction — you can still type any name, including a comma-separated
list. The filter looks at the last name in such a list, so a stack can be built
up one font at a time.

The built-in stack is always appended to whatever you name, so a font the machine
does not have falls back to a monospace rather than to something proportional. The
editor also warns when the font you typed does not appear to be installed, since
the fallback is otherwise silent.

It must be a monospaced font. Columns sit on a fixed pitch measured from the
character width, so a proportional font leaves the grid ragged and the cursor in the
wrong place. The size is not configurable: it grows to make the full 80 (or however
many) columns fill the panel, so resize the pane or drag the tab out to a bigger
window to get bigger text.

## Settings

Every `tn3270.*` setting is listed in [docs/SETTINGS.md](docs/SETTINGS.md),
with what it does, its default, and where it applies.

Settings used to be `tnzView.*`. The first run after upgrading copies them, and
your macros folder, to the new names, then offers to tidy the old keys away.

## Builds

The source carries no product name. A build takes one from `branding/`, which is
overlaid on the manifest only while the `.vsix` is being made:

```console
npm run package        # 3270 Terminal      -> vscode-3270-<version>.vsix
npm run package:bmc    # BMC AMI DevX 3270  -> vscode-3270-bmc-<version>.vsix
```

Both produce the same extension id, so they are the same extension wearing a
different label. Add a flavour by dropping another JSON file in `branding/`.

## Layout

```
src/           TypeScript extension (tree, sidecar client, session + settings tabs)
media/         3270 webview and host settings CSS/JS
sidecar/       Python JSON-lines process wrapping tnz.Tnz
docs/          Settings, keyboard map, macros, and file transfer references
examples/      Sample session scripts (copied into the macros folder on first open)
branding/      Display names applied at package time
scripts/       Build helpers
HISTORY.md     How the extension was built (this chat)
```

Apache-2.0. See `NOTICE` for the tnz attribution.
