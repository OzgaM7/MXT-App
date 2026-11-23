"""Lokalna baza SQLite bota: rezerwacje (kalendarz lokalny) i rejestr rozmów z kolejką wysyłki do aplikacji MXT."""

import asyncio
import json
import sqlite3
import threading
from datetime import datetime, timezone

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS rezerwacje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dzial TEXT NOT NULL,
  poczatek TEXT NOT NULL,           -- ISO UTC
  koniec TEXT NOT NULL,
  call_sid TEXT,
  opis TEXT NOT NULL DEFAULT '',
  dane TEXT NOT NULL DEFAULT '{}',
  utworzono TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rezerwacje_dzial_idx ON rezerwacje(dzial, poczatek);
CREATE TABLE IF NOT EXISTS rozmowy (
  call_sid TEXT PRIMARY KEY,
  dane TEXT NOT NULL,               -- pełne zdarzenie rozmowy (to samo, co idzie do aplikacji MXT)
  utworzono TEXT NOT NULL,
  wyslano TEXT,                     -- NULL = jeszcze nie dotarło do aplikacji MXT
  proby INTEGER NOT NULL DEFAULT 0,
  blad TEXT NOT NULL DEFAULT ''
);
"""


def _teraz() -> str:
    return datetime.now(timezone.utc).isoformat()


class Baza:
    def __init__(self, sciezka: str):
        self.sciezka = sciezka
        with self._polacz() as db:
            db.executescript(SCHEMA)

    def _polacz(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.sciezka, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    # ---------- rezerwacje (kalendarz lokalny) ----------
    def _zajete(self, dzial: str, od: datetime, do: datetime) -> list[tuple[datetime, datetime]]:
        with self._polacz() as db:
            rows = db.execute("SELECT poczatek, koniec FROM rezerwacje WHERE dzial = ? AND koniec > ? AND poczatek < ?",
                              (dzial, od.astimezone(timezone.utc).isoformat(), do.astimezone(timezone.utc).isoformat())).fetchall()
        return [(datetime.fromisoformat(r["poczatek"]), datetime.fromisoformat(r["koniec"])) for r in rows]

    def _rezerwuj(self, dzial: str, start: datetime, koniec: datetime, call_sid: str, opis: str, dane: dict) -> int | None:
        """Zapis z kontrolą kolizji w jednej transakcji (BEGIN IMMEDIATE) – dwie rozmowy naraz nie zajmą tego samego terminu."""
        s, k = start.astimezone(timezone.utc).isoformat(), koniec.astimezone(timezone.utc).isoformat()
        with _lock, self._polacz() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if db.execute("SELECT 1 FROM rezerwacje WHERE dzial = ? AND koniec > ? AND poczatek < ?", (dzial, s, k)).fetchone():
                    db.execute("ROLLBACK")
                    return None
                cur = db.execute("INSERT INTO rezerwacje (dzial, poczatek, koniec, call_sid, opis, dane, utworzono) VALUES (?,?,?,?,?,?,?)",
                                 (dzial, s, k, call_sid, opis, json.dumps(dane, ensure_ascii=False), _teraz()))
                db.execute("COMMIT")
                return cur.lastrowid
            except Exception:
                db.execute("ROLLBACK")
                raise

    async def zajete(self, dzial: str, od: datetime, do: datetime):
        return await asyncio.to_thread(self._zajete, dzial, od, do)

    async def rezerwuj(self, dzial: str, start: datetime, koniec: datetime, call_sid: str, opis: str, dane: dict):
        return await asyncio.to_thread(self._rezerwuj, dzial, start, koniec, call_sid, opis, dane)

    # ---------- rejestr rozmów i kolejka wysyłki ----------
    def _zapisz_rozmowe(self, zdarzenie: dict) -> None:
        with _lock, self._polacz() as db:
            db.execute("INSERT INTO rozmowy (call_sid, dane, utworzono) VALUES (?, ?, ?) ON CONFLICT(call_sid) DO UPDATE SET dane = excluded.dane",
                       (zdarzenie["call_sid"], json.dumps(zdarzenie, ensure_ascii=False), _teraz()))

    def _oznacz(self, call_sid: str, ok: bool, blad: str = "") -> None:
        with _lock, self._polacz() as db:
            if ok:
                db.execute("UPDATE rozmowy SET wyslano = ?, blad = '', proby = proby + 1 WHERE call_sid = ?", (_teraz(), call_sid))
            else:
                db.execute("UPDATE rozmowy SET blad = ?, proby = proby + 1 WHERE call_sid = ?", (blad[:500], call_sid))

    def _do_wyslania(self, limit: int = 50) -> list[dict]:
        with self._polacz() as db:
            rows = db.execute("SELECT dane FROM rozmowy WHERE wyslano IS NULL AND proby < 50 ORDER BY utworzono LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["dane"]) for r in rows]

    async def zapisz_rozmowe(self, zdarzenie: dict):
        await asyncio.to_thread(self._zapisz_rozmowe, zdarzenie)

    async def oznacz(self, call_sid: str, ok: bool, blad: str = ""):
        await asyncio.to_thread(self._oznacz, call_sid, ok, blad)

    async def do_wyslania(self, limit: int = 50) -> list[dict]:
        return await asyncio.to_thread(self._do_wyslania, limit)
