import { getEffectiveTaskSettings } from '@main/core/projects/settings/effective-task-settings';
import { LocalTerminalProvider } from '@main/core/terminals/impl/local-terminal-provider';
import { runLifecycleScriptWithPolicy } from '@main/core/terminals/lifecycle-script-coordinator';
import { getTaskEnvVars } from '@main/core/workspaces/workspace-env';
import { LifecycleScriptService } from '@main/core/workspaces/workspace-lifecycle-service';
import { log } from '@main/lib/logger';
import type { ProjectProvider } from '../../projects/project-provider';
import { TEARDOWN_SCRIPT_WAIT_MS } from '../provision-task-error';
import {
  isLocalWorkspace,
  isWorktreeWorkspace,
  workspaceHasRemainingTasks,
  type LocalWorkspaceCleanupTarget,
} from './task-lifecycle-utils';

/**
 * Runs the configured teardown script for a workspace that has no live session in
 * the current app run (the task was archived earlier, or never opened since app
 * launch). Without this, deleting such a task would remove its worktree without
 * the teardown script ever running, leaking external resources it manages.
 *
 * Only local worktree workspaces are handled: remote transports need a live
 * connection that an unmounted task does not have, so they are skipped with a log.
 */
export async function runTeardownScriptForUnmountedWorkspace({
  project,
  projectId,
  task,
  workspace,
}: {
  project: ProjectProvider;
  projectId: string;
  task: { id: string; name: string };
  workspace: LocalWorkspaceCleanupTarget & { id: string };
}): Promise<void> {
  // Only worktree workspaces get their directory removed on delete; project-root
  // and byoi workspaces outlive the task.
  if (!isWorktreeWorkspace(workspace) || !workspace.path) return;

  if (!isLocalWorkspace(workspace)) {
    log.warn('deleteTask: skipping teardown script for unmounted non-local workspace', {
      taskId: task.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
    });
    return;
  }

  // A sibling task still referencing the workspace keeps it (and its worktree)
  // alive; the teardown script runs when the last reference goes away.
  if (await workspaceHasRemainingTasks(workspace.id, false)) return;

  const worktreeExists = await project.fileSystem.exists(workspace.path);
  if (!worktreeExists.success || !worktreeExists.data) return;

  const projectSettings = await project.settings.get();
  const taskSettings = await getEffectiveTaskSettings({
    projectSettings: project.settings,
    taskFs: project.fileSystem,
    taskConfigPath: project.configPathForDirectory(workspace.path),
  });
  const script = taskSettings.scripts?.teardown;
  if (!script) return;
  const shellSetup = taskSettings.shellSetup ?? projectSettings.shellSetup;

  const defaultBranch = await project.settings.getDefaultBranch();
  const terminals = new LocalTerminalProvider({
    projectId,
    workspaceId: workspace.id,
    scopeId: workspace.id,
    taskPath: workspace.path,
    tmux: false,
    shellSetup,
    ctx: project.ctx,
    taskEnvVars: getTaskEnvVars({
      taskId: task.id,
      taskName: task.name,
      taskPath: workspace.path,
      projectPath: project.repoPath,
      defaultBranch,
      portSeed: workspace.path,
    }),
  });
  const lifecycleService = new LifecycleScriptService({
    projectId,
    workspaceId: workspace.id,
    terminals,
  });

  try {
    await runLifecycleScriptWithPolicy({
      workspace: { lifecycleService },
      projectId,
      taskId: task.id,
      workspaceId: workspace.id,
      type: 'teardown',
      script,
      shellSetup,
      origin: 'workspace-destroy',
      policy: {
        timeoutMs: TEARDOWN_SCRIPT_WAIT_MS,
        logFailure: true,
        surfaceFailure: false,
        continueOnFailure: true,
      },
      logPrefix: 'deleteTask',
    });
  } finally {
    await lifecycleService.dispose();
  }
}
