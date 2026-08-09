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

import sounddevice as sd
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

import audio_capture
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
    ".json": "application/json; charset=utf-8",
}

DEFAULTS = {
    "port": 8000,
    "host": "127.0.0.1",
    "model": "base.en",
    "compute_type": "int8",
    "mic": None,
    "tick": 1.2,
    "window": 4.0,
    "align_window": 5,
    "align_tolerance": 3,
}


def load_persisted_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_persisted_config(port):
    cfg = load_persisted_config()
    cfg["port"] = port
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
    except Exception:
        pass


def env(name, default):
    val = os.environ.get(name)
    return val if val not in (None, "") else default


def build_parser():
    cfg = load_persisted_config()
    parser = argparse.ArgumentParser(
        prog="teleprompter",
        description="100% local AI teleprompter server",
    )
    parser.add_argument("--host", default=env("TELEPROMPTER_HOST", DEFAULTS["host"]))
    parser.add_argument(
        "--port",
        type=int,
        default=int(env("TELEPROMPTER_PORT", cfg.get("port", DEFAULTS["port"]))),
    )
    parser.add_argument("--model", default=env("TELEPROMPTER_MODEL", DEFAULTS["model"]))
    parser.add_argument(
        "--compute-type",
        default=env("TELEPROMPTER_COMPUTE_TYPE", DEFAULTS["compute_type"]),
    )
    parser.add_argument("--device", default=env("TELEPROMPTER_DEVICE", "cpu"))
    parser.add_argument("--mic", default=env("TELEPROMPTER_MIC", DEFAULTS["mic"]))
    parser.add_argument("--tick", type=float, default=DEFAULTS["tick"])
    parser.add_argument("--window", type=float, default=DEFAULTS["window"])
    parser.add_argument("--align-window", type=int, default=DEFAULTS["align_window"])
    parser.add_argument("--align-tolerance", type=int, default=DEFAULTS["align_tolerance"])
    parser.add_argument(
        "--browser-audio",
        action="store_true",
        help="Browser streams 16kHz PCM over WebSocket instead of the backend mic "
        "(macOS double-mic escape hatch).",
    )
    return parser


def resolve_mic(name):
    if not name:
        return None
    try:
        return int(name)
    except (TypeError, ValueError):
        pass
    target = str(name)
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0 and target.lower() in dev["name"].lower():
            return idx
    return target


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

    path = request.path
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
    return Response(200, "OK", Headers({"Content-Type": ct, "Content-Length": str(len(body))}), body)


async def main(args):
    loop = asyncio.get_running_loop()
    hub = SyncHub(loop)

    mic = resolve_mic(args.mic)
    capture = audio_capture.AudioCapture(mic=mic, browser_audio=args.browser_audio)

    def _on_sync(idx):
        hub.schedule({"type": "sync", "word_index": idx, "state": "speaking"})

    def _on_status(payload):
        if payload.get("ready") in (True, False):
            # One-time readiness broadcast also carries source config.
            payload = {**payload, "browser_audio": args.browser_audio,
                       "host": args.host, "port": args.port}
        hub.schedule({"type": "status", **payload})

    def _on_error(message):
        hub.schedule({"type": "error", "message": message})

    trans = transcriber.Transcriber(
        audio=capture,
        model_name=args.model,
        device=args.device,
        compute_type=args.compute_type,
        window=args.window,
        tick=args.tick,
        align_window=args.align_window,
        align_tolerance=args.align_tolerance,
        on_sync=_on_sync,
        on_status=_on_status,
        on_error=_on_error,
    )

    async def handle_client(ws):
        out = asyncio.Queue(maxsize=256)
        hub.register(out)
        sender = asyncio.create_task(_sender(ws, out))
        try:
            await out.put(json.dumps({"type": "config", "browser_audio": args.browser_audio}))
            await out.put(json.dumps({
                "type": "status",
                **({} if not trans.is_ready else {"model": args.model}),
                "ready": trans.is_ready,
            }))
            async for raw in ws:
                await handle_message(raw)
        except Exception:
            pass
        finally:
            hub.unregister(out)
            sender.cancel()

    async def handle_message(raw):
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            return
        mtype = msg.get("type")
        if mtype == "start":
            words = msg.get("words") or []
            if not trans.is_ready:
                hub.schedule({"type": "error", "message": "Model still loading. Try again shortly."})
                return
            if not words:
                hub.schedule({"type": "error", "message": "No transcript to run."})
                return
            trans.begin(words)
            hub.schedule({"type": "status", "state": "running", "running": True})
        elif mtype == "stop":
            trans.stop()
            hub.schedule({"type": "status", "state": "stopped", "running": False})
        elif mtype == "audio" and args.browser_audio:
            data = msg.get("data")
            if isinstance(data, list) and data:
                import numpy as np
                capture.write_frames(np.asarray(data, dtype=np.float32))
            elif msg.get("b64"):
                pass

    capture.start()
    trans.start_loading_async()
    trans.start_loop()

    save_persisted_config(args.port)

    # Slight backlog so slow transcription / large model download don't block UI.
    async with serve(
        handle_client,
        args.host,
        args.port,
        process_request=static_handler,
        max_size=2 * 1024 * 1024,
        compression=None,
    ) as server:
        shown = ", ".join(str(s.getsockname()) for s in server.sockets) \
            if server.sockets else f"{args.host}:{args.port}"
        print(f"Local AI Teleprompter listening on {shown}", flush=True)
        print(f"  Open http://{args.host}:{args.port} in your browser", flush=True)
        print(f"  Mic backend: {'browser-audio (WS)' if args.browser_audio else 'sounddevice'}", flush=True)
        print(f"  Model: {args.model} (compute_type={args.compute_type})", flush=True)
        print("  First run downloads the model (~145MB). Press Ctrl+C to stop.", flush=True)
        try:
            await asyncio.Future()
        finally:
            trans.shutdown()
            capture.stop()


def _report_device():
    print("Input devices:")
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            name = dev["name"]
            mark = " <-- default" if idx == sd.default.device[0] else ""
            print(f"  [{idx}] {name}{mark}")


if __name__ == "__main__":
    parser = build_parser()
    args = parser.parse_args()
    if args.browser_audio:
        print("Browser-audio mode: microphone will be owned by the browser.", flush=True)
    else:
        _report_device()
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\nShutting down.")