import { NextResponse } from 'next/server';
import { sendApprovalMessages } from '../../utils/sendApprovalMessages';

export async function GET() {
  try {
    const result = await sendApprovalMessages();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("Cron execution error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
