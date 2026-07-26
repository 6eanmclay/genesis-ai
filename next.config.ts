import type { NextConfig } from "next";

// A custom Cache-Control override for /dashboard was tried here (to force
// `no-store`) and removed — it never actually took effect (verified via
// curl: identical `no-cache, must-revalidate` header with or without it).
// Next's own internal handling for a page that reads cookies() via auth()
// applies its own Cache-Control after this config runs. The real access
// guarantee doesn't depend on this header anyway: signOut() clears the
// session cookie itself, and every request re-runs auth() server-side —
// confirmed by directly testing that a request with the cleared cookie
// gets a 307 to /login, not the dashboard.
const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
