import { ChartNoAxesColumn } from "lucide-react";
import { ModePlaceholder } from "./ModePlaceholder";

/** Insights mode (Design §14.6). Placeholder until T11.12 builds hotspots, activity and authors. */
export function InsightsView() {
  return (
    <ModePlaceholder
      icon={ChartNoAxesColumn}
      title="Insights"
      task="T11.12"
      description="Hotspots, a 52-week activity heatmap and contributor counts for this repository."
    />
  );
}
