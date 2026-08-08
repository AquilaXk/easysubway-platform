#!/usr/bin/env python3
import errno
import os
import re
import secrets
import stat
import sys


class PublishError(Exception):
    def __init__(self, code, exit_code):
        self.code = code
        self.exit_code = exit_code


def fail(code, exit_code):
    raise PublishError(code, exit_code)


def require_capabilities():
    required_flags = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, flag) for flag in required_flags):
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    dir_fd_functions = (os.open, os.unlink, os.stat, os.link)
    if any(function not in os.supports_dir_fd for function in dir_fd_functions):
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    if os.link not in os.supports_follow_symlinks or os.stat not in os.supports_follow_symlinks:
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)


def open_directory(path, parent_fd=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        if parent_fd is None:
            return os.open(path, flags)
        return os.open(path, flags, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT):
            fail("E_JRT_OUTPUT_CONFINEMENT", 2)
        raise


def same_identity(first, second):
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def write_all(descriptor, bytes_to_write):
    offset = 0
    while offset < len(bytes_to_write):
        written = os.write(descriptor, bytes_to_write[offset:])
        if written == 0:
            raise OSError("short write")
        offset += written


def read_all(descriptor, expected_size):
    parts = []
    remaining = expected_size
    while remaining:
        part = os.read(descriptor, remaining)
        if not part:
            break
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def unlink_if_identity(directory_fd, name, expected):
    if expected is None:
        return
    try:
        actual = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if same_identity(actual, expected):
            os.unlink(name, dir_fd=directory_fd)
    except OSError:
        pass


def reopen_and_match(repository, root_identity, build_identity, candidates_identity):
    root_fd = build_fd = candidates_fd = None
    try:
        root_fd = open_directory(repository)
        build_fd = open_directory("build", root_fd)
        candidates_fd = open_directory("candidates", build_fd)
        if not (
            same_identity(os.fstat(root_fd), root_identity)
            and same_identity(os.fstat(build_fd), build_identity)
            and same_identity(os.fstat(candidates_fd), candidates_identity)
        ):
            fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    finally:
        for descriptor in (candidates_fd, build_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)


def publish(repository, destination, content):
    if re.fullmatch(r"journey-release-tuple-[a-f0-9]{64}\.json", destination) is None:
        fail("E_JRT_OUTPUT_CONFINEMENT", 2)
    root_fd = build_fd = candidates_fd = temporary_fd = None
    temporary = None
    linked_identity = None
    published = False
    try:
        root_fd = open_directory(repository)
        build_fd = open_directory("build", root_fd)
        candidates_fd = open_directory("candidates", build_fd)
        root_identity = os.fstat(root_fd)
        build_identity = os.fstat(build_fd)
        candidates_identity = os.fstat(candidates_fd)

        temporary = f".journey-release-tuple-{secrets.token_hex(16)}.tmp"
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=candidates_fd,
        )
        write_all(temporary_fd, content)
        os.fsync(temporary_fd)
        temporary_identity = os.fstat(temporary_fd)
        if not stat.S_ISREG(temporary_identity.st_mode):
            fail("E_JRT_STAGE_IO", 1)
        os.close(temporary_fd)
        temporary_fd = None

        try:
            os.link(
                temporary,
                destination,
                src_dir_fd=candidates_fd,
                dst_dir_fd=candidates_fd,
                follow_symlinks=False,
            )
        except FileExistsError:
            fail("E_JRT_OUTPUT_EXISTS", 2)

        # From this point the destination was created by this invocation. Keep
        # its expected inode even if the following verification itself fails,
        # so failure cleanup can remove only that just-linked entry.
        linked_identity = temporary_identity
        linked_identity = os.stat(destination, dir_fd=candidates_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(linked_identity.st_mode)
            or not same_identity(linked_identity, temporary_identity)
            or linked_identity.st_size != len(content)
        ):
            fail("E_JRT_STAGE_IO", 1)
        candidate_fd = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=candidates_fd)
        try:
            candidate_identity = os.fstat(candidate_fd)
            if not same_identity(candidate_identity, linked_identity) or read_all(candidate_fd, len(content)) != content:
                fail("E_JRT_STAGE_IO", 1)
        finally:
            os.close(candidate_fd)
        reopen_and_match(repository, root_identity, build_identity, candidates_identity)
        os.unlink(temporary, dir_fd=candidates_fd)
        temporary = None
        published = True
    except OSError:
        fail("E_JRT_STAGE_IO", 1)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if candidates_fd is not None:
            if not published:
                unlink_if_identity(candidates_fd, destination, linked_identity)
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=candidates_fd)
                except OSError:
                    pass
        for descriptor in (candidates_fd, build_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)


def main():
    if len(sys.argv) != 3:
        fail("E_JRT_STAGE_IO", 1)
    require_capabilities()
    publish(sys.argv[1], sys.argv[2], sys.stdin.buffer.read())


try:
    main()
except PublishError as error:
    print(error.code, file=sys.stderr)
    sys.exit(error.exit_code)
except OSError:
    print("E_JRT_STAGE_IO", file=sys.stderr)
    sys.exit(1)
