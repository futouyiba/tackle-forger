import {
  BrowserCanonicalWorkbookError,
  inspectBrowserCanonicalWorkbook,
} from "./browser-canonical-workbook";
import {
  LOCAL_SESSION_PARSER_REQUEST,
  createLocalSessionParsedWorkbook,
  type LocalSessionParserRequest,
  type LocalSessionParserWorkerResponse,
} from "./local-session-parser-protocol";

export async function handleLocalSessionParserRequest(
  request: LocalSessionParserRequest,
): Promise<LocalSessionParserWorkerResponse> {
  if (request.type !== LOCAL_SESSION_PARSER_REQUEST) {
    return {
      type: "local_canonical_workbook_failed",
      generation: request.generation,
      error: {
        code: "LOCAL_SESSION_PARSER_PROTOCOL_INVALID",
        message: "本地工作簿解析请求协议无效。",
      },
    };
  }
  try {
    const parsed = await inspectBrowserCanonicalWorkbook({
      bytes: request.bytes,
      fileName: request.fileName,
      observedAt: request.observedAt,
    });
    return {
      type: "parsed_local_canonical_workbook",
      generation: request.generation,
      result: createLocalSessionParsedWorkbook({
        fileName: request.fileName,
        byteLength: request.byteLength,
        contentSha256: request.contentSha256,
        inspection: parsed.inspection,
        warnings: parsed.observation.warnings,
      }),
    };
  } catch (error) {
    return {
      type: "local_canonical_workbook_failed",
      generation: request.generation,
      error: {
        code:
          error instanceof BrowserCanonicalWorkbookError
            ? error.code
            : "LOCAL_SESSION_PARSE_FAILED",
        message: error instanceof Error ? error.message : "本地工作簿解析失败。",
      },
    };
  }
}

interface ParserWorkerGlobal {
  postMessage(message: LocalSessionParserWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LocalSessionParserRequest>) => void,
  ): void;
  close(): void;
}

const parserWorkerGlobal = globalThis as unknown as Partial<ParserWorkerGlobal>;
if (
  typeof parserWorkerGlobal.postMessage === "function"
  && typeof parserWorkerGlobal.addEventListener === "function"
  && typeof parserWorkerGlobal.close === "function"
  && !("document" in globalThis)
) {
  parserWorkerGlobal.addEventListener("message", (event) => {
    void handleLocalSessionParserRequest(event.data).then((response) => {
      parserWorkerGlobal.postMessage?.(response);
      parserWorkerGlobal.close?.();
    });
  });
}
