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
  { path: "project-radar", title: "Project Radar", description: "Explore project usage and estimated cost changes.", Component: ProjectRadar },
  { path: "cache-detective", title: "Cache Detective", description: "Inspect cache-read discounts and cache-write premiums.", Component: CacheDetective },
  { path: "context-replay", title: "Context Replay", description: "Follow submitted context across requests in a session.", Component: ContextReplay },
  { path: "spend-spikes", title: "Spend spikes", description: "Find unusually expensive days against your own recent history and see what changed.", Component: SpendChanges },
];
