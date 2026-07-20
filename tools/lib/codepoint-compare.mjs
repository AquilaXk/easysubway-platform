// 로케일 무관 코드포인트(UTF-16 code unit) 비교자.
//
// `String.prototype.localeCompare`를 로케일 인자 없이 호출하면 콜레이션이 실행 환경의
// ICU 기본 로케일에 의존한다(#2390). 그 결과 정렬 순서가 빌드 머신마다 달라져
// canonicalScopeHash나 datapack/evidence 산출물의 바이트·sha가 비결정적으로 갈릴 수 있다.
// tools/ 전반의 정렬 비교는 로케일에 의존하면 안 되므로, 로케일 무관·결정적인 이 헬퍼로
// 통일한다. 사용자 표시용 한국어 콜레이션이 실제로 필요한 곳에서만 명시 로케일
// (`localeCompare(other, "ko")` 등)을 쓴다.
export function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
