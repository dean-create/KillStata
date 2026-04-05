#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

SERVER_NAME = "killstata-stata-mcp"
SERVER_VERSION = "0.1.0"
DEFAULT_SESSION_ID = "default"
EDITIONS = ("mp", "se", "be")
MESSAGE_MODE = "newline"


def write_message(payload):
    data = json.dumps(payload, ensure_ascii=False)
    if MESSAGE_MODE == "content-length":
        encoded = data.encode("utf-8")
        sys.stdout.buffer.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii"))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
        return

    sys.stdout.write(data + "\n")
    sys.stdout.flush()


def read_message():
    global MESSAGE_MODE

    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None

        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith(b"{") or stripped.startswith(b"["):
            MESSAGE_MODE = "newline"
            return json.loads(stripped.decode("utf-8"))

        headers = {}
        current = line
        while True:
            if current in (b"\r\n", b"\n"):
                break
            key, _, value = current.decode("utf-8").partition(":")
            headers[key.strip().lower()] = value.strip()
            current = sys.stdin.buffer.readline()
            if not current:
                return None

        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None

        body = sys.stdin.buffer.read(length)
        if not body:
            return None

        MESSAGE_MODE = "content-length"
        return json.loads(body.decode("utf-8"))


def respond(request_id, result):
    write_message({"jsonrpc": "2.0", "id": request_id, "result": result})


def respond_error(request_id, code, message):
    write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def session_root():
    root = os.environ.get("KILLSTATA_STATA_MCP_HOME")
    if not root:
        root = os.path.join(tempfile.gettempdir(), "killstata-stata-mcp")
    path = Path(root).expanduser().resolve() / "sessions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def normalize_path(path_str):
    return str(Path(path_str.strip().strip("\"'")).expanduser().resolve())


def get_stata_path():
    value = os.environ.get("STATA_PATH", "").strip()
    if not value:
        raise RuntimeError("STATA_PATH is not configured.")
    return normalize_path(value)


def get_stata_edition():
    edition = os.environ.get("STATA_EDITION", "mp").strip().lower()
    if edition not in EDITIONS:
        raise RuntimeError(f"Unsupported STATA_EDITION: {edition}")
    return edition


def resolve_stata_executable():
    candidate = Path(get_stata_path())
    edition = get_stata_edition()

    if candidate.is_file():
        return str(candidate)

    if not candidate.is_dir():
        raise RuntimeError(f"Configured STATA_PATH does not exist: {candidate}")

    if sys.platform == "win32":
        names = {
            "mp": ["StataMP-64.exe", "StataMP.exe", "StataSE-64.exe", "StataSE.exe", "Stata-64.exe", "Stata.exe"],
            "se": ["StataSE-64.exe", "StataSE.exe", "StataMP-64.exe", "StataMP.exe", "Stata-64.exe", "Stata.exe"],
            "be": ["Stata-64.exe", "Stata.exe", "StataSE-64.exe", "StataSE.exe", "StataMP-64.exe", "StataMP.exe"],
        }[edition]
    elif sys.platform == "darwin":
        names = {
            "mp": ["StataMP.app/Contents/MacOS/StataMP", "stata-mp"],
            "se": ["StataSE.app/Contents/MacOS/StataSE", "stata-se"],
            "be": ["Stata.app/Contents/MacOS/Stata", "stata"],
        }[edition]
    else:
        names = {
            "mp": ["stata-mp"],
            "se": ["stata-se"],
            "be": ["stata"],
        }[edition]

    attempted = []
    for name in names:
        resolved = candidate / name
        attempted.append(str(resolved))
        if resolved.exists():
            return str(resolved)

    raise RuntimeError(
        "No Stata executable was found under the configured STATA_PATH.\n"
        + "Attempted:\n- "
        + "\n- ".join(attempted)
    )


SESSIONS = {}


def sanitize_session_id(session_id):
    value = (session_id or DEFAULT_SESSION_ID).strip()
    if not value:
        return DEFAULT_SESSION_ID
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value)
    return safe or DEFAULT_SESSION_ID


def get_session(session_id=None, working_dir=None):
    session_id = sanitize_session_id(session_id)
    session = SESSIONS.get(session_id)
    if session is None:
        base = session_root() / session_id
        base.mkdir(parents=True, exist_ok=True)
        session = {
            "id": session_id,
            "dir": str(base),
            "snapshot": str(base / "state.dta"),
            "cwd": normalize_path(working_dir) if working_dir else os.getcwd(),
            "last_used": time.time(),
            "process": None,
        }
        SESSIONS[session_id] = session
    elif working_dir:
        session["cwd"] = normalize_path(working_dir)

    Path(session["dir"]).mkdir(parents=True, exist_ok=True)
    session["last_used"] = time.time()
    return session


def list_sessions():
    result = []
    for session in SESSIONS.values():
        proc = session.get("process")
        result.append(
            {
                "session_id": session["id"],
                "working_dir": session["cwd"],
                "has_snapshot": Path(session["snapshot"]).exists(),
                "busy": bool(proc and proc.poll() is None),
                "last_used": session["last_used"],
            }
        )
    return result


def destroy_session(session_id):
    session_id = sanitize_session_id(session_id)
    session = SESSIONS.pop(session_id, None)
    if not session:
        return False
    proc = session.get("process")
    if proc and proc.poll() is None:
        proc.kill()
    shutil.rmtree(session["dir"], ignore_errors=True)
    return True


def cancel_session(session_id):
    session = SESSIONS.get(sanitize_session_id(session_id))
    if not session:
        return False
    proc = session.get("process")
    if not proc or proc.poll() is not None:
        return False
    proc.kill()
    return True


def reset_session(session_id):
    session = get_session(session_id)
    snapshot = Path(session["snapshot"])
    if snapshot.exists():
        snapshot.unlink()
    return session


def stata_command(executable, do_file):
    if sys.platform == "win32":
        return [[executable, "/e", "do", do_file], [executable, "/q", "/e", "do", do_file]]
    return [[executable, "-b", "do", do_file], [executable, "-q", "-b", "do", do_file]]


def format_run_output(session, command, exit_code, log_path, output, timeout_hit=False):
    lines = [
        f"session_id: {session['id']}",
        f"working_dir: {session['cwd']}",
        f"exit_code: {exit_code}",
        f"log_path: {log_path}",
        f"snapshot_path: {session['snapshot']}",
    ]
    if timeout_hit:
        lines.append("timed_out: true")
    lines.append("")
    lines.append("command:")
    lines.append(command)
    lines.append("")
    lines.append("output:")
    lines.append(output.strip() or "(no output captured)")
    return "\n".join(lines)


def read_log_output(log_path, stdout_text, stderr_text):
    parts = []
    log_file = Path(log_path)
    if log_file.exists():
        parts.append(log_file.read_text(encoding="utf-8", errors="replace"))
    if stdout_text.strip():
        parts.append(stdout_text.strip())
    if stderr_text.strip():
        parts.append(stderr_text.strip())
    text = "\n\n".join(part.strip() for part in parts if part.strip())
    if len(text) > 12000:
        return text[-12000:]
    return text


def run_stata(session, do_target, timeout):
    executable = resolve_stata_executable()
    session_dir = Path(session["dir"])
    session_dir.mkdir(parents=True, exist_ok=True)
    wrapper_path = session_dir / f"wrapper-{uuid.uuid4().hex}.do"
    log_path = session_dir / f"wrapper-{uuid.uuid4().hex}.log"
    snapshot_path = Path(session["snapshot"])

    wrapper = [
        "capture log close _all",
        f'log using "{log_path}", text replace',
        "set more off",
        f'capture noisily cd "{session["cwd"]}"',
        f'capture confirm file "{snapshot_path}"',
        "if _rc == 0 {",
        f'  capture noisily use "{snapshot_path}", clear',
        "}",
        f'capture noisily do "{do_target}"',
        "local killstata_rc = _rc",
        f'capture noisily save "{snapshot_path}", replace',
        "capture log close _all",
        "exit `killstata_rc'",
    ]
    wrapper_path.write_text("\n".join(wrapper) + "\n", encoding="utf-8")

    last_error = None
    for candidate in stata_command(executable, str(wrapper_path)):
        try:
            proc = subprocess.Popen(
                candidate,
                cwd=session["cwd"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            session["process"] = proc
            stdout_text, stderr_text = proc.communicate(timeout=timeout)
            output = read_log_output(log_path, stdout_text, stderr_text)
            session["process"] = None
            return {
                "exit_code": proc.returncode,
                "command": " ".join(candidate),
                "output": format_run_output(session, " ".join(candidate), proc.returncode, str(log_path), output),
                "timed_out": False,
            }
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout_text, stderr_text = proc.communicate()
            output = read_log_output(log_path, stdout_text, stderr_text)
            session["process"] = None
            return {
                "exit_code": 124,
                "command": " ".join(candidate),
                "output": format_run_output(session, " ".join(candidate), 124, str(log_path), output, timeout_hit=True),
                "timed_out": True,
            }
        except FileNotFoundError as exc:
            last_error = exc
            continue
        finally:
            session["process"] = None

    raise RuntimeError(f"Unable to start Stata executable: {last_error}")


def tool_run_selection(arguments):
    selection = arguments.get("selection", "")
    if not str(selection).strip():
        raise RuntimeError("selection is required")

    timeout = int(arguments.get("timeout", 120))
    session = get_session(arguments.get("session_id"), arguments.get("working_dir"))
    inner = Path(session["dir"]) / f"selection-{uuid.uuid4().hex}.do"
    inner.write_text(str(selection) + "\n", encoding="utf-8")
    return run_stata(session, str(inner), timeout)


def tool_run_file(arguments):
    file_path = arguments.get("file_path", "")
    if not str(file_path).strip():
        raise RuntimeError("file_path is required")

    timeout = int(arguments.get("timeout", 300))
    target = normalize_path(str(file_path))
    if not Path(target).exists():
        raise RuntimeError(f"file_path does not exist: {target}")

    session = get_session(arguments.get("session_id"), arguments.get("working_dir"))
    return run_stata(session, target, timeout)


def tool_session(arguments):
    action = str(arguments.get("action", "list")).strip().lower()
    session_id = arguments.get("session_id")

    if action == "list":
        return {"message": json.dumps({"sessions": list_sessions()}, ensure_ascii=False, indent=2)}
    if action == "reset":
        session = reset_session(session_id)
        return {"message": f"Session {session['id']} was reset."}
    if action == "destroy":
        destroyed = destroy_session(session_id)
        return {"message": f"Session {sanitize_session_id(session_id)} destroyed: {str(destroyed).lower()}"}
    if action == "destroy_all":
        for item in list(SESSIONS.keys()):
            destroy_session(item)
        return {"message": "All sessions destroyed."}
    if action == "cancel":
        cancelled = cancel_session(session_id)
        return {"message": f"Session {sanitize_session_id(session_id)} cancel requested: {str(cancelled).lower()}"}

    raise RuntimeError("Unsupported action. Use list, reset, destroy, destroy_all, or cancel.")


TOOLS = {
    "stata_run_selection": {
        "description": "Run a short Stata command block in a persisted Stata session. Use this for interactive analysis and short code snippets.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selection": {"type": "string", "description": "Stata code to execute."},
                "working_dir": {"type": "string", "description": "Absolute working directory for the Stata session."},
                "session_id": {"type": "string", "description": "Optional session identifier for persistent state."},
                "timeout": {"type": "integer", "minimum": 1, "description": "Timeout in seconds."},
            },
            "required": ["selection"],
            "additionalProperties": False,
        },
        "handler": tool_run_selection,
    },
    "stata_run_file": {
        "description": "Run a .do file in Stata. Prefer this for longer or reproducible workflows.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the .do file to run."},
                "working_dir": {"type": "string", "description": "Absolute working directory for the Stata session."},
                "session_id": {"type": "string", "description": "Optional session identifier for persistent state."},
                "timeout": {"type": "integer", "minimum": 1, "description": "Timeout in seconds."},
            },
            "required": ["file_path"],
            "additionalProperties": False,
        },
        "handler": tool_run_file,
    },
    "stata_session": {
        "description": "List, reset, cancel, or destroy persisted Stata sessions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "reset", "destroy", "destroy_all", "cancel"],
                    "description": "Session operation to perform.",
                },
                "session_id": {"type": "string", "description": "Session identifier for reset, destroy, or cancel."},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        "handler": tool_session,
    },
}


def handle_initialize(request_id, params):
    get_stata_edition()
    resolve_stata_executable()
    respond(
        request_id,
        {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        },
    )


def handle_tools_list(request_id):
    respond(
        request_id,
        {
            "tools": [
                {
                    "name": name,
                    "description": spec["description"],
                    "inputSchema": spec["inputSchema"],
                }
                for name, spec in TOOLS.items()
            ]
        },
    )


def handle_tools_call(request_id, params):
    name = params.get("name", "")
    if name not in TOOLS:
        respond_error(request_id, -32601, f"Unknown tool: {name}")
        return

    try:
        result = TOOLS[name]["handler"](params.get("arguments") or {})
        message = result["message"] if isinstance(result, dict) and "message" in result else result["output"]
        respond(request_id, {"content": [{"type": "text", "text": message}]})
    except Exception as exc:
        respond(
            request_id,
            {
                "content": [{"type": "text", "text": str(exc)}],
                "isError": True,
            },
        )


def main():
    while True:
        request = read_message()
        if request is None:
            break

        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        try:
            if method == "initialize":
                handle_initialize(request_id, params)
            elif method == "notifications/initialized":
                continue
            elif method == "ping" and request_id is not None:
                respond(request_id, {})
            elif method == "tools/list":
                handle_tools_list(request_id)
            elif method == "tools/call":
                handle_tools_call(request_id, params)
            elif request_id is not None:
                respond_error(request_id, -32601, f"Unsupported method: {method}")
        except Exception as exc:
            if request_id is not None:
                respond_error(request_id, -32000, str(exc))


if __name__ == "__main__":
    main()
