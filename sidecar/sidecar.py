"""JSON-lines sidecar wrapping tnz.Tnz for the 3270 Terminal VS Code extension.

One process, one worker thread per session. Commands arrive on stdin;
events are written to stdout as a single JSON object per line.

Copyright (c) 2026 Marcus Davage

SPDX-License-Identifier: Apache-2.0
"""

from __future__ import annotations

import ast
import base64
import json
import os
import queue
import re
import sys
import threading
import time
import traceback

# The protocol is UTF-8 in both directions. On Windows a pipe defaults to the
# ANSI code page, which cannot encode the cp310 box-drawing glyphs ISPF uses.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# tnz and ebcdic ship inside the extension, so there is nothing for a user to
# install. Ahead of site-packages, so the version tested against is the one
# that runs whatever else happens to be on the machine.
_vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_vendor):
    sys.path.insert(0, _vendor)

# A local IBM/tnz checkout still wins, for developing against an unreleased tnz.
_tnz_path = os.environ.get("VSCODE_3270_TNZ_PATH", "").strip()
if _tnz_path:
    sys.path.insert(0, _tnz_path)


def _configure_tnz_logging() -> None:
    """Point tnz at a writable log file.

    tnz ships a logging.json whose filename is relative, so it lands in the
    process working directory. Editors launch us from their install
    directory, which is typically read-only.
    """
    if "TNZ_LOGGING" in os.environ:
        return

    log_dir = os.environ.get("VSCODE_3270_LOG_DIR", "").strip()
    if not log_dir:
        os.environ["TNZ_LOGGING"] = ""  # disable tnz file logging
        return

    try:
        os.makedirs(log_dir, exist_ok=True)
        config = {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"tnz_format": {"format": "%(asctime)s %(message)s"}},
            "handlers": {
                "tnz_log": {
                    "class": "logging.FileHandler",
                    "encoding": "utf8",
                    "filename": os.path.join(log_dir, "tnz.log"),
                    "formatter": "tnz_format",
                    "mode": "w",
                }
            },
            "loggers": {
                "tnz": {
                    "handlers": ["tnz_log"],
                    "level": os.environ.get("VSCODE_3270_LOG_LEVEL", "WARN"),
                    "propagate": False,
                }
            },
        }
        config_path = os.path.join(log_dir, "tnz-logging.json")
        with open(config_path, "w", encoding="utf8") as file:
            json.dump(config, file)
        os.environ["TNZ_LOGGING"] = config_path
    except OSError:
        os.environ["TNZ_LOGGING"] = ""


_configure_tnz_logging()

try:
    from tnz.tnz import Tnz, TnzError, TnzTransferError
except ImportError as _exc:
    # The copy inside the extension should always satisfy this. Reaching here
    # means the packaged tree is missing or a broken tnz shadows it.
    sys.stderr.write(
        f"cannot import tnz ({_exc}). Looked in: {_vendor if os.path.isdir(_vendor) else 'no bundled copy'}. "
        "Reinstall the extension, or run: pip install tnz ebcdic\n"
    )
    raise SystemExit(2)

_stdout_lock = threading.Lock()
_sessions: dict[str, "Session"] = {}
_sessions_lock = threading.Lock()
# tnz reads SESSION_SECLEVEL out of the environment while it builds the SSL
# context, and the environment is shared by every session in this process.
# Held for the length of a connect so two of them cannot overlap.
_connect_lock = threading.Lock()


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def b64(data: bytes | bytearray) -> str:
    return base64.b64encode(bytes(data)).decode("ascii")


def _set_env(name: str, value) -> None:
    """Set an environment variable, or remove it when the value is empty."""
    if value:
        os.environ[name] = str(value)
    else:
        os.environ.pop(name, None)


# Standard 3270 screen sizes, 80-column models first and each group in
# increasing buffer size, so a suggestion keeps the current width where it can.
_MODELS = ((24, 80), (32, 80), (43, 80), (27, 132), (24, 132), (62, 160))


def _suggest_sizes(address: int, cols: int) -> list[str]:
    """Standard sizes big enough to hold the address the host asked for."""
    need = address + 1
    same = [f"{r}x{c}" for r, c in _MODELS if c == cols and r * c >= need]
    wider = [f"{r}x{c}" for r, c in _MODELS if c != cols and r * c >= need]
    return same[:1] + wider[:1] or ["62x160"]


def _deadline_wait(tns, idle_seconds: float):
    """A tns.wait that gives up once the transfer stops making progress.

    get_file and put_file poll wait() until the host sends a DDM message. If
    IND$FILE never starts -- the command was typed somewhere that is not a
    ready prompt, so it went into a field instead -- that loop spins forever
    and takes the session thread with it. Raising from wait() unwinds through
    their try/finally, which is the only way in from outside.
    """
    original = type(tns).wait
    deadline = time.monotonic() + idle_seconds

    def wait(timeout=None, zti=None, key=None):
        nonlocal deadline
        if tns.ddm_in_progress():
            deadline = time.monotonic() + idle_seconds
        elif time.monotonic() > deadline:
            raise TnzTransferError(
                f"no response from IND$FILE for {idle_seconds:g} seconds"
            )
        return original(tns, timeout=timeout, zti=zti, key=key)

    return wait


def _transfer_reason(exc: Exception, tns) -> str:
    """Turn an IND$FILE failure into something actionable."""
    text = str(exc).strip()
    if tns.seslost:
        return "the session was lost during the transfer"
    if text in ("", "None"):
        return "the transfer ended without a completion message from IND$FILE"
    if "no response from IND$FILE" in text:
        return (
            text
            + ". The command is typed at the cursor, so the session must be"
            " at a ready prompt (TSO READY, ISPF option 6, or CMS) rather"
            " than in a panel or editor."
        )
    return text


def _exception_chain(exc) -> list:
    """Walk __cause__ / __context__ so wrapped SSL errors are visible."""
    seen: list = []
    while exc is not None and exc not in seen:
        seen.append(exc)
        nxt = exc.__cause__ or exc.__context__
        if nxt is exc:
            break
        exc = nxt
    return seen


def _format_exc(exc) -> str:
    if exc is None:
        return ""
    text = str(exc).strip()
    name = type(exc).__name__
    if not text or text == name:
        return name
    return f"{name}: {text}"


def _seslost_exc(seslost):
    """Pull the exception out of tnz's seslost value.

    tnz sets seslost to True for a close with no error, or to a
    sys.exc_info() / (type, exc, tb) tuple when it knows why.
    """
    if isinstance(seslost, BaseException):
        return seslost
    if isinstance(seslost, tuple) and len(seslost) >= 2:
        return seslost[1]
    return None


def _failure_advice(exc, *, tns=None, secure: bool | None = None) -> str:
    """One sentence of what to try, or empty if we cannot say."""
    chain = _exception_chain(exc) if exc is not None else []
    blob = " ".join(_format_exc(e).lower() for e in chain)
    names = " ".join(type(e).__name__.lower() for e in chain)

    if re.search(r"invalid address: (\d+)", blob) and tns is not None:
        match = re.search(r"invalid address: (\d+)", blob)
        address = int(match.group(1))
        cols = tns.maxcol or 80
        options = " or ".join(_suggest_sizes(address, cols))
        return (
            f"The host wrote past the end of this {tns.maxrow}x{cols}"
            f" screen. Set the screen size to match the emulator that"
            f" started the session: the columns must match exactly and the"
            f" rows must be at least as many. Otherwise try {options}."
        )

    if any(
        key in blob
        for key in (
            "wrong version number",
            "wrong_version_number",
            "unknown protocol",
            "record layer failure",
            "httpsconnectionpool",
        )
    ):
        if secure:
            return (
                "This looks like a plain (non-TLS) TN3270 port. Turn off"
                " Secure in the host profile, or use port 23."
            )
        return (
            "The host answered in TLS. Turn on Secure in the host profile;"
            " the usual TLS port is 992, though some sites use another."
        )

    if any(
        key in blob
        for key in (
            "certificate_verify_failed",
            "certificate verify failed",
            "unable to get local issuer",
            "self signed certificate",
            "self-signed certificate",
        )
    ):
        return (
            "The certificate is not trusted. For a lab or self-signed host,"
            " turn off Verify certificate. Otherwise the host name in the"
            " profile must match the name on the certificate."
        )

    if any(
        key in blob
        for key in (
            "hostname mismatch",
            "doesn't match",
            "does not match",
            "certificate_hostname",
        )
    ):
        return (
            "The certificate name does not match this host. Use the name on"
            " the certificate, or turn off Verify certificate."
        )

    if "handshake" in blob or "ssl" in names or "ssl" in blob:
        if secure is False:
            return (
                "The host closed a TLS handshake. Turn on Secure in the"
                " host profile."
            )
        if secure:
            return (
                "The TLS handshake failed. Try turning off Verify"
                " certificate, setting Sec level to 1 for an older stack,"
                " or turning Secure off if this is actually a plain port."
            )

    refused = (
        "connection refused" in blob
        or "actively refused" in blob
        or "errno 111" in blob
        or "winerror 10061" in blob
        or "econnrefused" in names
        or "connectionrefused" in names
    )
    if refused:
        return (
            "Nothing is listening on that host and port. Check the port"
            " (992 is the usual TLS TN3270 port, 23 the usual plain one)"
            " and that the host name resolves to the machine you meant."
        )

    reset = (
        "connection reset" in blob
        or "connectionabort" in names
        or "connectionreset" in names
        or "winerror 10054" in blob
        or "errno 104" in blob
        or "broken pipe" in blob
    )
    if reset:
        if secure is False:
            return (
                "The host closed the connection. This port may expect TLS;"
                " turn on Secure in the host profile."
            )
        if secure:
            return (
                "The host closed the TLS connection. If this is a plain"
                " port, turn Secure off. Otherwise the host may have"
                " rejected the TN3270 negotiation (try toggling TN3270E)."
            )
        return "The host closed the connection."

    timed_out = (
        "timed out" in blob
        or "timeout" in names
        or "winerror 10060" in blob
        or "errno 110" in blob
    )
    if timed_out:
        return (
            "The host did not answer in time. Check the host name and port,"
            " and whether you need TLS (Secure) to reach it."
        )

    dns = (
        "gaierror" in names
        or "getaddrinfo" in blob
        or "name or service not known" in blob
        or "nodename nor servname" in blob
        or "not known" in blob
        and "host" in blob
    )
    if dns:
        return "The host name did not resolve. Check the spelling."

    if "eof" in blob or "connection closed" in blob:
        if secure is False:
            return (
                "The host closed the socket without speaking. This port may"
                " expect TLS; turn on Secure in the host profile."
            )
        return "The host closed the connection."

    return ""


def _explain_failure(exc, *, tns=None, secure: bool | None = None) -> str:
    """Exception text plus advice, for toasts and the status line."""
    if exc is None:
        return _seslost_reason(True, tns, secure=secure)
    reason = _format_exc(exc)
    extra = [
        _format_exc(e)
        for e in _exception_chain(exc)[1:]
        if _format_exc(e) not in reason
    ]
    if extra:
        reason = reason + " (" + "; ".join(extra) + ")"
    advice = _failure_advice(exc, tns=tns, secure=secure)
    if advice:
        reason = f"{reason}. {advice}" if reason else advice
    return reason or _seslost_reason(True, tns, secure=secure)


def _seslost_reason(seslost, tns, *, secure: bool | None = None) -> str:
    """Describe why tnz dropped the session."""
    exc = _seslost_exc(seslost)
    if exc is None:
        if secure is False:
            return (
                "The host closed the connection. If this port expects TLS,"
                " turn on Secure in the host profile."
            )
        return "The host closed the connection."
    return _explain_failure(exc, tns=tns, secure=secure)


NAV = {
    "left": "key_curleft",
    "right": "key_curright",
    "up": "key_curup",
    "down": "key_curdown",
    "tab": "key_tab",
    "backtab": "key_backtab",
    "home": "key_home",
    "end": "key_end",
    "wordleft": "key_word_left",
    "wordright": "key_word_right",
    "newline": "key_newline",
    "backspace": "key_backspace",
    "delete": "key_delete",
    "eraseeof": "key_eraseeof",
    "eraseinput": "key_eraseinput",
}

AID = {
    "enter": "enter",
    "clear": "clear",
    "attn": "attn",
    "pa1": "pa1",
    "pa2": "pa2",
    "pa3": "pa3",
}
for _i in range(1, 25):
    AID[f"pf{_i}"] = f"pf{_i}"


class _ScriptCancelled(Exception):
    """User dismissed an ask() box; the script should stop quietly."""


def _script_print(*args, **kwargs) -> None:
    kwargs.setdefault("file", sys.stderr)
    print(*args, **kwargs)


def _compile_script(source: str, path: str):
    """Compile a macro so that a top-level return exits it.

    The statements are grafted into a function through the syntax tree rather
    than by indenting the text. Every node keeps the line number the user sees
    in the editor, so a traceback points at the right line, and a multi-line
    string literal is not silently given four extra spaces per line.
    """
    body = ast.parse(source, path).body
    module = ast.parse(
        "def __macro_script():\n    pass\n__macro_script()\n", "<macro>"
    )
    function = module.body[0]
    if body:
        function.body = body
        function.end_lineno = getattr(body[-1], "end_lineno", None)
    ast.fix_missing_locations(module)
    return compile(module, path, "exec")


class _Click:
    def __init__(self, row: int, col: int) -> None:
        self.row = row
        self.col = col


class _ScriptApi:
    """Functions injected into a user script's globals."""

    def __init__(
        self, session: "Session", tracing: bool = False, name: str = ""
    ) -> None:
        self.session = session
        self.name = name
        self._ask_n = 0
        self.tracing = tracing
        # Anything ask_password() returned, so a trace of what was typed can
        # never carry the password into the log.
        self._secrets: list[str] = []

    def namespace(self) -> dict:
        api = {
            "unlocked": self.unlocked,
            "wait_unlock": self.wait_unlock,
            "pause": self.pause,
            "type": self.type,
            "on_screen": self.on_screen,
            "wait_for": self.wait_for,
            "screen": self.screen,
            "word_at": self.word_at,
            "ask": self.ask,
            "ask_password": self.ask_password,
            "warn": self.warn,
            "trace": self.trace,
            "trace_screen": self.trace_screen,
            "click": self._click_obj(),
        }
        for name, method in AID.items():
            api[name] = self._aid_fn(method)
        for name, method in NAV.items():
            api[name] = self._nav_fn(method)
        return {
            "__builtins__": {
                "True": True,
                "False": False,
                "None": None,
                "abs": abs,
                "bool": bool,
                "dict": dict,
                "enumerate": enumerate,
                "float": float,
                "int": int,
                "isinstance": isinstance,
                "len": len,
                "list": list,
                "max": max,
                "min": min,
                "print": _script_print,
                "range": range,
                "str": str,
                "tuple": tuple,
                "zip": zip,
            },
            **api,
        }

    def _tns(self):
        tns = self.session.tns
        if tns is None:
            raise TnzError("the session was lost")
        return tns

    def _redact(self, text: str) -> str:
        for secret in self._secrets:
            if secret:
                text = text.replace(secret, "********")
        return text

    def _trace(self, text: str) -> None:
        emit(
            {
                "op": "trace",
                "sessionId": self.session.session_id,
                "text": self._redact(text),
            }
        )

    def _step(self, text: str) -> None:
        """Trace an action, but only when the user asked for a trace."""
        if self.tracing:
            self._trace(text)

    def _where(self) -> str:
        """Cursor and keyboard state, the two things that explain a stray key."""
        tns = self._tns()
        cols = tns.maxcol or 80
        row = tns.curadd // cols + 1
        col = tns.curadd % cols + 1
        state = "locked" if (tns.pwait or tns.system_lock_wait) else "unlocked"
        return f"[{row},{col} {state}]"

    def trace(self, *parts) -> None:
        """Log a message whether or not tracing is switched on."""
        self._trace(" ".join(str(part) for part in parts))

    def trace_screen(self) -> None:
        """Log the screen as the script sees it, with row numbers."""
        tns = self._tns()
        text = self._plain_text()
        cols = tns.maxcol or 80
        lines = [f"screen {tns.maxrow}x{cols} {self._where()}"]
        for r in range(tns.maxrow):
            line = text[r * cols : (r + 1) * cols].rstrip()
            if line:
                lines.append(f"{r + 1:3d}|{line}")
        self._trace("\n".join(lines))

    def _click_obj(self) -> _Click:
        tns = self._tns()
        if self.session.last_click:
            row, col = self.session.last_click
        else:
            cols = tns.maxcol
            row = tns.curadd // cols + 1
            col = tns.curadd % cols + 1
        return _Click(row, col)

    def _aid_fn(self, method: str):
        def run() -> None:
            self._step(f"{method}() {self._where()}")
            getattr(self._tns(), method)()
            self.session._emit_screen()

        run.__name__ = method
        return run

    def _nav_fn(self, method: str):
        def run() -> None:
            self._step(f"{method}() {self._where()}")
            getattr(self._tns(), method)()
            self.session._emit_screen()

        run.__name__ = method
        return run

    def unlocked(self) -> bool:
        tns = self._tns()
        return not (tns.pwait or tns.system_lock_wait)

    def wait_unlock(self, seconds: float = 10) -> None:
        started = time.monotonic()
        self.session._wait_unlock(self._tns(), float(seconds) * 1000)
        self.session._emit_screen()
        self._step(
            f"wait_unlock({seconds:g}) returned after "
            f"{time.monotonic() - started:.2f}s {self._where()}"
        )

    def pause(self, seconds: float) -> None:
        self._step(f"pause({float(seconds):g})")
        time.sleep(float(seconds))

    def type(self, text: str) -> None:
        value = "" if text is None else str(text)
        self._step(f"type({value!r}) {self._where()}")
        self._tns().key_data(value)
        self.session._emit_screen()

    def _plain_text(self) -> str:
        tns = self._tns()
        text = tns.scrstr(0, 0, rstrip=False)
        size = tns.maxrow * tns.maxcol
        if len(text) < size:
            text = text + (" " * (size - len(text)))
        elif len(text) > size:
            text = text[:size]
        return text

    def on_screen(self, fragment: str) -> bool:
        found = str(fragment) in self._plain_text()
        self._step(f"on_screen({str(fragment)!r}) -> {found}")
        return found

    def wait_for(self, *fragments: str, seconds: float = 10) -> str:
        """Pump the session until one of the fragments is on the screen.

        An unlocked keyboard is not the screen you asked for: a logon replies
        several times before it prompts for a password. Returns the fragment
        that matched, or "" on timeout, so the script can branch.
        """
        tns = self._tns()
        wanted = [str(f) for f in fragments]
        started = time.monotonic()
        deadline = started + float(seconds)
        while True:
            text = self._plain_text()
            for fragment in wanted:
                if fragment in text:
                    self._step(
                        f"wait_for -> {fragment!r} after "
                        f"{time.monotonic() - started:.2f}s {self._where()}"
                    )
                    return fragment
            if tns.seslost:
                raise TnzError("the session was lost")
            if time.monotonic() > deadline:
                self._step(
                    f"wait_for({', '.join(repr(f) for f in wanted)}) timed out "
                    f"after {seconds:g}s {self._where()}"
                )
                return ""
            tns.wait(timeout=0.1)
            if tns.updated:
                tns.updated = False
                self.session._emit_screen()

    def screen(self, row: int, col: int, length: int) -> str:
        tns = self._tns()
        text = self._plain_text()
        start = (int(row) - 1) * tns.maxcol + (int(col) - 1)
        return text[start : start + int(length)]

    def word_at(self, click: _Click | None = None) -> str:
        tns = self._tns()
        pos = click or self._click_obj()
        text = self._plain_text()
        cols = tns.maxcol
        idx = (int(pos.row) - 1) * cols + (int(pos.col) - 1)
        if idx < 0 or idx >= len(text):
            return ""
        left = idx
        while left > 0 and not text[left - 1].isspace():
            left -= 1
        right = idx
        while right < len(text) and not text[right].isspace():
            right += 1
        return text[left:right].strip()

    def ask(self, prompt: str, default: str | None = None, max: int | None = None):
        reply = self._ask("input", prompt, default, max)
        if reply.get("cancelled"):
            self._step("ask cancelled, stopping")
            raise _ScriptCancelled()
        value = reply.get("value") or ""
        self._step(f"ask({str(prompt)!r}) -> {value!r}")
        return value

    def ask_password(self, prompt: str = "Password"):
        reply = self._ask("password", prompt, None, None)
        if reply.get("cancelled"):
            self._step("ask_password cancelled, stopping")
            raise _ScriptCancelled()
        value = reply.get("value") or ""
        self._secrets.append(value)
        self._step(f"ask_password({str(prompt)!r}) -> {len(value)} characters")
        return value

    def warn(self, message: str) -> None:
        self._trace(f"warn {message}")
        self._ask("warn", message, None, None)

    def _ask(
        self,
        kind: str,
        prompt: str,
        default: str | None,
        max_length: int | None,
    ) -> dict:
        self._ask_n += 1
        ask_id = f"a{self._ask_n}"
        payload = {
            "op": "scriptAsk",
            "sessionId": self.session.session_id,
            "askId": ask_id,
            "kind": kind,
            "prompt": str(prompt),
            "name": self.name,
        }
        if default is not None:
            payload["value"] = str(default)
        if max_length:
            payload["maxLength"] = int(max_length)
        emit(payload)
        return self.session._wait_script_reply(ask_id)


class Session:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.commands: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.tns: Tnz | None = None
        self.secure = False
        self.last_click: tuple[int, int] | None = None
        self.thread = threading.Thread(
            target=self._run, name=f"3270-{session_id}", daemon=True
        )

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        try:
            while not self.stop.is_set():
                try:
                    cmd = self.commands.get(timeout=0.05)
                except queue.Empty:
                    cmd = None

                if cmd is not None:
                    try:
                        self._handle(cmd)
                    except Exception:
                        # One bad command must not take the thread with it:
                        # the session would go on queueing keystrokes that
                        # nothing is left to read.
                        emit(
                            {
                                "op": "error",
                                "sessionId": self.session_id,
                                "message": f"{cmd.get('op')} failed: "
                                + traceback.format_exc(limit=2),
                            }
                        )

                tns = self.tns
                if tns is None:
                    continue
                try:
                    tns.wait(timeout=0.05)
                except Exception as exc:
                    emit(
                        {
                            "op": "error",
                            "sessionId": self.session_id,
                            "message": _explain_failure(
                                exc, tns=tns, secure=self.secure
                            ),
                        }
                    )
                    continue

                if tns.seslost:
                    reason = _seslost_reason(
                        tns.seslost, tns, secure=self.secure
                    )
                    emit(
                        {
                            "op": "error",
                            "sessionId": self.session_id,
                            "message": f"session lost: {reason}",
                        }
                    )
                    emit(
                        {
                            "op": "status",
                            "sessionId": self.session_id,
                            "connected": False,
                            "tls": False,
                            "lu": tns.lu_name or "",
                            "seslost": True,
                            "lock": True,
                            "reason": reason,
                        }
                    )
                    try:
                        tns.close()
                    except Exception:
                        pass
                    self.tns = None
                    continue

                if tns.updated:
                    tns.updated = False
                    try:
                        self._emit_screen()
                    except Exception:
                        # One unrenderable screen must not kill the session.
                        emit(
                            {
                                "op": "error",
                                "sessionId": self.session_id,
                                "message": "screen update failed: "
                                + traceback.format_exc(limit=1),
                            }
                        )
        except Exception:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": traceback.format_exc(),
                }
            )

    def _handle(self, cmd: dict) -> None:
        op = cmd.get("op")
        if op == "connect":
            self._connect(cmd)
        elif op == "disconnect":
            self._disconnect()
            # Nothing left to serve, so let the thread end rather than poll an
            # empty queue for the rest of the editor's life. A later connect
            # gets a fresh session.
            self.stop.set()
            drop_session(self)
        elif op == "refresh":
            # The webview reloaded and has nothing to draw until the host
            # next changes something, which could be a long wait.
            self._emit_screen()
        elif op == "key":
            self._key(cmd)
        elif op == "click":
            self._click(cmd)
        elif op == "paste":
            self._paste(cmd)
        elif op == "transfer":
            self._transfer(cmd)
        elif op == "macro":
            self._macro(cmd)
        elif op == "script":
            self._script(cmd)
        elif op == "scriptReply":
            pass
        else:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"unknown op {op}",
                }
            )

    def _connect(self, cmd: dict) -> None:
        self._disconnect()
        host = cmd.get("host") or "127.0.0.1"
        secure = bool(cmd.get("secure", True))
        self.secure = secure
        port = cmd.get("port")
        if port is None:
            port = 992 if secure else 23
        verify = bool(cmd.get("verifyCert", True))
        lu_name = (cmd.get("luName") or "").strip() or None
        code_page = str(cmd.get("codePage") or "037")
        # A typographic multiplication sign is an easy thing to paste in.
        ps_size = str(cmd.get("psSize") or "24x80").replace("\u00d7", "x")
        sec_level = cmd.get("secLevel")
        tn3270e = bool(cmd.get("tn3270e", True))

        tns = Tnz(name=self.session_id)
        # Advertising colour in the query reply is what invites the host to
        # send extended colour orders; without it we only get field colours.
        tns.capable_color = bool(cmd.get("capableColor", True))
        tns.use_tn3270e = tn3270e
        tns.lu_name = lu_name
        try:
            tns.encoding = f"cp{code_page}"
            # Character set 0xF1 carries the APL/line-drawing glyphs ISPF uses
            # for panel borders. tnz only wires this up for a UTF-8 tty, and
            # our stdout is a pipe.
            from tnz import cp310 as _  # noqa: F401  registers the codec

            # A tuple sets the codec for one character set: 0xF1 is the
            # alternate (GE) set, so the code page above stays in place.
            tns.encoding = ("cp310", 0xF1)
        except Exception as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"code page cp{code_page}: {exc}",
                }
            )
            return

        try:
            from tnz import _util

            rows, cols = _util.session_ps_size(ps_size)
            tns.amaxrow, tns.amaxcol = rows, cols
        except Exception as exc:
            # Falling back to 24x80 silently leaves the host free to address
            # rows we do not have, which shows up much later as a lost session.
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"screen size {ps_size}: {exc}",
                }
            )

        try:
            with _connect_lock:
                _set_env("SESSION_SECLEVEL", sec_level)
                try:
                    tns.connect(
                        host, int(port), secure=secure, verifycert=verify
                    )
                finally:
                    _set_env("SESSION_SECLEVEL", None)
        except Exception as exc:
            reason = _explain_failure(exc, tns=tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connect failed: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            return

        self.tns = tns
        # Wait until the transport exists or the session is lost.
        for _ in range(600):
            if tns._transport or tns.seslost:
                break
            tns.wait(timeout=0.05)

        if tns.seslost:
            reason = _seslost_reason(tns.seslost, tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connection lost during connect: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        if not tns._transport:
            reason = (
                f"timed out waiting for {host}:{port} to complete the"
                f" {'TLS ' if secure else ''}handshake. Check the host,"
                f" port, and whether Secure should be"
                f" {'off' if secure else 'on'}."
            )
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": reason,
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        tns.wait(timeout=2.0)
        if tns.seslost:
            reason = _seslost_reason(tns.seslost, tns, secure=secure)
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"connection lost during connect: {reason}",
                }
            )
            self._emit_lost(tns, reason)
            self.tns = None
            return

        tns.updated = False
        emit(
            {
                "op": "status",
                "sessionId": self.session_id,
                "connected": True,
                "tls": bool(secure),
                "lu": tns.lu_name or "",
                "seslost": False,
                "lock": bool(tns.pwait or tns.system_lock_wait),
            }
        )
        self._emit_screen()

    def _emit_lost(self, tns, reason: str) -> None:
        emit(
            {
                "op": "status",
                "sessionId": self.session_id,
                "connected": False,
                "tls": False,
                "lu": getattr(tns, "lu_name", "") or "",
                "seslost": True,
                "lock": True,
                "reason": reason,
            }
        )
        try:
            tns.close()
        except Exception:
            pass

    def _disconnect(self) -> None:
        tns = self.tns
        self.tns = None
        if tns is not None:
            try:
                tns.close()
            except Exception:
                pass
            emit(
                {
                    "op": "status",
                    "sessionId": self.session_id,
                    "connected": False,
                    "tls": False,
                    "lu": "",
                    "seslost": False,
                    "lock": False,
                }
            )

    def _key(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        kind = cmd.get("type")
        value = cmd.get("value") or ""
        try:
            if kind == "chars":
                if cmd.get("insert"):
                    tns.key_ins_data(value)
                else:
                    tns.key_data(value)
            elif kind == "nav":
                method = NAV.get(value)
                if not method:
                    raise TnzError(f"unknown nav {value}")
                getattr(tns, method)()
            elif kind == "aid":
                method = AID.get(value.lower())
                if not method:
                    raise TnzError(f"unknown aid {value}")
                getattr(tns, method)()
            else:
                raise TnzError(f"unknown key type {kind}")
        except TnzError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                    "lock": True,
                }
            )
            return
        self._emit_screen()

    def _click(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        row = int(cmd.get("row") or 1)
        col = int(cmd.get("col") or 1)
        self.last_click = (row, col)
        try:
            tns.set_cursor_position(row, col)
            if cmd.get("double"):
                tns.enter()
        except (TnzError, ValueError) as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                }
            )
            return
        self._emit_screen()

    def _paste(self, cmd: dict) -> None:
        tns = self.tns
        if tns is None:
            return
        try:
            tns.paste_data(cmd.get("text") or "")
        except TnzError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": str(exc),
                }
            )
            return
        self._emit_screen()

    def _wait_unlock(self, tns, timeout_ms: float) -> None:
        """Block until the host gives the keyboard back.

        Sending an AID sets both inhibit flags, so this is what makes a macro
        step wait for the screen the previous step asked for.
        """
        deadline = time.monotonic() + timeout_ms / 1000
        while tns.pwait or tns.system_lock_wait:
            if tns.seslost:
                raise TnzError("the session was lost")
            if time.monotonic() > deadline:
                raise TnzError(
                    f"the host did not respond within {timeout_ms:g} ms"
                )
            tns.wait(timeout=0.1)

    def _macro(self, cmd: dict) -> None:
        """Replay a parsed macro on the session thread.

        Running here rather than feeding the steps in one at a time keeps
        typing and AIDs in order and stops the user's keystrokes interleaving
        with the macro's.
        """
        tns = self.tns
        if tns is None:
            return
        name = cmd.get("name") or ""
        steps = cmd.get("steps") or []
        index = 0
        try:
            for index, step in enumerate(steps, 1):
                kind = step.get("kind")
                if kind == "text":
                    tns.key_data(step.get("value") or "")
                elif kind == "aid":
                    method = AID.get(str(step.get("value")).lower())
                    if not method:
                        raise TnzError(f"unknown aid {step.get('value')}")
                    getattr(tns, method)()
                elif kind == "nav":
                    method = NAV.get(str(step.get("value")))
                    if not method:
                        raise TnzError(f"unknown nav {step.get('value')}")
                    getattr(tns, method)()
                elif kind == "wait":
                    self._wait_unlock(tns, float(step.get("ms") or 10000))
                    self._emit_screen()
                elif kind == "pause":
                    time.sleep(float(step.get("ms") or 0) / 1000)
                else:
                    raise TnzError(f"unknown macro step {kind}")
        except (TnzError, ValueError) as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name} stopped at step {index}: {exc}",
                }
            )
        try:
            self._emit_screen()
        except Exception:
            pass

    def _script(self, cmd: dict) -> None:
        """Run a user Python file against this session.

        The file is executed with a small API (type, enter, on_screen, ask,
        …) and a restricted __builtins__. It runs on the session thread so
        keystrokes cannot interleave. ask() and warn() block until the
        editor answers on the same command queue.
        """
        tns = self.tns
        if tns is None:
            return
        name = cmd.get("name") or ""
        path = cmd.get("path") or ""
        try:
            with open(path, encoding="utf-8") as file:
                source = file.read()
        except OSError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name}: cannot read {path}: {exc}",
                }
            )
            return
        api = _ScriptApi(self, tracing=bool(cmd.get("trace")), name=name)
        if api.tracing:
            api._trace(f"macro {name}: start ({path})")
        try:
            compiled = _compile_script(source, path)
        except SyntaxError as exc:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name}: line {exc.lineno or 1}: "
                    f"{exc.msg}",
                }
            )
            return
        try:
            ns = api.namespace()
            # The click that started the macro belongs to this run only.
            self.last_click = None
            exec(compiled, ns, ns)
        except _ScriptCancelled:
            pass
        except (TnzError, ValueError) as exc:
            api._trace(f"macro {name}: stopped: {exc}")
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name}: {exc}",
                }
            )
        except Exception:
            emit(
                {
                    "op": "error",
                    "sessionId": self.session_id,
                    "message": f"macro {name}: {traceback.format_exc(limit=4)}",
                }
            )
        if api.tracing:
            api._trace(f"macro {name}: end")
        try:
            self._emit_screen()
        except Exception:
            pass

    def _wait_script_reply(self, ask_id: str) -> dict:
        while True:
            if self.stop.is_set() or self.tns is None:
                return {"cancelled": True}
            try:
                cmd = self.commands.get(timeout=0.1)
            except queue.Empty:
                tns = self.tns
                if tns is not None:
                    try:
                        tns.wait(timeout=0.05)
                    except Exception:
                        pass
                    if tns.seslost:
                        return {"cancelled": True}
                    if tns.updated:
                        tns.updated = False
                        try:
                            self._emit_screen()
                        except Exception:
                            pass
                continue
            op = cmd.get("op")
            if op == "scriptReply" and cmd.get("askId") == ask_id:
                return cmd
            if op == "disconnect":
                self.commands.put(cmd)
                return {"cancelled": True}
            # Drop keys while a dialog is up so they cannot land in the field.

    def _transfer(self, cmd: dict) -> None:
        """Run IND$FILE on the session thread.

        tnz drives its own wait loop for the duration, so nothing else can
        touch this Tnz while a transfer is running. Keeping it on the session
        thread is what makes that safe.
        """
        transfer_id = cmd.get("transferId") or ""
        direction = cmd.get("direction")
        local = cmd.get("localPath") or ""
        parms = cmd.get("parms") or ""

        def done(ok: bool, message: str) -> None:
            emit(
                {
                    "op": "transfer",
                    "sessionId": self.session_id,
                    "transferId": transfer_id,
                    "state": "done",
                    "ok": ok,
                    "message": message,
                }
            )

        tns = self.tns
        if tns is None:
            done(False, "not connected")
            return
        if tns.pwait or tns.system_lock_wait:
            done(
                False,
                "the keyboard is locked. IND$FILE is typed as a command, so"
                " the session must be at a ready prompt (TSO READY, ISPF"
                " option 6, or CMS) with the keyboard unlocked.",
            )
            return

        emit(
            {
                "op": "transfer",
                "sessionId": self.session_id,
                "transferId": transfer_id,
                "state": "start",
                "direction": direction,
                "localPath": local,
                "parms": parms,
            }
        )
        idle = float(cmd.get("idleTimeout") or 60)
        tns.wait = _deadline_wait(tns, idle)
        try:
            if direction == "download":
                message = tns.get_file(parms, local)
            elif direction == "upload":
                message = tns.put_file(local, parms)
            else:
                raise TnzError(f"unknown transfer direction {direction}")
        except TnzTransferError as exc:
            done(False, _transfer_reason(exc, tns))
        except (TnzError, OSError) as exc:
            done(False, str(exc))
        except Exception:
            done(False, traceback.format_exc(limit=2))
        else:
            done(True, str(message).strip())
        finally:
            try:
                del tns.wait
            except AttributeError:
                pass
            try:
                self._emit_screen()
            except Exception:
                pass

    def _emit_screen(self) -> None:
        tns = self.tns
        if tns is None:
            return
        rows = tns.maxrow
        cols = tns.maxcol
        text = tns.scrstr(0, 0, rstrip=False)
        # Pad/trim to the current buffer in case of a size race.
        size = rows * cols
        if len(text) < size:
            text = text + (" " * (size - len(text)))
        elif len(text) > size:
            text = text[:size]
        attrs, eff_eh, eff_fg, eff_bg = _effective_planes(tns, size)
        text = _mask_hidden(text, tns.plane_fa, attrs, size)
        cur = tns.curadd
        emit(
            {
                "op": "screen",
                "sessionId": self.session_id,
                "rows": rows,
                "cols": cols,
                "cursorRow": cur // cols + 1,
                "cursorCol": cur % cols + 1,
                "lock": bool(tns.pwait or tns.system_lock_wait),
                "text": text,
                "attr": b64(attrs),
                "fg": b64(eff_fg),
                "bg": b64(eff_bg),
                "eh": b64(eff_eh),
                "extendedColor": bool(tns.extended_color_mode()),
            }
        )


def _effective_planes(tns, size: int) -> tuple:
    """Resolve per-position attributes the way a 3270 display does.

    tnz stores a field attribute only at the field's own position, and
    extended attributes (colour, highlighting) may be set either on the
    field or on individual characters. Every position inherits from the
    nearest preceding field, wrapping around the buffer, and a character
    value overrides the field value.
    """
    plane_fa = tns.plane_fa
    plane_eh = tns.plane_eh
    plane_fg = tns.plane_fg
    plane_bg = tns.plane_bg

    attrs = bytearray(size)
    eff_eh = bytearray(size)
    eff_fg = bytearray(size)
    eff_bg = bytearray(size)

    field_pos = -1
    for i in range(size - 1, -1, -1):
        if plane_fa[i]:
            field_pos = i
            break

    f_fa = f_eh = f_fg = f_bg = 0
    if field_pos >= 0:
        f_fa = plane_fa[field_pos]
        f_eh = plane_eh[field_pos]
        f_fg = plane_fg[field_pos]
        f_bg = plane_bg[field_pos]

    for i in range(size):
        if plane_fa[i]:
            f_fa = plane_fa[i]
            f_eh = plane_eh[i]
            f_fg = plane_fg[i]
            f_bg = plane_bg[i]
            # The attribute byte takes up a screen position but belongs to
            # no field, and a 3270 shows it as a plain blank. Leaving its
            # planes at zero stops underscore or reverse video from
            # starting a column early and making the field look wider.
            continue

        attrs[i] = f_fa
        eff_eh[i] = plane_eh[i] or f_eh
        eff_fg[i] = plane_fg[i] or f_fg
        eff_bg[i] = plane_bg[i] or f_bg

    return attrs, eff_eh, eff_fg, eff_bg


def _mask_hidden(text: str, plane_fa, attrs: bytearray, size: int) -> str:
    """Blank non-display fields (passwords) and field attribute positions.

    Masking here keeps hidden characters inside this process.
    """
    chars = list(text)
    for i in range(size):
        if plane_fa[i] or attrs[i] & 0x0C == 0x0C:
            chars[i] = " "
    return "".join(chars)


def get_session(session_id: str) -> Session:
    with _sessions_lock:
        ses = _sessions.get(session_id)
        # A stopped or dead thread cannot serve commands, and queueing to one
        # would look like a session that has gone quiet for no reason.
        if ses is not None and (ses.stop.is_set() or not ses.thread.is_alive()):
            ses = None
        if ses is None:
            ses = Session(session_id)
            _sessions[session_id] = ses
            ses.start()
        return ses


def drop_session(session: Session) -> None:
    """Forget a session, unless a later connect has already replaced it."""
    with _sessions_lock:
        if _sessions.get(session.session_id) is session:
            del _sessions[session.session_id]


def main() -> int:
    emit({"op": "ready"})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"op": "error", "sessionId": "", "message": f"bad json: {exc}"})
            continue

        op = cmd.get("op")
        if op == "shutdown":
            with _sessions_lock:
                sessions = list(_sessions.values())
            for ses in sessions:
                ses.stop.set()
                ses.commands.put({"op": "disconnect"})
            break

        session_id = cmd.get("sessionId") or ""
        if not session_id:
            emit({"op": "error", "sessionId": "", "message": "sessionId required"})
            continue
        get_session(session_id).commands.put(cmd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
