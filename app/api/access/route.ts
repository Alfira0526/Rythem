import { NextResponse } from "next/server";
import { allowList, clientIp, isPrivileged } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the client whether this connection may see the test bed; also shows the caller's IP. */
export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  // Diagnostics only: how many entries the server sees and whether each looks like an IP/prefix.
  // Values are never returned.
  const entries = allowList().map((e) => ({
    length: e.length,
    looksValid: /^(\d{1,3}\.){1,3}(\d{1,3})?$|^[0-9a-f:]+$/i.test(e),
  }));
  return NextResponse.json(
    { privileged: isPrivileged(req.headers), ip, configured: entries.length, entries },
    { headers: { "cache-control": "no-store" } },
  );
}
