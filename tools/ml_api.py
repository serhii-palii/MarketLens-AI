#!/usr/bin/env python3
# FILE: tools/ml_api.py
# Shared helper for the tools: signs in to the app and calls its API with curl, never printing private details.
import contextlib
import getpass
import json
import os
import subprocess
import sys
import tempfile


class Api:
    """Calls the app with curl so the system certificate store is used."""

    def __init__(self, base, jar):
        self.base = base.rstrip("/")
        self.jar = jar

    def call(self, method, path, body=None):
        command = ["curl", "-s", "-S", "--max-time", "90", "-b", self.jar, "-c", self.jar, "-X", method,
                   "-H", "Content-Type: application/json", "-w", "\n%{http_code}", self.base + path]
        if body is not None:
            command += ["--data-binary", "@-"]
        result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                capture_output=True, text=True)
        if result.returncode != 0:
            return 0, {"error": "network_error"}
        text, _, status = result.stdout.rpartition("\n")
        try:
            return int(status), (json.loads(text) if text.strip() else {})
        except ValueError:
            return int(status or 0), {"error": "unreadable_response"}


@contextlib.contextmanager
def session():
    """Asks for the app address and owner key (neither is printed or stored) and yields a signed-in Api."""
    base = os.environ.get("ML_BASE") or input("App address (for example https://name.workers.dev): ").strip()
    key = getpass.getpass("Owner access key (hidden): ")
    with tempfile.TemporaryDirectory() as folder:
        api = Api(base, os.path.join(folder, "jar"))
        status, _ = api.call("POST", "/api/auth/login", {"accessKey": key})
        if status != 200:
            sys.exit(f"Login failed (HTTP {status}). Nothing else was done.")
        print("Logged in.")
        yield api