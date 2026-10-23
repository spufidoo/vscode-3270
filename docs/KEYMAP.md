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

Modifiers must appear in that order, and only the ones you need. Any subset is
legal: `f1`, `shift+f1`, `ctrl+shift+f1`, `ctrl+alt+shift+meta+f1`. `meta` is the
Windows key, or Command on a Mac. `shift+ctrl+f1` does nothing, because the
order is wrong.

A key name is the browser's `event.key`, lower-cased, except for the
substitutions in the tables below. The value of a binding is an action
(`aid:`, `nav:`, `local:`, or `macro:`), never a character. There is no chord
that means "type S instead." A one-character macro is the way to type a fixed
string, and binding `a` to it means the A key no longer types A.

### Letters and digits

| Keys | Chord |
| --- | --- |
| A–Z | `a` … `z` |
| 0–9, on the row above the letters | `0` … `9` |

Shift does not make a second chord for a letter. A and a both arrive as `a`, so
bind `a`, not `shift+a`. Binding `a` catches both and replaces typing that
letter. A digit is only the unshifted key. Shift+1 is whatever symbol your
layout produces (`!` on a US keyboard), not `shift+1`.

### Symbols

These are the characters a US keyboard produces. Another layout uses the
character that key produces there, still lower-cased, so a UK Shift+3 is `£`
and not `#`. The space bar is `space`, not a space character.

Unshifted, along a US keyboard: backtick, hyphen, equals, `[` `]`, backslash, `;` `'`, comma, full stop, `/`. The chord is that character. Shifted, the same keys are `~` `!` `@` `#` `$` `%` `^` `&` `*` `(` `)` `_` `+` `{` `}` `|` `:` `"` `<` `>` `?`.

### Editing and navigation

| Key | Chord |
| --- | --- |
| Enter | `enter` |
| Tab | `tab` |
| Backspace | `backspace` |
| Esc | `escape` |
| Insert | `insert` |
| Delete | `delete` |
| Home / End | `home` `end` |
| Page Up / Page Down | `pageup` `pagedown` |
| Arrows | `left` `right` `up` `down` |

`shift+tab`, `shift+left` and the other shifted navigation keys are their own
chords, because Shift does not turn them into a character. `ctrl+enter` and
`alt+delete` likewise.

### Function keys

`f1` … `f12`. Shift, Ctrl, Alt and the Windows key combine in the usual order,
which is how PF13–PF24 are `shift+f1` … `shift+f12`.

`f13` … `f24` are also chords, if the keyboard sends them. Some firmware turns
Fn plus a function key into one of these. Bind `f13`, not `fn+f1`: Fn never
appears in a chord. See [Keys that are not chords](#keys-that-are-not-chords).

### Lock and system keys

| Key | Chord |
| --- | --- |
| Caps Lock | `capslock` |
| Num Lock | `numlock` |
| Scroll Lock | `scrolllock` |
| Pause / Break | `pause` |
| Print Screen | `printscreen` |
| The menu key | `contextmenu` |

Windows may still toggle Caps Lock, Num Lock or Scroll Lock after the session
has handled the key. Vista can suppress that. This extension cannot.

### Modifiers on their own

A modifier tapped by itself is a chord in its own right, named for the side of
the keyboard it is on: `leftctrl` `rightctrl` `leftalt` `rightalt` `leftshift`
`rightshift` `leftmeta` `rightmeta`. This is how a real 3270 keyboard is laid
out, where the keys a PC uses for Ctrl carry ENTER and RESET.

They fire on release, and only when nothing else was pressed in between, so
`rightctrl` still behaves as an ordinary modifier in `rightctrl`+C. Writing them
with a `+`, as in `ctrl+rightctrl`, does nothing.

### The numeric keypad

The keypad is named by the physical key, so a binding does not take the number
row or the main Enter key with it. Num Lock does not matter: keypad 1 is
`numpad1` whether it would otherwise type `1` or move to End.

| Key | Chord |
| --- | --- |
| 0–9 | `numpad0` … `numpad9` |
| Enter | `numpadenter` |
| `+` | `numpadadd` |
| `-` | `numpadsubtract` |
| `*` | `numpadmultiply` |
| `/` | `numpaddivide` |
| `.` | `numpaddecimal` |

The Num Lock key itself is `numlock`, from the table above, not a `numpad` name.
Modifiers combine as usual: `shift+numpad1`, `ctrl+numpadenter`. A keypad key
with no binding keeps its ordinary behaviour. This puts PF1–PF12 on the keypad,
New Line on the keypad Enter, and ENTER on the right Ctrl key:

```json
"tn3270.keymap": {
  "numpad7": "aid:pf1",
  "numpad8": "aid:pf2",
  "numpad9": "aid:pf3",
  "numpad4": "aid:pf4",
  "numpad5": "aid:pf5",
  "numpad6": "aid:pf6",
  "numpad1": "aid:pf7",
  "numpad2": "aid:pf8",
  "numpad3": "aid:pf9",
  "numpad0": "aid:pf10",
  "numpaddecimal": "aid:pf11",
  "numpadenter": "nav:newline",
  "numpadadd": "aid:pf12",
  "rightctrl": "aid:enter"
}
```

`rightctrl` replaces Reset on that key. Reset stays on Ctrl+R. The main Enter
key is still ENTER.

### Wheel chords

`wheelup` `wheeldown` `wheelleft` `wheelright`. Modifiers combine as usual
(`ctrl+wheelup`). What the wheel does with them is under [The wheel](#the-wheel).

### Extra keys

A media or browser key is a chord when the keyboard sends it. The name is
`event.key` lower-cased:

`mediaplaypause` `mediatracknext` `mediatrackprevious` `mediastop`
`volumeup` `volumedown` `volumemute`
`browserback` `browserforward` `browserrefresh` `browserhome`

An ISO keyboard's extra key, the one beside left Shift on many UK and European
layouts, arrives as `intlbackslash` when it is not producing a character.

### Keys that are not chords

**Fn.** The keyboard handles it before Windows sees it. `fn+p` is not a name
you can write. If that combination reaches the session at all, it arrives as
`p`, or as whatever key the firmware substituted, with no record that Fn was
held.

**The four clipboard chords.** `ctrl+c`, `ctrl+x`, `ctrl+v` and `ctrl+a` are
taken before the keymap is consulted, and so are the same four with the Windows
or Command key. They are listed again under [Reserved keys](#reserved-keys).

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
| `wheelup`, `wheeldown` | PF7, PF8 |
| `wheelleft`, `wheelright` | PF10, PF11, if `tn3270.wheel.horizontal` is on |

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
| `ctrl+x` | Cut the marked block: copy it, then blank its input fields |
| `ctrl+v` | Paste into fields |
| `ctrl+a` | Mark the whole screen in block mode, otherwise select all |

Any printable key with no binding and no Ctrl, Alt or Meta is typed into the
current field.

## Mouse

| Action | Result |
| --- | --- |
| Click | Follow a hotspot, or move the cursor |
| Ctrl+click (Cmd+click on macOS) | Move the cursor and run `tn3270.clickMacro`, if set |
| Double-click | Move the cursor and send ENTER |
| Drag | Select text |
| Shift+click | Pull the near corner of a marked block (block mode) |
| Right-click | Copy, Cut, Paste and Mark all menu |
| Wheel up / down | Move the cursor to the pointer and send PF7 / PF8 |
| Wheel left / right | PF10 / PF11, if `tn3270.wheel.horizontal` is on |

### Hotspots

Text an application has written into a **protected** field can be clicked:
`F3=Exit` sends PF3, and an `http://` or `https://` address opens in a browser.
The pointer turns into a hand over one, so you can tell before you click.

A word counts as a key if it reads `PF3`, `F3`, `F3=Exit` or `3=Exit`, for keys 1
to 24. A bare number does not: `3` on its own is data. Only protected fields are
considered, so a click in something you can type into always just moves the
cursor, whatever it happens to contain.

`tn3270.hotspots` turns this off, or requires a double-click instead — in which
case a double-click away from a hotspot still sends ENTER as usual. Ctrl+click
belongs to `tn3270.clickMacro` and is never taken by a hotspot.

### The wheel

A 3270 screen has no scrollback, and the view always sizes the whole screen to
fit the panel, so there is nothing for a wheel to scroll. It sends an AID
instead, as Vista and PCOMM do: PF7 and PF8, the keys that page in ISPF, SDSF
and File-AID.

The chords are `wheelup`, `wheeldown`, `wheelleft` and `wheelright`, so they can
be rebound like any other. Modifiers work too, if your mouse sends them:

```json
"tn3270.keymap": {
  "wheelup": "aid:pf19",
  "ctrl+wheelup": "nav:up",
  "wheeldown": ""
}
```

Three things happen before an AID is sent:

- **The cursor moves to the cell under the pointer.** A split ISPF screen
  therefore scrolls the half you are pointing at, whichever half you were
  typing in.
- **Motion is accumulated.** A notched wheel sends one large event per notch,
  while a free-spinning wheel or a trackpad sends a stream of small ones; both
  have to travel the same distance to send one AID. Reversing direction starts
  the count again.
- **Nothing is sent while the keyboard is locked.** If the status line shows
  `X SYSTEM` the host is still working, and queued AIDs would overshoot by
  however far the wheel spun in the meantime, so the gesture is dropped rather
  than banked.

Horizontal is off until you set `tn3270.wheel.horizontal`. PF10 and PF11 shift
left and right in ISPF but mean nothing in particular elsewhere, and a tilt
wheel is easy to catch by accident. Binding `wheelleft` or `wheelright` in
`tn3270.keymap` works whether or not the setting is on, since overrides are
merged over the defaults.

The right-click menu is the view's own. VS Code's webview menu builds Cut, Copy
and Paste from Electron editing roles, which act on a text selection and an
editable target; block mode suppresses the first and a grid of `div`s is never
the second, so those entries do nothing here. Ours copies the marked block and
pastes through the extension host, which is the only side able to read the
clipboard. Cut copies the block and then blanks the input fields inside it,
leaving protected text alone; it needs a marked rectangle and is refused while
the keyboard is locked.

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
