#!/usr/bin/env python3
"""W3 — QLoRA training for the verdict-parser FT pilot (FOC-359).

Fine-tunes Qwen3-1.7B (4-bit nf4) with LoRA adapters to parse a review child's
final text into the supervisor-verdict JSON (PRD §3). Reads the JSONL produced
by export-dataset.mjs, formats each pair as a chat conversation (system +
user(input) + assistant(JSON output)), and trains with TRL SFTTrainer.

Run layout (one dir per training run, written by this script):
  <run-dir>/
    config.json      — the effective hyperparameters
    metrics.jsonl    — {step, epoch, loss, lr} appended each logging step
    train.log        — full stdout/stderr capture
    adapter/         — saved LoRA adapter on success
    status.json      — {status, startedAt, finishedAt, message}

Qwen3 runs in NON-thinking mode (enable_thinking=False): the task is structured
JSON emission, not reasoning, so we skip the <think> block for speed and clean
parsability.

Usage:
  python train.py --data-dir ft/verdict-parse/data --run-dir ft/verdict-parse/runs/<ts> \
                  --epochs 3 --lr 2e-4 --batch-size 2 --grad-accum 4 --seq-len 4096
"""
import argparse, json, os, sys, time, traceback
from pathlib import Path

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--base-model", default="Qwen/Qwen3-1.7B")
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch-size", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--seq-len", type=int, default=4096)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--warmup-ratio", type=float, default=0.03)
    p.add_argument("--seed", type=int, default=3407)
    return p.parse_args()

SYSTEM_PROMPT = (
    "You are a verdict parser. Given a code review's final status text (the "
    "'odprawa' block), output the review verdict as JSON matching the schema: "
    '{"verdict":"pass"|"fail","findings":[{"severity","text","evidence"}],'
    '"acMapping":[{"ac","evidence"}],"fingerprint":{"failingTests":[]}}. '
    "Severity is one of issue|todo|nit|question|praise. Evidence must cite an "
    "artifact (path:line). Output ONLY valid JSON, no prose, no markdown fences."
)

def load_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows

def build_dataset(rows, tokenizer):
    """Format each pair as a Qwen3 chat conversation (non-thinking)."""
    texts = []
    for r in rows:
        out = r["output"]
        # Compact, stable JSON — keys in fixed order, no extra whitespace.
        assistant = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": r["input"]},
            {"role": "assistant", "content": assistant},
        ]
        # enable_thinking=False: Qwen3 chat template emits no <think> block.
        text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False, enable_thinking=False
        )
        texts.append({"text": text})
    return texts

def write_status(run_dir, status, **extra):
    payload = {"status": status, **extra}
    (Path(run_dir) / "status.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def main():
    args = parse_args()
    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    log_path = run_dir / "train.log"
    metrics_path = run_dir / "metrics.jsonl"
    config_path = run_dir / "config.json"

    # Tee stdout/stderr to train.log.
    log_f = open(log_path, "w", encoding="utf-8")
    class Tee:
        def __init__(self, *s): self.s = s
        def write(self, d):
            for s in self.s: s.write(d); s.flush()
        def flush(self):
            for s in self.s: s.flush()
    sys.stdout = Tee(sys.__stdout__, log_f)
    sys.stderr = Tee(sys.__stderr__, log_f)

    cfg = vars(args)
    config_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    started_at = time.time()
    write_status(run_dir, "running", startedAt=started_at)

    try:
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
        from peft import LoraConfig, get_peft_model
        from datasets import Dataset
        from trl import SFTTrainer, SFTConfig

        print(f"[ft] torch {torch.__version__} cuda={torch.cuda.is_available()} "
              f"{torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'}", flush=True)

        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
        tok = AutoTokenizer.from_pretrained(args.base_model)
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        model = AutoModelForCausalLM.from_pretrained(
            args.base_model, quantization_config=bnb, device_map="auto",
            torch_dtype=torch.bfloat16, attn_implementation="sdpa",
        )
        model.config.use_cache = False

        lora = LoraConfig(
            r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0,
            bias="none", task_type="CAUSAL_LM",
            target_modules=["q_proj","k_proj","v_proj","o_proj",
                            "gate_proj","up_proj","down_proj"],
        )

        train_rows = load_jsonl(Path(args.data_dir) / "train.jsonl")
        eval_rows = load_jsonl(Path(args.data_dir) / "eval.jsonl")
        print(f"[ft] train={len(train_rows)} eval={len(eval_rows)}", flush=True)
        train_ds = Dataset.from_list(build_dataset(train_rows, tok))
        eval_ds = Dataset.from_list(build_dataset(eval_rows, tok))

        sft_cfg = SFTConfig(
            output_dir=str(run_dir / "checkpoints"),
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            per_device_eval_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accum,
            learning_rate=args.lr,
            warmup_ratio=args.warmup_ratio,
            lr_scheduler_type="cosine",
            logging_steps=5,
            eval_strategy="epoch",
            save_strategy="epoch",
            save_total_limit=1,
            bf16=True,
            max_length=args.seq_len,
            packing=False,
            dataset_text_field="text",
            completion_only_loss=False,  # full-sequence loss; small model, structured task
            seed=args.seed,
            report_to="none",
        )

        # Metrics callback → metrics.jsonl.
        from transformers import TrainerCallback
        class MetricsSink(TrainerCallback):
            def on_log(self, args, state, control, logs=None, **kwargs):
                if logs is None: return
                rec = {"step": state.global_step, "epoch": round(logs.get("epoch", 0), 4),
                       "loss": logs.get("loss"), "lr": logs.get("learning_rate")}
                if rec["loss"] is None: return
                with open(metrics_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps({k:v for k,v in rec.items() if v is not None},
                              ensure_ascii=False) + "\n")

        trainer = SFTTrainer(model=model, args=sft_cfg, train_dataset=train_ds,
                             eval_dataset=eval_ds, processing_class=tok,
                             peft_config=lora)
        trainer.add_callback(MetricsSink())

        trainer.train()
        trainer.save_model(str(run_dir / "adapter"))
        tok.save_pretrained(str(run_dir / "adapter"))

        finished_at = time.time()
        write_status(run_dir, "done", startedAt=started_at, finishedAt=finished_at,
                     elapsedSec=round(finished_at - started_at))
        print(f"[ft] DONE in {round(finished_at-started_at)}s — adapter at {run_dir/'adapter'}", flush=True)
    except Exception as e:
        write_status(run_dir, "failed", startedAt=started_at,
                     message=repr(e), traceback=traceback.format_exc())
        print(f"[ft] FAILED: {e}", file=sys.__stderr__, flush=True)
        traceback.print_exc(file=sys.__stderr__)
        sys.exit(1)
    finally:
        log_f.close()

if __name__ == "__main__":
    main()
