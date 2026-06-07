import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Edge middleware — enforces auth on protected sections of the app.
 *
 * Anything under `/dashboard` requires an authenticated session;
 * unauthenticated visitors are redirected to /login with a `next` param so
 * we can return them after sign-in.
 *
 * Sessions whose JWT callback set `error` (refresh failed → API token is
 * dead) are also bounced to /login: even if Auth.js's own session cookie
 * is still valid, requests would fail with 401 once they hit the API.
 */
export default auth((req) => {
  const { nextUrl } = req;
  const session = req.auth;
  const isAuthed = !!session && !session.error;

  const isProtected =
    nextUrl.pathname.startsWith("/dashboard") ||
    nextUrl.pathname.startsWith("/documents") ||
    nextUrl.pathname.startsWith("/admin") ||
    nextUrl.pathname.startsWith("/incidents") ||
    nextUrl.pathname.startsWith("/notifications") ||
    nextUrl.pathname.startsWith("/search") ||
    nextUrl.pathname.startsWith("/workflows") ||
    nextUrl.pathname.startsWith("/wiki") ||
    nextUrl.pathname.startsWith("/imports") ||
    nextUrl.pathname.startsWith("/chat") ||
    nextUrl.pathname.startsWith("/video") ||
    nextUrl.pathname.startsWith("/monitoring") ||
    nextUrl.pathname.startsWith("/media") ||
    nextUrl.pathname.startsWith("/ai") ||
    nextUrl.pathname.startsWith("/audit") ||
    nextUrl.pathname.startsWith("/analytics");

  if (isProtected && !isAuthed) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("next", nextUrl.pathname + nextUrl.search);
    if (session?.error) {
      loginUrl.searchParams.set("reason", session.error);
    }
    return NextResponse.redirect(loginUrl);
  }

  if (nextUrl.pathname === "/login" && isAuthed) {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
