/** Engine-neutral durable execution seam. The callback must contain every side effect. */
export interface DurableSteps {
  run<T>(id: string, execute: () => Promise<T>): Promise<T>;
}
export interface WorkflowAdapter {
  dispatch(runId: string): Promise<void>;
  handle(request: Request): Promise<Response>;
}
