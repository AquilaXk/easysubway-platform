/** expected의 모든 필드가 actual에 같은 값으로 있으면 참이다(클러스터가 채운 기본값 등 actual의 추가 필드는 허용). */
export function isSubset(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => isSubset(item, actual[index]));
  if (expected !== null && typeof expected === "object") {
    return actual !== null && typeof actual === "object" && Object.keys(expected).every((key) => isSubset(expected[key], actual[key]));
  }
  return expected === actual;
}
