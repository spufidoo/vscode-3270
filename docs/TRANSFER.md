# File transfer (IND$FILE)

**3270 Terminal: Download File from Host** and **3270 Terminal: Upload File to Host**
copy files over the 3270 session using IND$FILE. Both are also buttons on the
session tab's title bar.

There is no separate connection: the file travels through the terminal session
you are already logged on to, so whatever you can reach from TSO you can
transfer, and nothing extra needs opening on the network.

## Before you start

**Get to a command prompt.** IND$FILE is a host command and the extension runs
it by typing it at the cursor, so the session has to be somewhere a command can
be typed:

| Where you are | What to do |
| --- | --- |
| TSO **READY** | Nothing, you are ready |
| ISPF anywhere | Go to **option 6** (Command) |
| ISPF, want to leave it | `=X` returns to READY |
| CMS ready prompt | Nothing |

Option 6 is the least disruptive: you keep your ISPF session and can go back to
what you were doing afterwards.

From an ISPF panel or the editor, the command text just lands in whatever field
the cursor is in and nothing happens. The transfer then sits until the idle
timeout expires. The commands refuse to start when the keyboard is locked, but
they cannot tell a ready prompt from any other unlocked screen, so this one is
on you.

**Check IND$FILE is installed.** Type `IND$FILE` at READY on its own. A working
installation answers with a usage or parameter error, which is what you want to
see. `COMMAND IND$FILE NOT FOUND` means it is not installed or your site has
renamed it — some do. Ask whoever looks after TSO at your site.

## Download a TSO dataset

1. Get the session to READY or ISPF option 6, as above.
2. Run **3270 Terminal: Download File from Host** from the command palette, or press
   the download button on the session tab.
3. **Host file.** Type the dataset name.
   - In quotes for a fully qualified name: `'SYS1.PROCLIB(IEFBR14)'`
   - Without quotes to let TSO add your prefix: `SOURCE(MYPROG)` becomes
     `USERID.SOURCE(MYPROG)`
   - A sequential dataset has no member: `'USERID.REPORT.TXT'`
4. **Transfer type.** Pick **Text** for source, JCL, reports and anything you
   intend to read. Pick **Binary** for load modules and compressed files.
5. **Options.** Leave empty for a normal download. `APPEND` adds to the end of
   an existing local file instead of replacing it.
6. **Save dialog.** Choose where the file goes. The name is prefilled from the
   member name.

When it finishes you are offered **Open**. The file is ordinary text with the
host's records as lines, so it opens in the editor like anything else.

## Upload to a TSO dataset

The important difference is that **IND$FILE will not create a partitioned
dataset**. If you are uploading to a member, the PDS has to exist already.

1. **Make sure the target exists.** For a member, allocate the PDS first with
   ISPF **3.2**, matching the data you are sending — `RECFM(FB) LRECL(80)` for
   JCL and most source. For a sequential dataset you can let IND$FILE create it
   by passing the space and record options in step 6.
2. Get the session to READY or ISPF option 6.
3. Run **3270 Terminal: Upload File to Host**, or press the upload button.
4. **Pick the local file.** The dialog opens on the active editor's file.
5. **Host file.** The dataset name, same rules as for download. An existing
   member is overwritten without asking.
6. **Transfer type**, then **options**. For a new *sequential* dataset:

   ```
   RECFM(F) LRECL(80) BLKSIZE(3120) SPACE(10,5) TRACKS
   ```

   For an existing dataset or a PDS member, leave the options empty and let the
   dataset's own attributes apply.
7. Check the result in ISPF. A text upload should show your lines as records.

### Line length

Text uploads map one line to one record. Lines longer than the dataset's LRECL
are truncated by the host, silently, so a source file with long lines needs a
dataset allocated to fit — `RECFM(V) LRECL(255)` is the usual answer when 80
columns is not enough.

Tabs are sent as tab characters, not expanded. Convert them locally first if
the host tooling expects spaces.

## Text or binary

You are asked each time.

**Text** sends `ASCII CRLF`. tnz notices that pair and does the EBCDIC
translation itself rather than letting the host do it, because the host's
translation tables mishandle some characters — `|` is the usual casualty, which
matters for JCL and shell scripts. Host records become lines.

**Binary** copies bytes unchanged. Nothing is translated and no record
structure is preserved, so a download gives you the raw bytes with no
indication of where the host's records ended.

The code page used for text is the host profile's `codePage`, so if downloaded
text has the wrong currency symbol or accented characters, that is the setting
to change.

## Host file names

The name is passed to IND$FILE untouched, so use whatever the host expects:

| Host | Example |
| --- | --- |
| TSO, fully qualified | `'USERID.SOURCE(MYPROG)'` |
| TSO, prefix added by the host | `SOURCE(MYPROG)` |
| TSO sequential | `'USERID.REPORT.TXT'` |
| CMS | `PROFILE EXEC A` |

## Options

Whatever you type at the options prompt is passed to IND$FILE.

The two hosts introduce options differently, so `tn3270.transfer.syntax`
selects between them. It defaults to `tso`.

| Setting | Command sent |
| --- | --- |
| `tso` | `IND$FILE GET 'MY.DATA' ASCII CRLF` |
| `cms` | `IND$FILE GET FN FT FM ( ASCII CRLF` |

Which one a host wants is a fact about that host, so the **File transfer**
section of the host settings tab overrides the setting per profile. Set it there
if you reach both TSO and VM systems; the setting then only covers profiles that
leave the field on Default. The same goes for the default options offered at the
prompt and the idle timeout below.

The parenthesis is CMS convention. TSO takes options as bare keywords and
rejects one with `IKJ56712I INVALID KEYWORD, (`.

| Option | Use |
| --- | --- |
| `RECFM(F)` `RECFM(V)` `RECFM(U)` | Record format for a dataset being created |
| `LRECL(n)` | Record length |
| `BLKSIZE(n)` | Block size |
| `SPACE(p,s)` with `TRACKS`, `CYLINDERS` or `AVBLOCK(n)` | Space for a new sequential dataset |
| `APPEND` | Add to the end of the target instead of replacing it |

`ASCII` and `CRLF` are added for you in text mode; do not repeat them.

Set `tn3270.transfer.options` to pre-fill the prompt with the options you use
most.

## While a transfer runs

The screen does not update and keystrokes are ignored, because tnz owns the
session for the duration. The status line shows `FILE TRANSFER IN PROGRESS`.

IND$FILE has no way to abort a transfer in progress, so the progress
notification has no Cancel button. If the host goes quiet for
`tn3270.transfer.idleTimeout` seconds (60 by default) the transfer gives up
and the session returns to normal. The clock resets whenever data moves, so a
slow but healthy transfer will not trip it.

## Host-initiated transfers

tnz can accept transfers that the host starts by itself. That is left switched
off, so a host cannot read or write files on your machine unless you asked for
a transfer.

## Failures

The completion message from IND$FILE is reported as it comes. `TRANS03` means
success; anything else is an error and the message says what went wrong.

| Symptom | Cause |
| --- | --- |
| "the keyboard is locked" | Not at a ready prompt, or the host still owes a reply |
| "no response from IND$FILE" | The command went into a field instead of running. You were not at a command prompt |
| `COMMAND IND$FILE NOT FOUND` on screen | Not installed, or renamed at your site |
| `IKJ56712I INVALID KEYWORD, (` | The syntax in force is `cms` against a TSO host. Check the profile's IND$FILE syntax first, then `tn3270.transfer.syntax` |
| `IKJ56712I INVALID KEYWORD` naming an option | The host does not accept that option; check it against the ones above |
| `TRANS13` and similar | The host rejected the request; the number and text say why |
| Upload to a member fails | The PDS does not exist. IND$FILE cannot create one |
| Uploaded lines are cut short | Lines are longer than the dataset's LRECL |
| Downloaded text has odd characters | Wrong `codePage` in the host profile, or it should have been a binary transfer |
| "the session was lost" | The connection dropped mid-transfer |

A failed download leaves a partial file on disk. Check it before reusing it.
