#!/usr/bin/env bash
# F0 / T0.2 - embed the `problem` facet with every candidate model (4 in parallel).
# Usage: bash tools/precedent-spike/bakeoff.sh [facet]   (default facet: problem)
cd "$(dirname "$0")/../.." || exit 1
facet="${1:-problem}"
mkdir -p .spike-precedent/logs
models=(
  qwen/qwen3-embedding-8b
  qwen/qwen3-embedding-4b
  google/gemini-embedding-2
  google/gemini-embedding-001
  voyageai/voyage-4-large
  voyageai/voyage-4
  voyageai/voyage-code-4
  openai/text-embedding-3-large
  openai/text-embedding-3-small
  perplexity/pplx-embed-v1-4b
  baai/bge-m3
  mistralai/codestral-embed-2505
)
printf '%s\n' "${models[@]}" | xargs -P 4 -I{} sh -c \
  'm="{}"; node --no-warnings tools/precedent-spike/embed.mjs --model "$m" --facet '"$facet"' > ".spike-precedent/logs/$(echo "$m" | tr / _)__'"$facet"'.log" 2>&1; echo "done $m exit=$?"'
