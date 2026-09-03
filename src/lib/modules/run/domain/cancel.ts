export interface CancellableRun {
  id: string;
  status: string;
}

export function cancellableRunIds(
  sessionRuns: CancellableRun[],
  requestedRunId?: string,
): string[] {
  const liveIds: string[] = [];
  for (const run of sessionRuns) {
    if (run.status === "pending" || run.status === "running") liveIds.push(run.id);
  }
  return requestedRunId ? liveIds.filter((id) => id === requestedRunId) : liveIds;
}
