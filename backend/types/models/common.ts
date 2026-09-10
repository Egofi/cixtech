import type { ErrorRecord, ErrorResponseBody, ErrorSeverity } from "../errorTypes/common.js";
import type { HttpMethod } from "../routeTypes/common.js";

export type HttpMethodName = HttpMethod;

export interface ResolvedError {
  status: number;
  severity: ErrorSeverity;
  record: ErrorRecord;
  body: ErrorResponseBody;
  persist: boolean;
}
