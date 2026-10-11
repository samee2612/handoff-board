import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Publication is only available through an approved handoff review." },
    { status: 405 },
  );
}
