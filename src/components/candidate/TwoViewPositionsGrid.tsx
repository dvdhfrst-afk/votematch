"use client";

import { useState } from "react";
import type { Position, SubDimension } from "@/types/database";
import TwoViewPositionCard from "./TwoViewPositionCard";
import ViewToggle, { type ViewToggleValue } from "./ViewToggle";

/**
 * Client wrapper that pairs the ViewToggle with the positions grid so the
 * toggle can filter which panels (stated / inferred / both) render inside
 * each TwoViewPositionCard without making the whole candidate page a
 * client component. Council decision 007 §5.2.
 *
 * This component is mounted only when `NEXT_PUBLIC_ENABLE_TWO_VIEW === 'true'`
 * — the server page gates the render and falls back to the legacy
 * PositionCard path when the flag is off.
 */

type WithPositions = {
  sd: SubDimension;
  statedVisible: Position | null;
  inferredVisible: Position | null;
};

export default function TwoViewPositionsGrid({
  items,
}: {
  items: WithPositions[];
}) {
  const [view, setView] = useState<ViewToggleValue>("both");

  return (
    <>
      <div className="mt-3">
        <ViewToggle value={view} onChange={setView} />
      </div>

      <div className="grid grid-cols-1 gap-4 mt-4">
        {items.map(({ sd, statedVisible, inferredVisible }) => {
          // Apply the toggle filter. When the user picks a single view we
          // null-out the other side; TwoViewPositionCard already knows how to
          // render a one-sided card, so no per-card changes are needed.
          const statedForCard = view === "inferred" ? null : statedVisible;
          const inferredForCard = view === "stated" ? null : inferredVisible;

          // If the filter would leave the card with nothing to show on this
          // dimension (e.g. user picked "stated" but this dimension only has
          // an inferred row), skip it rather than render an empty shell.
          if (!statedForCard && !inferredForCard) return null;

          return (
            <TwoViewPositionCard
              key={sd.id}
              stated={statedForCard}
              inferred={inferredForCard}
              subDimension={sd}
            />
          );
        })}
      </div>
    </>
  );
}
