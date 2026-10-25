import { NextResponse } from "next/server";
import { allowList, clientIp, isPrivileged } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the client whether this connection may see the test bed; also shows the caller's IP. */
export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  // "configured" = how many allow-list entries the server can see (never the values themselves)
  return NextResponse.json(
    { privileged: isPrivileged(req.headers), ip, configured: allowList().length },
    { headers: { "cache-control": "no-store" } },
  );
}
