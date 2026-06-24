
# ============================================================
# Meeting Compiler Experiment v1
# Claire Nicholson / Colab Research Notebook
#
# Purpose:
# Transcript -> Embeddings -> Clusters -> Evidence
# -> Minutes -> AI Critique -> Iterative Improvement
#
# Supports:
# - .txt
# - .docx
#
# Uses:
# - MiniLM for embeddings
# - Clustering for topic grouping
# - Google Colab AI for critique
#
# ============================================================

!pip install -q sentence-transformers scikit-learn python-docx

# ============================================================
# Upload file
# ============================================================

from google.colab import files
from pathlib import Path

uploaded = files.upload()
filename = next(iter(uploaded))

# ============================================================
# Extract text
# ============================================================

def extract_text(filename, uploaded_file_bytes):
    ext = Path(filename).suffix.lower()

    if ext == ".txt":
        return uploaded_file_bytes.decode("utf-8", errors="ignore")

    if ext == ".docx":
        from docx import Document

        doc = Document(filename)

        paragraphs = [
            p.text.strip()
            for p in doc.paragraphs
            if p.text and p.text.strip()
        ]

        return "\n".join(paragraphs)

    raise ValueError(
        f"Unsupported file type: {ext}. Upload .txt or .docx"
    )

text = extract_text(filename, uploaded[filename])

print("=" * 80)
print("RAW EXTRACTION")
print("=" * 80)
print(text[:2000])

# ============================================================
# Cleanup
# ============================================================

import re

FILLER_WORDS = [
    "um",
    "uh",
    "erm",
    "yeah",
    "okay",
    "right",
    "mhm",
    "hmm"
]

def clean_text(text):

    text = text.replace("\r", "\n")

    text = re.sub(
        r"\b(" + "|".join(FILLER_WORDS) + r")\b",
        "",
        text,
        flags=re.I
    )

    text = re.sub(r"\n{2,}", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s+", " ", text)

    return text.strip()

cleaned = clean_text(text)

print("=" * 80)
print("CLEANED")
print("=" * 80)
print(cleaned[:2000])

# ============================================================
# Parameters
# ============================================================

MAX_WORDS = 110
OVERLAP = 25
TOP_K = 3
INCLUDE_DISCUSSION = False

# ============================================================
# Chunking
# ============================================================

def chunk_text(text, max_words=110, overlap=25):

    words = text.split()

    chunks = []

    step = max_words - overlap

    for i in range(0, len(words), step):

        chunk = " ".join(words[i:i + max_words])

        if len(chunk.split()) >= 35:
            chunks.append(chunk)

    return chunks

# ============================================================
# Embeddings
# ============================================================

from sentence_transformers import SentenceTransformer

model = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2"
)

# ============================================================
# Rules
# ============================================================

category_keywords = {

    "Decisions": [
        "agreed",
        "decided",
        "confirmed",
        "approved",
        "the plan is",
        "we will",
        "include",
        "exclude"
    ],

    "Actions": [
        "need to",
        "needs to",
        "follow up",
        "send",
        "review",
        "confirm",
        "check",
        "implement",
        "update",
        "provide",
        "look at"
    ],

    "Risks or issues": [
        "risk",
        "issue",
        "problem",
        "concern",
        "delay",
        "blocked",
        "missing",
        "unclear"
    ],

    "Evidence needed": [
        "audit",
        "udi",
        "eudamed",
        "declaration",
        "certificate",
        "label",
        "document",
        "manual",
        "technical file",
        "qms"
    ],

    "Open questions": [
        "question",
        "whether",
        "if",
        "not sure",
        "how long",
        "what information",
        "do you mean"
    ]
}

def classify_snippet(snippet):

    lower = snippet.lower()

    scores = {}

    for category, keywords in category_keywords.items():
        scores[category] = sum(
            1 for kw in keywords if kw in lower
        )

    best = max(scores, key=scores.get)

    if scores[best] == 0:
        return "Discussion"

    return best

# ============================================================
# Helpers
# ============================================================

import numpy as np
from collections import Counter
from sklearn.metrics.pairwise import cosine_similarity

stopwords = set("""
the and to of a in it is that for on with as this we they
you i was were be are have has had from by or an if at
so but about there their them our can could would should
need needs
""".split())

def clean_snippet(snippet):

    snippet = re.sub(
        r"\b[A-Z][a-z]+ [A-Z][a-z]+ \d+:\d+\b",
        "",
        snippet
    )

    snippet = re.sub(
        r"\b\d+:\d+\b",
        "",
        snippet
    )

    snippet = re.sub(
        r"\s+",
        " ",
        snippet
    )

    return snippet.strip()

def topic_title(evidence):

    combined = " ".join(evidence).lower()

    words = re.findall(
        r"\b[a-zA-Z]{4,}\b",
        combined
    )

    useful = [
        w for w in words
        if w not in stopwords
    ]

    common = Counter(useful).most_common(4)

    if not common:
        return "General discussion"

    return " ".join(
        word for word, _ in common
    ).title()

def evidence_score(text):

    score = 0

    signal_words = [
        "audit",
        "udi",
        "eudamed",
        "responsibility",
        "action",
        "will",
        "need to",
        "must",
        "declaration",
        "label"
    ]

    lower = text.lower()

    for word in signal_words:
        if word in lower:
            score += 2

    return score

# ============================================================
# Pipeline
# ============================================================

from sklearn.cluster import AgglomerativeClustering

def run_pipeline(
    cleaned_text,
    max_words,
    overlap,
    top_k,
    include_discussion
):

    chunks = chunk_text(
        cleaned_text,
        max_words=max_words,
        overlap=overlap
    )

    embeddings = model.encode(
        chunks,
        normalize_embeddings=True
    )

    n_clusters = min(
        max(5, len(chunks) // 6),
        14
    )

    clusterer = AgglomerativeClustering(
        n_clusters=n_clusters,
        metric="cosine",
        linkage="average"
    )

    labels = clusterer.fit_predict(
        embeddings
    )

    clusters = {}

    for idx, label in enumerate(labels):

        clusters.setdefault(
            label,
            []
        ).append({
            "text": chunks[idx],
            "embedding": embeddings[idx]
        })

    records = []

    for label, cluster_items in clusters.items():

        vectors = np.array(
            [x["embedding"] for x in cluster_items]
        )

        centroid = np.mean(
            vectors,
            axis=0
        ).reshape(1, -1)

        sims = cosine_similarity(
            centroid,
            vectors
        )[0]

        ranked = []

        for sim, item in zip(
            sims,
            cluster_items
        ):

            ranked.append({
                "score": sim + (
                    evidence_score(
                        item["text"]
                    ) * 0.08
                ),
                "text": item["text"]
            })

        ranked = sorted(
            ranked,
            key=lambda x: x["score"],
            reverse=True
        )

        evidence = [
            clean_snippet(
                r["text"]
            )
            for r in ranked[:top_k]
        ]

        categories = [
            classify_snippet(e)
            for e in evidence
        ]

        records.append({
            "topic": topic_title(evidence),
            "evidence": evidence,
            "categories": categories
        })

    sections = {
        "Decisions": [],
        "Actions": [],
        "Risks or issues": [],
        "Evidence needed": [],
        "Open questions": [],
        "Discussion": []
    }

    for record in records:

        for evidence, category in zip(
            record["evidence"],
            record["categories"]
        ):

            sections[category].append(
                f"- {record['topic']}: {evidence[:420]}"
            )

    output = []

    output.append("Meeting minutes")

    for section, items in sections.items():

        if not items:
            continue

        if (
            section == "Discussion"
            and not include_discussion
        ):
            continue

        output.append(f"\n\n{section}")

        seen = set()

        for item in items:

            if item not in seen:
                output.append(item)
                seen.add(item)

    return "\n".join(output)

# ============================================================
# AI Assessment
# ============================================================

from google.colab import ai
import json

def ai_assess_minutes(minutes_text):

    prompt = f"""
You are reviewing automatically generated meeting minutes.

Score from 1-10:

1. Specificity
2. Evidence quality
3. Action clarity
4. Noise removal
5. Professional usefulness

Return ONLY JSON.

{{
"specificity":0,
"evidence_quality":0,
"action_clarity":0,
"noise_removal":0,
"usefulness":0,
"main_problem":"",
"suggested_changes":{{
"max_words":110,
"overlap":25,
"top_k":3,
"include_discussion":false
}}
}}

Minutes:

{minutes_text[:12000]}
"""

    return ai.generate_text(prompt)

def extract_json(text):

    match = re.search(
        r"\{.*\}",
        text,
        re.S
    )

    if not match:
        raise ValueError(
            "No JSON found"
        )

    return json.loads(
        match.group(0)
    )

# ============================================================
# Iterative Improvement Loop
# ============================================================

for round_number in range(3):

    print("\n")
    print("=" * 80)
    print(f"ROUND {round_number + 1}")
    print("=" * 80)

    minutes_text = run_pipeline(
        cleaned,
        MAX_WORDS,
        OVERLAP,
        TOP_K,
        INCLUDE_DISCUSSION
    )

    assessment_raw = ai_assess_minutes(
        minutes_text
    )

    print(assessment_raw)

    try:

        assessment = extract_json(
            assessment_raw
        )

        suggestions = assessment[
            "suggested_changes"
        ]

        MAX_WORDS = suggestions.get(
            "max_words",
            MAX_WORDS
        )

        OVERLAP = suggestions.get(
            "overlap",
            OVERLAP
        )

        TOP_K = suggestions.get(
            "top_k",
            TOP_K
        )

        INCLUDE_DISCUSSION = suggestions.get(
            "include_discussion",
            INCLUDE_DISCUSSION
        )

        print("\nApplied changes:")
        print(
            MAX_WORDS,
            OVERLAP,
            TOP_K,
            INCLUDE_DISCUSSION
        )

    except Exception as e:

        print(
            "Assessment parse failed:",
            e
        )

# ============================================================
# Final output
# ============================================================

final_minutes = run_pipeline(
    cleaned,
    MAX_WORDS,
    OVERLAP,
    TOP_K,
    INCLUDE_DISCUSSION
)

print("\n")
print("=" * 80)
print("FINAL MINUTES")
print("=" * 80)
print(final_minutes)

