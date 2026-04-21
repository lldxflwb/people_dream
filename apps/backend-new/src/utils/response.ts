export enum AppErrorCode {
  InvalidParams = -1001,
  Unknown = -1000
}

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly data?: Record<string, unknown>
  ) {
    super(
      data?.msg && typeof data.msg === "string" ? data.msg : "Application error"
    );
    this.name = "AppError";
  }
}

export function formatAppError(error: AppError) {
  return {
    success: false,
    code: error.code,
    msg: error.message,
    data: error.data ?? null
  };
}

export function formatAppErrorCode(code: AppErrorCode) {
  return formatAppError(new AppError(code));
}
