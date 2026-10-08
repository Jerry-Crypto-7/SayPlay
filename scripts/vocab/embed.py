"""Podobnost sloves ke kotvám malým modelem all-MiniLM-L6-v2 (Apache-2.0) pro `build.mjs` (P44C T4).

Čte JSON {"words": [...], "anchors": [{"target", "text"}]} ze stdin, píše JSON
{"model", "scores": {slovo: {cíl: kosinus}}} na stdout – u každého cíle nejlepší z jeho
kotevních textů, zaokrouhleno na 4 místa. Jen CPU a jen offline mezipaměť; hra model nikdy nečte.
Vzor `scripts/p37a/embed.py`.
"""

import json
import sys

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def embed(model, tokenizer, texts):
    out = []
    for start in range(0, len(texts), 256):
        batch = tokenizer(
            texts[start : start + 256],
            padding=True,
            truncation=True,
            return_tensors="pt",
        )
        with torch.no_grad():
            tokens = model(**batch).last_hidden_state
        mask = batch["attention_mask"].unsqueeze(-1).float()
        mean = (tokens * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        out.append(torch.nn.functional.normalize(mean, dim=-1))
    return torch.cat(out)


def main():
    request = json.load(sys.stdin)
    revision = request.get("revision")
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL, revision=revision, local_files_only=True
    )
    model = AutoModel.from_pretrained(
        MODEL, revision=revision, local_files_only=True, use_safetensors=True
    ).eval()
    words = request["words"]
    anchors = request["anchors"]
    targets = sorted({anchor["target"] for anchor in anchors})
    scores = (
        embed(model, tokenizer, [f"to {word}" for word in words])
        @ embed(model, tokenizer, [f"to {anchor['text']}" for anchor in anchors]).T
    )
    columns = {
        target: torch.tensor(
            [i for i, a in enumerate(anchors) if a["target"] == target]
        )
        for target in targets
    }
    best = {
        target: scores[:, index].max(dim=1).values.tolist()
        for target, index in columns.items()
    }
    result = {
        word: {target: round(best[target][row], 4) for target in targets}
        for row, word in enumerate(words)
    }
    json.dump({"model": MODEL, "scores": result}, sys.stdout)


if __name__ == "__main__":
    torch.set_num_threads(1)
    main()
