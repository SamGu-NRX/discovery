"""Reads a generic credential from Windows Credential Manager, so secrets
reach kworker without an environment variable or a file. Names are in
docs/KNOWLEDGE.md ("Credentials on the Zephyrus")."""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes

CRED_TYPE_GENERIC = 1


class _CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def read(target: str) -> tuple[str | None, str] | None:
    """(user name, secret) of the generic credential `target`, or None when
    there is none or this is not Windows."""
    if os.name != "nt":
        return None
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    pcred = ctypes.POINTER(_CREDENTIAL)()
    if not advapi.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(pcred)):
        return None
    try:
        c = pcred.contents
        raw = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize)
        # cmdkey and the Credential Manager UI store the secret as UTF-16.
        try:
            secret = raw.decode("utf-16-le")
        except UnicodeDecodeError:
            secret = raw.decode("utf-8")
        return c.UserName, secret.strip()
    finally:
        advapi.CredFree(pcred)
