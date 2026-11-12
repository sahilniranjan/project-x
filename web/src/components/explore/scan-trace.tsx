"use client";

import { useEffect, useRef } from "react";
import { Radar } from "lucide-react";
import { cn } from "@/lib/cn";
import { ATS_LABEL, type AtsSource } from "@/lib/explore";
import type { ScanTraceEntry } from "./explore-provider";

// The live board feed for the FREE scan — the counterpart to <AiHuntTrace/> in AI
// mode. Without it the scan screen is a spinner and a number that does not move for
// minutes, which reads as hung. Each line is a board the core actually walked
// (`--trace` in scan-ats-full.mjs), newest at the bottom, auto-scrolled.
//
// Postings, not matches: at CONCURRENCY 20 the core cannot attribute a match to a
// company at the moment it finishes, so the per-line number is how many postings
// that board returned. The hero counter above stays the authority on matches.
const STYLE = `
.co-scan__dot{width:.5rem;height:.5rem;border-radius:50%;background:hsl(26 80% 55%);box-shadow:0 0 0 0 hsl(26 80% 55% /.5);animation:co-scan-pulse 1.5s ease-out infinite}
.co-scan__body{-webkit-mask-image:linear-gradient(180deg,transparent,#000 14%);mask-image:linear-gradient(180deg,transparent,#000 14%)}
.co-scan__row{animation:co-scan-in .3s ease both}
@keyframes co-scan-pulse{70%{box-shadow:0 0 0 .4rem hsl(26 80% 55% /0)}100%{box-shadow:0 0 0 0 hsl(26 80% 55% /0)}}
@keyframes co-scan-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.co-scan__dot,.co-scan__row{animation:none}}
`;

export function ScanTrace({ trace }: { trace: ScanTraceEntry[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Pin to the newest line. Keyed on length so it only fires when a board lands.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [trace.length]);

  if (trace.length === 0) return null;

  const rows = trace.slice(-40);

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-border/70 bg-surface/80 text-left shadow-xl shadow-black/10 backdrop-blur-md">
      <style>{STYLE}</style>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="co-scan__dot" />
        <span className="text-[12px] font-medium text-foreground">Walking boards live</span>
        <Radar className="ml-auto size-3.5 text-brand/70" />
      </div>
      <div ref={bodyRef} className="co-scan__body flex max-h-52 flex-col gap-1 overflow-y-auto px-4 py-3">
        {rows.map((e, i) => (
          <div
            key={e.id}
            className={cn(
              "co-scan__row flex items-baseline gap-2 text-[13px] leading-relaxed",
              i === rows.length - 1 ? "text-foreground" : "text-muted",
            )}
          >
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-faint">
              {ATS_LABEL[e.ats as AtsSource] ?? e.ats}
            </span>
            <span className="truncate font-medium">{e.company}</span>
            <span
              className={cn(
                "ml-auto shrink-0 tabular-nums text-[12px]",
                e.postings > 0 ? "text-brand" : "text-faint",
              )}
            >
              {e.postings > 0 ? `${e.postings} posting${e.postings === 1 ? "" : "s"}` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
