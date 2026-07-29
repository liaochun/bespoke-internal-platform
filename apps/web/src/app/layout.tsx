import type { Metadata } from "next";

import { DemoModeBanner } from "@/components/DemoModeBanner";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Northbound Ops — Interactive Demo",
  description:
    "A static, client-side demo of the Northbound Ops internal business-operations platform. No real backend — all data lives in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <DemoModeBanner />
      </body>
    </html>
  );
}
