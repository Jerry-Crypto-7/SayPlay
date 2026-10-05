"""Vektory textu malým modelem all-MiniLM-L6-v2 (Apache-2.0) pro `nearest.mjs` (P37A T6).

Čte JSON {"words": [...], "assets": [{"id", "text"}]} ze stdin, píše JSON
{"model", "words": {slovo: [[id, skóre], ...3]}} na stdout. Jen pro skript; hra
za běhu čte hotové `src/play/arcade/nearest.json`, model nikdy.
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
        # Průměr přes tokeny bez výplně – pooling, se kterým byl model trénovaný.
        mask = batch["attention_mask"].unsqueeze(-1).float()
        mean = (tokens * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        out.append(torch.nn.functional.normalize(mean, dim=-1))
    return torch.cat(out)


def main():
    request = json.load(sys.stdin)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    model = AutoModel.from_pretrained(
        MODEL, local_files_only=True, use_safetensors=True
    ).eval()
    words = request["words"]
    assets = request["assets"]
    scores = (
        embed(model, tokenizer, words)
        @ embed(model, tokenizer, [asset["text"] for asset in assets]).T
    )
    best = scores.topk(3, dim=1)
    result = {
        word: [
            [assets[index]["id"], round(float(score), 4)]
            for score, index in zip(
                best.values[row].tolist(), best.indices[row].tolist()
            )
        ]
        for row, word in enumerate(words)
    }
    json.dump({"model": MODEL, "words": result}, sys.stdout)


if __name__ == "__main__":
    main()
