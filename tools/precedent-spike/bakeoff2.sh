#!/usr/bin/env bash
# F0 / T0.2 (part 2) - dimension truncation (Matryoshka) and instruction-prefix variants.
# A model that ignores `dimensions` returns its native size; embed.mjs records the actual dims in the metadata.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p .spike-precedent/logs

# instruction-prefixed QUERY form for Qwen3 (documents stay unprefixed); properly quoted, runs alongside the others
node --no-warnings tools/precedent-spike/embed.mjs --model qwen/qwen3-embedding-8b --facet problem --tag q \
  --prefix 'Instruct: Given a software engineering ticket, retrieve earlier tickets that describe the same underlying problem\nQuery: ' \
  > .spike-precedent/logs/v2_qwen8b_prefix.log 2>&1 &

jobs=(
  "--model openai/text-embedding-3-large --dims 1024"
  "--model openai/text-embedding-3-large --dims 256"
  "--model google/gemini-embedding-2 --dims 768"
  "--model voyageai/voyage-4-large --dims 256"
  "--model voyageai/voyage-code-4 --dims 256"
  "--model mistralai/codestral-embed-2505 --dims 512"
  "--model qwen/qwen3-embedding-8b --dims 1024"
)
printf '%s\n' "${jobs[@]}" | xargs -P 3 -I{} sh -c 'a="{}"; n=$(echo "$a" | tr " /" "__" | cut -c1-80); node --no-warnings tools/precedent-spike/embed.mjs $a --facet problem > ".spike-precedent/logs/v2_$n.log" 2>&1; echo "done $a exit=$?"'
wait
echo "bakeoff2 finished"
