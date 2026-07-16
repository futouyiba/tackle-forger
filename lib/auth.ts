import type { NextRequest } from "next/server";

export function requestUser(request: NextRequest) {
  const email = request.headers.get("oai-authenticated-user-email") || "local@tackle-forger";
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  const name =
    encoded &&
    request.headers.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encoded)
      : encoded || email.split("@")[0];
  return {
    email,
    name,
    role: "admin" as const,
  };
}
