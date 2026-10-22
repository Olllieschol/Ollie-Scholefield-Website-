import type { Metadata } from "next";
import { Prototype } from "@/components/preview/Prototype";

export const metadata: Metadata = { title: "Design preview", robots: { index: false } };

export default function FlowPage() {
  return <Prototype />;
}
