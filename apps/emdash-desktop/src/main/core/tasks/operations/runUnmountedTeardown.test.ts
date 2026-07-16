import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectProvider } from '../../projects/project-provider';
import { runUnmountedTeardown } from './runUnmountedTeardown';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  disposeContext: vi.fn(),
  getEffectiveTaskSettings: vi.fn(),
  getProjectById: vi.fn(),
  lifecycleScriptService: vi.fn(),
  localExecutionContext: vi.fn(),
  localProjectSettingsProvider: vi.fn(),
  localTerminalProvider: vi.fn(),
  logWarn: vi.fn(),
  runLifecycleScriptWithPolicy: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock('@main/core/projects/operations/getProjects', () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: mocks.localExecutionContext,
}));

vi.mock('@main/core/projects/settings/providers/local-project-settings-provider', () => ({
  LocalProjectSettingsProvider: mocks.localProjectSettingsProvider,
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: mocks.logWarn,
  },
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
    type: 'local',
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

describe('runUnmountedTeardown', () => {
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
    mocks.getProjectById.mockResolvedValue(undefined);
    mocks.localExecutionContext.mockImplementation(function LocalExecutionContextMock() {
      return { dispose: mocks.disposeContext };
    });
    mocks.localProjectSettingsProvider.mockImplementation(
      function LocalProjectSettingsProviderMock() {
        return {
          get: vi.fn(async () => ({ shellSetup: 'persisted-shell-setup' })),
          getDefaultBranch: vi.fn(async () => 'main'),
        };
      }
    );
  });

  it('runs the teardown script against the worktree and disposes the script service', async () => {
    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
      intent: 'delete',
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
      runUnmountedTeardown({
        project: makeProject(),
        projectId: 'project-1',
        task: { id: 'task-1', name: 'Task One' },
        workspace: localWorktree,
        intent: 'delete',
      })
    ).rejects.toThrow('boom');

    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('skips when a sibling task still references the workspace', async () => {
    mocks.selectLimit.mockResolvedValue([{ id: 'sibling-task' }]);

    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
      intent: 'delete',
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('skips non-local workspaces', async () => {
    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: { ...localWorktree, type: 'project-ssh', location: 'remote' },
      intent: 'delete',
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('logs skipped non-local workspaces even when their persisted path is missing', async () => {
    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: {
        ...localWorktree,
        type: 'project-ssh',
        location: 'remote',
        path: null,
      },
      intent: 'delete',
    });

    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipping teardown script for unmounted non-local workspace'),
      expect.objectContaining({ workspaceId: 'workspace-1' })
    );
  });

  it('runs for a project-root workspace when archiving the last active task', async () => {
    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: { ...localWorktree, kind: 'project-root' },
      intent: 'archive',
    });

    expect(mocks.runLifecycleScriptWithPolicy).toHaveBeenCalledOnce();
  });

  it('skips when no teardown script is configured', async () => {
    mocks.getEffectiveTaskSettings.mockResolvedValue({ scripts: {} });

    await runUnmountedTeardown({
      project: makeProject(),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
      intent: 'delete',
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
    expect(mocks.lifecycleScriptService).not.toHaveBeenCalled();
  });

  it('skips when the worktree directory no longer exists', async () => {
    await runUnmountedTeardown({
      project: makeProject({ worktreeExists: false }),
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: localWorktree,
      intent: 'delete',
    });

    expect(mocks.runLifecycleScriptWithPolicy).not.toHaveBeenCalled();
  });

  it('reconstructs local project services when the project is not mounted', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'emdash-persisted-teardown-'));
    const projectPath = path.join(tempDir, 'project');
    const worktreePath = path.join(tempDir, 'worktree');
    await mkdir(projectPath);
    await mkdir(worktreePath);
    mocks.getProjectById.mockResolvedValue({
      type: 'local',
      id: 'project-1',
      name: 'Project',
      path: projectPath,
      baseRef: 'main',
      repositoryWorkspaceId: null,
      createdAt: '',
      updatedAt: '',
    });

    try {
      await runUnmountedTeardown({
        projectId: 'project-1',
        task: { id: 'task-1', name: 'Task One' },
        workspace: { ...localWorktree, path: worktreePath },
        intent: 'delete',
      });

      expect(mocks.localProjectSettingsProvider).toHaveBeenCalledWith(
        'project-1',
        projectPath,
        'main',
        expect.anything()
      );
      expect(mocks.runLifecycleScriptWithPolicy).toHaveBeenCalledOnce();
      expect(mocks.disposeContext).toHaveBeenCalledOnce();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
