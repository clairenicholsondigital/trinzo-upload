import re

DECISION_CUE_PATTERNS = [
    (
        re.compile(
            r"\b(?:agreed|we agreed|let's|lets|we should|should|need to|needs to|must|go with|keep it|make sure|decided|decision is|will take place|will renew|will pursue|agreed to|we'll|we will)\b",
            re.IGNORECASE,
        ),
        0.2,
    ),
    (
        re.compile(
            r"\b(?:main issue is|important thing is|better to|rather than|instead of|no, let's|actually, let's)\b",
            re.IGNORECASE,
        ),
        0.15,
    ),
]

DECISION_ACCEPTANCE_PATTERNS = [
    re.compile(
        r"\b(?:agreed|we agreed|let's|lets|go with|keep(?:\s+it|\s+the|\b)|decision is|decided|accepted|that's fine|sounds good|yes, let's|no, let's)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:should|need to|needs to|must)\b.*\b(?:clearer|specific|specificly|specifically|educational|sales-led|salesy|positioning|approach|direction|wording|language|scope|timeline)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:main issue is|important thing is)\b.*\b(?:clear|clearer|scope|timeline|positioning|approach)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:main priority|priority for next week|priority next week|not really a blocker anymore|no longer a blocker|blocker anymore)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:will take place on|will renew with|will pursue|agreed to move|agreed to include|preferred contingency|one-year contract|three-year commitment)\b",
        re.IGNORECASE,
    ),
]

NON_DECISION_PATTERNS = [
    # Questions
    re.compile(r"\?$"),

    # Agenda/navigation chatter
    re.compile(
        r"^\s*(?:agenda|today|first|next|then|what we want to do|we're working through|we are working through)\b",
        re.IGNORECASE,
    ),

    # Meeting admin
    re.compile(r"\blet's capture actions\b", re.IGNORECASE),
    re.compile(r"^\s*let'?s do that\.?\s*$", re.IGNORECASE),
    re.compile(r"^\s*go on\.?\s*$", re.IGNORECASE),
    re.compile(r"^\s*anything else\??\s*$", re.IGNORECASE),

    # Discussion rather than decisions
    re.compile(
        r"\b(?:risk is|there is a risk|may ask|might ask|could ask|for example|that means|this means|we discussed|we reviewed|we considered)\b",
        re.IGNORECASE,
    ),

    # Generic filler statements
    re.compile(
        r"\blet'?s see if we can\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\blet'?s see what we can do\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*let'?s run through\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*(?:right,\s*)?let'?s\s+(?:go through|move on|start with)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*(?:right,\s*)?let'?s\s+run through\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\blet'?s see if we can do something\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*let'?s give background\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bgive background\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdo something there\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdo something\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bthat's just kind of\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bgive you a bit of background\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdo you see where i'm getting at\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bif that makes sense\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\byou know\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:we haven't decided|we have not decided|still deciding|not sure|maybe|needs more discussion|need more discussion|we'll come back to it|we will come back to it|that needs more discussion)\b",
        re.IGNORECASE,
    ),

    # Rehearsal/presentation filler
    re.compile(
        r"^\s*(?:say|talk through|go through|show|remember when)\b",
        re.IGNORECASE,
    ),
]
