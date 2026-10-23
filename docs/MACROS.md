# Macros

A macro is either a **tape** (text with `[action]` markers) or a **script** (a
Python file that can read the screen and ask questions as it runs). Define
both in `tn3270.macros` and play them from a key or from **3270 Terminal: Run
Macro**. Tapes and scripts share the picker; they do not replace each other.

```json
"tn3270.macros": {
  "listcat": "LISTC[enter]",
  "back to primary": "[pf3][pf3][pf3]",
  "edit jcl": ["=3.4[enter][wait]", "MY.JCL[enter]"],
  "logon": "[home][prompt:Userid][enter][wait][password:Password][enter]",
  "startlpar": { "script": "startlpar" }
},
"tn3270.keymap": {
  "ctrl+l": "macro:listcat",
  "ctrl+alt+l": "macro:logon"
},
"tn3270.clickMacro": "startlpar"
```

## Tapes

A tape types, moves the cursor, sends AID keys, waits for the keyboard to
unlock, and can ask you for values *before* it starts. It is not a program:
there is no `if`, and `[wait]` does not look at the screen text. For those,
use a [script](#scripts).

A 3270 session tab must be focused.

| How | What happens |
| --- | --- |
| Command palette → **3270 Terminal: Run Macro** | Pick a name from `tn3270.macros` |
| A keymap chord `macro:<name>` | Same, without the picker |
| The 3270 tab's command palette while that tab is active | Same as Run Macro |

If no macros are defined, Run Macro offers to open the `tn3270.macros` setting.
If the named macro is missing or the markers do not parse, a toast names the
problem and nothing is typed.

Open **Keyboard Shortcuts** if a chord you bound never fires: the editor or
another extension may be claiming it first. See [KEYMAP.md](KEYMAP.md).

## How to define one

User `settings.json`, under `tn3270.macros`. Each key is the name you pick in
Run Macro and the name you put after `macro:` in the keymap.

The value is either a string, or an **array of strings joined with no
separator**. The array is only there so a long sequence stays readable; it is
not a list of independent macros.

```json
"tn3270.macros": {
  "one line": "LISTC[enter]",
  "split only for reading": [
    "=3.4[enter][wait]",
    "MY.JCL[enter][wait]",
    "S[enter]"
  ]
}
```

Anything outside `[...]` is typed into the field the cursor is in, exactly as
if you had pressed those keys. Markers are substituted as the steps below.

`[[` is a literal `[`. There is no escape for `]`.

Marker names are case-insensitive (`[Enter]` and `[enter]` are the same).
Labels on `[prompt:]` and `[password:]` keep the capitalisation you wrote.

## Execution

1. The source is parsed. A bad marker aborts here; the session is untouched.
2. Every `[prompt:]` and `[password:]` is asked, in order, **before** the first
   character is typed. Dismissing any box with Escape abandons the whole macro.
3. The resulting steps are replayed on the session thread as one batch, so your
   keystrokes cannot interleave with it.
4. If a step fails or a `[wait]` times out, the macro stops there. The status
   line names the step number.
5. Focus returns to the 3270 when the prompts (if any) are done.

Because the replay is one batch, a prompt cannot depend on what the host showed
after an ENTER. Ask everything you will need up front, then type.

## Primitives

### Literal text

Typed into the current input field with the session's insert/replace mode.

| Example | Result |
| --- | --- |
| `LISTC` | Types `LISTC` |
| `TSO LISTA` | Types that, including the space |
| `LOGON `[prompt:Userid] | Types `LOGON `, then the answer |

Protected fields reject the key, same as typing by hand. Put `[home]` or
`[tab]` first if the cursor might not be in the field you mean.

### AID keys — talk to the host

Each of these sends an AID, then locks the keyboard until the host replies.
Follow one with `[wait]` unless it is the last step.

| Marker | AID |
| --- | --- |
| `[enter]` | ENTER |
| `[pf1]` … `[pf24]` | PF1–PF24 |
| `[pa1]` `[pa2]` `[pa3]` | PA1–PA3 (no field changes) |
| `[clear]` | CLEAR |
| `[attn]` | ATTN |

There is no `[reset]` here. Reset is a local view action (`local:reset` on a
key). It is not a macro step, and it would not clear `X SYSTEM` anyway — only
the host can unlock that.

### Cursor and edit keys — local to the buffer

Nothing is sent to the host. These change what the next AID will carry.

| Marker | Meaning |
| --- | --- |
| `[left]` `[right]` `[up]` `[down]` | Cursor one position |
| `[home]` | First input field |
| `[end]` | End of the current field |
| `[wordleft]` `[wordright]` | Previous / next word |
| `[tab]` `[backtab]` | Next / previous input field |
| `[newline]` | First field on the next line |
| `[backspace]` | Delete the character to the left |
| `[delete]` | Delete the character under the cursor |
| `[eraseeof]` | Erase from the cursor to the end of the field |
| `[eraseinput]` | Erase every unprotected field |

### Wait for the host

| Marker | Meaning |
| --- | --- |
| `[wait]` | Wait until the keyboard unlocks, up to 10 seconds |
| `[wait:5000]` | The same, timeout in milliseconds |

Use this after every AID that is not the last step. The wait returns as soon as
the host unlocks; it does **not** look at the screen text. A password panel and
an error panel both unlock the keyboard, and `[wait]` cannot tell them apart.

If the host never unlocks, the macro stops with a timeout on that step.

### Fixed delay

| Marker | Meaning |
| --- | --- |
| `[pause:500]` | Sleep 500 milliseconds, host or not |

`[pause]` with no time is an error. Prefer `[wait]` after AIDs. `[pause]` is
for hosts that unlock the keyboard before the screen you care about has
finished painting — a last resort, not a substitute for `[wait]`.

### Ask, then type

| Marker | Meaning |
| --- | --- |
| `[prompt:Label]` | Input box; answer is typed as text |
| `[prompt]` | Same, label defaults to `Value` |
| `[password:Label]` | Masked box; answer is not remembered |
| `[password]` | Same, label defaults to `Password` |

The label is the prompt on the box. A colon in the label is allowed
(`[prompt:User ID: TSO]`). Leading and trailing spaces around the label are
stripped.

Answers to `[prompt:...]` with the **same label** are offered back as the
default next time in this editor session. That lives only in memory; it is not
written to settings. `[password:...]` answers are never kept, not even for the
next run.

Never put a password in `tn3270.macros` itself. Settings files are plain text
and sync between machines. `[password:...]` exists so you do not have to.

### Literal `[`

| Marker | Meaning |
| --- | --- |
| `[[` | One `[` character in the typed text |

## What is not a primitive

These look as if they might work and do not:

| You might write | What actually happens |
| --- | --- |
| `[reset]` `[insert]` | Parse error — not AID or nav names |
| `[wait:Password]` | Parse error — wait takes milliseconds |
| `[if]` `[onscreen:…]` | Parse error |
| A password in the JSON | Typed in the clear, stored in settings, synced |

Keymap-only actions (`local:insert`, `local:reset`) have no macro spelling.

## Examples

**One TSO command at READY**

```json
"lista": "TSO LISTA[enter]"
```

Drop the `TSO ` prefix if you are already at the READY prompt rather than an
ISPF command line.

**ISPF jump, then wait, then type**

```json
"edit jcl": "=3.4[enter][wait]MY.JCL[enter]"
```

Without `[wait]`, `MY.JCL` is typed while the keyboard is still locked and the
step fails with Input Inhibit.

**Leave ISPF**

```json
"back to primary": "[pf3][wait][pf3][wait][pf3]"
```

**Logon, userid and password asked, nothing stored**

```json
"logon": "[home][prompt:Userid][enter][wait][password:Password][enter]"
```

`[home]` pins the cursor to the first field. Both boxes appear before anything
is typed. Escape on the password box types nothing at all.

**LOGON command with the userid in the same field**

```json
"logon tso": "LOGON [prompt:Userid][enter][wait][password:Password][enter]"
```

**Clear a field, then type**

```json
"replace field": "[home][eraseeof]NEW.NAME[enter]"
```

**A PF key, then another**

```json
"split": "[pf2][wait]"
```

## Troubleshooting

**`macro "…": [foo] is not a known action`.** The name is not in the tables
above. Check spelling (`[password]`, not `[passwrod]`). Reload the window if
you just installed a build that added `[prompt]` / `[password]` — an older
extension reports those as "does not take a value".

**`[wait]` times out.** The host never unlocked. You may not have been at a
screen that accepts the AID you sent, or the host is slow: try `[wait:30000]`.

**Input Inhibit on a later step.** An AID was not followed by `[wait]`, so the
macro typed while the keyboard was locked.

**The typed text landed in the wrong field.** The tape uses wherever the cursor
is. Start with `[home]` or `[tab]`.

**I have to click the 3270 to type afterwards.** That was a bug in older
builds; current ones return focus after Run Macro and after prompts. Reload
the extension if you still see it.

**The password appeared on the screen.** The host field is not a 3270
non-display field. The sidecar only blanks fields the host marked hidden;
`[password:]` only masks the *box you type into*.

## Scripts

A script is a Python file that talks to the live session: it can read the
screen, branch, and ask questions *after* ENTER. Tape macros keep working
unchanged.

### Where the file lives

**3270 Terminal: Open Macros Folder** creates (and reveals) the macros directory
under this editor's global storage, and copies `startlpar.py` there the first
time if it is missing.

| Setting | File |
| --- | --- |
| `{ "script": "startlpar" }` | `<macros folder>/startlpar.py` |
| `{ "script": "startlpar.py" }` | Same |
| `{ "script": "C:\\\\Users\\\\…\\\\mine.py" }` | That path |

A bare name may only contain letters, digits, `.`, `_` and `-`. Relative paths
with `..` are rejected.

The folder is per machine and per editor. It is not `settings.json` and it is
not git. Do not put passwords in the `.py` file.

`tn3270.clickMacro` is the name of a macro (tape or script) to run on
Ctrl+click (Cmd+click on macOS). The click is stored first, so `word_at(click)`
sees the LPAR you pointed at.

### How a script runs

The file is executed on the session thread with a small API (below) and a
restricted `__builtins__`. Top-level `return` stops the script, as does Escape
on an `ask` / `ask_password` box. Errors show on the status line, naming the
line number in your file. `print` goes to the 3270 log, not into the JSON pipe.

### What the script namespace has

Everything in the API table, plus these builtins and nothing else:

```
abs bool dict enumerate float int isinstance len list max min
print range str tuple zip  True False None
```

That has consequences worth knowing before you write anything long:

- **No `import`.** There is no `__import__`, so `import re` fails. Screen text
  is a plain `str`, so `find`, `split`, `startswith` and slicing cover most of
  what a macro needs.
- **No exception classes.** `Exception`, `ValueError` and friends are not
  defined, so `try:` / `except ValueError:` raises `NameError` on the except
  line rather than catching anything. Test with `if` instead.
- **No `open`, no file or network access.** A macro drives the session; use
  [file transfer](TRANSFER.md) to move data.

These restrictions are a guardrail against a macro doing something surprising
by accident, **not** a security boundary. Python offers no real way to sandbox
`exec`, and a determined script can reach anything the editor can. Only run
scripts you wrote or trust, the same as a Vista `.mac`.

### API

| Function | Meaning |
| --- | --- |
| `unlocked()` | Keyboard is not held by the host |
| `wait_unlock(seconds=10)` | Wait until unlock; raises if the host never does |
| `pause(seconds)` | Sleep, host or not |
| `type(text)` | Type into the current field |
| `enter()` `clear()` `attn()` `pf1()`…`pf24()` `pa1()`…`pa3()` | AID |
| `home()` `tab()` `eraseeof()` and the other nav names | Cursor / edit |
| `on_screen("text")` | True if that string is on the screen *now* |
| `wait_for("a", "b", seconds=10)` | Wait for one of the fragments; returns the one that matched, or `""` on timeout |
| `screen(row, col, length)` | Slice, 1-based row and column |
| `word_at(click)` | Non-blank run at that cell (or at the cursor) |
| `click.row` `click.col` | Last click, or the cursor if there was none |
| `ask(prompt, default=None, max=None)` | Input box; Escape stops the script |
| `ask_password(prompt)` | Masked box; not stored |
| `warn(message)` | Notification plus a line on the status bar; the script carries on |
| `trace(...)` | Write a line to the 3270 output channel |
| `trace_screen()` | Write the whole screen to the output channel |

Rows and columns are 1-based, like a 3270. `wait_unlock` takes **seconds**,
not milliseconds (tapes use milliseconds in `[wait:5000]`).

`warn` does not block. It raises a VS Code notification and puts the text on the
session status line, so follow it with `return` if the script should stop.

### Waiting for a screen, not for an unlock

`wait_unlock` returns as soon as the host hands the keyboard back, and that first
reply is often not the panel you want. A TSO logon answers in a fraction of a
second and only then paints the password panel, so `on_screen` immediately after
`wait_unlock` tests the wrong screen and the macro takes its error branch.

Wait for the content instead, and let it tell you which screen arrived:

```python
seen = wait_for("Password  ===>", "not authorized to use TSO", seconds=20)
if seen == "not authorized to use TSO":
    warn("Not authorised")
    return
if not seen:
    trace_screen()
    warn("Timed out waiting for the logon panel")
    return
```

This is Vista's `Wait(n, condition)`. Order matters less than specificity: a
fragment that also appears in a header will match the wrong screen, so test the
vague ones only after the specific ones have failed. Use `pause()` only when
nothing on the screen marks the moment you need.

### Tracing a script

Set `tn3270.macroTrace` to `true` and every step is logged to the **3270**
output channel, which opens by itself when a traced macro starts:

```
[LPAR] macro startlpar: start (…\macros\startlpar.py)
[LPAR] ask('Enter LPAR') -> 'LPAR'
[LPAR] type('LPAR USERID') [1,7 unlocked]
[LPAR] enter() [1,18 unlocked]
[LPAR] wait_unlock(10) returned after 0.31s [4,16 unlocked]
[LPAR] on_screen('Password  ===>') -> False
[LPAR] warn Can't find the password prompt anywhere.
```

The square brackets are the cursor row and column, then whether the host had the
keyboard. That pair is usually what explains a keystroke the host rejects: text
typed at the wrong cursor position lands in the wrong field, and text typed while
the keyboard is locked is discarded.

Anything `ask_password` returned is replaced with asterisks before a line is
logged, so a traced logon does not put the password in the channel.

`trace("...")` writes your own line whatever the setting, and `trace_screen()`
dumps the screen with row numbers, which is the quickest way to see the exact
spacing of a prompt you are matching with `on_screen`.

### Example

`examples/startlpar.py` in the repo is the Vista Start LPAR flow: click a
name, map a short userid code, log on, stop with a message if the screen is
wrong. After **Open Macros Folder**, that file is in the macros directory as
`startlpar.py`. Point `tn3270.macros` at it and set `tn3270.clickMacro` as
in the sample at the top of this page.

### A longer script

`startlpar.py` logs on and stops. A script that goes further has to recognise
each panel it lands on, because the keyboard unlocking does not mean the screen
you wanted has arrived. This one opens a member in ISPF Edit from the primary
menu, and backs out with a message when the data set or the member is not
there.

**3270 Terminal: Open Macros Folder**, then save the script below as
`editmember.py` in that folder. Do not put a password in the file. Register it
and give it a key:

```json
"tn3270.macros": {
  "editmember": { "script": "editmember" }
},
"tn3270.keymap": {
  "ctrl+alt+e": "macro:editmember"
}
```

Run it from the ISPF primary option menu, with the cursor anywhere. The first
time, set `tn3270.macroTrace` to `true` and watch the **3270** output channel.
`trace_screen()` prints the panel with row numbers, which is how you correct
the strings in `wait_for` and the slice in `screen` when your ISPF wording or
field positions differ. Turn tracing off once the script lands where you
expect.

```python
# editmember.py — open a member in ISPF Edit from the primary menu.
# No import, and no try/except: neither is available. See "What the script
# namespace has" above.

if not on_screen("ISPF Primary Option Menu"):
    warn("Start this from the ISPF primary option menu")
    return

dataset = ask("Data set name", max=44)
member = ask("Member", max=8)
if not dataset or not member:
    return

# =2 jumps to Edit from any ISPF panel. Wait for the entry panel itself.
type("=2")
enter()
seen = wait_for("ISPF Edit Entry", "ISREDM01", seconds=15)
if not seen:
    trace_screen()
    warn("Edit entry panel did not appear")
    return

# The data set name field on this panel starts at row 3, column 26.
# screen() keeps the trailing spaces, so strip before comparing.
home()
type(dataset)
tab()
type(member)
enter()

seen = wait_for(
    "EDIT ",
    "Member not found",
    "Data set not cataloged",
    seconds=20,
)
if seen == "Member not found":
    warn(member + " is not in " + dataset)
    pf3()
    return
if seen == "Data set not cataloged":
    warn(dataset + " is not catalogued")
    pf3()
    return
if not seen:
    trace_screen()
    warn("Edit did not open, and the panel was not a known error")
    return

# In the editor the member name sits on row 2. A mismatch here means
# wait_for matched a header that was not this edit session.
title = screen(2, 1, 40).strip()
trace(title)
if member not in title:
    warn("Opened a panel, but it does not show " + member)
    pf3()
```

Three habits make a script this long reliable.

- **Name every screen you might land on**, and put the specific fragments
  before the vague ones. `wait_for` returns the first fragment that is
  anywhere on the screen, so `"EDIT "` will match a tutorial that mentions
  Edit if you list it first.
- **Read a field when the title is not enough.** `screen(row, col, length)` is
  1-based and includes trailing spaces. `strip()` before you compare.
- **Leave the session somewhere recognisable when you stop.** `pf3()` here
  returns to the edit entry panel. A script that `return`s in the middle of a
  panel is not wrong, but the next one then has to cope with wherever you
  abandoned it.

## Related

- [KEYMAP.md](KEYMAP.md) — chords, including `macro:<name>`
- [TRANSFER.md](TRANSFER.md) — IND$FILE is a command, not a macro
