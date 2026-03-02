import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      now: new Date().toISOString(),
      git: {
        sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        message: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
        ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      },
    },
    {
      headers: { "x-route-id": "api-version" },
    }
  );
}