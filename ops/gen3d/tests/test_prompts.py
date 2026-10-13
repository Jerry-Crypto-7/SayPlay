"""Šablony podle třídy, druhé zadání a předkontrola obrázku (P45E T2).

Provenance, která by zapsala šablonu z configu místo zadání, ze kterého model opravdu
vznikl, vypadá v disclosure správně a lže – proto ji drží test, ne oko.
"""

import json
import subprocess
from pathlib import Path

import pytest
from test_batch import fake_result
from test_server import FakeComfy as MeshComfy

import precheck


class FakeComfy(MeshComfy):
    """Atrapa ze `test_server`, která navíc umí stáhnout obrázek pro předkontrolu."""

    def download(self, output, target: Path) -> Path:
        if target.suffix != ".png":
            return super().download(output, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"png")
        return target


import batch
import server
from comfy_client import ComfyError


def test_class_picks_its_template_and_unknown_class_falls_back_to_prop():
    assert "four legs" in batch.prompt_for("hippo", "quadruped", "a")
    assert "wings spread" in batch.prompt_for("firefly", "flyer", "a")
    assert "chunky oversized toy version" in batch.prompt_for("receipt", "flat", "a")
    assert batch.prompt_for("teapot", "spaceship", "a") == batch.prompt_for(
        "teapot", "prop", "a"
    )
    assert batch.prompt_for("hippo", "quadruped", "a") != batch.prompt_for(
        "hippo", "quadruped", "b"
    )


def test_prop_a_is_the_prompt_every_earlier_model_was_made_from():
    # Server a starší cache neznají třídu; jejich provenance stojí na tomhle zadání.
    assert batch.prompt_for("teapot", "prop", "a") == (
        "a teapot, low-poly stylized 3D game asset, single object, centered, "
        "full view, flat colors, plain white background"
    )


def test_feature_line_follows_the_noun():
    prompt = batch.prompt_for("orca", "swimmer", "a")
    assert prompt.startswith("a orca, black and white killer whale")
    assert "fins" in prompt


def test_json_list_carries_class_and_flat_wins(tmp_path):
    source = tmp_path / "nouns.json"
    source.write_text(
        json.dumps(
            {
                "nouns": [
                    {"noun": "orca", "class": "swimmer", "flat": False},
                    {"noun": "Playing Cards", "class": "prop", "flat": True},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert batch.load_classes(source) == {"orca": "swimmer", "playing card": "flat"}
    assert batch.load_nouns(source) == ["orca", "Playing Cards"]
    text = tmp_path / "nouns.txt"
    text.write_text("orca  # 3\n", encoding="utf-8")
    assert batch.load_classes(text) == {}


def test_attempts_go_a0_b0_a1_and_record_the_prompt_that_worked(tmp_path):
    tried: list = []

    def generate(noun, out_dir, seed, prompt):
        tried.append((seed, prompt))
        if len(tried) < 3:
            raise RuntimeError("quality gate: 40000 triangles")
        return fake_result(out_dir)

    def prompt_of(noun, variant):
        return batch.prompt_for(noun, "quadruped", variant)

    [record] = batch.run_batch(
        ["hippo"],
        limit=1,
        generate=generate,
        record_path=tmp_path / "batch.json",
        cache_root=tmp_path / "cache",
        attempts=batch.ATTEMPTS,
        prompt_of=prompt_of,
    )
    a, b = prompt_of("hippo", "a"), prompt_of("hippo", "b")
    assert tried == [(0, a), (0, b), (1, a)]
    assert [(t["variant"], t["seed"]) for t in record["attempts"]] == [
        ("a", 0),
        ("b", 0),
    ]
    assert (record["variant"], record["seed"], record["prompt"]) == ("a", 1, a)


def test_provenance_names_the_prompt_and_seed_actually_used(tmp_path):
    def generate(noun, out_dir, seed, prompt):
        if prompt == batch.prompt_for(noun, "quadruped", "a"):  # A neprojde nikdy
            raise RuntimeError("quality gate: 40000 triangles")
        return fake_result(out_dir)

    sources: list = []
    batch.run_batch(
        ["hippo"],
        limit=1,
        generate=generate,
        record_path=tmp_path / "batch.json",
        cache_root=tmp_path / "cache",
        quarantine=lambda noun, result: sources.append(
            batch.provenance(result["prompt"], result["seed"])
        ),
        attempts=batch.ATTEMPTS,
        prompt_of=lambda noun, variant: batch.prompt_for(noun, "quadruped", variant),
    )
    used = batch.prompt_for("hippo", "quadruped", "b")
    assert repr(used) in sources[0] and "seed 0" in sources[0]
    assert batch.prompt_for("hippo", "quadruped", "a") not in sources[0]


def test_cached_noun_keeps_the_prompt_it_was_made_from(tmp_path):
    def run(record):
        return batch.run_batch(
            ["hippo"],
            limit=1,
            generate=lambda noun, out_dir, seed, prompt: fake_result(out_dir),
            record_path=tmp_path / record,
            cache_root=tmp_path / "cache",
            prompt_of=lambda noun, variant: batch.prompt_for(noun, "quadruped", "b"),
        )

    run("first.json")
    [cached] = run("second.json")
    assert cached["cached"] is True
    assert cached["prompt"] == batch.prompt_for("hippo", "quadruped", "b")


def test_rejected_image_never_reaches_trellis(tmp_path):
    comfy = FakeComfy()
    seen: list = []

    def check(image: Path) -> dict:
        seen.append(image)
        raise precheck.PrecheckRejected("precheck: image looks like 'bear' (no)")

    with pytest.raises(precheck.PrecheckRejected):
        server.generate(comfy, "mole", tmp_path / "mole", prompt="a mole", check=check)
    assert comfy.calls == 1  # jen obrázek, síť z TRELLIS se nespustila
    assert seen == [tmp_path / "mole" / "image.png"]


def test_passed_image_goes_on_to_trellis(tmp_path):
    comfy = FakeComfy(crash_on_mesh=True)
    with pytest.raises(ComfyError):
        server.generate(
            comfy, "mole", tmp_path / "mole", check=lambda image: {"verdict": "top1"}
        )
    assert comfy.calls == 2


def judge_answer(monkeypatch, line: dict | None, code: int = 0):
    def fake_run(args, **kwargs):
        stdout = json.dumps(line) + "\n" if line is not None else ""
        return subprocess.CompletedProcess(args, code, stdout=stdout, stderr="boom")

    monkeypatch.setattr(precheck.subprocess, "run", fake_run)


def test_precheck_passes_top1_and_top3(monkeypatch, tmp_path):
    for verdict in ("top1", "top3"):
        judge_answer(monkeypatch, {"verdict": verdict, "answer": {"name": "mole"}})
        assert precheck.check("mole", tmp_path / "image.png")["verdict"] == verdict


def test_precheck_rejects_what_the_judge_would_reject(monkeypatch, tmp_path):
    for verdict in ("no", "broken"):
        judge_answer(monkeypatch, {"verdict": verdict, "answer": {"name": "bear"}})
        with pytest.raises(precheck.PrecheckRejected, match="bear"):
            precheck.check("mole", tmp_path / "image.png")


def test_precheck_asks_the_chosen_judge(monkeypatch, tmp_path):
    # P46F: Opus 5.5 místo Codexu; bez volby zůstává Codex.
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        line = {"verdict": "top1", "answer": {"name": "mole"}}
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(line), stderr="")

    monkeypatch.setattr(precheck.subprocess, "run", fake_run)
    precheck.check("mole", tmp_path / "image.png", judge="claude")
    precheck.check("mole", tmp_path / "image.png")
    assert [a[a.index("--judge") + 1] for a in calls] == ["claude", "codex"]


def test_precheck_without_an_answer_lets_the_card_work_on(monkeypatch, tmp_path):
    # Vyčerpaný limit Codexu nesmí zastavit kartu; soud po 3D ho dožene (plán P45E).
    judge_answer(monkeypatch, {"verdict": "unavailable", "error": "codex exit 1"})
    assert precheck.check("mole", tmp_path / "image.png")["verdict"] == "unavailable"
    judge_answer(monkeypatch, None, code=1)
    assert precheck.check("mole", tmp_path / "image.png")["verdict"] == "unavailable"
