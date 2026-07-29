// Server-component wrapper — see admin/users/[user_id]/page.tsx for why this
// split exists. Pre-renders every built-in role key (fixed/deterministic,
// unlike the random-per-browser staff user ids).
import RoleDetailClient from "./RoleDetailClient";

const BUILT_IN_ROLE_KEYS = ["super_admin", "admin", "manager", "assistant_manager", "accountant", "staff"];

export function generateStaticParams() {
  return BUILT_IN_ROLE_KEYS.map((role_key) => ({ role_key }));
}

export default function Page({ params }: { params: { role_key: string } }) {
  return <RoleDetailClient params={params} />;
}
