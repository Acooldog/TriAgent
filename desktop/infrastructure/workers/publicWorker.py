"""Public-facing worker entry point.

Delegates to the full worker implementation in src/Presentation/worker.py
for all operations (ping, decrypt, agent).
"""

from __future__ import annotations

import pathlib
import sys

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from src.Presentation.worker import main as _worker_main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(_worker_main())
