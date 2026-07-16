import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectProvider } from '../../projects/project-provider';
import { runTeardownScriptForUnmountedWorkspace } from './unmounted-workspace-teardown';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  getEffectiveTaskSettings: vi.fn(),
  lifecycleScriptService: vi.fn(),
  localTerminalProvider: vi.fn(),
  runLifecycleScriptWithPolicy: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
  },
}));

vi.mock('@main/core/projects/settings/effective-task-settings', () => ({
  getEffectiveTaskSettings: mocks.getEffectiveTaskSettings,
}));

vi.mock('@main/core/terminals/impl/local-terminal-provider', () => ({
  LocalTerminalProvider: mocks.localTerminalProvider,
}));

vi.mock('@main/core/terminals/lifecycle-script-coordinator', () => ({
  runLifecycleScriptWithPolicy: mocks.runLifecycleScriptWithPolicy,
}));

vi.mock('@main/core/workspaces/workspace-lifecycle-service', () => ({
  LifecycleScriptService: mocks.lifecycleScriptService,
}));

function makeProject(overrides: { worktreeExists?: boolean } = {}): ProjectProvider {
  const { worktreeExists = true } = overrides;
  return {
    repoPath: '/repo',
    ctx: {},
    fileSystem: {
      exists: vi.fn(async () => ({ success: true as const, data: worktreeExists })),
    },
    settings: {
      get: vi.fn(async () => ({ shellSetup: 'project-shell-setup' })),
      getDefaultBranch: vi.fn(async () => 'main'),
    },
    configPathForDirectory: (directoryPath: string) => `${directoryPath}/.emdash.json`,
  } as unknown as ProjectProvider;
}

const localWorktree = {
  id: 'workspace-1',
  type: 'local' as const,
  kind: 'worktree' as const,
  location: 'local' as const,
  path: '/worktrees/task-1',
};

describe('runTeardownScriptForUnmountedWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectLimit.mockResolvedValue([]);
    mocks.getEffectiveTaskSettings.mockResolvedValue({
      scripts: { teardown: './cleanup.sh' },
    });
    mocks.lifecycleScriptService.mockImplementation(function LifecycleScriptServiceMock() {
      return { dispose: mocks.dispose };
    });
    mocks.runLifecycleScriptWithPolicy.mockResolvedValue({ kind: 'succeeded' });
  });

  it('runs the teardown script against the worktree and disposes the script service', async () => {
    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
    });

    expect(mocks.runLifecycleScriptWithPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'teardown',
        script: './cleanup.sh',
        shellSetup: 'project-shell-setup',
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        policy: expect.objectContaining({ timeoutMs: expect.any(Number) }),
      })
    );
    expect(mocks.localTerminalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPath: '/worktrees/task-1',
        taskEnvVars: expect.objectContaining({ EMDASH_TASK_ID: 'task-1' }),
      })
    );
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the script service even when the script run throws', async () => {
    mocks.runLifecycleScriptWithPolicy.mockRejectedValue(new Error('boom'));

    await expect(
      runTeardownScriptForUnmountedWorkspace({
        project: makeProject(),
        projectId: 'project-1',
        task: { id: 'task-1', name: 'Task One' },
        workspace: localWorktree,
      })
    ).rejects.toThrow('boom');

    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('skips when a sibling task still references the workspace', async () => {
    mocks.selectLimit.mockResolvedValue([{ id: 'sibling-task' }]);

    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('skips non-local workspaces', async () => {
    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: { ...localWorktree, type: 'project-ssh', location: 'remote' },
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('skips project-root workspaces', async () => {
    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: { ...localWorktree, kind: 'project-root' },
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('skips when no teardown script is configured', async () => {
    mocks.getEffectiveTaskSettings.mockResolvedValue({ scripts: {} });

    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
    expect(mocks.lifecycleScriptService).not.toHaveBeenCalled();
  });

  it('skips when the worktree directory no longer exists', async () => {
    await runTeardownScriptForUnmountedWorkspace({
      project: makeProject({ worktreeExists: false }),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });
});
