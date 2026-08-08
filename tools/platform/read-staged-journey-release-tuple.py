#!/usr/bin/env python3
import hashlib
import errno
import json
import os
import re
import stat
import sys

IDENTITY_FIELDS = (
    "backendImageDigest",
    "backendConfigDigest",
    "journeyContractDigest",
    "serverRouteBundleDigest",
    "deploymentRevision",
    "environmentIdentity",
)
REQUIRED_FIELDS = ("schemaVersion", "artifactKind", *IDENTITY_FIELDS, "tupleSha256")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
REVISION = re.compile(r"[a-f0-9]{40}\Z")
ENVIRONMENT = re.compile(r"[A-Za-z0-9._-]+\Z")


def fail(code, status):
    sys.stderr.write(f"{code}\n")
    raise SystemExit(status)


def usage(argv):
    if len(argv) != 6 or argv[0::2] != ["--tuple-sha256", "--deployment-revision", "--environment-identity"]:
        fail("E_JRT_READ_USAGE", 2)
    tuple_sha, revision, environment = argv[1::2]
    if not SHA.fullmatch(tuple_sha) or not REVISION.fullmatch(revision) or not ENVIRONMENT.fullmatch(environment):
        fail("E_JRT_READ_USAGE", 2)
    return tuple_sha, revision, environment


def nofollow_flags():
    if (
        not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
        or not hasattr(os, "O_NONBLOCK")
        or os.open not in os.supports_dir_fd
    ):
        fail("E_JRT_READ_CONFINEMENT", 2)
    return os.O_DIRECTORY | os.O_NOFOLLOW


def open_chain():
    directory_flags = nofollow_flags()
    repository = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    fds = []
    try:
        fds.append(os.open(repository, os.O_RDONLY | directory_flags))
        fds.append(os.open("build", os.O_RDONLY | directory_flags, dir_fd=fds[-1]))
        fds.append(os.open("candidates", os.O_RDONLY | directory_flags, dir_fd=fds[-1]))
        return tuple(fds)
    except OSError as error:
        close_all(reversed(fds))
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            fail("E_JRT_READ_CONFINEMENT", 2)
        fail("E_JRT_READ_IO", 1)


def identity(fd):
    info = os.fstat(fd)
    return info.st_dev, info.st_ino


def close_all(fds):
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def read_candidate(candidates_fd, filename):
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=candidates_fd)
    except OSError as error:
        if error.errno == errno.ELOOP:
            fail("E_JRT_READ_CONFINEMENT", 2)
        if error.errno == errno.ENOENT:
            fail("E_JRT_CANDIDATE_NOT_REGULAR", 2)
        fail("E_JRT_READ_IO", 1)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= 4096:
            fail("E_JRT_CANDIDATE_NOT_REGULAR", 2)
        chunks = []
        remaining = info.st_size
        while True:
            chunk = os.read(fd, max(1, min(4097, remaining + 1)))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
            if remaining < 0:
                fail("E_JRT_READ_IO", 1)
        if remaining != 0:
            fail("E_JRT_READ_IO", 1)
        return b"".join(chunks), identity(fd)
    except OSError:
        fail("E_JRT_READ_IO", 1)
    finally:
        close_all((fd,))


def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def validate(bytes_value, requested_sha, requested_revision, requested_environment):
    try:
        candidate = json.loads(bytes_value.decode("utf-8"), object_pairs_hook=object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        fail("E_JRT_CANDIDATE_JSON", 2)
    if not isinstance(candidate, dict):
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if tuple(candidate.keys()) != REQUIRED_FIELDS:
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if candidate["schemaVersion"] != "JOURNEY_RELEASE_TUPLE_V1" or candidate["artifactKind"] != "journey-release-tuple":
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if not all(isinstance(candidate[name], str) and DIGEST.fullmatch(candidate[name]) for name in IDENTITY_FIELDS[:4]):
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if not isinstance(candidate["deploymentRevision"], str) or not REVISION.fullmatch(candidate["deploymentRevision"]):
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if not isinstance(candidate["environmentIdentity"], str) or len(candidate["environmentIdentity"]) > 255 or not ENVIRONMENT.fullmatch(candidate["environmentIdentity"]):
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    if not isinstance(candidate["tupleSha256"], str) or not DIGEST.fullmatch(candidate["tupleSha256"]):
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    canonical = (json.dumps(candidate, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if bytes_value != canonical:
        fail("E_JRT_CANDIDATE_SCHEMA", 2)
    computed = "sha256:" + hashlib.sha256(("\n".join(candidate[name] for name in IDENTITY_FIELDS) + "\n").encode("utf-8")).hexdigest()
    if candidate["tupleSha256"] != computed or requested_sha != computed.removeprefix("sha256:") or candidate["deploymentRevision"] != requested_revision or candidate["environmentIdentity"] != requested_environment:
        fail("E_JRT_CANDIDATE_IDENTITY", 2)


def main():
    requested_sha, requested_revision, requested_environment = usage(sys.argv[1:])
    filename = f"journey-release-tuple-{requested_sha}.json"
    chain = open_chain()
    try:
        chain_identity = tuple(identity(fd) for fd in chain)
        bytes_value, candidate_identity = read_candidate(chain[2], filename)
        validate(bytes_value, requested_sha, requested_revision, requested_environment)
        fresh_chain = open_chain()
        try:
            fresh_identity = tuple(identity(fd) for fd in fresh_chain)
            fresh_bytes, fresh_candidate_identity = read_candidate(fresh_chain[2], filename)
            if fresh_identity != chain_identity or fresh_candidate_identity != candidate_identity or fresh_bytes != bytes_value:
                fail("E_JRT_READ_CONFINEMENT", 2)
        finally:
            close_all(fresh_chain)
        try:
            offset = 0
            while offset < len(bytes_value):
                offset += os.write(1, bytes_value[offset:])
        except (OSError, BrokenPipeError):
            fail("E_JRT_READ_IO", 1)
    finally:
        close_all(chain)


if __name__ == "__main__":
    main()
