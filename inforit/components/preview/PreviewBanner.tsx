import Link from "next/link";
import { DemoBanner } from "@/components/ui";

export function PreviewBanner() {
  return (
    <DemoBanner>
      <span>Design preview. Made-up people, venues and prices.</span>
      <Link href="/preview" className="shrink-0 font-bold underline underline-offset-2">
        All screens
      </Link>
    </DemoBanner>
  );
}
