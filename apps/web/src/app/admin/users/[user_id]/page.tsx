// Server-component wrapper. `generateStaticParams` is required for static
// export (`output: "export"`) but isn't allowed in a "use client" file, so
// the actual page logic lives in ./UserProfileClient.tsx (which reads the
// live URL param via useParams() at runtime — unaffected by which params
// were pre-rendered at build time). Visiting a user id below via an in-app
// <Link> click always works client-side; only a hard-refresh / direct visit
// to an id outside this fixed set would need a rebuild to pre-render.
import { PERSONA_KEYS } from "@/lib/demoSeed";

import UserProfileClient from "./UserProfileClient";

export function generateStaticParams() {
  return Object.values(PERSONA_KEYS).map((user_id) => ({ user_id }));
}

export default function Page() {
  return <UserProfileClient />;
}
