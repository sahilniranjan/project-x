import { instrumentSerif } from "@/lib/fonts";

// Brand mark — lowercase "px" (project-x) on brand orange in Instrument Serif.
// Matches the favicon (src/app/icon.svg) and the docs wordmark one-for-one.
export function PxMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`${instrumentSerif.className} inline-flex shrink-0 items-center justify-center rounded-md bg-brand text-white`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.78),
        letterSpacing: "0.01em",
        lineHeight: 1,
        paddingBottom: Math.round(size * 0.08),
      }}
    >
      px
    </span>
  );
}
