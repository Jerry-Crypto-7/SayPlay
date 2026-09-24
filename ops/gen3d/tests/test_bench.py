"""Měření nesmí vypadat lépe, než je: chyby zůstávají v datech, studený start zvlášť."""

from pathlib import Path

import pytest

from bench import bench_model, load_nouns, percentile, summarize

NOUNS_FILE = Path(__file__).resolve().parents[3] / "evals" / "gen3d" / "bench-nouns.txt"


def fake_run(failing: set[str]):
    def run(noun: str) -> dict:
        if noun in failing:
            raise RuntimeError(f"ComfyUI failed on {noun}")
        return {
            "imageS": 2.0,
            "meshS": 10.0,
            "finishS": 1.0,
            "tris": 4000,
            "glbBytes": 90_000,
            "vramPeakMiB": 20_000,
        }

    return run


def test_bench_nouns_are_twelve_across_three_kinds():
    nouns = load_nouns(NOUNS_FILE)
    assert len(nouns) == 12
    assert len(set(nouns)) == 12


def test_every_noun_is_recorded_including_failures_and_first_is_cold():
    nouns = [f"n{i}" for i in range(12)]
    records = bench_model("zimage", nouns, fake_run({"n5"}))
    assert [r["noun"] for r in records] == nouns
    failed = [r for r in records if not r["ok"]]
    assert [r["noun"] for r in failed] == ["n5"]
    assert "ComfyUI failed on n5" in failed[0]["error"]
    assert [r["cold"] for r in records] == [True] + [False] * 11


def test_summary_keeps_cold_start_out_of_warm_percentiles():
    nouns = [f"n{i}" for i in range(12)]
    records = bench_model("zimage", nouns, fake_run({"n5"}))
    records[0]["totalS"] = 300.0  # studený start je pomalý
    summary = summarize(records)["zimage"]
    assert summary["runs"] == 12
    assert summary["ok"] == 11
    assert summary["failed"] == ["n5"]
    assert summary["coldStart"]["totalS"] == 300.0
    assert summary["warm"]["totalS"]["p90"] < 300.0
    assert summary["warm"]["meshS"]["p50"] == pytest.approx(10.0)
    assert summary["warm"]["totalS"]["n"] == 10  # 12 − studený − chyba


def test_percentile_is_nearest_rank():
    values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert percentile(values, 50) == 5
    assert percentile(values, 90) == 9
    assert percentile([], 50) is None
