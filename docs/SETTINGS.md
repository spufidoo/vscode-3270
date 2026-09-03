# Settings

Every setting the extension contributes, what it does, and its default. All live
under the `tn3270.` prefix in your user or workspace `settings.json`. Most take
effect immediately in open sessions; the exceptions are noted.

Open **File → Preferences → Settings** and search for `tn3270`, or edit
`settings.json` directly.

## Moving from `tnzView.*`

These settings were called `tnzView.*` before the extension was renamed, and the
extension id changed with the name. The first activation after upgrading copies
every old value it recognises to the new key, and copies your script macros from
the old extension's storage folder into the new one. Nothing already set under
`tn3270.*` is overwritten. You are then asked once whether to delete the old
keys; declining leaves them in place, where the editor will flag them as unknown
settings but nothing will read them. `tnzView.tnzPath` is the only key that was
also renamed, to `tn3270.libraryPath`. No passwords are involved, because none
were ever stored.

## Connection and hosts

### `tn3270.hosts`

Array of saved host profiles, shown in the **Hosts** tree. Normally you edit these
through **Add Host** / **Edit Host** rather than by hand, but they are plain JSON.
Each profile is an object; the fields are listed under
[Host profile fields](#host-profile-fields) below.

- Type: `array`
- Default: `[]`

### `tn3270.pythonPath`

Python 3.10+ interpreter that has the `tnz` package installed. Empty uses the `py`
launcher or `python` on the `PATH`.

- Type: `string`
- Default: `""`
- Applies: next connect (the sidecar is spawned per session)

### `tn3270.libraryPath`

Optional path to a local [IBM/tnz](https://github.com/IBM/tnz) checkout, added to
`PYTHONPATH`. For developing against an unreleased tnz; leave empty to use the
installed package.

- Type: `string`
- Default: `""`
- Applies: next connect

## Appearance

### `tn3270.fontFamily`

Default font for the 3270 screen, as a CSS font list, e.g. `Cascadia Mono` or
`"IBM 3270", Consolas`. Must be monospaced: columns sit on a fixed pitch, so a
proportional font will not line up. The size is not set here; it grows to fill the
panel. A host profile with its own **Font** overrides this. Empty uses the
built-in stack of Lucida Console, Cascadia Mono, Consolas and Courier New.

- Type: `string`
- Default: `""`
- Applies: live, to every session that has not set its own font

### `tn3270.selection`

How selecting and copying works in a session.

- `block` (default) — marks a rectangle of rows and columns, like Vista TN3270 and
  PCOMM. Drag to mark, Shift+click to extend, Ctrl+A to mark the whole screen.
- `stream` — a linear run of characters like a text editor, which also allows
  dragging text out to another app and the webview's own right-click Copy.

Either way, Ctrl+C copies and Ctrl+V pastes, and non-display (password) fields
read as blanks so they can never be copied.

This setting governs the **mouse** only. Shift+arrows mark a rectangle from the
keyboard in either mode, anchored on the 3270 cursor, and Escape drops it. See
[KEYMAP.md](KEYMAP.md) for the `local:mark*` actions behind those chords.

- Type: `string` (`block` | `stream`)
- Default: `block`
- Applies: live

## Keyboard and macros

### `tn3270.keymap`

Overrides for 3270 key bindings. Each entry maps a chord such as `alt+1` to an
action:

- `aid:<name>` — `enter`, `clear`, `attn`, `pa1`–`pa3`, `pf1`–`pf24`
- `nav:<name>` — `tab`, `backtab`, `left`, `right`, `up`, `down`, `home`, `end`,
  `wordleft`, `wordright`, `backspace`, `delete`, `eraseeof`, `eraseinput`,
  `newline`
- `local:<name>` — `insert`, `reset`
- `macro:<name>` — a `tn3270.macros` entry

An empty value removes a default binding. Run **3270 Terminal: Show Keyboard Map** to
see the merged result. Full syntax is in [KEYMAP.md](KEYMAP.md).

- Type: `object` (chord → action string)
- Default: `{}`
- Applies: live

### `tn3270.macros`

Named macros, played from a `macro:<name>` keymap chord or **3270 Terminal: Run Macro**.
A value is one of:

- a **tape** string with `[action]` markers, e.g. `TSO[enter][wait]LISTC[enter]`
- an array of tape strings
- a **script**, `{ "script": "startlpar" }`, naming a Python file in the macros
  folder (**3270 Terminal: Open Macros Folder**)

Never put a password in this setting. Details and the script API are in
[MACROS.md](MACROS.md).

- Type: `object` (name → tape | tape[] | `{ "script": string }`)
- Default: `{}`
- Applies: live

### `tn3270.clickMacro`

Name of a `tn3270.macros` entry to run on Ctrl+click (Cmd+click on macOS) in a
session. The click position is passed to the script as `click`. Empty means a
Ctrl+click only moves the cursor. Typical value: `startlpar`.

- Type: `string`
- Default: `""`
- Applies: live

### `tn3270.macroTrace`

Log every step a script macro takes to the **3270** output channel: what is typed,
which AID key is sent, where the cursor was, and what `on_screen`/`wait_for` found.
Passwords from `ask_password` are shown as asterisks. The channel opens itself when
a traced macro starts.

- Type: `boolean`
- Default: `false`
- Applies: next macro run

## File transfer

### `tn3270.transfer.syntax`

How IND$FILE options are introduced.

- `tso` (default) — bare keywords: `IND$FILE GET 'MY.DATA' ASCII CRLF`. TSO rejects
  a parenthesis with `IKJ56712I INVALID KEYWORD, (`.
- `cms` — options after a parenthesis: `IND$FILE GET FN FT FM ( ASCII CRLF`.

- Type: `string` (`tso` | `cms`)
- Default: `tso`

### `tn3270.transfer.idleTimeout`

Seconds to wait for IND$FILE to respond before giving up. The clock resets whenever
the transfer makes progress, so this only fires when the host has gone quiet —
usually because the command was typed somewhere that is not a ready prompt.

- Type: `number` (minimum `5`)
- Default: `60`

### `tn3270.transfer.options`

IND$FILE options offered as the default when starting a transfer, e.g.
`RECFM(V) LRECL(255)`. `ASCII` and `CRLF` are added automatically for text
transfers.

- Type: `string`
- Default: `""`

See [TRANSFER.md](TRANSFER.md) for host file-name formats and what the failure
messages mean.

## Host profile fields

These live inside each object in `tn3270.hosts`. The host settings tab writes them
for you; this is what it writes.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable identifier, generated for new profiles |
| `label` | string | Name shown in the Hosts tree |
| `group` | string | Optional sidebar folder |
| `host` | string | DNS name or IP |
| `port` | number | TCP port. New profiles start on 23; TLS moves to 992 |
| `secure` | boolean | TLS. New profiles are plain telnet (`false`) |
| `verifyCert` | boolean | Verify the server certificate (TLS only) |
| `secLevel` | number | TLS level for older stacks; `1` is common. Omit for default |
| `luName` | string | LU name; requires `tn3270e` |
| `tn3270e` | boolean | Negotiate TN3270E |
| `codePage` | string | EBCDIC code page, e.g. `037` |
| `psSize` | string | Screen size as `rowsxcols`, e.g. `24x80` or `30x133` |
| `extendedColor` | boolean | Advertise colour capability to the host |
| `blink` | boolean | Render the blink highlight instead of ignoring it |
| `colors` | object | Per-host palette (`background`, `black`, `blue`, `red`, `pink`, `green`, `turquoise`, `yellow`, `white`) |
| `fontFamily` | string | Per-host font; empty follows `tn3270.fontFamily` |

Passwords are never stored in a profile. Log on in the 3270 screen, or use a script
macro that prompts with `ask_password`.

## Example

A working extract from a user `settings.json`. Hosts, fonts, macros, and keymap
overrides sit alongside each other; anything not listed here uses the defaults
above, so transfers here use TSO syntax. Three of the
profiles are shown so the shape is obvious: a dark BMC session with its own font,
a light Compuware session that inherits the global font, and a TLS host on a
non-standard port.

Do not put a password in a tape. The `mypassword` entry below is a placeholder;
the original used `[password:Password]` (or `ask_password` in a script) instead.

```json
{
    "tn3270.hosts": [
        {
            "id": "f7ea3eb2-77e1-4277-bc7b-848c78a75eb6",
            "label": "DB2B",
            "group": "BMC",
            "host": "db2b",
            "port": 23,
            "secure": false,
            "verifyCert": true,
            "luName": "",
            "tn3270e": true,
            "codePage": "037",
            "psSize": "43x80",
            "extendedColor": true,
            "blink": true,
            "colors": {
                "background": "#000000",
                "black": "#000000",
                "blue": "#7890f0",
                "red": "#f01818",
                "pink": "#ff00ff",
                "green": "#24d830",
                "turquoise": "#58f0f0",
                "yellow": "#ffff00",
                "white": "#ffffff"
            },
            "fontFamily": "Consolas"
        },
        {
            "id": "934a857f-0742-4933-87cd-5a445bab2c73",
            "label": "CW01",
            "group": "Compuware",
            "host": "cw01",
            "port": 23,
            "secure": false,
            "verifyCert": true,
            "luName": "",
            "tn3270e": true,
            "codePage": "037",
            "psSize": "32x80",
            "extendedColor": true,
            "blink": false,
            "colors": {
                "background": "#ffffff",
                "black": "#000000",
                "blue": "#7890f0",
                "red": "#f01818",
                "pink": "#ff00ff",
                "green": "#24d830",
                "turquoise": "#58f0f0",
                "yellow": "#ffff00",
                "white": "#bfbfbf"
            },
            "fontFamily": ""
        },
        {
            "id": "4c3607e2-8c0f-48d5-a9d2-461ec4e70012",
            "label": "Moshix",
            "host": "www.moshix.tech",
            "port": 2023,
            "secure": true,
            "verifyCert": true,
            "luName": "",
            "tn3270e": true,
            "codePage": "037",
            "psSize": "24x80",
            "extendedColor": true,
            "blink": false,
            "colors": {
                "background": "#ffffff",
                "black": "#000000",
                "blue": "#7890f0",
                "red": "#f01818",
                "pink": "#ff00ff",
                "green": "#24d830",
                "turquoise": "#58f0f0",
                "yellow": "#baba26",
                "white": "#d7d6d6"
            },
            "fontFamily": ""
        }
    ],
    "tn3270.fontFamily": "Consolas",
    "tn3270.selection": "block",
    "tn3270.macros": {
        "password": "[password:Password]",
        "probe": "[prompt:Type something]",
        "startlpar": { "script": "startlpar" },
        "logon": "[prompt:Userid][enter][wait][password:Password][enter][wait][enter]"
    },
    "tn3270.macroTrace": false,
    "tn3270.clickMacro": "startlpar",
    "tn3270.keymap": {
        "ctrl+alt+p": "macro:password",
        "pageup": "aid:pf7",
        "pagedown": "aid:pf8",
        "shift+pageup": "aid:pf19",
        "shift+pagedown": "aid:pf20",
        "shift+enter": "nav:newline"
    }
}
```

The rest of that user's hosts (DB2A, CW09, CW13, SYSP, ESAJ, VTHB) follow the same
shape as DB2B or CW01: same `codePage` and `tn3270e`, with `psSize`, `group`,
`blink`, and `colors` varying per LPAR.

## Related

- [KEYMAP.md](KEYMAP.md) — chords and action names
- [MACROS.md](MACROS.md) — tape markers and the script API
- [TRANSFER.md](TRANSFER.md) — IND$FILE file names and options
