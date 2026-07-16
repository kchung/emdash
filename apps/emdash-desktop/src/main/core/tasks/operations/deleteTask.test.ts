import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTask } from './deleteTask';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  deleteIndex: vi.fn(),
  deleteWhere: vi.fn(),
  delViewState: vi.fn(),
  createBoundExec: vi.fn(),
  gitExec: vi.fn(),
  getProject: vi.fn(),
  getProjectById: vi.fn(),
  isActive: vi.fn(),
  runPersistedTeardown: vi.fn(),
  selectLimit: vi.fn(),
  teardownTaskIfPresent: vi.fn(),
}));

vi.mock('@emdash/core/exec', () => ({
  createBoundExec: mocks.createBoundExec,
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
    delete: () => ({
      where: mocks.deleteWhere,
    }),
  },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    getProject: mocks.getProject,
  },
}));

vi.mock('@main/core/projects/operations/getProjects', () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock('@main/core/tasks/task-session-manager', () => ({
  taskSessionManager: {
    teardownTaskIfPresent: mocks.teardownTaskIfPresent,
  },
}));

vi.mock('./runUnmountedTeardown', () => ({
  runUnmountedTeardown: mocks.runPersistedTeardown,
}));

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    isActive: mocks.isActive,
  },
}));

vi.mock('@main/core/view-state/view-state-service', () => ({
  viewStateService: {
    del: mocks.delViewState,
  },
}));

vi.mock('@main/core/search/workspace-file-index-service', () => ({
  workspaceFileIndexService: {
    deleteIndex: mocks.deleteIndex,
  },
}));

vi.mock('@main/lib/telemetry', () => ({
  telemetryService: {
    capture: mocks.capture,
  },
}));

describe('deleteTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.gitExec.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.createBoundExec.mockReturnValue({ exec: mocks.gitExec });
    mocks.getProject.mockReturnValue(undefined);
    mocks.getProjectById.mockResolvedValue(undefined);
    mocks.isActive.mockReturnValue(false);
    mocks.runPersistedTeardown.mockResolvedValue(undefined);
    mocks.teardownTaskIfPresent.mockResolvedValue({
      handled: false,
      result: { success: true },
    });
  });

  it('deletes both the aggregate view-state key and the dedicated tabs key', async () => {
    mocks.selectLimit.mockResolvedValueOnce([{ id: 'task-1', workspaceId: null }]);

    await deleteTask('project-1', 'task-1');

    expect(mocks.delViewState).toHaveBeenCalledWith('task:task-1');
    expect(mocks.delViewState).toHaveBeenCalledWith('task:task-1:tabs');
  });

  it('preserves the workspace file index when an archived sibling still references the workspace', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        { id: 'workspace-1', kind: 'worktree', branchName: null, config: null },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([{ id: 'archived-sibling' }]);

    await deleteTask('project-1', 'task-1', { deleteWorktree: false });

    expect(mocks.deleteIndex).not.toHaveBeenCalled();
  });

  it('runs unmounted teardown when the task has no live session', async () => {
    const fakeProject = { removeTaskWorktree: vi.fn() };
    mocks.getProject.mockReturnValue(fakeProject);
    mocks.runPersistedTeardown.mockResolvedValue(undefined);
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', name: 'Task One', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        {
          id: 'workspace-1',
          type: 'local',
          kind: 'worktree',
          location: 'local',
          path: '/tmp/worktree',
          branchName: null,
          config: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([]);

    await deleteTask('project-1', 'task-1');

    expect(mocks.runPersistedTeardown).toHaveBeenCalledWith(
      expect.objectContaining({
        project: fakeProject,
        projectId: 'project-1',
        task: { id: 'task-1', name: 'Task One' },
        workspace: expect.objectContaining({ id: 'workspace-1', path: '/tmp/worktree' }),
        intent: 'delete',
      })
    );
  });

  it('runs unmounted teardown when the task is deleted but its worktree is retained', async () => {
    mocks.getProject.mockReturnValue({ removeTaskWorktree: vi.fn() });
    mocks.runPersistedTeardown.mockResolvedValue(undefined);
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', name: 'Task One', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        {
          id: 'workspace-1',
          type: 'local',
          kind: 'worktree',
          location: 'local',
          path: '/tmp/worktree',
          branchName: null,
          config: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([]);

    await deleteTask('project-1', 'task-1', { deleteWorktree: false });

    expect(mocks.runPersistedTeardown).toHaveBeenCalledOnce();
    expect(mocks.createBoundExec).not.toHaveBeenCalled();
  });

  it('skips unmounted teardown when the task had a live session', async () => {
    mocks.getProject.mockReturnValue({ removeTaskWorktree: vi.fn() });
    mocks.teardownTaskIfPresent.mockResolvedValue({
      handled: true,
      result: { success: true },
    });
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', name: 'Task One', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        {
          id: 'workspace-1',
          type: 'local',
          kind: 'worktree',
          location: 'local',
          path: '/tmp/worktree',
          branchName: null,
          config: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([]);

    await deleteTask('project-1', 'task-1');

    expect(mocks.runPersistedTeardown).not.toHaveBeenCalled();
  });

  it('skips unmounted teardown when the workspace is mounted or mid-acquire', async () => {
    mocks.getProject.mockReturnValue({ removeTaskWorktree: vi.fn() });
    // Mid-bootstrap: not yet registered in the session manager, but the
    // workspace registry has a live or in-flight entry.
    mocks.isActive.mockReturnValue(true);
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', name: 'Task One', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        {
          id: 'workspace-1',
          type: 'local',
          kind: 'worktree',
          location: 'local',
          path: '/tmp/worktree',
          branchName: null,
          config: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([]);

    await deleteTask('project-1', 'task-1');

    expect(mocks.isActive).toHaveBeenCalledWith('workspace-1');
    expect(mocks.runPersistedTeardown).not.toHaveBeenCalled();
  });

  it('removes an owned local worktree by recorded path when the project is not mounted', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'emdash-delete-task-'));
    const projectPath = path.join(tempDir, 'project');
    const worktreePath = path.join(tempDir, 'task-worktree');
    await mkdir(path.join(worktreePath, '.git'), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(worktreePath, 'file.txt'), 'content');

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
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'task-1', workspaceId: 'workspace-1' }])
      .mockResolvedValueOnce([
        {
          id: 'workspace-1',
          type: 'local',
          kind: 'worktree',
          location: 'local',
          path: worktreePath,
          branchName: 'task/branch',
          config: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    try {
      await deleteTask('project-1', 'task-1');

      expect(mocks.runPersistedTeardown).toHaveBeenCalledWith(
        expect.objectContaining({
          project: undefined,
          projectId: 'project-1',
          intent: 'delete',
        })
      );
      await expect(access(worktreePath)).rejects.toThrow();
      expect(mocks.createBoundExec).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: projectPath })
      );
      expect(mocks.gitExec).toHaveBeenCalledWith(['worktree', 'prune'], { timeoutMs: 5_000 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
