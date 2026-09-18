#!/usr/bin/env python3
"""Accept a single ephemeral runner credential on stdin, never a host PAT."""

import os
from pathlib import Path
import sys

config = sys.stdin.readline(2 * 1024 * 1024).strip()
if not config or len(config) >= 2 * 1024 * 1024 - 1:
    raise SystemExit("missing or oversized just-in-time runner configuration")
Path.home().mkdir(parents=True, exist_ok=True)
Path(os.environ["RUNNER_TOOL_CACHE"]).mkdir(parents=True, exist_ok=True)
os.environ["ACTIONS_RUNNER_INPUT_JITCONFIG"] = config
os.execv("/opt/actions-runner/bin/Runner.Listener", ["Runner.Listener", "run"])
