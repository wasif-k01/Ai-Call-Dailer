import { Construction } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { NAV } from "./nav";

/** Honest placeholder for pages that are not built yet — no fake controls. */
export function ComingSoon({ href }: { href: string }) {
  const item = NAV.find((n) => n.href === href)!;
  return (
    <>
      <PageHeader title={item.label} />
      <EmptyState
        icon={<Construction className="size-8" />}
        title="Not built yet"
        description={`This section is scheduled for development phase ${item.phase}. It will appear here once it has been implemented and tested.`}
      />
    </>
  );
}
