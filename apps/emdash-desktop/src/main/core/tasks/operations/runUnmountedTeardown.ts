import path from 'node:path';
import { FileSystem } from '@emdash/core/files';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { getProjectById } from '@main/core/projects/operations/getProjects';
import { getEffectiveTaskSettings } from '@main/core/projects/settings/effective-task-settings';
import { LocalProjectSettingsProvider } from '@main/core/projects/settings/providers/local-project-settings-provider';
import { LocalTerminalProvider } from '@main/core/terminals/impl/local-terminal-provider';
import { runLifecycleScriptWithPolicy } from '@main/core/terminals/lifecycle-script-coordinator';
import { getTaskEnvVars } from '@main/core/workspaces/workspace-env';
import { LifecycleScriptService } from '@main/core/workspaces/workspace-lifecycle-service';
import { log } from '@main/lib/logger';
import type { ProjectProvider } from '../../projects/project-provider';
import { TEARDOWN_SCRIPT_WAIT_MS } from '../provision-task-error';
import {
  isLocalWorkspace,
  workspaceHasRemainingTasks,
  type LocalWorkspaceCleanupTarget,
} from './task-lifecycle-utils';

type LocalTeardownProject = Pick<
  ProjectProvider,
  'repoPath' | 'ctx' | 'fileSystem' | 'settings' | 'configPathForDirectory'
>;

type ResolvedLocalTeardownProject = {
  project: LocalTeardownProject;
  dispose?: () => void;
};

async function resolveLocalTeardownProject(
  projectId: string,
  mountedProject: ProjectProvider | undefined
): Promise<ResolvedLocalTeardownProject | undefined> {
  if (mountedProject) {
    return mountedProject.type === 'local' ? { project: mountedProject } : undefined;
  }

  const persistedProject = await getProjectById(projectId);
  if (persistedProject?.type !== 'local') return undefined;

  // Storage Settings can delete a task whose project has never been mounted in this
  // app run. Rebuild only the local services needed by the teardown script instead
  // of opening a full ProjectProvider (which would start fetch services and acquire
  // project-wide runtime leases).
  const fileSystem = new FileSystem();
  const ctx = new LocalExecutionContext({ root: persistedProject.path });
  const settings = new LocalProjectSettingsProvider(
    persistedProject.id,
    persistedProject.path,
    persistedProject.baseRef,
    fileSystem
  );

  return {
    project: {
      repoPath: persistedProject.path,
      ctx,
      fileSystem,
      settings,
      configPathForDirectory: (directoryPath) => path.join(directoryPath, '.emdash.json'),
    },
    dispose: () => ctx.dispose(),
  };
}

/**
 * Runs the configured teardown script for a persisted workspace that has no live
 * session in the current app run. Without this, archive/delete after an app restart
 * would skip the script and leak external resources it manages.
 *
 * Only local workspaces are handled: remote transports need a live connection that
 * an unmounted task does not have, so they are skipped with a log.
 */
export async function runUnmountedTeardown({
  project,
  projectId,
  task,
  workspace,
  intent,
}: {
  project?: ProjectProvider;
  projectId: string;
  task: { id: string; name: string };
  workspace: LocalWorkspaceCleanupTarget & { id: string };
  intent: 'archive' | 'delete';
}): Promise<void> {
  const logPrefix = intent === 'archive' ? 'archiveTask' : 'deleteTask';

  if (!isLocalWorkspace(workspace)) {
    log.warn(`${logPrefix}: skipping teardown script for unmounted non-local workspace`, {
      taskId: task.id,
      workspaceId: workspace.id,
      workspaceType: workspace.type,
    });
    return;
  }

  if (!workspace.path) return;

  // Project-root is intentional here. Live workspace teardown runs the configured
  // lifecycle script for both worktrees and no-worktree tasks, whose lifecycle cwd
  // is the repository root. Persisted teardown must preserve those same semantics.

  // Deletion calls this after its task row is gone, so any remaining reference is a
  // sibling. Archive calls it after marking the task archived, so ignore archived
  // references and run only when the last active task leaves the workspace.
  if (await workspaceHasRemainingTasks(workspace.id, intent === 'archive')) return;

  const resolved = await resolveLocalTeardownProject(projectId, project);
  if (!resolved) {
    log.warn(`${logPrefix}: unable to resolve local project for unmounted teardown`, {
      taskId: task.id,
      projectId,
      workspaceId: workspace.id,
    });
    return;
  }

  try {
    const localProject = resolved.project;
    const workspaceExists = await localProject.fileSystem.exists(workspace.path);
    if (!workspaceExists.success || !workspaceExists.data) return;

    const projectSettings = await localProject.settings.get();
    const taskSettings = await getEffectiveTaskSettings({
      projectSettings: localProject.settings,
      taskFs: localProject.fileSystem,
      taskConfigPath: localProject.configPathForDirectory(workspace.path),
    });
    const script = taskSettings.scripts?.teardown;
    if (!script) return;
    const shellSetup = taskSettings.shellSetup ?? projectSettings.shellSetup;

    const defaultBranch = await localProject.settings.getDefaultBranch();
    const terminals = new LocalTerminalProvider({
      projectId,
      workspaceId: workspace.id,
      scopeId: workspace.id,
      taskPath: workspace.path,
      tmux: false,
      shellSetup,
      ctx: localProject.ctx,
      taskEnvVars: getTaskEnvVars({
        taskId: task.id,
        taskName: task.name,
        taskPath: workspace.path,
        projectPath: localProject.repoPath,
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
        logPrefix,
      });
    } finally {
      await lifecycleService.dispose();
    }
  } finally {
    resolved.dispose?.();
  }
}
