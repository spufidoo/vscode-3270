# Changelog

Notable changes, newest first. The decisions behind them are in [HISTORY.md](HISTORY.md).

## [1.0.1] - 2026-10-22

- Shorter README. The reference material now lives in the docs it links to, and a session recording sits at the top.
- Marketplace search keywords for the systems and products people look up.
- This changelog, which is what the Marketplace shows on its Changelog tab.

## [1.0.0] - 2026-10-05

- Published as `spufidoo.vscode-3270`. Same product as 0.13.0. First-run migration still copies macros from the earlier `mdavage.*` installs.

## [0.13.0] - 2026-09-16

- Cut copies a marked rectangle and blanks the input fields inside it. Protected text is left alone, and a locked keyboard refuses the cut before anything is erased.

## [0.12.0] - 2026-09-10

- Several sessions on one host. Tabs after the first are numbered, and a pinned LU still allows only one.
- The wheel sends PF7 and PF8 at the pointer. A tilt wheel can send PF10 and PF11.
- The 3270 bell, a rule line through the cursor, cursor shape and blink, and clickable PF-key hotspots.
- A logon macro that waits until the screen has settled, plus screen capture and a session log.

## [0.11.1] - 2026-09-04

- A host-profile save that fails says why.
- Palette edits repaint the open sessions for that host.

## [0.11.0] - 2026-09-03

- Mark a rectangle from the keyboard, and a right-click menu for copy, cut and paste.
- The font box suggests monospaced fonts installed on the machine.
- Insert works from a Mac keyboard.

## [0.10.0] - 2026-09-02

- tnz and ebcdic are packaged in the extension. Nothing to pip install.

## [0.9.0] - 2026-09-01

- Renamed from TNZ 3270. Settings moved from `tnzView.*` to `tn3270.*`, and the first run copies the old values.

## [0.8.1] - 2026-09-01

- A session tab is named after its host, not after its connection state.

## [0.8.0] - 2026-09-01

- A session left open across a window reload connects again.

## [0.7.2] - 2026-09-01

- The settings example shows the selection mode.

## [0.7.1] - 2026-09-01

- Block selection, as in PCOMM and Vista. A settings reference and a Marketplace icon.

## [0.6.2] - 2026-08-28

- The logon macro waits for the panel. Script macros can be traced. A global font default is back.

## [0.5.3] - 2026-08-28

- Script macros, a font per host, and the copy highlight clears after you copy.

## [0.4.0] - 2026-08-27

- Every macro marker is documented.

## [0.3.5] - 2026-08-26

- Development history recorded.

## [0.3.4] - 2026-08-26

- The keyboard returns to the 3270 after a command takes focus.

## [0.3.3] - 2026-08-26

- The field-attribute byte no longer takes the field's highlighting.

## [0.3.2] - 2026-08-25

- IND$FILE options are sent the way the host expects. TSO gets bare keywords; CMS gets a parenthesis.

## [0.3.1] - 2026-08-25

- The active session is tracked from every panel.

## [0.3.0] - 2026-08-25

- Keyboard macros.

## [0.2.0] - 2026-08-25

- IND$FILE download and upload.

## [0.1.9] - 2026-08-25

- Key bindings are a table you can override.

## [0.1.8] - 2026-08-25

- Lost sessions are explained, and any screen size is accepted.

## [0.1.6] - 2026-08-25

- The sidecar pipes are UTF-8, so a box-drawing character does not crash it.

## [0.1.5] - 2026-08-24

- Host profiles are edited in a settings tab, with a colour palette per host.

## [0.1.4] - 2026-08-24

- The screen is selectable text, and extended colour is shown.

## [0.1.2] - 2026-08-24

- Non-display fields stay hidden, and field colours are restored.

## [0.1.1] - 2026-08-24

- The sidecar no longer crashes when the editor's install directory is read-only.

## [0.1.0] - 2026-08-24

- First release. Host list, a 3270 screen, PF keys, and the Apache-2.0 licence.
