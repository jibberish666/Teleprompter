#!/usr/bin/env python3
"""Local AI Teleprompter server.

Co-hosts HTTP (static UI) and WebSocket (sync + optional browser audio) on a
single port using the `websockets` library. Owns the microphone via
`sounddevice`, runs a local Whisper model (`faster-whisper`) and broadcasts a
`word_index` to the browser so the prompter scrolls in sync with speech.
"""
import argparse
import asyncio
import json
import os
import socket

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

import audio_capture
import config
import session
import transcriber

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
CONFIG_FILE = os.path.join(ROOT, "teleprompter.json")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}

DEFAULTS = {
    "port": 8000,
    "host": "127.0.0.1",
    "profile": "fast",
    "model": "base.en",
    "compute_type": "int8",
    "mic": None,
    "tick": 1.2,
    "window": 4.0,
    "align_window": 5,
    "align_tolerance": 5,
}


def load_persisted_config():
    return config.load_config(CONFIG_FILE)


def save_persisted_config(port=None, mic=None):
    cfg = config.load_config(CONFIG_FILE)
    if port is not None:
        cfg["server"]["port"] = port
    if mic is not None:
        cfg["audio"]["device_id"] = str(mic)
    config.save_config(cfg, CONFIG_FILE)


def env(name, default):
    val = os.environ.get(name)
    return val if val not in (None, "") else default


def build_parser():
    cfg = load_persisted_config()
    server_cfg = cfg.get("server", {})
    engine_cfg = cfg.get("engine", {})
    audio_cfg = cfg.get("audio", {})

    parser = argparse.ArgumentParser(
        prog="teleprompter",
        description="100% local AI teleprompter server",
    )
    parser.add_argument("--host", default=env("TELEPROMPTER_HOST", server_cfg.get("host", DEFAULTS["host"])))
    parser.add_argument(
        "--port",
        type=int,
        default=int(env("TELEPROMPTER_PORT", server_cfg.get("port", DEFAULTS["port"]))),
    )
    parser.add_argument("--profile", default=env("TELEPROMPTER_PROFILE", engine_cfg.get("profile", DEFAULTS["profile"])))
    parser.add_argument("--model", default=env("TELEPROMPTER_MODEL", engine_cfg.get("model", None)))
    parser.add_argument(
        "--compute-type",
        default=env("TELEPROMPTER_COMPUTE_TYPE", engine_cfg.get("compute_type", DEFAULTS["compute_type"])),
    )
    parser.add_argument("--device", default=env("TELEPROMPTER_DEVICE", engine_cfg.get("device", "cpu")))
    parser.add_argument("--mic", default=env("TELEPROMPTER_MIC", audio_cfg.get("device_id", DEFAULTS["mic"])))
    parser.add_argument("--tick", type=float, default=None)
    parser.add_argument("--window", type=float, default=None)
    parser.add_argument("--align-window", type=int, default=engine_cfg.get("align_window", DEFAULTS["align_window"]))
    parser.add_argument("--align-tolerance", type=int, default=engine_cfg.get("align_tolerance", DEFAULTS["align_tolerance"]))
    parser.add_argument(
        "--browser-audio",
        action="store_true",
        help="Browser streams 16kHz PCM over WebSocket instead of the backend mic "
        "(macOS double-mic escape hatch).",
    )
    return parser





class SyncHub:
    """Broadcasts payloads to all connected WebSocket clients."""

    def __init__(self, loop):
        self.loop = loop
        self._queues = set()

    def register(self, q):
        self._queues.add(q)

    def unregister(self, q):
        self._queues.discard(q)

    def schedule(self, payload):
        # Safe to call from the transcriber thread.
        if not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._publish, payload)

    def _publish(self, payload):
        text = json.dumps(payload)
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()
                except Exception:
                    pass
            q.put_nowait(text)


async def _sender(ws, q):
    try:
        while True:
            text = await q.get()
            await ws.send(text)
    except Exception:
        return


async def static_handler(_connection, request):
    """Serve static files for plain HTTP GETs; let WebSocket upgrades through."""
    if (request.headers.get("Upgrade") or "").lower() == "websocket":
        return None

    if request.method != "GET":
        body = b"Method Not Allowed"
        return Response(405, "Method Not Allowed", Headers({"Content-Type": "text/plain", "Content-Length": str(len(body))}), body)

    path = request.path.split("?", 1)[0].split("#", 1)[0]
    if path in ("/", "/index.html"):
        rel = "index.html"
    elif path.startswith("/static/"):
        rel = path[len("/static/"):]
    else:
        rel = path.lstrip("/")
    static_root = os.path.realpath(STATIC)
    full = os.path.realpath(os.path.join(static_root, rel))
    if full != static_root and not full.startswith(static_root + os.sep):
        body = b"Forbidden"
        return Response(403, "Forbidden", Headers({"Content-Type": "text/plain", "Content-Length": str(len(body))}), body)
    if not os.path.isfile(full):
        body = b"Not Found"
        return Response(404, "Not Found", Headers({"Content-Type": "text/plain", "Content-Length": str(len(body))}), body)

    try:
        with open(full, "rb") as fh:
            body = fh.read()
    except OSError:
        body = b"Not Found"
        return Response(404, "Not Found", Headers({"Content-Type": "text/plain", "Content-Length": str(len(body))}), body)

    ct = MIME.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
    return Response(
        200,
        "OK",
        Headers({
            "Content-Type": ct,
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        }),
        body,
    )


async def main(args):
    loop = asyncio.get_running_loop()
    hub = SyncHub(loop)

    prompter = session.PrompterSession(
        event_sink=hub.schedule,
        on_config_save=save_persisted_config,
        config_path=CONFIG_FILE,
        mic=args.mic,
        browser_audio=args.browser_audio,
        profile=args.profile,
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        tick=args.tick,
        window=args.window,
        align_window=args.align_window,
        align_tolerance=args.align_tolerance,
        host=args.host,
        port=args.port,
    )

    async def handle_client(ws):
        out = asyncio.Queue(maxsize=256)
        hub.register(out)
        sender = asyncio.create_task(_sender(ws, out))
        try:
            for init_msg in prompter.get_initial_messages():
                await out.put(json.dumps(init_msg))
            async for raw in ws:
                prompter.dispatch(raw)
        except Exception:
            pass
        finally:
            hub.unregister(out)
            sender.cancel()

    # Bind first: if port is in use or bind fails, background threads won't be orphaned.
    async with serve(
        handle_client,
        args.host,
        args.port,
        process_request=static_handler,
        max_size=2 * 1024 * 1024,
        compression=None,
    ) as server:
        save_persisted_config(port=args.port)
        prompter.start()

        shown = ", ".join(str(s.getsockname()) for s in server.sockets) \
            if server.sockets else f"{args.host}:{args.port}"
        print(f"Local AI Teleprompter listening on {shown}", flush=True)
        print(f"  Open http://{args.host}:{args.port} in your browser", flush=True)
        print(f"  Mic backend: {'browser-audio (WS)' if prompter.is_browser_audio else 'sounddevice'}", flush=True)
        print(f"  Profile: {prompter.profile} (model={prompter.model_name}, tick={prompter.tick}s, compute_type={args.compute_type})", flush=True)
        print("  First run downloads the model if needed. Press Ctrl+C to stop.", flush=True)
        try:
            await asyncio.Future()
        finally:
            prompter.shutdown()


if __name__ == "__main__":
    parser = build_parser()
    args = parser.parse_args()
    if args.browser_audio:
        print("Browser-audio mode: microphone will be owned by the browser.", flush=True)
    else:
        audio_capture.AudioSource.report_devices()
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\nShutting down.")