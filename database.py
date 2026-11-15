"""Small SQLite/PostgreSQL compatibility layer for Chess Online.

Set DATABASE_URL to a PostgreSQL connection string (for example Neon) to use
PostgreSQL. Otherwise DB_PATH selects a local SQLite database.
"""
import os
import re
import sqlite3


class Database:
    def __init__(self, database_url=None, db_path=None):
        self.is_postgres = bool(database_url or os.environ.get("DATABASE_URL"))
        self.integrity_error = sqlite3.IntegrityError
        if self.is_postgres:
            try:
                import psycopg
                from psycopg.rows import dict_row
            except ImportError as exc:
                raise RuntimeError("PostgreSQL support requires psycopg. Install requirements.txt.") from exc
            url = database_url or os.environ["DATABASE_URL"]
            self.conn = psycopg.connect(url, autocommit=True, row_factory=dict_row, connect_timeout=10)
            self.integrity_error = psycopg.IntegrityError
        else:
            path = db_path or os.environ.get("DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "chess.db")
            parent = os.path.dirname(os.path.abspath(path))
            os.makedirs(parent, exist_ok=True)
            self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")

    def execute(self, sql, params=()):
        if not self.is_postgres:
            return self.conn.execute(sql, params)
        statement = sql.replace("?", "%s")
        statement = re.sub(r"^\s*BEGIN\s+IMMEDIATE\s*$", "BEGIN", statement, flags=re.I)
        if re.match(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+", statement, flags=re.I):
            statement = re.sub(r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+", "INSERT INTO ", statement, flags=re.I)
            statement += " ON CONFLICT DO NOTHING"
        return self.conn.execute(statement, params)

    def executescript(self, script):
        if self.is_postgres:
            # SQLite's INTEGER PRIMARY KEY auto-generates IDs; use BIGSERIAL in PostgreSQL.
            script = re.sub(r"\bid\s+INTEGER\s+PRIMARY\s+KEY\b", "id BIGSERIAL PRIMARY KEY", script, flags=re.I)
            script = re.sub(r"\b(user_id|white_id|black_id)\s+INTEGER\b", r"\1 BIGINT", script, flags=re.I)
        for statement in script.split(";"):
            if statement.strip():
                self.execute(statement)

    def user_columns(self):
        if self.is_postgres:
            rows = self.execute(
                "SELECT column_name AS name FROM information_schema.columns "
                "WHERE table_schema=current_schema() AND table_name='users'"
            )
            return {row["name"] for row in rows}
        return {row["name"] for row in self.execute("PRAGMA table_info(users)")}

    def close(self):
        self.conn.close()
