from __future__ import annotations

import copy
import json
import re
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import game


class GameStore:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL)")

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=20)
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self, language: str, difficulty: str):
        data = game.new_game(language, difficulty)
        key = secrets.token_urlsafe(32)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT COUNT(*) FROM games").fetchone()[0] >= 1000:
                raise ValueError("Save capacity reached. Resume an existing game.")
            db.execute("INSERT INTO games VALUES (?, ?)", (key, json.dumps(data, ensure_ascii=False)))
        return {"game_id": key, **game.view(data, 0)}

    def _load(self, db, key):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
            raise ValueError("Game not found. Use the exact game_id returned by start_game.")
        row = db.execute("SELECT data FROM games WHERE id = ?", (key,)).fetchone()
        if row is None:
            raise ValueError("Game not found. Use the exact game_id returned by start_game.")
        return json.loads(row[0])

    def get(self, key):
        with self.connection() as db:
            return {"game_id": key, **game.view(self._load(db, key))}

    def history(self, key, offset=0, limit=30):
        with self.connection() as db:
            data = self._load(db, key)
        end = offset + limit
        return {"game_id": key, "events": data["history"][offset:end],
                "next_offset": end if end < len(data["history"]) else None,
                "chapter_summaries": data["summaries"]}

    def mutate(self, key, action, turn, choice=None, note=""):
        signature = {"action": action, "turn": turn, "choice": choice, "note": note}
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            data = self._load(db, key)
            prior = data.get("last_action")
            if prior and prior["signature"] == signature:
                return copy.deepcopy(prior["response"])
            history_from = len(data["history"])
            if action == "choose":
                game.choose(data, turn, choice, note)
            elif action == "continue":
                game.continue_game(data, turn)
            else:
                raise ValueError("Unsupported action")
            response = {"game_id": key, **game.view(data, history_from)}
            data["last_action"] = {"signature": signature, "response": response}
            db.execute("UPDATE games SET data = ? WHERE id = ?", (json.dumps(data, ensure_ascii=False), key))
            return response
