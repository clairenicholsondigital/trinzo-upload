from __future__ import annotations

import re


BRITISH_ENGLISH_DIRECT_SWAPS = {
    "Analyze": "Analyse",
    "analyze": "analyse",
    "Analyzed": "Analysed",
    "analyzed": "analysed",
    "Analyzing": "Analysing",
    "analyzing": "analysing",
    "Utilize": "Utilise",
    "utilize": "utilise",
    "Utilized": "Utilised",
    "utilized": "utilised",
    "Utilizing": "Utilising",
    "utilizing": "utilising",
    "Utilization": "Utilisation",
    "utilization": "utilisation",
}


BRITISH_ENGLISH_DIRECT_SWAP_RE = re.compile(
    r"\b(" + "|".join(re.escape(source) for source in BRITISH_ENGLISH_DIRECT_SWAPS) + r")\b"
)


def apply_british_english_direct_swaps(text: str) -> str:
    """Apply approved direct British-English spelling swaps only."""
    return BRITISH_ENGLISH_DIRECT_SWAP_RE.sub(lambda match: BRITISH_ENGLISH_DIRECT_SWAPS[match.group(0)], text)


def apply_british_english_to_payload(value):
    """Recursively apply approved spelling swaps to strings in a JSON-like payload."""
    if isinstance(value, str):
        return apply_british_english_direct_swaps(value)
    if isinstance(value, list):
        return [apply_british_english_to_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: apply_british_english_to_payload(item) for key, item in value.items()}
    return value


def speaker_owned_phrase(speaker: str) -> str:
    if not speaker:
        return "the speaker's item"
    first_name = speaker.split()[0]
    suffix = "'" if first_name.endswith("s") else "'s"
    return f"{first_name}{suffix} item"


def expand_mine_reference(text: str, speaker: str = "") -> str:
    if not text or "mine" not in text.lower():
        return text
    return re.sub(r"\bmine\b", speaker_owned_phrase(speaker), text, flags=re.IGNORECASE)


def sentence_case(text: str) -> str:
    text = text.strip().rstrip(".")
    if not text:
        return text
    return text[0].upper() + text[1:]


def finalize_sentence(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        return cleaned
    if cleaned[-1] in ".!?":
        return cleaned
    return cleaned + "."

MALFORMED_QUESTION_LEAD_TOKENS = {
    "a",
    "about",
    "after",
    "an",
    "around",
    "as",
    "at",
    "before",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "onto",
    "over",
    "the",
    "through",
    "to",
    "under",
    "with",
}

QUESTION_LIKE_FRAGMENT_START_RE = re.compile(
    r"^(?:"
    r"are|is|am|was|were|do|does|did|can|could|will|would|should|shall|"
    r"has|have|had|may|might|must|what|why|when|where|who|how"
    r")\b",
    re.IGNORECASE,
)


def has_malformed_trailing_question_fragment(text: str) -> bool:
    """Return True when a sentence ends with a short malformed question fragment.

    Some transcript exports occasionally concatenate a substantive statement with a
    short follow-up question after a dangling lowercase article/preposition, e.g.
    ``... running it through a Are you not?``.  Detect the pattern using token and
    question-boundary heuristics so callers can trim or penalize it without relying
    on exact transcript strings.
    """
    cleaned = re.sub(r"\s+", " ", text.strip())
    if not cleaned.endswith("?"):
        return False

    match = re.search(r"\b(?P<lead>[a-z]{1,12})\s+(?P<question>[A-Z][^.!?]{1,80}\?)\s*$", cleaned)
    if not match:
        return False
    lead = match.group("lead").lower()
    if lead not in MALFORMED_QUESTION_LEAD_TOKENS:
        return False

    question = match.group("question").strip()
    question_tokens = re.findall(r"[A-Za-z0-9']+", question)
    if not (2 <= len(question_tokens) <= 6):
        return False
    if not QUESTION_LIKE_FRAGMENT_START_RE.search(question):
        return False

    prefix = cleaned[: match.start()].strip()
    prefix_tokens = re.findall(r"[A-Za-z0-9']+", prefix)
    return len(prefix_tokens) >= 4


def trim_malformed_trailing_question_fragment(text: str) -> str:
    """Remove only a malformed trailing short question fragment when present."""
    cleaned = re.sub(r"\s+", " ", text.strip())
    if not has_malformed_trailing_question_fragment(cleaned):
        return text.strip()
    lead_pattern = "|".join(sorted(MALFORMED_QUESTION_LEAD_TOKENS, key=len, reverse=True))
    trimmed = re.sub(
        rf"\s+\b(?:{lead_pattern})\s+[A-Z][^.!?]{{1,80}}\?\s*$",
        "",
        cleaned,
    )
    return trimmed.strip()


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"(?<=\w)(?=[A-Z][a-z])", ". ", text)
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]


def normalize_text_fragment(text: str, speaker: str = "") -> str:
    cleaned = expand_mine_reference(text.strip(), speaker)
    cleaned = re.sub(r"^(okay|right|so|yeah|true|fine|interesting|correct)\b[,.]?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip().rstrip(".")


def normalize_requested_task(task_text: str, speaker: str = "") -> str:
    cleaned = normalize_text_fragment(task_text, speaker)
    cleaned = re.sub(r"^(also|just)\b\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bfor us\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned.rstrip("?.!")


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text))


def has_minimum_output_words(text: str, min_words: int = 3) -> bool:
    return word_count(text) >= min_words
