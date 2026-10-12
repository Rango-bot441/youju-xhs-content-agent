// An operation owns its target for its whole lifetime, even if the user navigates.
export function captureTaskOperation({ taskId, draftId, reviewRevision, scope, lockedFields = [] }) {
  const snapshot = { taskId, draftId, reviewRevision, scope: scope ? structuredClone(scope) : null, lockedFields: [...lockedFields] };
  if (snapshot.scope) Object.freeze(snapshot.scope);
  Object.freeze(snapshot.lockedFields);
  return Object.freeze(snapshot);
}

export async function submitRevision(request, operation, instruction) {
  if (!operation.taskId || !operation.draftId) throw new Error('请先选择明确的任务和稿件。');
  await request(`/api/drafts/${operation.draftId}/feedback`, { decision: 'needs_changes', comment: instruction, expectedReviewRevision: operation.reviewRevision });
  return request(`/api/tasks/${operation.taskId}/runs`, {
    action: 'revise', draftId: operation.draftId, instruction,
    scope: operation.scope, lockedFields: operation.lockedFields,
  });
}

export async function submitExistingDraft(request, { taskId, newTask, draft }) {
  // Existing tasks keep their account, sources, requirements and collaboration links.
  const task = taskId ? { id: taskId } : await request('/api/tasks', newTask);
  const saved = await request(`/api/tasks/${task.id}/drafts`, draft);
  return { taskId: task.id, draft: saved };
}
