"""SQLAlchemy engine and session helpers."""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


_url = get_settings().sqlalchemy_url
_is_sqlite = _url.startswith("sqlite")
engine = create_engine(_url, connect_args={"check_same_thread": False} if _is_sqlite else {})

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")  # readers are not blocked while a book is ingested
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

# Columns added after the first release. create_all() creates missing tables but never alters
# existing ones, so a database created by an earlier version needs these added by hand.
_ADDED_COLUMNS = {"document_chunks": {"paragraph_starts": "JSON"}}


def add_missing_columns(bind=engine) -> list[str]:
    """Bring an older database up to date. Returns the columns it added (for logging and tests)."""
    added = []
    inspector = inspect(bind)
    with bind.begin() as connection:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {column["name"] for column in inspector.get_columns(table)}
            for name, ddl_type in columns.items():
                if name not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl_type}"))
                    added.append(f"{table}.{name}")
    return added


def init_db() -> None:
    from .models import tables  # noqa: F401  (registers the models)

    Base.metadata.create_all(engine)
    add_missing_columns()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
