"""People and glossary from the Settings page, for the Python minutes scripts.

The Node server writes the current Settings page lists to a JSON file and
passes its path in TRINZO_SETTINGS_SNAPSHOT. Without it (local runs, tests)
the scripts keep using the JSON files in config/.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _snapshot() -> dict[str, Any] | None:
    path = os.environ.get("TRINZO_SETTINGS_SNAPSHOT", "").strip()
    if not path:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def apply_people(config: dict[str, Any]) -> dict[str, Any]:
    """Replaces participant_groups with the Settings page People list."""
    data = _snapshot()
    people = data.get("people") if data else None
    if not isinstance(people, list):
        return config
    groups: dict[str, str] = {}
    for person in people:
        if not isinstance(person, dict) or not isinstance(person.get("name"), str):
            continue
        group = "client" if person.get("side") == "client" else "trinzo"
        for name in [person["name"], *[s for s in person.get("spellings") or [] if isinstance(s, str)]]:
            groups[name] = group
    return {**config, "participant_groups": groups}


def glossary_or(default: dict[str, str]) -> dict[str, str]:
    """The Settings page Glossary meanings, or the default glossary."""
    data = _snapshot()
    terms = data.get("terms") if data else None
    if not isinstance(terms, list):
        return default
    return {
        term["term"]: term["meaning"]
        for term in terms
        if isinstance(term, dict)
        and isinstance(term.get("term"), str)
        and isinstance(term.get("meaning"), str)
        and term["meaning"].strip()
    }
