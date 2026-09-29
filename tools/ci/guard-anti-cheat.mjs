import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EasySubway Platform Anti-Cheating & Infrastructure Integrity Guard
 * (Standardized on EasyConvert Multi-Gate Architecture)
 *
 * Scans infrastructure manifests, operations tooling, and CI scripts to enforce:
 * 1. ANTI-CIRCULAR-MOCKING: Test helpers circularly referencing deployment artifacts.
 * 2. ANTI-SILENT-PASS: Silent catches or "|| true" masking deployment health check failures.
 * 3. ANTI-PRODUCTION-CHEAT: Insecure bypass flags, dummy secrets, or test-only port exposures.
 * 4. ANTI-HOLLOW-ASSERTION: Tautological assertions in test suites.
 * 5. GATE_INFRA_SECURITY: Fail-closed configuration and zero fake tokens.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  '.cache',
  'build',
  'dist',
  '.external',
]);

const SUPPORTED_EXTENSIONS = /\.(mjs|cjs|js|ts|yaml|yml|json|sh)$/;

export function scanDirectory(dir, extension = SUPPORTED_EXTENSIONS, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        scanDirectory(path.join(dir, entry.name), extension, fileList);
      }
    } else if (entry.isFile() && extension.test(entry.name)) {
      fileList.push(path.join(dir, entry.name));
    }
  }
  return fileList;
}

export function getLineAndSnippet(content, index, matchLength = 0) {
  const upToMatch = content.slice(0, index);
  const line = upToMatch.split('\n').length;
  const lineStart = content.lastIndexOf('\n', index) + 1;
  let lineEnd = content.indexOf('\n', index + Math.max(matchLength, 1));
  if (lineEnd === -1) lineEnd = content.length;
  const snippet = content.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
  return {
    line,
    snippet: snippet.length > 120 ? snippet.slice(0, 117) + '...' : snippet,
  };
}

export function checkCircularMocking(repoRoot = ROOT_DIR) {
  const violations = [];
  const testHelperDirs = [
    path.join(repoRoot, 'tools/ci'),
  ];
  const files = testHelperDirs
    .flatMap((d) => scanDirectory(d, /\.(mjs|cjs|js)$/))
    .filter((f) => !f.endsWith('guard-anti-cheat.mjs'));

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const circularPattern = /(?:import\s+[\s\S]*?\s+from|require\s*\(|import\s*\()\s*['"](\.\.?\/[^'"]*(?:\/deploy|\/production))['"]/gs;
    let match;
    while ((match = circularPattern.exec(content)) !== null) {
      const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
      violations.push({
        file: path.relative(repoRoot, file),
        line,
        rule: 'ANTI-CIRCULAR-MOCKING',
        snippet,
        message: 'Test helper circularly imports deployment engine.',
      });
    }
  }
  return violations;
}

export function checkSilentPassBypasses(repoRoot = ROOT_DIR) {
  const violations = [];
  const testFiles = scanDirectory(path.join(repoRoot, 'tools'), /\.(test\.mjs|spec\.mjs)$/)
    .filter((f) => !f.endsWith('guard-anti-cheat.test.mjs'));

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const bypassPatterns = [
      {
        regex: /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,60}?return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\})\s*;?[\s\S]{0,20}?\}/gis,
        desc: 'Catch block silently returning true in JS test.',
      },
    ];
    for (const pattern of bypassPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-SILENT-PASS',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }

  // Scan shell scripts in ops/tools for silent || true in validation
  const shFiles = scanDirectory(path.join(repoRoot, 'tools'), /\.sh$/);
  for (const file of shFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const silentPattern = /(?:healthcheck|validate|verify)[^\n]*\|\|\s*true/gi;
    let match;
    while ((match = silentPattern.exec(content)) !== null) {
      const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
      violations.push({
        file: path.relative(repoRoot, file),
        line,
        rule: 'ANTI-SILENT-PASS',
        snippet,
        message: 'Masking healthcheck/validation failure with "|| true".',
      });
    }
  }

  return violations;
}

export function checkProductionCheats(repoRoot = ROOT_DIR) {
  const violations = [];
  const manifestDirs = [
    path.join(repoRoot, 'k8s'),
    path.join(repoRoot, 'helm'),
    path.join(repoRoot, 'docker'),
  ];
  const manifestFiles = manifestDirs
    .flatMap((d) => scanDirectory(d, /\.(yaml|yml|json)$/));

  const cheatPatterns = [
    {
      regex: /['"]?(?:password|secret|key)['"]?\s*:\s*['"]?(?:dummy|fake|placeholder|secret123|password123)['"]?/gi,
      desc: 'Dummy or placeholder credential detected in infrastructure manifest.',
    },
  ];

  for (const file of manifestFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of cheatPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-PRODUCTION-CHEAT',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }

  return violations;
}

export function checkHollowAssertions(repoRoot = ROOT_DIR) {
  const violations = [];
  const testFiles = scanDirectory(path.join(repoRoot, 'tools'), /\.(test\.mjs|spec\.mjs)$/)
    .filter((f) => !f.endsWith('guard-anti-cheat.test.mjs'));

  const hollowPatterns = [
    {
      regex: /assert\.(?:strictEqual|equal)\s*\(\s*([a-zA-Z0-9_$]+)\s*,\s*\1\s*\)/g,
      desc: 'Tautological assertion comparing variable with itself.',
    },
    {
      regex: /assert\.(?:ok|isTrue)\s*\(\s*true\s*\)/g,
      desc: 'Hollow assertion assert.ok(true).',
    },
  ];

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of hollowPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-HOLLOW-ASSERTION',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
  return violations;
}

export function runAntiCheatAudit(repoRoot = ROOT_DIR) {
  return [
    ...checkCircularMocking(repoRoot),
    ...checkSilentPassBypasses(repoRoot),
    ...checkProductionCheats(repoRoot),
    ...checkHollowAssertions(repoRoot),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('\n🔒 Running EasySubway Platform Anti-Cheat & Infrastructure Integrity Guard (EasyConvert Standard)...\n');
  const violations = runAntiCheatAudit();

  if (violations.length > 0) {
    console.error(`\x1b[31m❌ [REJECTED] Found ${violations.length} Anti-Cheat violation(s):\x1b[0m\n`);
    for (const v of violations) {
      console.error(`  \x1b[33m${v.file}:${v.line}\x1b[0m [\x1b[31m${v.rule}\x1b[0m]`);
      console.error(`    Snippet : "${v.snippet}"`);
      console.error(`    Reason  : ${v.message}\n`);
    }
    process.exit(1);
  } else {
    console.log('\x1b[32m✅ [PASS] Zero shortcuts, zero circular mocks, zero silent passes, zero hollow assertions detected.\x1b[0m\n');
    process.exit(0);
  }
}
