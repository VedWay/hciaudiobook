"""Accessible RAG Audiobook backend."""
import sys
from pathlib import Path

# The `ingestion` package lives at the repository root so it can also be used
# from the command line; make it importable when running from `backend/`.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
