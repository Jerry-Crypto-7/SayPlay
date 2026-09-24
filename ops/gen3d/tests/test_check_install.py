"""Kontrola instalace musí chytit licenčně vadnou instalaci, která jinak funguje."""

from check_install import card_license, forbidden_packages, license_verdict

PIP_LIST_CLEAN = """Package    Version
---------- -------
torch      2.9.0+cu128
trimesh    4.8.1
"""


def test_clean_environment_has_no_forbidden_package():
    assert forbidden_packages(PIP_LIST_CLEAN) == []


def test_nvdiffrast_pulled_in_as_a_dependency_is_caught():
    listing = PIP_LIST_CLEAN + "nvdiffrast 0.3.3\n"
    assert forbidden_packages(listing) == ["nvdiffrast"]


def test_nvdiffrec_and_case_variants_are_caught():
    listing = PIP_LIST_CLEAN + "NVDiffRec 0.1\nnvdiffrast_light 0.2\n"
    assert sorted(forbidden_packages(listing)) == ["nvdiffrast_light", "nvdiffrec"]


def test_freeze_format_is_read_too():
    assert forbidden_packages(
        "nvdiffrast @ git+https://github.com/NVlabs/nvdiffrast\n"
    ) == ["nvdiffrast"]


def test_permissive_licenses_pass():
    assert license_verdict("mit") == "OK"
    assert license_verdict("Apache-2.0") == "OK"


def test_noncommercial_and_missing_licenses_fail():
    assert license_verdict("cc-by-nc-4.0") == "FAIL"
    assert license_verdict("other") == "FAIL"
    assert license_verdict(None) == "FAIL"


def test_known_custom_model_license_needs_review_not_ok():
    assert license_verdict("LicenseRef-DINOv3") == "REVIEW"


def test_license_is_read_from_model_card_front_matter():
    card = "---\nlicense: apache-2.0\ntags:\n- comfyui\n---\n# Model\nlicense: mit in prose\n"
    assert card_license(card) == "apache-2.0"
    assert card_license("# no front matter\n") is None
