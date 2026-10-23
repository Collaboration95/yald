import type { ComponentType } from "react";
import { ProjectRadar } from "./ProjectRadar";
import { CacheDetective } from "./CacheDetective";
import { ContextReplay } from "./ContextReplay";
import { SpendChanges } from "./SpendChanges";

export interface LabsInvestigation {
  path: string;
  title: string;
  description: string;
  /** Mounted only under enabled LabsLayout. Own queries inside this component. */
  Component?: ComponentType;
}

/** L03/L05/L07 register their independent components here; the shell owns no data queries. */
export const LABS_INVESTIGATIONS: readonly LabsInvestigation[] = [
  { path: "spend-spikes", title: "Spend spikes", description: "Unusually expensive days and what drove them.", Component: SpendChanges },
  { path: "project-radar", title: "Projects", description: "Which projects cost more or less than the period before.", Component: ProjectRadar },
  { path: "cache-detective", title: "Cache savings", description: "What caching saved against paying full input price.", Component: CacheDetective },
  { path: "context-replay", title: "Context growth", description: "How much sessions grow from their first request to their last.", Component: ContextReplay },
];
