#!/usr/bin/env python3
"""W4 — Eval harness for the verdict-parser FT pilot (FOC-359, PRD §5).

Loads a trained LoRA adapter + base model (4-bit), runs the held-out eval
split, and scores against the §5 bar:
  1. Schema validity 100% — every output parses as JSON and satisfies the
     supervisor-verdict.mjs guards. One schema-invalid output fails the pilot.
  2. Field-level reconstruction F1 >= 0.80 — verdict exact match; findings[]
     F1 over (severity, text-lemma@0.6, evidence-prefix); acMapping[] F1.

Usage:
  python eval.py --adapter ft/verdict-parse/runs/<id>/adapter
  python eval.py --adapter <id>   # shorthand: resolves to runs/<id>/adapter
"""
import argparse, json, re, sys, time
from pathlib import Path

# ---------- schema guards (frozen from supervisor-verdict.mjs:90-105) ----------
VERDICTS = ["pass", "fail"]
SEVERITIES = ["issue", "todo", "nit", "question", "praise"]
NON_EVIDENCE = ["", "-", "--", "n/a", "na", "none", "todo", "tbd", "?", "see above", "obvious"]

def is_evidence(s):
    t = str(s or "").strip()
    return len(t) >= 4 and t.lower() not in NON_EVIDENCE

def validate_output(out):
    errs = []
    if not isinstance(out, dict):
        return ["output not a JSON object"]
    if out.get("verdict") not in VERDICTS:
        errs.append('verdict "{}" not in {}'.format(out.get("verdict"), VERDICTS))
    fa = out.get("findings")
    if not isinstance(fa, list):
        errs.append("findings not array")
    else:
        for i, f in enumerate(fa):
            if not isinstance(f, dict):
                errs.append("finding[{}] not object".format(i)); continue
            if f.get("severity") not in SEVERITIES:
                errs.append('finding[{}] severity "{}" not in {}'.format(i, f.get("severity"), SEVERITIES))
            if not str(f.get("text", "")).strip():
                errs.append("finding[{}] text empty".format(i))
            if not is_evidence(f.get("evidence")):
                errs.append('finding[{}] evidence not evidence: "{}"'.format(i, f.get("evidence")))
    am = out.get("acMapping")
    if not isinstance(am, list):
        errs.append("acMapping not array")
    else:
        for i, a in enumerate(am):
            if not isinstance(a, dict):
                errs.append("acMapping[{}] not object".format(i)); continue
            if not str(a.get("ac", "")).strip():
                errs.append("acMapping[{}] ac empty".format(i))
            if not is_evidence(a.get("evidence")):
                errs.append('acMapping[{}] evidence not evidence: "{}"'.format(i, a.get("evidence")))
    fp = out.get("fingerprint", {})
    if not isinstance(fp, dict):
        errs.append("fingerprint not object")
    elif not isinstance(fp.get("failingTests", []), list):
        errs.append("failingTests not array")
    return errs

# ---------- extraction from model text ----------
# Qwen3 non-thinking emits an empty think block then JSON; thinking mode may
# reason first. Strip think blocks, then brace-match from each '{' left to
# right and json.loads — prefer the first object that contains a 'verdict'
# key (the actual verdict); fall back to the first parseable object.
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

def _brace_match(text, start):
    """Return the substring of a balanced object starting at index `start`,
    or None if it doesn't close."""
    depth, i, in_str, esc = 0, start, False, False
    while i < len(text):
        c = text[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i+1]
        i += 1
    return None

def extract_json(text):
    text = THINK_BLOCK_RE.sub("", text)
    candidates = []
    for idx, c in enumerate(text):
        if c != "{": continue
        cand = _brace_match(text, idx)
        if cand is None: continue
        try:
            obj = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "verdict" in obj:
            return obj, None
        candidates.append(obj)
    if candidates:
        return candidates[0], None
    return None, "no parseable JSON object found"

# ---------- lemma + match helpers ----------
_LEMMA = re.compile(r"[a-z0-9]+")
def lemmas(s):
    return _LEMMA.findall(str(s or "").lower())
def lemma_overlap(a, b):
    la, lb = lemmas(a), lemmas(b)
    if not la or not lb: return 0.0
    inter = sum(1 for w in la if w in lb)
    return inter / max(1, min(len(la), len(lb)))

_ARTIFACT_RE = re.compile(r"[A-Za-z0-9_./\\\-]+\.(mjs|py|ts|js|jsx|md|json|txt|sh|bat|cfg|yml|yaml)(:\d+)?")
def evidence_prefix_match(a, b):
    def norm(e):
        m = _ARTIFACT_RE.search(str(e or ""))
        return m.group(0).lower() if m else str(e or "").lower()[:40]
    return norm(a) == norm(b)

def finding_match(pred, gold):
    if pred.get("severity") != gold.get("severity"): return False
    if lemma_overlap(pred.get("text"), gold.get("text")) < 0.6: return False
    return evidence_prefix_match(pred.get("evidence"), gold.get("evidence"))

def acmap_match(pred, gold):
    if str(pred.get("ac", "")).strip().lower() != str(gold.get("ac", "")).strip().lower(): return False
    return evidence_prefix_match(pred.get("evidence"), gold.get("evidence"))

def f1(tp, fp, fn):
    if tp == 0: return 0.0
    p = tp / (tp + fp); r = tp / (tp + fn)
    return 2 * p * r / (p + r) if (p + r) > 0 else 0.0

def score_pair(pred, gold):
    v_match = 1 if pred.get("verdict") == gold.get("verdict") else 0
    pf, gf = pred.get("findings", []), gold.get("findings", [])
    used = [False] * len(gf)
    tp = 0
    for p in pf:
        for j, g in enumerate(gf):
            if not used[j] and finding_match(p, g):
                used[j] = True; tp += 1; break
    fp_f = len(pf) - tp; fn_f = len(gf) - tp
    f_f1 = f1(tp, fp_f, fn_f)
    pa, ga = pred.get("acMapping", []), gold.get("acMapping", [])
    used_a = [False] * len(ga)
    tp_a = 0
    for p in pa:
        for j, g in enumerate(ga):
            if not used_a[j] and acmap_match(p, g):
                used_a[j] = True; tp_a += 1; break
    fp_a = len(pa) - tp_a; fn_a = len(ga) - tp_a
    a_f1 = f1(tp_a, fp_a, fn_a)
    return {"verdict": v_match, "findings_f1": f_f1, "acMapping_f1": a_f1,
            "findings_tp": tp, "findings_fp": fp_f, "findings_fn": fn_f,
            "ac_tp": tp_a, "ac_fp": fp_a, "ac_fn": fn_a}

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--adapter", required=True)
    p.add_argument("--data-dir", default="ft/verdict-parse/data")
    p.add_argument("--report", default=None)
    p.add_argument("--base-model", default="Qwen/Qwen3-1.7B")
    p.add_argument("--max-new", type=int, default=1024)
    p.add_argument("--limit", type=int, default=0, help="eval only first N pairs (debug)")
    return p.parse_args()

def main():
    args = parse_args()
    adapter = Path(args.adapter)
    if not adapter.is_absolute() and not adapter.exists():
        cand = Path("ft/verdict-parse/runs") / args.adapter / "adapter"
        if cand.exists(): adapter = cand
    if not adapter.exists():
        print("[eval] adapter not found: {}".format(adapter), file=sys.stderr); sys.exit(2)
    report_path = Path(args.report) if args.report else adapter.parent / "eval.json"

    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import PeftModel

    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_compute_dtype=torch.bfloat16)
    tok = AutoTokenizer.from_pretrained(args.base_model)
    if tok.pad_token is None: tok.pad_token = tok.eos_token
    base = AutoModelForCausalLM.from_pretrained(args.base_model, quantization_config=bnb,
             device_map="auto", torch_dtype=torch.bfloat16, attn_implementation="sdpa")
    model = PeftModel.from_pretrained(base, str(adapter))
    model.eval()

    SYSTEM = ("You are a verdict parser. Given a code review's final status text, "
              'output the review verdict as JSON: {"verdict":"pass"|"fail",'
              '"findings":[{"severity","text","evidence"}],'
              '"acMapping":[{"ac","evidence"}],'
              '"fingerprint":{"failingTests":[]}}. '
              "Output ONLY valid JSON.")
    rows = []
    with open(Path(args.data_dir) / "eval.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line: rows.append(json.loads(line))
    if args.limit: rows = rows[:args.limit]
    print("[eval] {} held-out pairs, adapter={}".format(len(rows), adapter), flush=True)

    results = []
    schema_invalid = 0
    t0 = time.time()
    for i, r in enumerate(rows):
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": r["input"]}]
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = tok(prompt, return_tensors="pt").to("cuda")
        with torch.no_grad():
            out_ids = model.generate(**inputs, max_new_tokens=args.max_new,
                                     do_sample=False, temperature=1.0,
                                     pad_token_id=tok.pad_token_id)
        gen = tok.decode(out_ids[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        pred, perr = extract_json(gen)
        gold = r["output"]
        entry = {"_src": r.get("_src"), "_verdict": r.get("_verdict"), "gen_head": gen[:300]}
        if pred is None:
            schema_invalid += 1
            entry.update({"schema_valid": False, "schema_err": perr,
                          "scores": {"verdict": 0, "findings_f1": 0, "acMapping_f1": 0}})
        else:
            verrs = validate_output(pred)
            if verrs:
                schema_invalid += 1
                entry.update({"schema_valid": False, "schema_err": verrs,
                              "scores": {"verdict": 0, "findings_f1": 0, "acMapping_f1": 0}})
            else:
                sc = score_pair(pred, gold)
                entry.update({"schema_valid": True, "scores": sc, "pred": pred})
        results.append(entry)
        if (i + 1) % 5 == 0 or i == len(rows) - 1:
            print("[eval] {}/{} done ({:.0f}s) schema_invalid={}".format(
                i + 1, len(rows), time.time() - t0, schema_invalid), flush=True)

    n = len(results)
    valid = [r for r in results if r.get("schema_valid")]
    schema_rate = (n - schema_invalid) / n if n else 0.0
    v_acc = sum(r["scores"]["verdict"] for r in valid) / n if n else 0.0
    f_f1 = sum(r["scores"]["findings_f1"] for r in valid) / n if n else 0.0
    a_f1 = sum(r["scores"]["acMapping_f1"] for r in valid) / n if n else 0.0
    macro = (v_acc + f_f1 + a_f1) / 3.0
    report = {
        "adapter": str(adapter), "baseModel": args.base_model, "pairs": n,
        "schema_validity": round(schema_rate, 4),
        "schema_invalid_count": schema_invalid,
        "verdict_accuracy": round(v_acc, 4),
        "findings_f1": round(f_f1, 4),
        "acMapping_f1": round(a_f1, 4),
        "field_level_macro_f1": round(macro, 4),
        "bar": {"schema_100": schema_rate == 1.0, "f1_080": macro >= 0.80},
        "passed": schema_rate == 1.0 and macro >= 0.80,
        "per_pair": results,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "per_pair"}, indent=2), flush=True)
    print("[eval] report -> {}".format(report_path), flush=True)

if __name__ == "__main__":
    main()
