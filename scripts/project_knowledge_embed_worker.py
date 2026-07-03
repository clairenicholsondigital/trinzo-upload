#!/usr/bin/env python3
"""Process queued project knowledge chunk embeddings."""
from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import contextmanager
from typing import Any

from project_knowledge_embeddings import embed_texts


def db_kwargs() -> dict[str, Any]:
    if os.getenv("DATABASE_URL"):
        return {"dsn": os.environ["DATABASE_URL"]}
    return {
        "host": os.getenv("PGHOST"),
        "port": int(os.getenv("PGPORT", "5432")),
        "dbname": os.getenv("PGDATABASE"),
        "user": os.getenv("PGUSER"),
        "password": os.getenv("PGPASSWORD"),
    }


@contextmanager
def connect():
    try:
        import psycopg2
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"psycopg2 unavailable: {exc}") from exc
    kwargs = db_kwargs()
    if "dsn" in kwargs:
        conn = psycopg2.connect(kwargs["dsn"])
    else:
        conn = psycopg2.connect(**kwargs)
    try:
        yield conn
    finally:
        conn.close()


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def process_queue(project_id: int | None = None, item_id: int | None = None, batch_size: int | None = None, max_attempts: int | None = None) -> dict[str, Any]:
    batch_size = batch_size or int(os.getenv("PROJECT_KNOWLEDGE_EMBED_BATCH_SIZE", "20"))
    max_attempts = max_attempts or int(os.getenv("PROJECT_KNOWLEDGE_EMBED_MAX_ATTEMPTS", "3"))
    stats = {"ok": True, "processed": 0, "embedded": 0, "failed": 0, "skippedEmpty": 0, "queuedLeft": 0}

    try:
        import psycopg2.extras
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "error": f"psycopg2 unavailable: {exc}", "processed": 0, "embedded": 0, "failed": 0, "skippedEmpty": 0, "queuedLeft": 0}
    with connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters = ["embedding_status IN ('queued','failed','processing')", "embedding_attempts < %s"]
            params: list[Any] = [max_attempts]
            if project_id:
                filters.append("project_id = %s")
                params.append(project_id)
            if item_id:
                filters.append("item_id = %s")
                params.append(item_id)
            params.append(batch_size)
            cur.execute(
                f"""
                SELECT id, chunk_text
                FROM project_knowledge_chunks
                WHERE {' AND '.join(filters)}
                ORDER BY embedding_enqueued_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT %s
                """,
                params,
            )
            rows = list(cur.fetchall())
            ids = [row["id"] for row in rows]
            if ids:
                cur.execute(
                    "UPDATE project_knowledge_chunks SET embedding_status='processing', embedding_attempts=embedding_attempts+1, updated_at=NOW() WHERE id = ANY(%s)",
                    (ids,),
                )
            conn.commit()

        if not rows:
            return stats

        texts = [str(row["chunk_text"] or "") for row in rows]
        non_empty = [text for text in texts if text.strip()]
        if not non_empty:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE project_knowledge_chunks SET embedding_status='skipped_empty', embedding_processed_at=NOW(), updated_at=NOW() WHERE id = ANY(%s)",
                    (ids,),
                )
            conn.commit()
            stats["processed"] = len(ids)
            stats["skippedEmpty"] = len(ids)
            return stats

        embeddings, diagnostics = embed_texts(non_empty)
        if not diagnostics.get("available"):
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE project_knowledge_chunks SET embedding_status='queued', embedding_error=%s, updated_at=NOW() WHERE id = ANY(%s)",
                    (diagnostics.get("reason") or "MiniLM unavailable", ids),
                )
            conn.commit()
            stats.update({"ok": False, "error": diagnostics.get("reason") or "MiniLM unavailable", "processed": len(ids)})
            return stats

        with conn.cursor() as cur:
            for row in rows:
                text = str(row["chunk_text"] or "")
                if not text.strip():
                    cur.execute(
                        "UPDATE project_knowledge_chunks SET embedding_status='skipped_empty', embedding_processed_at=NOW(), updated_at=NOW() WHERE id=%s",
                        (row["id"],),
                    )
                    stats["skippedEmpty"] += 1
                    continue
                embedding = embeddings.get(text) or embeddings.get(text.strip())
                if not embedding:
                    cur.execute(
                        "UPDATE project_knowledge_chunks SET embedding_status='failed', embedding_error='No embedding returned', embedding_processed_at=NOW(), updated_at=NOW() WHERE id=%s",
                        (row["id"],),
                    )
                    stats["failed"] += 1
                    continue
                cur.execute(
                    "UPDATE project_knowledge_chunks SET embedding=%s::vector, embedding_status='embedded', embedding_error=NULL, embedding_processed_at=NOW(), updated_at=NOW() WHERE id=%s",
                    (vector_literal(embedding), row["id"]),
                )
                stats["embedded"] += 1
            cur.execute("SELECT COUNT(*) FROM project_knowledge_chunks WHERE embedding_status IN ('queued','failed') AND embedding_attempts < %s", (max_attempts,))
            stats["queuedLeft"] = int(cur.fetchone()[0])
        conn.commit()
        stats["processed"] = len(rows)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", type=int)
    parser.add_argument("--item-id", type=int)
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--max-attempts", type=int)
    args = parser.parse_args()
    print(json.dumps(process_queue(args.project_id, args.item_id, args.batch_size, args.max_attempts)))


if __name__ == "__main__":
    main()
