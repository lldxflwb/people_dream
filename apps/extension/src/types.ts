export const MESSAGE_TYPE_CAPTURE_PAGE = "capture-page" as const;
export const MESSAGE_TYPE_FORCE_CAPTURE = "force-capture" as const;

export type CaptureReason = "hidden" | "manual" | "timer" | "unload";

export interface CapturePayload {
  capturedAt: string;
  dwellMs: number;
  excerpt: string;
  pageSignals: string[];
  reason: CaptureReason;
  scrollDepth: number;
  textContent: string;
  title: string;
  url: string;
}

export interface CapturePageMessage {
  payload: CapturePayload;
  type: typeof MESSAGE_TYPE_CAPTURE_PAGE;
}

export interface ForceCaptureMessage {
  type: typeof MESSAGE_TYPE_FORCE_CAPTURE;
}

export type RuntimeMessage = CapturePageMessage | ForceCaptureMessage;

export interface ExtensionStateResponse {
  report: {
    stats: {
      trackedPages: number;
    };
  };
  settings: {
    paused: boolean;
  };
}

export interface PageStatusResponse {
  blacklisted?: boolean;
  exists?: boolean;
  normalizedUrl?: string;
  resource?: {
    lastSeenAt: string;
    versionCount: number;
    visitCount: number;
  };
  rule?: {
    kind: string;
    mode: string;
    pattern: string;
  };
}
