"""Document ingestion: PDF/text parsing, chunking, embeddings and the Qdrant store.

This package is deliberately independent of the web backend so it can be run
from the command line (``python -m ingestion some.pdf``) and unit-tested alone.
"""
