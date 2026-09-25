import { NextResponse } from 'next/server';

import { adminAuth, adminDb, verifyIdToken } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

/**
 * Resolve an allowlisted, email-verified recipient email to a Firebase Auth UID.
 *
 * Returns uniform `404` when the email is not on `allowlist/{email}`, has not
 * signed in yet, or does not have `emailVerified: true` so the endpoint cannot
 * be used by an allowlisted caller to enumerate unverified or non-allowlisted
 * Firebase Auth accounts.
 */
export async function POST(request: Request): Promise<Response> {
  const callerUid = await verifyIdToken(request.headers.get('authorization'));
  if (!callerUid) {
    return NextResponse.json(
      { error: 'Please sign in with an allowlisted account.' },
      { status: 401 },
    );
  }

  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@') || email.length > 254) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }

  const allowlistSnap = await adminDb().collection('allowlist').doc(email).get();
  if (!allowlistSnap.exists) {
    return NextResponse.json(
      { error: 'That person is not an active allowlisted member yet.' },
      { status: 404 },
    );
  }

  try {
    const userRecord = await adminAuth().getUserByEmail(email);
    if (userRecord.emailVerified !== true || !userRecord.uid) {
      return NextResponse.json(
        { error: 'That person is not an active allowlisted member yet.' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      uid: userRecord.uid,
      email,
    });
  } catch {
    return NextResponse.json(
      { error: 'That person has not signed in to activate their account yet.' },
      { status: 404 },
    );
  }
}
