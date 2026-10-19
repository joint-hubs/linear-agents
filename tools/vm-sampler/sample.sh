#!/bin/sh
# tools/vm-sampler/sample.sh — FOC-809 VM sizing-band sampler (host side).
#
# Purpose: record the evidence behind the Fenix sizing bands (FOC-809). Each sample is one
# JSON line: host load, host memory, docker disk usage, per-container CPU/memory, and the
# claude process census inside fenix-supervisor. scripts/vm-sampler-report.mjs turns the
# collected samples.jsonl into p20/p50/p80/peak bands per phase.
#
# This is a measurement tool, not part of the Fenix deployment: after the measurement
# window it is removed from the VM together with its whole directory (`sample.sh purge` —
# AC1 of FOC-809).
#
# Usage:
#   sample.sh once                print one JSON sample line to stdout
#   sample.sh start [interval_s]  start a nohup'd loop appending samples.jsonl (default 60 s)
#   sample.sh stop                kill the loop and remove the pid file
#   sample.sh purge               stop AND remove the whole sampler directory
#
# Runs on the VM host as a user in the docker group. Every source is read best-effort: a
# source that fails contributes null (or [] for the lists) and never aborts the line.
#
# FENIX_SAMPLER_DIR (default $HOME/fenix-sampler) — samples.jsonl, sampler.pid, sampler.log
# FENIX_DIR          (default $HOME/fenix)        — the compose project (docker compose exec needs it)

SAMPLER_DIR=${FENIX_SAMPLER_DIR:-$HOME/fenix-sampler}
FENIX_DIR=${FENIX_DIR:-$HOME/fenix}

usage() {
  echo "usage: $0 once | start [interval_s] | stop | purge" >&2
  exit 2
}

# ── one sample → one JSON line on stdout ─────────────────────────────────────

sample_once() {
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  load1=null; load5=null
  if [ -r /proc/loadavg ]; then
    set -- $(cat /proc/loadavg)
    load1=$1; load5=$2
  fi

  mem_used=null; mem_cache=null; mem_avail=null
  mem=$(free -m 2>/dev/null | awk '$1 == "Mem:" { print $3, $6, $7 }')
  if [ -n "$mem" ]; then
    set -- $mem
    mem_used=$1; mem_cache=$2; mem_avail=$3
  fi

  disk=null
  disk_out=$({ df -BM --output=used /var/lib/docker 2>/dev/null || df -BM --output=used /; } \
    | awk 'NR == 2 { gsub(/M/, "", $1); if ($1 ~ /^[0-9]+$/) print $1 }')
  [ -n "$disk_out" ] && disk=$disk_out

  containers='[]'
  frag=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | awk -F'|' '
    NF >= 3 {
      name = $1; cpu = $2; mem = $3;
      sub(/%.*/, "", cpu);
      sub(/ \/ .*/, "", mem);
      val = mem + 0;
      if        (mem ~ /TiB/)      mb = val * 1048576;
      else if   (mem ~ /GiB/)      mb = val * 1024;
      else if   (mem ~ /MiB/)      mb = val;
      else if   (mem ~ /[kK]iB/)   mb = val / 1024;
      else                         mb = val / 1048576;
      gsub(/\\/, "\\\\", name); gsub(/"/, "\\\"", name);
      printf "%s{\"name\":\"%s\",\"cpu_pct\":%.1f,\"mem_mb\":%.1f}", sep, name, cpu, mb;
      sep = ",";
      n++;
    }')
  [ -n "$frag" ] && containers="[$frag]"

  claude_procs=null
  top_rss='[]'
  # ONE exec: line 1 = claude process count, lines 2-4 = the three biggest RSS processes
  census=$(cd "$FENIX_DIR" 2>/dev/null \
    && docker compose exec -T fenix-supervisor sh -c 'pgrep -c -x claude; ps -eo rss,comm --sort=-rss | sed -n 2,4p' 2>/dev/null)
  if [ -n "$census" ]; then
    count=$(printf '%s\n' "$census" | awk 'NR == 1 && $1 ~ /^[0-9]+$/ { print $1 }')
    [ -n "$count" ] && claude_procs=$count
    frag=$(printf '%s\n' "$census" | awk 'NR > 1 {
      rss = $1;
      if (rss !~ /^[0-9]+$/) next;
      comm = $0; sub(/^[ ]*[0-9]+[ ]+/, "", comm);
      gsub(/\\/, "\\\\", comm); gsub(/"/, "\\\"", comm);
      printf "%s{\"rss_mb\":%.1f,\"comm\":\"%s\"}", sep, rss / 1024, comm;
      sep = ",";
    }')
    [ -n "$frag" ] && top_rss="[$frag]"
  fi

  printf '{"ts":"%s","load1":%s,"load5":%s,"mem_used_mb":%s,"mem_avail_mb":%s,"mem_cache_mb":%s,"disk_used_mb":%s,"containers":[%s],"claude_procs":%s,"top_rss":[%s]}\n' \
    "$ts" "$load1" "$load5" "$mem_used" "$mem_avail" "$mem_cache" "$disk" "$containers" "$claude_procs" "$top_rss"
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "${1:-}" in
  once)
    sample_once
    ;;
  start)
    interval=${2:-60}
    case "$interval" in ''|*[!0-9]*) usage;; esac
    mkdir -p "$SAMPLER_DIR"
    if [ -f "$SAMPLER_DIR/sampler.pid" ] && kill -0 "$(cat "$SAMPLER_DIR/sampler.pid")" 2>/dev/null; then
      echo "sampler: already running (pid $(cat "$SAMPLER_DIR/sampler.pid"))" >&2
      exit 1
    fi
    : >"$SAMPLER_DIR/sampler.log"
    nohup "$0" __loop "$interval" >>"$SAMPLER_DIR/sampler.log" 2>&1 &
    echo $! >"$SAMPLER_DIR/sampler.pid"
    echo "sampler: started (pid $(cat "$SAMPLER_DIR/sampler.pid"), interval ${interval}s, log $SAMPLER_DIR/sampler.log)"
    ;;
  stop)
    if [ -f "$SAMPLER_DIR/sampler.pid" ]; then
      pid=$(cat "$SAMPLER_DIR/sampler.pid")
      kill "$pid" 2>/dev/null || echo "sampler: pid $pid was not alive" >&2
      rm -f "$SAMPLER_DIR/sampler.pid"
      echo "sampler: stopped"
    else
      echo "sampler: not running (no $SAMPLER_DIR/sampler.pid)" >&2
      exit 1
    fi
    ;;
  purge)
    "$0" stop >/dev/null 2>&1 || true
    rm -rf "$SAMPLER_DIR"
    echo "sampler: purged ($SAMPLER_DIR removed)"
    ;;
  __loop)
    interval=$2
    while :; do
      sample_once >>"$SAMPLER_DIR/samples.jsonl"
      sleep "$interval"
    done
    ;;
  *)
    usage
    ;;
esac