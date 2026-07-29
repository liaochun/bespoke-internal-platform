// Server-component wrapper. Unlike admin/users/[user_id] and admin/roles/[role_key],
// this route can't rely on generateStaticParams: claim tokens are minted at runtime
// by "Find a sub" (see api.ts), so the set of valid tokens isn't known at build time.
// Static export requires every path to be pre-rendered, so this is a single fixed
// path instead — the token is read client-side from the query string (see
// ClaimShiftClient), which resolves for any token, seeded or freshly generated.
import ClaimShiftClient from "./ClaimShiftClient";

export default function Page() {
  return <ClaimShiftClient />;
}
