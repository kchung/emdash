import { eq, sql } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { tasks, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { runUnmountedTeardown } from './runUnmountedTeardown';

export async function archiveTask(projectId: string, taskId: string): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  const workspaceWasActive =
    task.workspaceId !== null && workspaceRegistry.isActive(task.workspaceId);

  await db
    .update(tasks)
    .set({
      archivedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(tasks.id, taskId));
  telemetryService.capture('task_archived', { project_id: projectId, task_id: taskId });

  // 'archive' reaps the tmux session + agent process and runs the teardown script,
  // but keeps the worktree and the persisted session id so Restore can resume.
  // Plain 'detach' would leak the tmux session indefinitely (#2689).
  const teardownAttempt = await taskSessionManager
    .teardownTaskIfPresent(taskId, 'archive')
    .catch((e) => {
      log.warn('archiveTask: teardown failed', { taskId, error: String(e) });
      return null;
    });

  if (teardownAttempt && !teardownAttempt.result.success) {
    log.warn('archiveTask: teardown failed', {
      taskId,
      error: teardownAttempt.result.error.message,
    });
  }

  const workspaceIsActive =
    task.workspaceId !== null && workspaceRegistry.isActive(task.workspaceId);
  const needsUnmountedTeardown =
    teardownAttempt?.handled === false && !workspaceWasActive && !workspaceIsActive;

  if (needsUnmountedTeardown && task.workspaceId) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, task.workspaceId))
      .limit(1);
    if (workspace) {
      await runUnmountedTeardown({
        project: projectManager.getProject(projectId),
        projectId,
        task: { id: task.id, name: task.name },
        workspace,
        intent: 'archive',
      }).catch((e) => {
        log.warn('archiveTask: persisted workspace teardown script failed', {
          taskId,
          error: String(e),
        });
      });
    }
  }
}
