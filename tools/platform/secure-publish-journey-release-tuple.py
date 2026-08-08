#!/usr/bin/env python3
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys


IDENTITY_FIELDS = (
    "backendImageDigest", "backendConfigDigest", "journeyContractDigest",
    "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity",
)
REQUIRED_FIELDS = ("schemaVersion", "artifactKind", *IDENTITY_FIELDS, "tupleSha256")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
REVISION = re.compile(r"[a-f0-9]{40}\Z")
ENVIRONMENT = re.compile(r"[A-Za-z0-9._-]+\Z")
IDENTITY_HEADER = re.compile(rb"EASYSUBWAY_JRT_PUBLISH_V1 ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+)\Z")
REPOSITORY = Path(__file__).resolve().parents[2]


class PublishError(Exception):
    def __init__(self, code, exit_code):
        self.code = code
        self.exit_code = exit_code


def fail(code, exit_code):
    raise PublishError(code, exit_code)


def require_capabilities():
    if any(not hasattr(os, flag) for flag in ("O_DIRECTORY", "O_NOFOLLOW")):
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    if any(function not in os.supports_dir_fd for function in (os.open, os.unlink, os.stat, os.link)):
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    if os.link not in os.supports_follow_symlinks or os.stat not in os.supports_follow_symlinks:
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)


def parse_candidate(content):
    try:
        candidate = json.loads(content, object_pairs_hook=exact_candidate_object)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("E_JRT_STAGE_IO", 1)
    if not isinstance(candidate, dict):
        fail("E_JRT_STAGE_IO", 1)
    if candidate.get("schemaVersion") != "JOURNEY_RELEASE_TUPLE_V1" or candidate.get("artifactKind") != "journey-release-tuple":
        fail("E_JRT_STAGE_IO", 1)
    if not all(isinstance(candidate.get(name), str) and DIGEST.fullmatch(candidate[name]) for name in IDENTITY_FIELDS[:4]):
        fail("E_JRT_STAGE_IO", 1)
    if not isinstance(candidate.get("deploymentRevision"), str) or not REVISION.fullmatch(candidate["deploymentRevision"]):
        fail("E_JRT_STAGE_IO", 1)
    if not isinstance(candidate.get("environmentIdentity"), str) or not ENVIRONMENT.fullmatch(candidate["environmentIdentity"]):
        fail("E_JRT_STAGE_IO", 1)
    expected = "sha256:" + hashlib.sha256(
        ("\n".join(candidate[name] for name in IDENTITY_FIELDS) + "\n").encode("utf-8")
    ).hexdigest()
    if candidate.get("tupleSha256") != expected:
        fail("E_JRT_STAGE_IO", 1)
    return f"journey-release-tuple-{expected.removeprefix('sha256:')}.json"


def parse_request(payload):
    header, separator, content = payload.partition(b"\n")
    match = IDENTITY_HEADER.fullmatch(header)
    if not separator or match is None or not content:
        fail("E_JRT_STAGE_IO", 1)
    return tuple(int(value) for value in match.groups()), content


def exact_candidate_object(pairs):
    if tuple(name for name, _ in pairs) != REQUIRED_FIELDS:
        fail("E_JRT_STAGE_IO", 1)
    return dict(pairs)


def open_directory(path, parent_fd=None):
    try:
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT):
            fail("E_JRT_OUTPUT_CONFINEMENT", 2)
        raise


def open_chain():
    descriptors = []
    try:
        descriptors.append(open_directory(REPOSITORY))
        descriptors.append(open_directory("build", descriptors[0]))
        descriptors.append(open_directory("candidates", descriptors[1]))
        return tuple(descriptors), tuple(os.fstat(fd) for fd in descriptors)
    except Exception:
        close_all(descriptors)
        raise


def close_all(descriptors):
    for descriptor in reversed(descriptors):
        if descriptor is not None:
            os.close(descriptor)


def same_identity(first, second):
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def identities_match(actual, expected):
    flattened = tuple(value for identity in actual for value in (identity.st_dev, identity.st_ino))
    return flattened == expected


def write_all(descriptor, content):
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written == 0:
            raise OSError("short write")
        offset += written


def read_all(descriptor, expected_size):
    parts = []
    while sum(map(len, parts)) < expected_size:
        part = os.read(descriptor, expected_size)
        if not part:
            break
        parts.append(part)
    return b"".join(parts)


def unlink_if_identity(directory_fd, name, expected):
    try:
        if expected is not None and same_identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False), expected):
            os.unlink(name, dir_fd=directory_fd)
            return True
    except OSError:
        pass
    return False


def create_temporary(directory_fd, content):
    name = f".journey-release-tuple-{secrets.token_hex(16)}.tmp"
    descriptor = None
    identity = None
    try:
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        identity = os.fstat(descriptor)
        if not stat.S_ISREG(identity.st_mode):
            fail("E_JRT_STAGE_IO", 1)
        write_all(descriptor, content)
        os.fsync(descriptor)
        if not same_identity(os.fstat(descriptor), identity):
            fail("E_JRT_STAGE_IO", 1)
        return name, identity
    except Exception:
        unlink_if_identity(directory_fd, name, identity)
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def link_and_verify(directory_fd, temporary, destination, temporary_identity, content, publication):
    try:
        os.link(temporary, destination, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
    except FileExistsError:
        fail("E_JRT_OUTPUT_EXISTS", 2)
    publication["created_identity"] = temporary_identity
    observed_identity = os.stat(destination, dir_fd=directory_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(observed_identity.st_mode)
        or not same_identity(observed_identity, temporary_identity)
        or observed_identity.st_size != len(content)
    ):
        fail("E_JRT_STAGE_IO", 1)
    descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        if not same_identity(os.fstat(descriptor), temporary_identity) or read_all(descriptor, len(content)) != content:
            fail("E_JRT_STAGE_IO", 1)
    finally:
        os.close(descriptor)


def verify_fresh_chain(expected):
    descriptors, identities = open_chain()
    try:
        if not all(same_identity(actual, wanted) for actual, wanted in zip(identities, expected)):
            fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    finally:
        close_all(descriptors)


def publish(expected_identities, content):
    destination = parse_candidate(content)
    descriptors = (None, None, None)
    temporary = None
    temporary_identity = None
    publication = {"created_identity": None}
    published = False
    try:
        descriptors, identities = open_chain()
        if not identities_match(identities, expected_identities):
            fail("E_JRT_OUTPUT_CONFINEMENT", 2)
        candidates_fd = descriptors[2]
        temporary, temporary_identity = create_temporary(candidates_fd, content)
        link_and_verify(candidates_fd, temporary, destination, temporary_identity, content, publication)
        if not unlink_if_identity(candidates_fd, temporary, temporary_identity):
            fail("E_JRT_STAGE_IO", 1)
        temporary = None
        os.fsync(candidates_fd)
        verify_fresh_chain(identities)
        published = True
    except OSError:
        fail("E_JRT_STAGE_IO", 1)
    finally:
        if descriptors[2] is not None:
            if not published:
                unlink_if_identity(descriptors[2], destination, publication["created_identity"])
            if temporary is not None:
                unlink_if_identity(descriptors[2], temporary, temporary_identity)
        close_all(descriptors)


def main():
    if len(sys.argv) != 1:
        fail("E_JRT_USAGE", 2)
    require_capabilities()
    expected_identities, content = parse_request(sys.stdin.buffer.read())
    publish(expected_identities, content)


try:
    main()
except PublishError as error:
    print(error.code, file=sys.stderr)
    sys.exit(error.exit_code)
except OSError:
    print("E_JRT_STAGE_IO", file=sys.stderr)
    sys.exit(1)
