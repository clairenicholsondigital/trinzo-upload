from __future__ import annotations

import re


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
