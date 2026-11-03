import type { CallToolResult } from '@modelcontextprotocol/server';
import { DISPATCHED_MARKER } from '../experts/dispatch.js';
import type { ConsultOutcome, DispatchSnapshot } from '../experts/dispatch.js';
import type { ExpertDefinition } from '../experts/registry.js';
import { expertToolName } from '../experts/registry.js';

/**
 * Every tool result is built here as an explicit projection. Internal objects (jobs, tasks, errors,
 * sessions) never reach the wire directly.
 */

export const COLLECT_TOOL = 'expert_collect';
export const STATUS_TOOL = 'expert_status';
export const CANCEL_TOOL = 'expert_cancel';
export const LIST_TOOL = 'list_experts';

function text(value: string): CallToolResult['content'][number] {
  return { type: 'text', text: value };
}

export function errorResult(message: string): CallToolResult {
  return { content: [text(message)], isError: true };
}

export function outcomeResult(outcome: ConsultOutcome): CallToolResult {
  switch (outcome.kind) {
    case 'answered':
      return {
        content: [text(outcome.answer)],
        structuredContent: {
          outcome: 'ANSWERED',
          expert: outcome.expertId,
          summary: outcome.summary,
          answer: outcome.answer,
        },
      };
    case 'dispatched':
      return {
        content: [
          text(
            [
              DISPATCHED_MARKER,
              outcome.summary,
              `The ${outcome.expertId} expert is still working. Continue your own work and call ${COLLECT_TOOL} with dispatchId "${outcome.dispatchId}" when you need the report (${STATUS_TOOL} shows progress).`,
            ].join('\n'),
          ),
        ],
        structuredContent: {
          outcome: DISPATCHED_MARKER,
          expert: outcome.expertId,
          dispatchId: outcome.dispatchId,
          summary: outcome.summary,
          plan: outcome.plan,
          nextTool: COLLECT_TOOL,
        },
      };
    case 'capacity':
      return {
        content: [
          text(
            `Expert capacity reached; the ${outcome.expertId} expert wanted to investigate but no slot is free. Retry later.\nTriage summary: ${outcome.summary}`,
          ),
        ],
        structuredContent: {
          outcome: 'CAPACITY',
          expert: outcome.expertId,
          summary: outcome.summary,
          plan: outcome.plan,
        },
        isError: true,
      };
  }
}

export function snapshotProjection(snapshot: DispatchSnapshot): Record<string, unknown> {
  return {
    dispatchId: snapshot.dispatchId,
    expert: snapshot.expertId,
    status: snapshot.status,
    latestStatus: snapshot.latestStatus,
    statusLog: [...snapshot.statusLog],
    startedAt: snapshot.startedAt,
    ...(snapshot.finishedAt !== undefined && { finishedAt: snapshot.finishedAt }),
  };
}

export function statusResult(snapshot: DispatchSnapshot): CallToolResult {
  return {
    content: [text(`${snapshot.status}: ${snapshot.latestStatus}`)],
    structuredContent: snapshotProjection(snapshot),
  };
}

/** Final result of a dispatched investigation. Failed and cancelled jobs are tool errors. */
export function reportResult(snapshot: DispatchSnapshot): CallToolResult {
  const projection = snapshotProjection(snapshot);
  switch (snapshot.status) {
    case 'completed':
      return {
        content: [text(snapshot.report ?? '')],
        structuredContent: { ...projection, report: snapshot.report ?? '' },
      };
    case 'failed':
      return {
        content: [text(`The expert investigation failed: ${snapshot.error ?? 'unknown error'}`)],
        structuredContent: { ...projection, error: snapshot.error ?? 'unknown error' },
        isError: true,
      };
    case 'cancelled':
      return {
        content: [text('The expert investigation was cancelled before it produced a report.')],
        structuredContent: projection,
        isError: true,
      };
    case 'working':
      return {
        content: [text(`Still working: ${snapshot.latestStatus}`)],
        structuredContent: projection,
      };
  }
}

export function unknownDispatchResult(): CallToolResult {
  return errorResult('Unknown dispatchId. It may have expired or never existed.');
}

export function expertsListResult(experts: readonly ExpertDefinition[]): CallToolResult {
  const rows = experts.map((expert) => ({
    id: expert.id,
    tool: expertToolName(expert),
    title: expert.title,
    description: expert.description,
  }));
  return {
    content: [text(rows.map((row) => `${row.tool} — ${row.title}: ${row.description}`).join('\n'))],
    structuredContent: { experts: rows },
  };
}
