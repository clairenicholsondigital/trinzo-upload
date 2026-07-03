#!/usr/bin/env python3
"""Retrieve relevant per-project knowledge chunks with semantic/keyword fallback."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from contextlib import contextmanager
from typing import Any

from project_knowledge_embeddings import embed_texts

STOPWORDS = {"the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "has", "have", "will", "project", "update"}


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
    conn = psycopg2.connect(kwargs["dsn"]) if "dsn" in kwargs else psycopg2.connect(**kwargs)
    try:
        yield conn
    finally:
        conn.close()


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def tokens(query: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for token in re.findall(r"[a-zA-Z0-9]{3,}", query.lower()):
        if token not in STOPWORDS and token not in seen:
            seen.add(token)
            result.append(token)
    return result[:12]


def retrieve(project_id: int, query: str, top_k: int = 8, item_types: list[str] | None = None) -> dict[str, Any]:
    top_k = min(max(int(top_k or 8), 1), 25)
    item_types = [item for item in (item_types or []) if item]
    try:
        import psycopg2.extras
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "retrieval_mode": "none", "chunks": [], "error": f"psycopg2 unavailable: {exc}"}
    with connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            embeddings, diagnostics = embed_texts([query]) if query.strip() else ({}, {"available": False, "reason": "empty query"})
            query_embedding = embeddings.get(query) or embeddings.get(query.strip())
            if query_embedding:
                params: list[Any] = [project_id, vector_literal(query_embedding), top_k]
                type_filter = ""
                if item_types:
                    params.insert(2, item_types)
                    type_filter = "AND i.item_type = ANY(%s)"
                cur.execute(
                    f"""
                    SELECT c.id AS chunk_id, i.id AS item_id, i.title, i.item_type, i.metadata,
                           c.chunk_text, 1 - (c.embedding <=> %s::vector) AS score,
                           i.created_at
                    FROM project_knowledge_chunks c
                    JOIN project_knowledge_items i ON i.id = c.item_id
                    WHERE c.project_id = %s AND i.status = 'active' AND c.embedding_status = 'embedded' AND c.embedding IS NOT NULL
                    {type_filter}
                    ORDER BY c.embedding <=> %s::vector, i.created_at DESC
                    LIMIT %s
                    """,
                    [vector_literal(query_embedding), project_id, *( [item_types] if item_types else [] ), vector_literal(query_embedding), top_k],
                )
                rows = list(cur.fetchall())
                if rows:
                    return {"ok": True, "retrieval_mode": "semantic", "chunks": [dict(row) for row in rows], "diagnostics": diagnostics}

            query_tokens = tokens(query)
            if not query_tokens:
                return {"ok": True, "retrieval_mode": "none", "chunks": [], "diagnostics": diagnostics}
            clauses = []
            where_params: list[Any] = [project_id]
            type_filter = ""
            if item_types:
                where_params.append(item_types)
                type_filter = "AND i.item_type = ANY(%s)"
            for token in query_tokens:
                where_params.append(f"%{token}%")
                clauses.append(f"(c.chunk_text ILIKE %s OR i.title ILIKE %s)")
                where_params.append(f"%{token}%")
            where_params.append(top_k)
            score_expr = " + ".join([f"CASE WHEN c.chunk_text ILIKE %s OR i.title ILIKE %s THEN 1 ELSE 0 END" for _ in query_tokens])
            # score params are duplicated before where params for the expression.
            score_params: list[Any] = []
            for token in query_tokens:
                score_params.extend([f"%{token}%", f"%{token}%"])
            cur.execute(
                f"""
                SELECT c.id AS chunk_id, i.id AS item_id, i.title, i.item_type, i.metadata,
                       c.chunk_text, ({score_expr})::float AS score, i.created_at
                FROM project_knowledge_chunks c
                JOIN project_knowledge_items i ON i.id = c.item_id
                WHERE c.project_id = %s AND i.status = 'active' {type_filter}
                  AND ({' OR '.join(clauses)})
                ORDER BY score DESC, i.created_at DESC
                LIMIT %s
                """,
                score_params + where_params,
            )
            rows = list(cur.fetchall())
            if rows:
                return {"ok": True, "retrieval_mode": "keyword_fallback", "chunks": [dict(row) for row in rows], "diagnostics": diagnostics}
            return {"ok": True, "retrieval_mode": "none", "chunks": [], "diagnostics": diagnostics}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", type=int, required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--item-types", default="")
    args = parser.parse_args()
    item_types = [item.strip() for item in args.item_types.split(",") if item.strip()]
    print(json.dumps(retrieve(args.project_id, args.query, args.top_k, item_types), default=str))


if __name__ == "__main__":
    main()
