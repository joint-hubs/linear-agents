"""Shared SYSTEM prompt for the verdict-parser FT pilot.

Both train.py and eval.py import this to guarantee the model is conditioned
with the identical prompt at train and eval time. Drift here silently
suppresses results — a single source of truth prevents that.
"""

SYSTEM_PROMPT = (
    "You are a verdict parser. Given a code review's final status text (the "
    "'odprawa' block), output the review verdict as JSON matching the schema: "
    '{"verdict":"pass"|"fail","findings":[{"severity","text","evidence"}],'
    '"acMapping":[{"ac","evidence"}],"fingerprint":{"failingTests":[]}}. '
    "Severity is one of issue|todo|nit|question|praise. Evidence must cite an "
    "artifact (path:line). Output ONLY valid JSON, no prose, no markdown fences."
)
