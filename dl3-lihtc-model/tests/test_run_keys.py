"""Keys typed into the website: sealed in the browser, unsealed only by the GitHub job."""
import base64
import json

import pytest

from src import run_keys as rk


@pytest.fixture(scope="module")
def pair():
    return rk.new_keypair()


def test_round_trip(pair):
    pem, jwk = pair
    sealed = rk.seal({"GEMINI_API_KEY": "AIzaSyExample_123-abc", "CENSUS_API_KEY": "0123456789abcdef"}, jwk)
    assert "AIza" not in sealed
    assert rk.unseal(sealed, pem) == {"GEMINI_API_KEY": "AIzaSyExample_123-abc", "CENSUS_API_KEY": "0123456789abcdef"}


def test_public_key_is_a_browser_jwk(pair):
    _, jwk = pair
    assert jwk["kty"] == "RSA" and jwk["alg"] == "RSA-OAEP-256" and jwk["key_ops"] == ["encrypt"] and "d" not in jwk


def test_empty_means_use_repository_secrets(pair):
    assert rk.unseal("", pair[0]) == {}


def test_only_the_two_api_keys_can_be_sent(pair):
    pem, jwk = pair
    with pytest.raises(rk.SealError, match="refused PATH"):
        rk.unseal(rk.seal({"PATH": "abcdefgh123"}, jwk), pem)


def test_line_breaks_cannot_inject_other_variables(pair):
    pem, jwk = pair
    with pytest.raises(rk.SealError, match="does not look like"):
        rk.unseal(rk.seal({"GEMINI_API_KEY": "abcdefgh123\nHERENOW_DRIVE_TOKEN=x"}, jwk), pem)


def test_wrong_private_key(pair):
    _, jwk = pair
    other_pem, _ = rk.new_keypair()
    with pytest.raises(rk.SealError, match="PIPELINE_KEY_PRIVATE"):
        rk.unseal(rk.seal({"GEMINI_API_KEY": "abcdefgh123"}, jwk), other_pem)


def test_garbage_is_refused(pair):
    for bad in ("hello", "v1:!!!", "v1:" + base64.urlsafe_b64encode(json.dumps([1]).encode()).decode()):
        with pytest.raises(rk.SealError):
            rk.unseal(bad, pair[0])


def test_unseal_command_masks_and_exports(pair, tmp_path, monkeypatch, capsys):
    pem, jwk = pair
    env = tmp_path / "env"
    monkeypatch.setenv("PIPELINE_KEY_PRIVATE", pem)
    monkeypatch.setenv("SEALED_KEYS", rk.seal({"GEMINI_API_KEY": "secretvalue123"}, jwk))
    monkeypatch.setenv("GITHUB_ENV", str(env))
    assert rk.main(["unseal"]) == 0
    out = capsys.readouterr().out
    assert "::add-mask::secretvalue123" in out and env.read_text() == "GEMINI_API_KEY=secretvalue123\n"
    assert out.count("secretvalue123") == 1  # only inside the mask command, which the runner hides


def test_unseal_command_without_private_key(pair, monkeypatch, capsys):
    monkeypatch.delenv("PIPELINE_KEY_PRIVATE", raising=False)
    monkeypatch.setenv("SEALED_KEYS", rk.seal({"GEMINI_API_KEY": "secretvalue123"}, pair[1]))
    assert rk.main(["unseal"]) == 2 and "PIPELINE_KEY_PRIVATE" in capsys.readouterr().out


def test_missing_website_key_falls_back_to_repository_secret(pair, tmp_path, monkeypatch, capsys):
    pem, jwk = pair
    env = tmp_path / "env"
    monkeypatch.setenv("PIPELINE_KEY_PRIVATE", pem)
    monkeypatch.setenv("SEALED_KEYS", rk.seal({"GEMINI_API_KEY": "fromwebsite123"}, jwk))
    monkeypatch.setenv("FALLBACK_GEMINI_API_KEY", "reposecret999")
    monkeypatch.setenv("FALLBACK_CENSUS_API_KEY", "censussecret777")
    monkeypatch.setenv("GITHUB_ENV", str(env))
    assert rk.main(["unseal"]) == 0
    assert env.read_text() == "GEMINI_API_KEY=fromwebsite123\nCENSUS_API_KEY=censussecret777\n"
    assert "CENSUS_API_KEY from the repository secret" in capsys.readouterr().out
