"""Drama 3 text validation and chunking, for the Linux (vLLM-Omni) backend.

A pure-Python copy of drama3-mlx's validate_text (drama3_mlx/prompt.py) and
split_text (drama3_mlx/chunking.py, itself from fish-speech v3's
fish_omni/chunking.py). drama3-mlx cannot be imported off Apple Silicon, and
vLLM-Omni's speech API neither validates nor splits text, so the Linux daemon
uses these to behave like the macOS one. Keep them in sync with drama3-mlx.
"""

import re

STRUCTURAL_TOKENS = (
    "<|im_start|>",
    "<|im_end|>",
    "<|voice|>",
    "<|text|>",
    "<|interleave|>",
    "<|semantic:",
)
SPEAKER_TAG_PATTERN = re.compile(r"<\|speaker:([0-9]+)\|>")
MAX_SPEAKER_ID = 15
# The Unicode White_Space property (str.strip() also strips U+001C..U+001F).
UNICODE_WHITE_SPACE = "".join(
    map(
        chr,
        (*range(0x9, 0xE), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B))
        + (0x2028, 0x2029, 0x202F, 0x205F, 0x3000),
    )
)

CHUNK_BYTES = 300
CHUNK_MAX_SPEAKERS = 3
SENTENCE_ENDS = frozenset(".!?;。！？；…\n")
CLAUSE_MARKS = frozenset(",:，：、")
SPACES = frozenset(" ")
PROTECTED_SPAN = re.compile(r"<\|[^|>]*\|>|<([A-Za-z][\w-]*)\b[^>]*>.*?</\1>|\[[^\[\]]*\]", re.S)


class InvalidInputError(ValueError):
    """The request text cannot be served as given."""


def validate_text(text: str, location: str = "text") -> None:
    """Non-empty, no structural tokens, and only canonical speaker tags 0..15."""
    if not text.strip(UNICODE_WHITE_SPACE):
        raise InvalidInputError(f"{location}: text must not be empty")
    for token in STRUCTURAL_TOKENS:
        if token in text:
            raise InvalidInputError(f"{location}: {token} is written by the prompt builder")
    for marker in re.finditer(r"<\|speaker", text):
        tag = SPEAKER_TAG_PATTERN.match(text, marker.start())
        digits = tag.group(1) if tag else ""
        if not digits or str(int(digits)) != digits or int(digits) > MAX_SPEAKER_ID:
            raise InvalidInputError(
                f"{location}: speaker tags must be <|speaker:0|> to "
                f"<|speaker:{MAX_SPEAKER_ID}|>; got {text!r}"
            )


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _protected_pieces(text: str) -> list:
    pieces, last = [], 0
    for match in PROTECTED_SPAN.finditer(text):
        if match.start() > last:
            pieces.append((text[last : match.start()], False))
        pieces.append((match.group(0), True))
        last = match.end()
    if last < len(text):
        pieces.append((text[last:], False))
    return pieces


def _breaks_at(text: str, index: int, marks: frozenset) -> bool:
    if text[index] not in marks:
        return False
    # Keep decimals such as 3.14 in one piece.
    return not (
        text[index] == "."
        and 0 < index < len(text) - 1
        and text[index - 1].isdigit()
        and text[index + 1].isdigit()
    )


def _break_at_marks(pieces: list, length: int, marks: frozenset) -> list:
    out = []
    for text, protected in pieces:
        if protected or utf8_len(text) <= length:
            out.append((text, protected))
            continue
        start = 0
        for index in range(len(text)):
            if _breaks_at(text, index, marks):
                out.append((text[start : index + 1], False))
                start = index + 1
        if start < len(text):
            out.append((text[start:], False))
    return out


def _break_by_length(pieces: list, length: int) -> list:
    out = []
    for text, protected in pieces:
        if protected or utf8_len(text) <= length:
            out.append((text, protected))
            continue
        current, size = "", 0
        for char in text:
            if current and size + utf8_len(char) > length:
                out.append((current, False))
                current, size = "", 0
            current += char
            size += utf8_len(char)
        out.append((current, False))
    return out


def split_by_length(text: str, length: int = CHUNK_BYTES) -> list:
    if not text.strip(UNICODE_WHITE_SPACE):
        return []
    if utf8_len(text) <= length:
        return [text]
    pieces = _break_at_marks(_protected_pieces(text), 0, SENTENCE_ENDS)
    for marks in (CLAUSE_MARKS, SPACES):
        pieces = _break_at_marks(pieces, length, marks)
    pieces = _break_by_length(pieces, length)

    chunks, current = [], ""
    for piece, _ in pieces:
        if current and utf8_len(current + piece) > length:
            chunks.append(current)
            current = ""
        current += piece
    chunks.append(current)
    return [
        chunk.strip(UNICODE_WHITE_SPACE) for chunk in chunks if chunk.strip(UNICODE_WHITE_SPACE)
    ]


def parse_speaker_segments(text: str) -> list:
    parts = SPEAKER_TAG_PATTERN.split(text)
    segments = [("0", parts[0])] if parts[0].strip(UNICODE_WHITE_SPACE) else []
    for speaker, body in zip(parts[1::2], parts[2::2]):
        if body.strip(UNICODE_WHITE_SPACE):
            segments.append((speaker, body))
    return segments


def split_text(
    text: str, max_bytes: int = CHUNK_BYTES, max_speakers: int = CHUNK_MAX_SPEAKERS
) -> list:
    """Generation chunks for text, in order: by length, or by speaker segment."""
    if SPEAKER_TAG_PATTERN.search(text) is None:
        return split_by_length(text, max_bytes)

    segments = []
    for speaker, body in parse_speaker_segments(text):
        for piece in split_by_length(body, max_bytes):
            segments.append((speaker, f"<|speaker:{speaker}|> {piece}"))

    chunks, batch, speakers, size = [], [], [], 0
    for speaker, segment in segments:
        new_speaker = speaker not in speakers
        too_many_speakers = new_speaker and len(speakers) >= max_speakers
        too_long = bool(batch) and size + utf8_len(segment) > max_bytes
        if too_many_speakers or too_long:
            chunks.append("\n".join(batch))
            batch, speakers, size = [], [], 0
            new_speaker = True
        batch.append(segment)
        if new_speaker:
            speakers.append(speaker)
        size += utf8_len(segment)
    if batch:
        chunks.append("\n".join(batch))
    return chunks
