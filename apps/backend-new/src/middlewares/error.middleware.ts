import type { Request, Response } from "express";
import {
  ExpressErrorMiddlewareInterface,
  HttpError,
  Middleware
} from "routing-controllers";
import { ValidationError } from "class-validator";
import { Service } from "typedi";
import {
  AppError,
  AppErrorCode,
  formatAppError,
  formatAppErrorCode
} from "../utils/response";
import { ConfigService } from "../services/config.service";

function hasValidationErrors(
  value: unknown
): value is { errors: ValidationError[] } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "errors" in value &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

@Service()
@Middleware({ type: "after" })
export class ErrorMiddleware implements ExpressErrorMiddlewareInterface {
  constructor(private readonly configService: ConfigService) {}

  error(
    error: unknown,
    _request: Request,
    response: Response,
    next: (err?: unknown) => unknown
  ): void {
    try {
      if (response.writableEnded) {
        console.error(error);
        return;
      }

      if (!error) {
        response.status(500).json(formatAppErrorCode(AppErrorCode.Unknown));
        return;
      }

      if (error instanceof AppError) {
        if (this.configService.config.env === "development") {
          console.error(error);
        }
        response.status(400).json(formatAppError(error));
        return;
      }

      if (error instanceof HttpError && hasValidationErrors(error)) {
        const firstError = error.errors[0];
        response.status(error.httpCode).json(
          formatAppError(
            new AppError(AppErrorCode.InvalidParams, {
              msg:
                firstError?.toString(false, true, undefined, true) ??
                error.message
            })
          )
        );
        return;
      }

      if (error instanceof Error) {
        console.error(error);
        response.status(500).json({
          success: false,
          code: AppErrorCode.Unknown,
          msg: error.message
        });
        return;
      }

      console.error(error);
      response.status(500).json(formatAppErrorCode(AppErrorCode.Unknown));
    } finally {
      next();
    }
  }
}
