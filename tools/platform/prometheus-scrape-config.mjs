// prometheus.yml(고정 형식)의 scrape_configs를 YAML 의존성 없이 읽는다. 계약 테스트들이 같은 파서를 쓴다.

// job별 static target 문자열.
export function scrapeTargetsByJob(text) {
  const jobs = new Map();
  let current;
  let inTargets = false;
  for (const line of text.split("\n")) {
    const job = line.match(/^  - job_name: "([^"]+)"\s*$/);
    if (job) {
      current = job[1];
      jobs.set(current, []);
      inTargets = false;
      continue;
    }
    if (!current) continue;
    if (/^\s+- targets:\s*$/.test(line)) {
      inTargets = true;
      continue;
    }
    const inline = line.match(/^\s+- targets: \[(.*)\]\s*$/);
    if (inline) {
      jobs.get(current).push(...inline[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")));
      inTargets = false;
      continue;
    }
    const item = line.match(/^\s+- "([^"]+)"\s*$/);
    if (inTargets && item) {
      jobs.get(current).push(item[1]);
      continue;
    }
    if (inTargets && line.trim() !== "") inTargets = false;
  }
  return jobs;
}

// job별 params.module(없으면 null)과 relabel로 덮는 __address__ 값(없으면 null).
export function scrapeJobSettings(text) {
  const jobs = new Map();
  let current;
  let addressRelabel = false;
  for (const line of text.split("\n")) {
    const job = line.match(/^  - job_name: "([^"]+)"\s*$/);
    if (job) {
      current = { module: null, address: null };
      jobs.set(job[1], current);
      addressRelabel = false;
      continue;
    }
    if (!current) continue;
    current.module ??= line.match(/^\s+module: \[([a-z0-9_]+)\]\s*$/)?.[1] ?? null;
    if (/^\s+- target_label: __address__\s*$/.test(line)) addressRelabel = true;
    else if (addressRelabel) {
      current.address ??= line.match(/^\s+replacement: (\S+)\s*$/)?.[1] ?? null;
      addressRelabel = false;
    }
  }
  return jobs;
}
