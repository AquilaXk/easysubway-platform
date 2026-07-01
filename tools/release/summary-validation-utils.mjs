import { readFile } from "node:fs/promises";

export function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function required(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`summary missing ${name}`);
  }
  return value;
}

export function collectStrings(value, path = "$", out = []) {
  if (typeof value === "string") out.push([path, value]);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => collectStrings(item, `${path}.${key}`, out));
  }
  return out;
}

export function stableFlatJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export async function readJson(path) {
  return readFile(path, "utf8").then(JSON.parse);
}
