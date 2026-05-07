import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Edge middleware — enforces auth on protected sections of the app.
 *
 * Anything under `/dashboard` requires an authenticated session;
 * unauthenticated visitors are redirected to /login with a `next` param so
 * we can return them after sign-in.
 */
export default auth((req) => {
  const { nextUrl } = req;
  const isAuthed = !!req.auth;

  const isProtected =
    nextUrl.pathname.startsWith("/dashboard");

  if (isProtected && !isAuthed) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("next", nextUrl.pathname + nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // If a logged-in user hits /login, send them straight to the dashboard.
  if (nextUrl.pathname === "/login" && isAuthed) {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  // Skip Next.js internals and static assets so middleware only runs on pages.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
