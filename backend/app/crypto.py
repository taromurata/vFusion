"""Fernet wrapper for credential encryption at rest.

Key resolution order on backend startup:

  1. ``FERNET_KEY`` env var. Set this for managed deploys (1Password,
     CI-injected secrets, etc.) — it wins over everything else.
  2. On-disk key at ``/app/secrets/fernet.key`` (persisted in the
     ``vfusion_secrets`` named docker volume). Survives container
     rebuilds; lives next to no other state.
  3. None of the above → generate a new key, write it to the secrets
     volume with mode 0600, and use it. First-run UX is now zero-touch:
     ``docker compose up`` is the whole bootstrap.

Losing the resolved key makes every stored credential unrecoverable —
that's the point. The secrets volume needs to be backed up for
disaster recovery. If you migrate to another host, copy that volume
(or set ``FERNET_KEY`` explicitly via env from your secrets manager).
"""

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


logger = logging.getLogger(__name__)


SECRETS_DIR = Path("/app/secrets")
KEY_FILE = SECRETS_DIR / "fernet.key"


def _resolve_key() -> bytes:
    """Return the Fernet key bytes, generating + persisting if needed."""
    # 1) env var — explicit takes priority
    if settings.fernet_key:
        return settings.fernet_key.encode()

    # 2) on-disk
    if KEY_FILE.exists():
        return KEY_FILE.read_bytes().strip()

    # 3) generate
    try:
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise RuntimeError(
            f"Can't create secrets dir {SECRETS_DIR}: {e}. Either set "
            f"FERNET_KEY in .env, or make sure the vfusion_secrets volume "
            f"is mounted at /app/secrets in docker-compose.yml."
        ) from e
    new_key = Fernet.generate_key()
    KEY_FILE.write_bytes(new_key + b"\n")
    try:
        KEY_FILE.chmod(0o600)
    except OSError:
        # Some filesystems (bind mounts on Windows hosts, etc.) don't
        # support chmod. Not fatal — the docker volume is already
        # access-controlled at the host level.
        pass
    logger.warning(
        "FERNET_KEY not set in env — generated a new key at %s and "
        "persisted to the vfusion_secrets docker volume. Back up that "
        "volume; if you lose the key, every encrypted credential in "
        "the database becomes unreadable.",
        KEY_FILE,
    )
    return new_key


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    return Fernet(_resolve_key())


def encrypt_secret(payload: dict[str, Any]) -> str:
    """Encrypt a dict to a string. Returns base64-encoded ciphertext."""
    plaintext = json.dumps(payload, separators=(",", ":")).encode()
    return _fernet().encrypt(plaintext).decode()


def decrypt_secret(ciphertext: str) -> dict[str, Any]:
    """Decrypt back to a dict. Raises ValueError if the key is wrong."""
    try:
        plaintext = _fernet().decrypt(ciphertext.encode())
    except InvalidToken as e:
        raise ValueError("decryption failed — wrong FERNET_KEY?") from e
    return json.loads(plaintext.decode())
