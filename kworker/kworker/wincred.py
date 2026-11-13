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


CRED_PERSIST_LOCAL_MACHINE = 2


def write(target: str, user: str, secret: str) -> None:
    """Stores a generic credential through CredWriteW, so the secret never
    appears on a command line (cmdkey /pass:<secret> would put it there)."""
    if os.name != "nt":
        raise OSError("Windows Credential Manager exists only on Windows")
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    blob = secret.encode("utf-16-le")
    buf = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
    cred = _CREDENTIAL()
    cred.Type = CRED_TYPE_GENERIC
    cred.TargetName = target
    cred.UserName = user
    cred.CredentialBlobSize = len(blob)
    cred.CredentialBlob = ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE
    if not advapi.CredWriteW(ctypes.byref(cred), 0):
        raise OSError(f"CredWriteW failed for {target}: error {ctypes.get_last_error()}")
