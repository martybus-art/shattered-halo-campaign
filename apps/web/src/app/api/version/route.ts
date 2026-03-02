import { NextResponse } from "next/server";

// Ensure this route's bundle hash differs from other tiny routes.
// Prevents Vercel from attempting serverless function deduplication via symlink.

export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const revalidate = 0;
export const dynamic = "force-dynamic";
const __route_id = "api-version";



export async function GET() {
  return NextResponse.json({
    now: new Date().toISOString(),
    git: {
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      message: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    // harmless extra field to ensure output differs too (optional, but helps)
    route: __route_id,
  });
}
