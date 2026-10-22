import { redirect } from "next/navigation";

// Stage A: the only thing to look at is the design preview.
export default function Home() {
  redirect("/preview");
}
