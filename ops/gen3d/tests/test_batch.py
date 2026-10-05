"""Dávka pálí hodiny karty: po přerušení musí pokračovat, ne začít znovu, a hotové
slovo (v cache i v záznamu) už nesmí generovat."""

import json
from pathlib import Path

import pytest

import batch
import cache


def fake_result(out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    lod0 = out_dir / "x-lod0.glb"
    lod0.write_bytes(b"glb")
    return {
        "lod0": str(lod0),
        "lod1": str(lod0),
        "preview": str(out_dir / "x.png"),
        "gate": {"passed": True, "reasons": []},
    }


class Interrupted(BaseException):
    """Jako Ctrl+C nebo zabitý proces: dávka ho nesmí spolknout jako selhání slova."""


def make_generate(
    calls: list,
    stop_after: int | None = None,
    fail: set = frozenset(),
    seeds: list | None = None,
):
    """`fail` = slova, která selžou; prvek `(slovo, semínko)` selže jen na tom semínku."""

    def generate(noun: str, out_dir: Path, seed: int) -> dict:
        if stop_after is not None and len(calls) == stop_after:
            raise Interrupted
        calls.append(noun)
        if seeds is not None:
            seeds.append(seed)
        if noun in fail or (noun, seed) in fail:
            raise RuntimeError("quality gate: 5% of vertex colours are purple")
        return fake_result(out_dir)

    return generate


def run(tmp_path, nouns, generate, limit=10, seeds=(0,)):
    return batch.run_batch(
        nouns,
        limit=limit,
        generate=generate,
        record_path=tmp_path / "batch.json",
        cache_root=tmp_path / "cache",
        quarantine=None,
        seeds=seeds,
    )


def test_interrupted_batch_resumes_where_it_stopped(tmp_path):
    nouns = ["penguin", "teapot", "dragon", "sock"]
    calls: list = []
    with pytest.raises(Interrupted):
        run(tmp_path, nouns, make_generate(calls, stop_after=2))
    assert calls == ["penguin", "teapot"]
    saved = json.loads((tmp_path / "batch.json").read_text(encoding="utf-8"))
    assert [r["noun"] for r in saved["records"]] == ["penguin", "teapot"]

    calls.clear()
    records = run(tmp_path, nouns, make_generate(calls))
    assert calls == ["dragon", "sock"]
    assert [r["noun"] for r in records] == nouns


def test_cached_noun_is_recorded_without_the_gpu(tmp_path):
    out_dir = cache.entry_dir("teapot", tmp_path / "cache")
    cache.store("teapot", fake_result(out_dir), tmp_path / "cache")
    calls: list = []
    records = run(tmp_path, ["teapots", "sock"], make_generate(calls))
    assert calls == ["sock"]
    assert records[0]["noun"] == "teapot" and records[0]["verdict"] == "passed"


def test_failed_noun_is_recorded_with_reason_and_not_retried(tmp_path):
    calls: list = []
    records = run(tmp_path, ["frog", "sock"], make_generate(calls, fail={"frog"}))
    assert records[0]["verdict"] == "failed" and "purple" in records[0]["reason"]
    calls.clear()
    run(tmp_path, ["frog", "sock"], make_generate(calls))
    assert calls == []


def test_failed_seed_tries_the_next_one_and_keeps_the_attempt(tmp_path):
    calls: list = []
    used: list = []
    records = run(
        tmp_path,
        ["frog"],
        make_generate(calls, fail={("frog", 1)}, seeds=used),
        seeds=(1, 2, 3),
    )
    assert used == [1, 2]
    assert records[0]["verdict"] == "passed" and records[0]["seed"] == 2
    assert "reason" not in records[0]
    assert [a["seed"] for a in records[0]["attempts"]] == [1]
    assert "purple" in records[0]["attempts"][0]["reason"]


def test_noun_failing_every_seed_is_failed_with_the_last_reason(tmp_path):
    calls: list = []
    records = run(tmp_path, ["frog"], make_generate(calls, fail={"frog"}), seeds=(1, 2))
    assert calls == ["frog", "frog"]
    assert records[0]["verdict"] == "failed" and "purple" in records[0]["reason"]
    assert [a["seed"] for a in records[0]["attempts"]] == [1, 2]


def test_limit_counts_nouns_not_new_generations(tmp_path):
    calls: list = []
    records = run(tmp_path, ["a cat", "the dog", "frog"], make_generate(calls), limit=2)
    assert [r["noun"] for r in records] == ["cat", "dog"]


def test_derived_nouns_skip_catalog_tags_and_sort_by_frequency():
    demand = [
        {"text": "A penguin slides down an icy mountain collecting fish"},
        {"text": "penguins fight a giant robot"},
        {"text": "run away from the robot"},
        {"text": "a penguin on a pirate ship"},
    ]
    fidelity = {
        "sentences": [
            {
                "text": "space marine in a mall",
                "checklist": [
                    {"item": "space marine", "slot": "hero"},
                    {"item": "mall", "slot": "setting"},
                    {"item": "shoot", "slot": "verb"},
                ],
            }
        ]
    }
    catalog = {"assets": [{"tags": ["fish", "ship"]}]}
    counted = batch.derive_nouns(demand, fidelity, catalog)
    nouns = [noun for noun, _ in counted]
    assert nouns[:2] == ["penguin", "robot"]
    assert "space marine" in nouns
    assert not {"fish", "ship", "mall", "shoot", "a", "the", "giant", "icy"} & set(
        nouns
    )
