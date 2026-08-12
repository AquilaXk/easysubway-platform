#!/usr/bin/env node

import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AcquisitionError,
  inspectServerRouteBundlePublicationDescriptor,
} from "./acquire-server-route-bundle.mjs";
import {
  CandidateBindingError,
  validateJourneyReleaseTupleBytes,
} from "./bind-journey-release-candidate.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "descriptorSha256",
  "producerGitSha",
  "tupleSha256",
  "serverRouteBundleDigest",
]);
const ERROR_MESSAGES = Object.freeze({
  DESCRIPTOR_BINDING_USAGE: "expected exact descriptor binding arguments",
  DESCRIPTOR_SHAPE_INVALID: "publication descriptor validation failed",
  DESCRIPTOR_PRODUCER_IDENTITY_MISMATCH: "descriptor producer identity validation failed",
  DESCRIPTOR_IDENTITY_MISMATCH: "descriptor publication identity validation failed",
  DESCRIPTOR_TUPLE_INVALID: "staged release tuple validation failed",
  DESCRIPTOR_TUPLE_IDENTITY_MISMATCH: "descriptor and release tuple identities differ",
  DESCRIPTOR_INPUT_UNSTABLE: "descriptor binding input changed during verification",
});

export class DescriptorBindingError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "publication descriptor binding failed");
    this.name = "DescriptorBindingError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function bindServerRouteBundlePublicationDescriptor({
  descriptorPath,
  tuplePath,
  beforeSecondRead,
}) {
  if (
    !isNonemptyString(descriptorPath) ||
    !isNonemptyString(tuplePath) ||
    (beforeSecondRead !== undefined && typeof beforeSecondRead !== "function")
  ) throw bindingFailure("DESCRIPTOR_BINDING_USAGE", 2);

  const descriptorBytes = await readRegularInput(
    descriptorPath,
    "DESCRIPTOR_SHAPE_INVALID",
  );
  const tupleBytes = await readRegularInput(tuplePath, "DESCRIPTOR_TUPLE_INVALID");
  let descriptor;
  let tuple;
  try {
    descriptor = inspectServerRouteBundlePublicationDescriptor(descriptorBytes);
  } catch (error) {
    if (error instanceof AcquisitionError) {
      throw bindingFailure(error.code, error.exitCode);
    }
    throw bindingFailure("DESCRIPTOR_SHAPE_INVALID", 2);
  }
  try {
    tuple = validateJourneyReleaseTupleBytes(tupleBytes);
  } catch (error) {
    if (error instanceof CandidateBindingError) {
      throw bindingFailure("DESCRIPTOR_TUPLE_INVALID", error.exitCode);
    }
    throw bindingFailure("DESCRIPTOR_TUPLE_INVALID", 2);
  }
  if (tuple.serverRouteBundleDigest !== descriptor.serverRouteBundleDigest) {
    throw bindingFailure("DESCRIPTOR_TUPLE_IDENTITY_MISMATCH", 2);
  }

  await beforeSecondRead?.();
  const [descriptorSecondRead, tupleSecondRead] = await Promise.all([
    readRegularInput(descriptorPath, "DESCRIPTOR_INPUT_UNSTABLE"),
    readRegularInput(tuplePath, "DESCRIPTOR_INPUT_UNSTABLE"),
  ]);
  if (
    !descriptorBytes.equals(descriptorSecondRead) ||
    !tupleBytes.equals(tupleSecondRead)
  ) throw bindingFailure("DESCRIPTOR_INPUT_UNSTABLE");

  return {
    schemaVersion: "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1",
    artifactKind: "platform-server-route-bundle-descriptor-binding",
    descriptorSha256: descriptor.descriptorSha256,
    producerGitSha: descriptor.producerGitSha,
    tupleSha256: tuple.tupleSha256,
    serverRouteBundleDigest: descriptor.serverRouteBundleDigest,
  };
}

export function formatDescriptorBindingSuccess(binding) {
  if (
    binding === null ||
    Array.isArray(binding) ||
    typeof binding !== "object" ||
    !sameArray(Object.keys(binding), BINDING_FIELDS) ||
    binding.schemaVersion !== "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1" ||
    binding.artifactKind !== "platform-server-route-bundle-descriptor-binding" ||
    !matchesString(binding.descriptorSha256, SHA256) ||
    !matchesString(binding.producerGitSha, GIT_SHA) ||
    !matchesString(binding.tupleSha256, SHA256_REFERENCE) ||
    !matchesString(binding.serverRouteBundleDigest, SHA256_REFERENCE)
  ) throw bindingFailure("DESCRIPTOR_IDENTITY_MISMATCH", 2);
  return `${JSON.stringify(binding)}\n`;
}

async function readRegularInput(path, code) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw bindingFailure(code, code === "DESCRIPTOR_INPUT_UNSTABLE" ? 1 : 2);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw bindingFailure(code, 2);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof DescriptorBindingError) throw error;
    throw bindingFailure(code, code === "DESCRIPTOR_INPUT_UNSTABLE" ? 1 : 2);
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseCliArguments(args) {
  const [descriptorFlag, descriptorPath, tupleFlag, tuplePath] = args;
  if (
    args.length !== 4 ||
    descriptorFlag !== "--descriptor" ||
    tupleFlag !== "--tuple" ||
    !isNonemptyString(descriptorPath) ||
    !isNonemptyString(tuplePath) ||
    descriptorPath.startsWith("--") ||
    tuplePath.startsWith("--")
  ) throw bindingFailure("DESCRIPTOR_BINDING_USAGE", 2);
  return {
    descriptorPath,
    tuplePath,
  };
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function matchesString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function sameArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function bindingFailure(code, exitCode = 1) {
  return new DescriptorBindingError(code, exitCode);
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const binding = await bindServerRouteBundlePublicationDescriptor(input);
  process.stdout.write(formatDescriptorBindingSuccess(binding));
}

if (samePhysicalFile(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    const failure = error instanceof DescriptorBindingError
      ? error
      : bindingFailure("DESCRIPTOR_INPUT_UNSTABLE");
    process.stderr.write(`${failure.code} ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  });
}

function samePhysicalFile(modulePath, entry) {
  if (!entry) return false;
  const entryPath = resolve(entry);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}
