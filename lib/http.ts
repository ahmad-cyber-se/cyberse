import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, { status: 200, ...init });
}
export function created(data: unknown) { return NextResponse.json(data, { status: 201 }); }
export function badRequest(message: string) { return NextResponse.json({ error: message }, { status: 400 }); }
export function unauthorized(message='Authentication required') { return NextResponse.json({ error: message }, { status: 401 }); }
export function forbidden(message='Access denied') { return NextResponse.json({ error: message }, { status: 403 }); }
export function notFound(message='Not found') { return NextResponse.json({ error: message }, { status: 404 }); }
export function conflict(message: string) { return NextResponse.json({ error: message }, { status: 409 }); }
export function serverError(error: unknown) {
  console.error(error);
  return NextResponse.json({ error: 'A server error occurred' }, { status: 500 });
}
