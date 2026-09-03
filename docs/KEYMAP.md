# Keyboard map

Bindings apply while a 3270 tab has focus. Run **3270 Terminal: Show Keyboard Map**
from the command palette to see the ones actually in effect, including your own
overrides.

## Changing bindings

Run **3270 Terminal: Open Settings** from the command palette and search for
`keymap`, or add `tn3270.keymap` to your user `settings.json` (see
[SETTINGS.md](SETTINGS.md) for how to open it on your platform). The keyboard
map view also has an **edit keymap** link. Each entry maps a chord to an action:

```json
"tn3270.keymap": {
  "escape": "aid:pa2",
  "ctrl+shift+e": "nav:eraseinput",
  "shift+escape": "local:reset",
  "ctrl+l": "macro:listcat",
  "pause": ""
}
```

Entries are merged over the defaults, so list only what differs. An empty string
removes a default, which is how you hand a chord back to the editor when the two
are fighting over it. Open sessions apply changes as soon as you save; no
reconnect or reload.

## Chord syntax

A chord is modifiers followed by a key name, all lower case:

```
ctrl+alt+shift+meta+<key>
```

Modifiers must appear in that order, and only the ones you need. The key name is
the browser's `event.key` lower-cased, with these substitutions:

| Key | Name |
| --- | --- |
| Arrow keys | `left` `right` `up` `down` |
| Space bar | `space` |
| Page Up / Page Down | `pageup` `pagedown` |
| Esc | `escape` |

Everything else is the obvious lower-case name: `a`, `7`, `f9`, `enter`, `tab`,
`home`, `end`, `insert`, `delete`, `backspace`, `pause`.

Use `shift+` only for keys where Shift does not already change the character.
`shift+f3` and `shift+tab` are right; a shifted letter arrives as that letter, so
bind `a`, not `shift+a`.

### Modifiers on their own

A modifier tapped by itself is a chord in its own right, named for the side of
the keyboard it is on: `leftctrl` `rightctrl` `leftalt` `rightalt` `leftshift`
`rightshift` `leftmeta` `rightmeta`. This is how a real 3270 keyboard is laid
out, where the keys a PC uses for Ctrl carry ENTER and RESET.

They fire on release, and only when nothing else was pressed in between, so
`rightctrl` still behaves as an ordinary modifier in `rightctrl`+C. Writing them
with a `+`, as in `ctrl+rightctrl`, does nothing.

## Actions

### `aid:` — send an AID and unlock

An AID, or Attention IDentifier, is the byte a 3270 sends to say *"I am done,
here is the screen."* It is the only thing that talks to the host. Everything
else you do at a 3270 — typing, tabbing between fields, erasing — happens
entirely in the terminal's own buffer, and the host has no idea it is
happening. Nothing reaches it until you press an AID key.

Pressing one sends the AID byte, the cursor position and the contents of every
field you changed, all in one go, and then locks the keyboard: the status line
shows `X SYSTEM` and your typing is ignored until the host replies with a new
screen. That lock is not the emulator being slow, it is how the protocol works.

Which AID you send is how the host knows what you *meant* by the same screen
full of data. A program sees ENTER and PF3 as different requests even though
the fields are identical, which is why 3270 applications put a legend like
`F3=Exit F7=Up F8=Down` along the bottom.

| Action | Meaning |
| --- | --- |
| `aid:enter` | ENTER. Submit the screen |
| `aid:pf1` … `aid:pf24` | Program function 1–24. The application decides what each one means |
| `aid:pa1` `aid:pa2` `aid:pa3` | Program attention 1–3. Sends the AID *without* your field changes; usually PA1 means cancel and PA2 means reshow |
| `aid:clear` | CLEAR. Blanks the screen buffer and tells the host to rebuild it |
| `aid:attn` | ATTN. An interrupt rather than a submission — under TSO this is what breaks into a running program |

Because these are the keys that unlock a locked keyboard, a macro step that
follows one should be `[wait]`; see [MACROS.md](MACROS.md).

### `nav:` — move the cursor or edit the screen

Local to the screen buffer; nothing is sent to the host. These decide what the
next AID will carry.

| Action | Meaning |
| --- | --- |
| `nav:left` `nav:right` `nav:up` `nav:down` | Cursor one position |
| `nav:home` | First input field |
| `nav:end` | End of the current field |
| `nav:wordleft` `nav:wordright` | Previous / next word |
| `nav:tab` `nav:backtab` | Next / previous input field |
| `nav:newline` | First field on the next line |
| `nav:backspace` | Delete the character to the left |
| `nav:delete` | Delete the character under the cursor |
| `nav:eraseeof` | Erase from the cursor to the end of the field |
| `nav:eraseinput` | Erase every unprotected field |

### `local:` — handled by the view

| Action | Meaning |
| --- | --- |
| `local:insert` | Toggle insert mode |
| `local:reset` | Leave insert mode and clear the status message |
| `local:markleft` | Extend the block selection left |
| `local:markright` | Extend the block selection right |
| `local:markup` | Extend the block selection up |
| `local:markdown` | Extend the block selection down |
| `local:markclear` | Drop the block selection |

Reset sends nothing to the host, so it clears the view's own state but not a lock
the host is holding. If the status line shows `X SYSTEM`, the host has the
keyboard and only the host can give it back.

#### Marking a block from the keyboard

`shift+left`, `shift+right`, `shift+up` and `shift+down` mark a rectangle without
the mouse; `ctrl+c` copies it and `escape` drops it.

The first press anchors the block at the 3270 cursor. After that only the far
corner moves, so the rectangle can be drawn in any direction and pulled back
through itself. **The 3270 cursor does not move while you mark**, and nothing is
sent to the host, so copying never costs you your place in a field. Any other
key drops the mark, which is why you cannot type in the middle of marking.

Unlike the mouse, this works whichever way `tn3270.selection` is set: that
setting governs the mouse, while the keyboard always marks a rectangle. It also
composes with the mouse — mark with the arrows, then Shift+click to pull a corner
somewhere distant.

### `macro:` — play a named macro

`macro:<name>` runs an entry from `tn3270.macros`. See
[MACROS.md](MACROS.md).

## Defaults

| Chord | Action |
| --- | --- |
| `f1` … `f12` | PF1–PF12 |
| `shift+f1` … `shift+f12` | PF13–PF24 |
| `enter` | ENTER |
| `alt+1` `alt+2` `alt+3` | PA1, PA2, PA3 |
| `alt+c`, `pause` | CLEAR |
| `alt+a` | ATTN |
| `tab`, `shift+tab` | Tab, backtab |
| `left` `right` `up` `down` | Cursor movement |
| `home` | First input field |
| `end` | End of field |
| `alt+left` `alt+right` | Word left, word right |
| `backspace` `delete` | Edit |
| `ctrl+home`, `shift+end` | Erase to end of field |
| `alt+delete` | Erase input |
| `ctrl+enter` | New line |
| `insert` | Toggle insert mode |
| `ctrl+i` | Toggle insert mode (macOS default; most Mac keyboards have no Insert key) |
| `ctrl+r`, `rightctrl` | Reset |
| `shift+left` `shift+right` `shift+up` `shift+down` | Extend the block selection |
| `escape` | Drop the block selection |

Defaults follow [zti](https://github.com/IBM/tnz), the terminal front end shipped
with tnz, wherever the two overlap.

## Macros

Named sequences live in `tn3270.macros` and are played with `macro:<name>` or
**3270 Terminal: Run Macro**. The full marker list, execution order, and examples
are in [MACROS.md](MACROS.md).

## Reserved keys

These are handled before the keymap is consulted and cannot be rebound:

| Chord | Behaviour |
| --- | --- |
| `ctrl+c` | Copy when text is selected, ATTN when it is not |
| `ctrl+v` | Paste into fields |
| `ctrl+x` `ctrl+a` | Left to the editor |

Any printable key with no binding and no Ctrl, Alt or Meta is typed into the
current field.

## Mouse

| Action | Result |
| --- | --- |
| Click | Move the cursor |
| Ctrl+click (Cmd+click on macOS) | Move the cursor and run `tn3270.clickMacro`, if set |
| Double-click | Move the cursor and send ENTER |
| Drag | Select text |
| Shift+click | Pull the near corner of a marked block (block mode) |
| Right-click | Copy, Paste and Mark all menu |

The right-click menu is the view's own. VS Code's webview menu builds Cut, Copy
and Paste from Electron editing roles, which act on a text selection and an
editable target; block mode suppresses the first and a grid of `div`s is never
the second, so those entries do nothing here. Ours copies the marked block and
pastes through the extension host, which is the only side able to read the
clipboard. There is no Cut, as a terminal cannot cut host data.

## Troubleshooting

**A chord does nothing.** The editor or the window manager may be claiming it
before the webview sees it. Check Keyboard Shortcuts for a conflicting VS Code
command, or pick a different chord. `alt+` chords open menus on some Linux
desktops.

**A chord does the wrong thing.** Open **Show Keyboard Map** and confirm your
override is listed. A typo in the chord adds a new binding rather than replacing
one, so the default stays in place.

**A chord does the 3270 thing *and* a VS Code thing.** Both see the same key
press: the webview handles it, and VS Code separately resolves its own
keybindings from it, so F5 used to send PF5 and start the debugger. Every
default chord that VS Code also binds — F1 to F12 with and without Shift,
`alt+1` to `alt+3`, `alt+a`, `alt+c`, `alt+left`, `alt+right`, `alt+delete`
and `ctrl+r` — is claimed for `tn3270.session.keyGuard`, a command that does
nothing, whenever a 3270 tab has focus. That leaves the webview as the only
handler. One consequence: F1 no longer opens the command palette in a session
tab, because it is PF1. Ctrl+Shift+P still does.

A chord you add yourself is not covered, so claim it the same way in Keyboard
Shortcuts (`keybindings.json`):

```json
{
  "key": "ctrl+shift+e",
  "command": "tn3270.session.keyGuard",
  "when": "activeWebviewPanelId == tn3270.session"
}
```

`tn3270.sessionActive` is also available as a `when` clause. It is true while a
session tab is open rather than only while it has focus, so prefer
`activeWebviewPanelId` for guards.

**An action name is rejected.** Names are case-sensitive and take the form
`kind:name` from the tables above. An unknown `aid:` or `nav:` name surfaces as
an error on the status line when you press the key.
