import { NextResponse, type NextRequest } from "next/server";
import { isPrivileged } from "@/lib/access";

/** The chart editor is only served to allow-listed IPs (see lib/access.ts). */
export function proxy(req: NextRequest) {
  if (!isPrivileged(req.headers)) {
    return new NextResponse("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/editor", "/editor/:path*"],
};
