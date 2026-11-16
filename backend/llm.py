"""The AI analyst: a plain-language briefing for each scan and a chat that knows the scan.

Groq writes the text. If there is no key, or the call fails, a rule-based briefing is returned instead, so the
panel is never empty. The model only ever sees the numbers of the scan, never anything else.
"""
from __future__ import annotations

import os

MODEL = os.getenv("SPACEDEBRIS_MODEL", "openai/gpt-oss-120b")

RULES = """You are the analyst on a space traffic desk. You explain a 24-hour close-approach scan to a smart non-expert.
Rules:
- Use only the scan numbers you are given. Never invent objects, distances or times.
- The data is orbital elements (TLEs) propagated with SGP4. Distances are estimates, not an operational collision probability. Say so once, briefly, when it matters.
- Plain language, short sentences, no jargon without a half-sentence explanation. Warm, direct, a little punchy. No emoji.
- Never claim an event will or will not happen. Say what the numbers show.
"""


def _summary(scan: dict) -> str:
    t = scan["target"]
    lines = [
        f"Target: {t['name']} (NORAD {t['id']}), orbit {int(t['perigee_km'])} to {int(t['apogee_km'])} km up.",
        f"Alert distance: {scan['threshold_km']:g} km. Window: {scan['window']['start_utc']} to {scan['window']['end_utc']} UTC.",
        f"Objects checked: {scan['objects_total']:,} (satellites plus {scan.get('objects_debris', 0):,} pieces of tracked debris). Close approaches found: {scan['threat_count']}, of which {scan.get('threat_debris', 0)} are debris.",
        f"Data: {scan['source']} (newest orbital elements from {scan['data_epoch_utc']} UTC).",
    ]
    for i, th in enumerate(scan["threats"][:5], 1):
        lines.append(
            f"{i}. {th['name']}: {th['distance_km']} km at {th['tca_utc']} UTC, closing speed {th['rel_speed_kms']} km/s, risk band {th['risk']}, a {th.get('kind', 'satellite')}."
        )
    return "\n".join(lines)


def rule_briefing(scan: dict) -> str:
    t = scan["target"]["name"]
    n = scan["threat_count"]
    if n == 0:
        return (
            f"All clear. In the next 24 hours nothing in the catalogue comes within {scan['threshold_km']:g} km of {t}. "
            "That is based on public orbital elements, so treat it as a screening result and not as a guarantee."
        )
    top = scan["threats"][0]
    band = {
        "HIGH": "That is close enough that a real operator would start planning an avoidance manoeuvre.",
        "MEDIUM": "That is worth watching. A real operator would keep tracking it and refresh the orbit data.",
        "LOW": "That is inside the alert distance but far from alarming. Routine monitoring is enough.",
    }[top["risk"]]
    return (
        f"{n} close approach{'es' if n != 1 else ''} to {t} in the next 24 hours. "
        f"The closest is {top['name']}: about {top['distance_km']} km away at {top['tca_utc']} UTC, "
        f"passing at {top['rel_speed_kms']} km/s. {band} "
        "These are estimates from public orbital elements, not an operational collision probability."
    )


def _complete(messages: list, max_tokens: int) -> str | None:
    """One Groq chat completion over its OpenAI-compatible REST endpoint. None when there is no key."""
    key = os.getenv("GROQ_API_KEY", "")
    if not key:
        return None
    import httpx

    r = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={"model": MODEL, "messages": messages, "max_tokens": max_tokens, "temperature": 0.4, "reasoning_effort": "low"},
        timeout=30,
    )
    r.raise_for_status()
    return (r.json()["choices"][0]["message"]["content"] or "").strip()


def briefing(scan: dict, style: str = "plain") -> tuple[str, str]:
    if not os.getenv("GROQ_API_KEY"):
        return rule_briefing(scan), "rules"
    tone = (
        "Explain like the reader is twelve: one everyday comparison. Quote only the closest approach number, exactly as given, and never generalise the other distances."
        if style == "simple"
        else "Write a crisp mission briefing."
    )
    prompt = (
        f"{tone} Three short parts, as plain text with no markdown symbols: what the scan found, why it matters, what a real operator would do.\n"
        f"Maximum 110 words.\n\nSCAN\n{_summary(scan)}"
    )
    try:
        text = _complete([{"role": "system", "content": RULES}, {"role": "user", "content": prompt}], 1200) or ""
        if len(text) < 20:
            raise ValueError("empty")
        return text, "groq"
    except Exception:  # noqa: BLE001
        return rule_briefing(scan), "rules"


def chat(message: str, scan: dict, history: list[dict]) -> tuple[str, str]:
    if not os.getenv("GROQ_API_KEY"):
        return "The analyst chat needs its AI key, which this server does not have. The briefing above still reflects the scan.", "rules"
    system = (
        RULES
        + "\nYou are chatting about ONE scan, given below. Answer questions about it, about orbits, satellites, debris and conjunctions."
        + " If the question is about something else, say you only cover space traffic and steer back. Keep answers under 90 words.\n\nSCAN\n"
        + _summary(scan)
    )
    msgs = [{"role": "system", "content": system}]
    for h in history[-6:]:
        if h.get("role") in ("user", "assistant") and isinstance(h.get("content"), str):
            msgs.append({"role": h["role"], "content": h["content"][:600]})
    msgs.append({"role": "user", "content": message[:500]})
    try:
        return _complete(msgs, 900) or "I could not form an answer. Try rephrasing.", "groq"
    except Exception:  # noqa: BLE001
        return "The analyst could not be reached just now. Try again in a moment.", "error"
