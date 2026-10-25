import { NextResponse } from "next/server";
import { clientIp, isPrivileged } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the client whether this connection may see the test bed; also shows the caller's IP. */
export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  return NextResponse.json({ privileged: isPrivileged(req.headers), ip }, { headers: { "cache-control": "no-store" } });
}
