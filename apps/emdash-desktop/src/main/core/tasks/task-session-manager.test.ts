import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { TaskProvider } from '../projects/project-provider';
import { executeTeardown, taskSessionManager } from './task-session-manager';

const teardown = vi.fn();

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    teardown: (...args: unknown[]) => teardown(...args),
  },
}));

// session-targets pulls in the real DB client; it is only used by the fallback path,
// not by executeTeardown, so a stub keeps this unit test free of a SQLite import.
vi.mock('@main/core/tasks/session-targets', () => ({
  getTaskSessionLeafIds: vi.fn(),
}));

function makeTask() {
  const conversations = { detachAll: vi.fn(), destroyAll: vi.fn() };
  const terminals = { detachAll: vi.fn(), destroyAll: vi.fn() };
  const task = { conversations, terminals } as unknown as TaskProvider;
  return { task, conversations, terminals };
}

describe('executeTeardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detach keeps tmux + agent running and keeps the workspace', async () => {
    const { task, conversations, terminals } = makeTask();
    await executeTeardown(task, 'workspace-1', 'detach');

    expect(conversations.detachAll).toHaveBeenCalledTimes(1);
    expect(terminals.detachAll).toHaveBeenCalledTimes(1);
    expect(conversations.destroyAll).not.toHaveBeenCalled();
    expect(terminals.destroyAll).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledWith('workspace-1', 'detach');
  });

  it('terminate reaps tmux + agent and destroys the workspace', async () => {
    const { task, conversations, terminals } = makeTask();
    await executeTeardown(task, 'workspace-1', 'terminate');

    expect(conversations.destroyAll).toHaveBeenCalledTimes(1);
    expect(terminals.destroyAll).toHaveBeenCalledTimes(1);
    expect(conversations.detachAll).not.toHaveBeenCalled();
    expect(terminals.detachAll).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledWith('workspace-1', 'terminate');
  });

  // The regression for #2689: archive must reap the tmux session + agent process
  // (destroyAll), but keep the workspace/worktree so Restore works. The registry's
  // 'archive' mode (not 'terminate') still runs the teardown script without
  // destroying the worktree or firing provider terminate hooks.
  it('archive reaps tmux + agent but keeps the workspace', async () => {
    const { task, conversations, terminals } = makeTask();
    await executeTeardown(task, 'workspace-1', 'archive');

    expect(conversations.destroyAll).toHaveBeenCalledTimes(1);
    expect(terminals.destroyAll).toHaveBeenCalledTimes(1);
    expect(conversations.detachAll).not.toHaveBeenCalled();
    expect(terminals.detachAll).not.toHaveBeenCalled();
    // crucially NOT 'terminate', which would run onDestroy and remove the worktree.
    expect(teardown).toHaveBeenCalledWith('workspace-1', 'archive');
  });
});

describe('teardownTaskIfPresent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports when no lifecycle entry was available for teardown', async () => {
    const attempt = await taskSessionManager.teardownTaskIfPresent(
      'missing-task-presence-test',
      'archive'
    );

    expect(attempt).toEqual({ handled: false, result: { success: true, data: undefined } });
  });

  it('atomically claims and tears down an available lifecycle entry', async () => {
    const { task } = makeTask();
    await taskSessionManager.registerTask(
      'live-task-presence-test',
      {
        path: '/tmp/worktree',
        workspaceId: 'workspace-presence-test',
        taskProvider: task,
      },
      'project-presence-test',
      {} as IExecutionContext
    );

    const attempt = await taskSessionManager.teardownTaskIfPresent(
      'live-task-presence-test',
      'archive'
    );

    expect(attempt.handled).toBe(true);
    expect(attempt.result.success).toBe(true);
    expect(teardown).toHaveBeenCalledWith('workspace-presence-test', 'archive');
  });
});
