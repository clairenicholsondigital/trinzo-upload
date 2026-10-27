"""Source-grounded admission of new milestones; existing-ID matching is separate."""
import json
from pathlib import Path
import re

_ROOT = Path(__file__).resolve().parent.parent
_POLICY = json.loads((_ROOT / "config/milestone_creation_intent.json").read_text())
_CATALOG = json.loads((_ROOT / "config/project_rules.json").read_text())["milestones"]


def normalise(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def has_milestone_creation_intent(name, source):
    key = normalise(name)
    if not key:
        return False
    name_pattern = r"[\W_]+".join(re.escape(token) for token in key.split())
    patterns = [re.compile(pattern.replace("__NAME__", name_pattern), re.I)
                for pattern in _POLICY["intentPatterns"]]
    clauses = [text.strip() for text in re.split(r"[.!?;\n]+", str(source or "")) if text.strip()]
    aliases = next((values for label, values in _CATALOG.items() if normalise(label) == key), [])
    for index, clause in enumerate(clauses):
        if re.search(_POLICY["rejectionPattern"], clause, re.I):
            continue
        if any(pattern.search(clause) for pattern in patterns):
            return True
        if (re.search(r"\b" + name_pattern + r"\b", clause, re.I) and index > 0
                and re.search(_POLICY["precedingIntentPattern"], clauses[index - 1], re.I)):
            return True
        catalog_key = lambda value: re.sub(r"\b([a-z]{4,})s\b", r"\1", normalise(value))
        text = " " + catalog_key(clause) + " "
        if any(" " + catalog_key(alias) + " " in text for alias in aliases):
            return True
    return False
