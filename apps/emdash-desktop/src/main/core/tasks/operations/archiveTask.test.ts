import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveTask } from './archiveTask';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  getProject: vi.fn(),
  isActive: vi.fn(),
  runPersistedTeardown: vi.fn(),
  selectLimit: vi.fn(),
  teardownTaskIfPresent: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
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
    update: () => ({
      set: mocks.updateSet,
    }),
  },
}));

vi.mock('@main/core/tasks/task-session-manager', () => ({
  taskSessionManager: {
    teardownTaskIfPresent: mocks.teardownTaskIfPresent,
  },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    getProject: mocks.getProject,
  },
}));

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    isActive: mocks.isActive,
  },
}));

vi.mock('./runUnmountedTeardown', () => ({
  runUnmountedTeardown: mocks.runPersistedTeardown,
}));

vi.mock('@main/lib/telemetry', () => ({
  telemetryService: {
    capture: mocks.capture,
  },
}));

describe('archiveTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.isActive.mockReturnValue(false);
    mocks.runPersistedTeardown.mockResolvedValue(undefined);
    mocks.teardownTaskIfPresent.mockResolvedValue({
      handled: true,
      result: { success: true },
    });
  });

  it('archives by reaping the runtime without deleting workspace assets', async () => {
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'workspace-1',
        status: 'done',
      },
    ]);
    await archiveTask('project-1', 'task-1');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        archivedAt: expect.anything(),
        updatedAt: expect.anything(),
      })
    );
    const updatePayload = mocks.updateSet.mock.calls[0]?.[0];
    expect(updatePayload).not.toHaveProperty('status');
    expect(updatePayload).not.toHaveProperty('statusChangedAt');

    expect(mocks.teardownTaskIfPresent).toHaveBeenCalledWith('task-1', 'archive');
    expect(mocks.capture).toHaveBeenCalledWith('task_archived', {
      project_id: 'project-1',
      task_id: 'task-1',
    });
    expect(mocks.selectLimit).toHaveBeenCalledTimes(1);
  });

  it('runs unmounted teardown when archiving a task without a live session', async () => {
    const project = { type: 'local' };
    mocks.getProject.mockReturnValue(project);
    mocks.teardownTaskIfPresent.mockResolvedValue({
      handled: false,
      result: { success: true },
    });
    mocks.selectLimit
      .mockResolvedValueOnce([
        {
          id: 'task-1',
          name: 'Task One',
          workspaceId: 'workspace-1',
          status: 'done',
        },
      ])
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
      ]);
    await archiveTask('project-1', 'task-1');

    expect(mocks.runPersistedTeardown).toHaveBeenCalledWith({
      project,
      projectId: 'project-1',
      task: { id: 'task-1', name: 'Task One' },
      workspace: expect.objectContaining({ id: 'workspace-1', path: '/tmp/worktree' }),
      intent: 'archive',
    });
  });

  it('does not run unmounted teardown when a lifecycle entry appeared after the pre-check', async () => {
    mocks.isActive.mockReturnValue(false);
    mocks.teardownTaskIfPresent.mockResolvedValue({
      handled: true,
      result: { success: true },
    });
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: 'task-1',
        name: 'Task One',
        workspaceId: 'workspace-1',
        status: 'done',
      },
    ]);

    await archiveTask('project-1', 'task-1');

    expect(mocks.runPersistedTeardown).not.toHaveBeenCalled();
  });
});
