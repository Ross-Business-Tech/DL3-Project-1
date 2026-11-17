"""API keys a person types into the website, sealed so only the GitHub job can read them.

The website encrypts each key in the visitor's browser with the PUBLIC key in public/pipeline-key.json
(RSA-OAEP, SHA-256, Web Crypto) and sends only the sealed text to the "DL3 data pipeline" workflow. The repository
is public and so are workflow inputs, but sealed text is useless without the PRIVATE key, which lives only in the
GitHub secret PIPELINE_KEY_PRIVATE.

    python -m src.run_keys new-keypair   # once: writes public/pipeline-key.json (commit it) and the private key
                                         # to ~/.herenow/dl3_pipeline_private_key.pem (paste into the GitHub secret,
                                         # then delete the file)
    python -m src.run_keys unseal        # in the workflow: reads SEALED_KEYS and PIPELINE_KEY_PRIVATE, masks the
                                         # keys in the log and exports them to the following steps ($GITHUB_ENV);
                                         # a key not sent falls back to FALLBACK_<NAME> (the repository secret)

Sealed text format: "v1:" + base64url(JSON {"GEMINI_API_KEY": base64(ciphertext), "CENSUS_API_KEY": ...}).
Only those two names are accepted, and a value must look like an API key (no spaces or line breaks), so nothing
sent from a browser can set any other variable for the job.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_KEY_FILE = ROOT.parent / "public" / "pipeline-key.json"
ALLOWED = ("GEMINI_API_KEY", "CENSUS_API_KEY")
KEY_SHAPE = re.compile(r"^[A-Za-z0-9_\-.]{8,200}$")


class SealError(ValueError):
    pass


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    text = text.strip().replace("+", "-").replace("/", "_")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_keypair() -> tuple[str, dict]:
    """(private key PEM, public key as a JWK the browser imports)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    nums = key.public_key().public_numbers()
    as_bytes = lambda n: n.to_bytes((n.bit_length() + 7) // 8, "big")  # noqa: E731
    jwk = {"kty": "RSA", "alg": "RSA-OAEP-256", "ext": True, "key_ops": ["encrypt"],
           "n": _b64(as_bytes(nums.n)), "e": _b64(as_bytes(nums.e))}
    return pem, jwk


def seal(values: dict, jwk: dict) -> str:
    """What the browser does (used by tests and for running from a terminal)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    pub = rsa.RSAPublicNumbers(int.from_bytes(_unb64(jwk["e"]), "big"), int.from_bytes(_unb64(jwk["n"]), "big")).public_key()
    oaep = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    body = {k: base64.b64encode(pub.encrypt(v.encode(), oaep)).decode() for k, v in values.items() if v}
    return "v1:" + _b64(json.dumps(body).encode())


def unseal(sealed: str, private_pem: str) -> dict[str, str]:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    sealed = (sealed or "").strip()
    if not sealed:
        return {}
    if not sealed.startswith("v1:"):
        raise SealError("The sealed keys are not in a format this job understands (expected v1:).")
    try:
        body = json.loads(_unb64(sealed[3:]))
    except ValueError as e:
        raise SealError("The sealed keys could not be read.") from e
    if not isinstance(body, dict):
        raise SealError("The sealed keys could not be read.")
    extra = set(body) - set(ALLOWED)
    if extra:
        raise SealError(f"Only {', '.join(ALLOWED)} can be sent; refused {', '.join(sorted(extra))}.")
    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    oaep = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    out = {}
    for name, ct in body.items():
        try:
            value = key.decrypt(base64.b64decode(ct), oaep).decode().strip()
        except Exception as e:  # wrong key pair, damaged text
            raise SealError(f"{name} could not be unsealed. Was public/pipeline-key.json made with the private key "
                            "in the PIPELINE_KEY_PRIVATE secret?") from e
        if not KEY_SHAPE.match(value):
            raise SealError(f"{name} does not look like an API key (letters, digits, - _ . only).")
        out[name] = value
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new-keypair")
    n.add_argument("--private-out", type=Path, default=Path.home() / ".herenow" / "dl3_pipeline_private_key.pem")
    n.add_argument("--public-out", type=Path, default=PUBLIC_KEY_FILE)
    sub.add_parser("unseal")
    a = ap.parse_args(argv)

    if a.cmd == "new-keypair":
        pem, jwk = new_keypair()
        a.private_out.parent.mkdir(parents=True, exist_ok=True)
        a.private_out.write_text(pem)
        a.private_out.chmod(0o600)
        a.public_out.parent.mkdir(parents=True, exist_ok=True)
        a.public_out.write_text(json.dumps(jwk, indent=2) + "\n")
        print(f"  public key (commit it): {a.public_out}\n  private key: {a.private_out}\n"
              "  Next: paste the private key file's whole contents into the GitHub secret PIPELINE_KEY_PRIVATE, "
              "then delete that file.")
        return 0

    try:
        private = os.environ.get("PIPELINE_KEY_PRIVATE", "")
        sealed = os.environ.get("SEALED_KEYS", "")
        if sealed.strip() and not private.strip():
            raise SealError("Keys were sent from the website but the PIPELINE_KEY_PRIVATE secret is not set.")
        values = unseal(sealed, private)
    except SealError as e:
        print(f"::error::{e}")
        return 2
    sources = {name: "website" for name in values}
    for name in ALLOWED:  # nothing typed on the website: the repository secret, if there is one
        fallback = (os.environ.get(f"FALLBACK_{name}") or "").strip()
        if name not in values and fallback and "\n" not in fallback:
            values[name], sources[name] = fallback, "repository secret"
    env_file = os.environ.get("GITHUB_ENV")
    for name, value in values.items():
        print(f"::add-mask::{value}")
        if env_file:
            with open(env_file, "a") as fh:
                fh.write(f"{name}={value}\n")
    print("Keys for this run: " + (", ".join(f"{k} from the {v}" for k, v in sources.items()) or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
