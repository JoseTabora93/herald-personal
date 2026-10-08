"""SQLite state, transactional migrations and short, serialized mutations."""

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
 status TEXT NOT NULL CHECK(status IN ('inbox','next','in_progress','waiting','done','cancelled')),
 priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')), due_at TEXT,
 source_type TEXT NOT NULL, source_id TEXT, project TEXT, agent_task_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE UNIQUE INDEX tasks_source ON tasks(source_type,source_id) WHERE source_id IS NOT NULL;
CREATE INDEX tasks_status ON tasks(status,due_at);
CREATE TABLE task_events (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
 created_at TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE idempotency (
 key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE checkins (
 id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, accomplished TEXT NOT NULL,
 pending TEXT NOT NULL, tomorrow TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE checkin_events (
 id TEXT PRIMARY KEY, checkin_id TEXT NOT NULL REFERENCES checkins(id),
 created_at TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE provider_state (
 provider TEXT PRIMARY KEY, cursor TEXT, last_sync_at TEXT, error TEXT
);
CREATE TABLE mail (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
 subject TEXT NOT NULL, sender TEXT NOT NULL, preview TEXT NOT NULL, body TEXT NOT NULL,
 received_at TEXT NOT NULL, category TEXT NOT NULL, category_manual INTEGER NOT NULL DEFAULT 0,
 unread INTEGER NOT NULL, web_url TEXT, task_id TEXT REFERENCES tasks(id),
 archived INTEGER NOT NULL,
 location TEXT NOT NULL, UNIQUE(provider,provider_id)
);
CREATE INDEX mail_received ON mail(received_at DESC);
CREATE TABLE mail_events (
 id TEXT PRIMARY KEY, mail_id TEXT NOT NULL REFERENCES mail(id),
 kind TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE mail_actions (
 id TEXT PRIMARY KEY, mail_id TEXT NOT NULL REFERENCES mail(id), kind TEXT NOT NULL,
 fingerprint TEXT NOT NULL, state TEXT NOT NULL, previous TEXT NOT NULL,
 result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX mail_action_lookup ON mail_actions(mail_id,kind,created_at);
"""

AGENT_SCHEMA = """
CREATE TABLE agent_runs (
 run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
 payload_hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_run_events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL,
 UNIQUE(run_id,revision)
);
"""


class Database:
    def __init__(self, directory: Path):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "personal.sqlite3"
        if self.path.is_symlink():
            raise ValueError("El archivo de estado no puede ser un enlace simbólico.")
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        self.path.chmod(0o600)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > 2:
                raise ValueError("La base de datos requiere una versión más reciente del servicio.")
            if version == 0:
                connection.executescript(
                    "BEGIN IMMEDIATE;\n" + SCHEMA + "PRAGMA user_version=1; COMMIT;"
                )
            if version < 2:
                connection.executescript(
                    "BEGIN IMMEDIATE;\n" + AGENT_SCHEMA + "PRAGMA user_version=2; COMMIT;"
                )

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
