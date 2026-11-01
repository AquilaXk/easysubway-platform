// platform#227·#273: 관측 설정 배포 모듈들이 같이 쓰는 오류 형식과 digest. 오류 코드(E_OBS_DEPLOY_*)는 runbook과 receipt가 그대로 읽는다.
import { createHash } from "node:crypto";

export class DeployError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export const fail = (code, detail) => { throw new DeployError(code, detail); };
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const message = (error) => String(error?.detail ?? error?.message ?? error).slice(0, 600);
